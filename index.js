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
import { formatNumber } from './helpers.js' 
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
    }).split("/").reverse().join("-");
};

const getTime = () => {
    return new Date().toLocaleTimeString("id-ID", {
        hour12: false,
        timeZone: "Asia/Jakarta"
    });
};

const getTodayLong = () => {
    const options = { 
        weekday: "long",
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Jakarta"
    };
    return new Date().toLocaleDateString("id-ID", options);
};

const getNowJakarta = () => {
    const now = new Date();
    const jakartaTime = new Date(
        now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" })
    );
    const year = jakartaTime.getFullYear();
    const month = String(jakartaTime.getMonth() + 1).padStart(2, "0");
    const day = String(jakartaTime.getDate()).padStart(2, "0");
    const hours = String(jakartaTime.getHours()).padStart(2, "0");
    const minutes = String(jakartaTime.getMinutes()).padStart(2, "0");
    const seconds = String(jakartaTime.getSeconds()).padStart(2, "0");

    return {
        date: `${year}-${month}-${day}`,
        time: `${hours}:${minutes}:${seconds}`
    };
};

// Multi-Device State
const sessions = new Map();
const connectionStates = new Map();
const qrCodes = new Map();

// Init Express & Socket.IO
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Start Baileys for a specific session
async function startSock(sessionId = 'default') {
    const sessionFolder = `./auth_info/${sessionId}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        browser: [BOT_NAME, 'Chrome', '1.0'],
    });

    sessions.set(sessionId, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrImage = await qrcode.toDataURL(qr);
            io.to(sessionId).emit('qr', qrImage);
            qrCodes.set(sessionId, qrImage);
            connectionStates.set(sessionId, false);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`⛔ Koneksi [${sessionId}] terputus:`, statusCode);
            connectionStates.set(sessionId, false);
            qrCodes.delete(sessionId);
            io.to(sessionId).emit('connection-status', false);

            if (shouldReconnect) {
                startSock(sessionId);
            } else {
                sessions.delete(sessionId);
                connectionStates.delete(sessionId);
                qrCodes.delete(sessionId);
                if (fs.existsSync(sessionFolder)) {
                    fs.rmSync(sessionFolder, { recursive: true, force: true });
                }
            }
        } else if (connection === 'open') {
            console.log(`✅ [${sessionId}] Terhubung ke WhatsApp!`);
            connectionStates.set(sessionId, true);
            qrCodes.delete(sessionId);
            io.to(sessionId).emit('connection-status', true);
            io.to(sessionId).emit('qr', null);
        }
    });
}

// Auto-load existing sessions on startup
async function loadExistingSessions() {
    const authPath = './auth_info';
    if (!fs.existsSync(authPath)) {
        fs.mkdirSync(authPath, { recursive: true });
    }

    // Migrasi sesi lama
    if (fs.existsSync(`${authPath}/creds.json`)) {
        const defaultPath = `${authPath}/default`;
        if (!fs.existsSync(defaultPath)) {
            fs.mkdirSync(defaultPath, { recursive: true });
        }
        const files = fs.readdirSync(authPath);
        for (const file of files) {
            const oldPath = `${authPath}/${file}`;
            const newPath = `${defaultPath}/${file}`;
            if (fs.statSync(oldPath).isFile()) {
                fs.renameSync(oldPath, newPath);
            }
        }
        console.log('✅ Migrasi sesi lama ke "default" berhasil.');
    }

    // Baca semua subfolder
    const dirs = fs.readdirSync(authPath, { withFileTypes: true })
                   .filter(dirent => dirent.isDirectory())
                   .map(dirent => dirent.name);

    if (dirs.length === 0) {
        dirs.push('default');
    }

    for (const sessionId of dirs) {
        await startSock(sessionId);
    }
}

loadExistingSessions();

async function getGuruById(kode_guru) {
    const [rows] = await db.query(
        "SELECT * FROM guru WHERE kode_guru = ? LIMIT 1",
        [kode_guru]
    );
    if (rows.length === 0) return null;
    return rows[0];
}

async function sendPersonal(sessionId, number, message) {
    if (!number || !message) return;
    const sock = sessions.get(sessionId);
    if (!sock) return;

    const jid = formatNumber(number);

    sock.sendMessage(jid, { text: message })
        .then(() => {
            console.log(`✅ Pesan ke ${jid} berhasil dikirim via [${sessionId}]`);
        })
        .catch((err) => {
            console.error(`❌ Gagal kirim pesan ke ${jid} via [${sessionId}]:`, err);
        });
}

// NEW ENDPOINT: Create new session
app.post('/sessions/create', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ status: false, message: 'Parameter sessionId wajib diisi.' });
    }

    if (sessions.has(sessionId)) {
        return res.status(400).json({ status: false, message: `Sesi '${sessionId}' sudah ada.` });
    }

    try {
        await startSock(sessionId);
        res.json({ status: true, message: `Sesi '${sessionId}' sedang diinisialisasi.` });
    } catch (error) {
        res.status(500).json({ status: false, message: `Gagal membuat sesi: ${error.message}` });
    }
});

// NEW ENDPOINT: List all sessions
app.get('/sessions', (req, res) => {
    const list = [];
    for (const [id, sock] of sessions.entries()) {
        list.push({
            sessionId: id,
            connected: connectionStates.get(id) || false
        });
    }
    res.json({ status: true, data: list });
});

// NEW ENDPOINT: Get specific session status and QR
app.get('/sessions/:sessionId/status', (req, res) => {
    const { sessionId } = req.params;
    
    if (!sessions.has(sessionId)) {
        return res.status(404).json({ status: false, message: `Sesi '${sessionId}' tidak ditemukan.` });
    }

    res.json({
        status: true,
        data: {
            sessionId: sessionId,
            connected: connectionStates.get(sessionId) || false,
            qr: qrCodes.get(sessionId) || null
        }
    });
});

// API: Kirim pesan personal
app.post('/send-personal', async (req, res) => {
    const { number, message, apiKey, sessionId } = req.body;
    const activeSession = sessionId || 'default';

    if (!number || !message || !apiKey) {
        return res.status(400).json({
            status: false,
            message: 'Parameter number, message, dan apiKey wajib diisi.'
        });
    }
    
    if (apiKey !== VALID_APIKEY) {
        return res.status(400).json({ status: false, message: 'Api key tidak valid.' });
    }

    const sock = sessions.get(activeSession);
    if (!sock || !connectionStates.get(activeSession)) {
        return res.status(400).json({ status: false, message: `Sesi '${activeSession}' belum terhubung.` });
    }

    res.json({ status: true, message: 'Pesan sedang dikirim.' });
    sendPersonal(activeSession, number, message);
});

// API: Kirim pesan ke grup
app.post('/send-group', (req, res) => {
    const { groupId, message, apiKey, sessionId } = req.body;
    const activeSession = sessionId || 'default';

    if (!groupId || !message || !apiKey) {
        return res.status(400).json({
            status: false,
            message: 'Parameter groupId dan message wajib diisi.'
        });
    }

    if (apiKey !== VALID_APIKEY) {
        return res.status(400).json({ status: false, message: 'Api key tidak valid.' });
    }

    const sock = sessions.get(activeSession);
    if (!sock || !connectionStates.get(activeSession)) {
        return res.status(400).json({ status: false, message: `Sesi '${activeSession}' belum terhubung.` });
    }

    const jid = groupId.endsWith('@g.us') ? groupId : groupId + '@g.us';
    res.json({ status: true, message: 'Pesan sedang dikirim ke grup.' });

    sock.sendMessage(jid, { text: message })
        .then(() => {
            console.log(`✅ Pesan berhasil dikirim ke grup: ${jid} via [${activeSession}]`);
        })
        .catch((err) => {
            console.error(`❌ Gagal mengirim pesan ke grup ${jid}:`, err);
        });
});

// API: List grup
app.get('/groups', async (req, res) => {
    const sessionId = req.query.sessionId || 'default';
    const sock = sessions.get(sessionId);

    if (!connectionStates.get(sessionId) || !sock) {
        return res.status(400).json({ status: false, message: `Sesi '${sessionId}' belum terkoneksi.` });
    }

    try {
        const groups = await sock.groupFetchAllParticipating();
        res.json({ status: true, data: Object.values(groups) });
    } catch (error) {
        res.status(500).json({ status: false, message: 'Gagal mengambil grup', error: error.message });
    }
});

// API: Disconnect
app.post('/disconnect', async (req, res) => {
    try {
        const { sessionId } = req.body;
        const activeSession = sessionId || 'default';
        const sock = sessions.get(activeSession);

        if (sock) {
            await sock.logout();
            sessions.delete(activeSession);
            connectionStates.delete(activeSession);
            qrCodes.delete(activeSession);

            const path = `./auth_info/${activeSession}`;
            if (fs.existsSync(path)) {
                fs.rmSync(path, { recursive: true, force: true });
            }

            io.to(activeSession).emit('connection-status', false);
            startSock(activeSession);

            return res.json({ status: true, message: `Berhasil logout & reset sesi [${activeSession}].` });
        }
        res.status(400).json({ status: false, message: `Tidak ada koneksi aktif untuk [${activeSession}].` });
    } catch (error) {
        console.error('Error saat disconnect:', error);
        res.status(500).json({ status: false, message: 'Gagal disconnect.' });
    }
});

// API: Kirim gambar ke grup
app.post('/send-group-image', async (req, res) => {
    const { groupId, imageUrl, caption, sessionId } = req.body;
    const activeSession = sessionId || 'default';

    if (!groupId || !imageUrl) {
        return res.status(400).json({
            status: false,
            message: 'Parameter groupId dan imageUrl wajib diisi.'
        });
    }

    const sock = sessions.get(activeSession);
    if (!sock || !connectionStates.get(activeSession)) {
        return res.status(400).json({ status: false, message: `Sesi '${activeSession}' belum terhubung.` });
    }

    try {
        const jid = groupId.endsWith('@g.us') ? groupId : groupId + '@g.us';
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data, 'binary');

        await sock.sendMessage(jid, {
            image: buffer,
            caption: caption || ''
        });

        res.json({ status: true, message: 'Gambar berhasil dikirim ke grup.' });
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
    const { number, url, message, sessionId } = req.query;
    const activeSession = sessionId || 'default';

    if (!number || !url) {
        return res.status(400).json({ status: false, message: 'Parameter number dan url wajib diisi.' });
    }

    const sock = sessions.get(activeSession);
    if (!sock || !connectionStates.get(activeSession)) {
        return res.status(400).json({ status: false, message: `Sesi '${activeSession}' belum terhubung.` });
    }

    const jid = number.endsWith('@s.whatsapp.net') ? number : number + '@s.whatsapp.net';
    const text = message ? `${message}\n\n${url}` : url;

    try {
        await sock.sendMessage(jid, { text: text });
        res.json({ status: true, message: 'URL berhasil dikirim.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ status: false, message: 'Gagal mengirim URL.', error: err.toString() });
    }
});

app.get('/send-ad-message', async (req, res) => {
    const { number, title, body, url, image, sessionId } = req.query;
    const activeSession = sessionId || 'default';
  
    if (!number || !title || !body || !url || !image) {
      return res.status(400).json({ status: false, message: 'Parameter wajib diisi.' });
    }
  
    const sock = sessions.get(activeSession);
    if (!sock || !connectionStates.get(activeSession)) {
        return res.status(400).json({ status: false, message: `Sesi '${activeSession}' belum terhubung.` });
    }

    const jid = number.endsWith('@s.whatsapp.net') ? number : number + '@s.whatsapp.net';
  
    try {
      const response = await axios.get(image, { responseType: 'arraybuffer' });
      const imageBuffer = Buffer.from(response.data, 'binary');
  
      await sock.sendMessage(jid, {
        image: imageBuffer,
        caption: `${body}\n\n👉 ${url}`
      });
  
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

app.post("/add-absen", async (req, res) => {
    const conn = await db.getConnection();

    try {
        const { kode_guru, apiKey, sessionId } = req.body;
        const { date: today, time: timeNow } = getNowJakarta();
        
        if (apiKey !== VALID_APIKEY) {
            return res.status(401).json({ success: false, message: "API Key tidak valid" });
        }

        if (!kode_guru) {
            return res.status(400).json({ success: false, message: "kode_guru wajib dikirim" });
        }

        let activeSessionId = sessionId;
        if (!activeSessionId) {
            const activeSessions = Array.from(connectionStates.entries()).filter(([id, state]) => state);
            if (activeSessions.length > 0) {
                activeSessionId = activeSessions[0][0];
            }
        }

        const [cek] = await conn.query(
            `
            SELECT 'siswa' AS tipe, nis AS id 
            FROM tb_santri WHERE rfid = ? 
            UNION
            SELECT 'guru' AS tipe, kode_guru AS id 
            FROM guru WHERE code = ?
            LIMIT 1
            `,
            [kode_guru, kode_guru]
        );

        if (cek.length === 0) {
            return res.status(404).json({ success: false, message: "Kode tidak ditemukan" });
        }

        const data = cek[0];

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

        const [guruCheck] = await conn.query(
            `
            SELECT 
                (SELECT COUNT(*) FROM kehadiran WHERE guru=? AND tanggal=?) AS kehadiran,
                (SELECT COUNT(*) FROM apel_guru WHERE kode_guru=? AND tanggal=?) AS apel
            `,
            [data.id, today, data.id, today]
        );

        let result = [];

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

        if (guruCheck[0].apel == 0) {
            await conn.query(
                "INSERT INTO apel_guru (kode_guru, tanggal, ket) VALUES (?, ?, 'hadir')",
                [data.id, today]
            );
            result.push("Absen guru dicatat");

            const guruData = await getGuruById(data.id);
            if (guruData && activeSessionId) {
                const noWA = guruData.no_hp;
                const nama = guruData.nama_guru;
                const dayIndo = getTodayLong();
                sendPersonal(
                    activeSessionId,
                    noWA,
                    `Selamat Datang, ${nama}.\n\nDi SMK Darul Lughah wal Karomah. Kehadiran Anda telah tercatat pada hari ini ${dayIndo}, pukul ${timeNow}.\n\nTerima kasih.`
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

// Socket.io room assignment
io.on('connection', (socket) => {
    console.log('🔌 Client terhubung ke dashboard');
    
    socket.on('join-session', (sessionId) => {
        socket.join(sessionId);
        socket.emit('connection-status', connectionStates.get(sessionId) || false);
        console.log(`🔌 Client bergabung ke room sesi: ${sessionId}`);
    });
});

server.listen(PORT, () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});