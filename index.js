import makeWASocket, { 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    DisconnectReason 
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import fs from 'fs'
import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import bodyParser from 'body-parser'
import qrcode from 'qrcode'
import axios from 'axios'
import dotenv from 'dotenv'
import { formatNumber } from './helpers.js' // tambahkan .js saat import file lokal
import db from "./db.js"
dotenv.config()

const PORT = process.env.PORT || 3000;
const BOT_NAME = process.env.BOT_NAME || 'BotKu';
const VALID_APIKEY = process.env.API_KEY;
const getToday = () => {
    return new Date().toLocaleDateString("id-ID", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).split("/").reverse().join("-"); // format YYYY-MM-DD
};
const getTime = () => {
    return new Date().toLocaleTimeString("id-ID", {
        hour12: false, // format 24 jam
        timeZone: "Asia/Jakarta" // sesuaikan dengan zona kamu
    });
};
const getTodayLong = () => {
    const options = { 
        weekday: "long",   // hari (Senin, Selasa, ...)
        day: "2-digit",    // tanggal
        month: "short",    // bulan 3 huruf (Jan, Feb, Mar)
        year: "numeric",   // tahun 4 digit
        timeZone: "Asia/Jakarta" // zona WIB
    };
    return new Date().toLocaleDateString("id-ID", options);
};

let sock;
let isConnected = false;

// Init Express & Socket.IO
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Start Baileys
async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        browser: [BOT_NAME, 'Chrome', '1.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrImage = await qrcode.toDataURL(qr);
            io.emit('qr', qrImage);
            io.emit('connection-status', false);
            isConnected = false;
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log('⛔ Koneksi terputus:', statusCode);
            io.emit('connection-status', false);
            isConnected = false;

            if (shouldReconnect) {
                startSock();
            }
        } else if (connection === 'open') {
            console.log('✅ Terhubung ke WhatsApp!');
            io.emit('connection-status', true);
            io.emit('qr', null);
            isConnected = true;
        }
    });
}

startSock();

async function getGuruById(kode_guru) {
    const [rows] = await db.query(
        "SELECT * FROM guru WHERE kode_guru = ? LIMIT 1",
        [kode_guru]
    );

    if (rows.length === 0) return null;
    return rows[0]; // Pastikan nama kolom sesuai tabel kamu
}

async function sendPersonal(number, message) {
    if (!number || !message) return;

    const jid = formatNumber(number);

    // Jalankan WA di background tanpa await
    sock.sendMessage(jid, { text: message })
        .then(() => {
            console.log(`✅ Pesan ke ${jid} berhasil dikirim`);
        })
        .catch((err) => {
            console.error(`❌ Gagal kirim pesan ke ${jid}:`, err);
        });
}

// API: Kirim pesan personal
app.post('/send-personal', async (req, res) => {
    const { number, message, apiKey } = req.body;

    if (!number || !message|| !apiKey) {
        return res.status(400).json({
            status: false,
            message: 'Parameter number, message, dan apiKey wajib diisi.'
        });
    }
    
    if (apiKey != VALID_APIKEY) {
        return res.status(400).json({
            status: false,
            message: 'Api key tidak valid.'
        });
    }

    // Respon cepat
    res.json({ status: true, message: 'Pesan sedang dikirim.' });

    // Kirim personal di background
    sendPersonal(number, message);
});


// API: Kirim pesan ke grup
app.post('/send-group', (req, res) => {
    const { groupId, message, apiKey } = req.body;

    if (!groupId || !message || !apiKey) {
        return res.status(400).json({
            status: false,
            message: 'Parameter groupId dan message wajib diisi.'
        });
    }

    if (apiKey != VALID_APIKEY) {
        return res.status(400).json({
            status: false,
            message: 'Api key tidak valid.'
        });
    }

    const jid = groupId.endsWith('@g.us') ? groupId : groupId + '@g.us';

    // Kirim respon cepat ke client
    res.json({
        status: true,
        message: 'Pesan sedang dikirim ke grup.'
    });

    // Kirim pesan di background
    sock.sendMessage(jid, { text: message })
        .then(() => {
            console.log(`✅ Pesan berhasil dikirim ke grup: ${jid}`);
        })
        .catch((err) => {
            console.error(`❌ Gagal mengirim pesan ke grup ${jid}:`, err);
        });
});


// API: List grup
app.get('/groups', async (req, res) => {
    if (!isConnected || !sock) {
        return res.status(400).json({ status: false, message: 'Belum terkoneksi ke WhatsApp.' });
    }
    const groups = await sock.groupFetchAllParticipating();
    res.json({ status: true, data: Object.values(groups) });
});

// API: Disconnect
app.post('/disconnect', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();

            // Reset variabel
            sock = null;
            isConnected = false;

            // Hapus file auth agar QR baru muncul
            // const fs = require('fs');
            const path = './auth_info';
            if (fs.existsSync(path)) {
                fs.rmSync(path, { recursive: true, force: true });
            }

            io.emit('connection-status', false);

            // Mulai ulang koneksi untuk memunculkan QR
            startSock();

            return res.json({ status: true, message: 'Berhasil logout & reset koneksi.' });
        }
        res.status(400).json({ status: false, message: 'Tidak ada koneksi aktif.' });
    } catch (error) {
        console.error('Error saat disconnect:', error);
        res.status(500).json({ status: false, message: 'Gagal disconnect.' });
    }
});


// Socket.IO untuk kirim status real-time
io.on('connection', (socket) => {
    console.log('🔌 Client terhubung ke dashboard');
    socket.emit('connection-status', isConnected);
});

app.post('/send-group-image', async (req, res) => {
    const { groupId, imageUrl, caption } = req.body;

    if (!groupId || !imageUrl) {
        return res.status(400).json({
            status: false,
            message: 'Parameter groupId dan imageUrl wajib diisi.'
        });
    }

    try {
        const jid = groupId.endsWith('@g.us') ? groupId : groupId + '@g.us';

        // Ambil gambar dari URL (buffer)
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data, 'binary');

        // Kirim gambar
        await sock.sendMessage(jid, {
            image: buffer,
            caption: caption || ''
        });

        res.json({
            status: true,
            message: 'Gambar berhasil dikirim ke grup.'
        });
    } catch (err) {
        console.error('❌ Gagal mengirim gambar:', err);
        res.status(500).json({
            status: false,
            message: 'Gagal mengirim gambar ke grup.',
            error: err.message
        });
    }
});
app.get('/send-url', async (req, res) => {
    const { number, url, message } = req.query;

    if (!number || !url) {
        return res.status(400).json({ status: false, message: 'Parameter number dan url wajib diisi.' });
    }

    const jid = number.endsWith('@s.whatsapp.net') ? number : number + '@s.whatsapp.net';
    const text = message ? `${message}\n\n${url}` : url;

    try {
        await sock.sendMessage(jid, {
            text: text
        });

        res.json({ status: true, message: 'URL berhasil dikirim dengan preview (jika tersedia).' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ status: false, message: 'Gagal mengirim URL.', error: err.toString() });
    }
});

app.get('/send-ad-message', async (req, res) => {
    const { number, title, body, url, image } = req.query;
  
    if (!number || !title || !body || !url || !image) {
      return res.status(400).json({ status: false, message: 'Parameter number, title, body, url, dan image wajib diisi.' });
    }
  
    const jid = number.endsWith('@s.whatsapp.net') ? number : number + '@s.whatsapp.net';
  
    try {
      // Ambil gambar
      const response = await axios.get(image, { responseType: 'arraybuffer' });
      const imageBuffer = Buffer.from(response.data, 'binary');
  
      // 1. Kirim gambar dulu dengan caption (caption bisa diklik)
      await sock.sendMessage(jid, {
        image: imageBuffer,
        caption: `${body}\n\n👉 ${url}`
      });
  
      // 2. Kirim externalAdReply (tidak wajib, hanya jika ingin)
      await sock.sendMessage(jid, {
        text: body,
        contextInfo: {
          externalAdReply: {
            title,
            body,
            mediaType: 1,
            renderLargerThumbnail: true,
            showAdAttribution: true,
            sourceUrl: url,
            jpegThumbnail: imageBuffer
          }
        }
      });
  
      res.json({ status: true, message: 'Pesan gambar & adReply berhasil dikirim.' });
    } catch (err) {
      console.error('❌ Error:', err.message);
      res.status(500).json({ status: false, message: 'Gagal kirim pesan', error: err.toString() });
    }
  });
  
// Endpoint tambah data
app.post("/add-absen", async (req, res) => {
    const conn = await db.getConnection(); // transaksi ringan

    try {
        const { kode_guru, apiKey } = req.body;
        const today = getToday();
        const timeNow = getTime();
        
        if (apiKey !== VALID_APIKEY) {
            return res.status(401).json({ success: false, message: "API Key tidak valid" });
        }

        if (!kode_guru) {
            return res.status(400).json({ success: false, message: "kode_guru wajib dikirim" });
        }

        // ===============================================================
        // ⚡ OPTIMASI: Cek siswa dan guru sekaligus (1 query UNION)
        // ===============================================================
        const [cek] = await conn.query(
            `
            SELECT 'siswa' AS tipe, nis AS id 
            FROM santri_code WHERE code = ? 
            UNION
            SELECT 'guru' AS tipe, kode_guru AS id 
            FROM guru WHERE code = ?
            LIMIT 1
            `,
            [kode_guru, kode_guru]
        );

        if (cek.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Kode tidak ditemukan"
            });
        }

        const data = cek[0];

        // ===============================================================
        // ⚡ ABSENSI SISWA (optimized)
        // ===============================================================
        if (data.tipe === "siswa") {
            const [already] = await conn.query(
                "SELECT 1 FROM waqiah WHERE nis = ? AND tanggal = ? LIMIT 1",
                [data.id, today]
            );

            if (already.length === 0) {
                await conn.query(
                    "INSERT INTO waqiah (nis, tanggal, hadir) VALUES (?, ?, ?)",
                    [data.id, today, timeNow]
                );
            }

            return res.json({
                success: true,
                tipe: "siswa",
                status: already.length ? "error" : "success",
                message: already.length ? "Sudah Absen" : "Berhasil"
            });
        }

        // ===============================================================
        // ⚡ ABSENSI GURU (optimized)
        // ===============================================================

        // Cek sekaligus 2 tabel (mengajar + kehadiran)
        const [guruCheck] = await conn.query(
            `
            SELECT 
                (SELECT COUNT(*) FROM kehadiran WHERE guru=? AND tanggal=?) AS kehadiran,
                (SELECT COUNT(*) FROM apel_guru WHERE kode_guru=? AND tanggal=?) AS apel
            `,
            [data.id, today, data.id, today]
        );

        let result = [];

        // Insert mengajar jika belum
        if (guruCheck[0].kehadiran == 0) {
            await conn.query(
                "INSERT INTO kehadiran (guru, tanggal, ket) VALUES (?, ?, 1)",
                [data.id, today]
            );
            result.push("Absen mengajar dicatat");
        } else {
            await conn.query(
                "UPDATE kehadiran SET ket = 1 WHERE guru = ? AND tanggal = ?",
                [data.id, today]
            );
            result.push("Absen mengajar sudah ada");
        }

        // Insert hadir guru jika belum
        if (guruCheck[0].apel == 0) {
            await conn.query(
                "INSERT INTO apel_guru (kode_guru, tanggal, ket) VALUES (?, ?, 'hadir')",
                [data.id, today]
            );
            result.push("Absen guru dicatat");

            const guruData = await getGuruById(data.id);
            if (guruData) {
                const noWA = guruData.no_hp;
                const nama = guruData.nama_guru;
                const dayIndo = getTodayLong();
                sendPersonal(
                    noWA,
                    `Selamat Datang, ${nama}.

Di SMK Darul Lughah wal Karomah. Kehadiran Anda telah tercatat pada hari ini ${dayIndo}, pukul ${timeNow}.

Terima kasih.`
                );
            }


        } else {
            result.push("Absen guru sudah ada");
        }

        return res.json({
            success: true,
            tipe: "guru",
            message: "Proses absensi guru selesai",
            result
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, error: err.message });

    } finally {
        conn.release();
    }
});

server.listen(PORT, () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});