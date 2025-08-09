const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} = require('@whiskeysockets/baileys');
require('dotenv').config();
const { Boom } = require('@hapi/boom');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const qrcode = require('qrcode');
const { formatNumber } = require('./helpers');

const PORT = process.env.PORT || 3000;
const BOT_NAME = process.env.BOT_NAME || 'BotKu';

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

// API: Kirim pesan personal
app.post('/send-personal', async (req, res) => {
    const { number, message } = req.body;
    if (!number || !message) {
        return res.status(400).json({
            status: false,
            message: 'Parameter number dan message wajib diisi.'
        });
    }

    const jid = formatNumber(number);

    // Kirim respon cepat ke client
    res.json({ status: true, message: 'Pesan sedang dikirim.' });

    // Jalankan pengiriman di background (tidak menghambat respon)
    sock.sendMessage(jid, { text: message })
        .then(() => {
            console.log(`✅ Pesan ke ${jid} berhasil dikirim`);
        })
        .catch((err) => {
            console.error(`❌ Gagal kirim pesan ke ${jid}:`, err);
        });
});

// API: Kirim pesan ke grup
app.post('/send-group', async (req, res) => {
    const { groupId, message } = req.body;
    if (!groupId || !message) {
        return res.status(400).json({ status: false, message: 'Parameter groupId dan message wajib diisi.' });
    }

    try {
        const jid = groupId.endsWith('@g.us') ? groupId : groupId + '@g.us';
        await sock.sendMessage(jid, { text: message });
        res.json({ status: true, message: 'Pesan berhasil dikirim ke grup.' });
    } catch (err) {
        res.status(500).json({ status: false, message: 'Gagal mengirim pesan', error: err.toString() });
    }
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
            const fs = require('fs');
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

app.get('/send-image', async (req, res) => {
    const { number, caption, imageUrl } = req.query;

    if (!number || !imageUrl) {
        return res.status(400).json({ status: false, message: 'Parameter number dan imageUrl wajib diisi.' });
    }

    const jid = number.endsWith('@s.whatsapp.net') ? number : number + '@s.whatsapp.net';

    try {
        // Ambil data gambar dari URL
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data, 'binary');

        await sock.sendMessage(jid, {
            image: buffer,
            caption: caption || ''
        });

        res.json({ status: true, message: 'Gambar berhasil dikirim.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ status: false, message: 'Gagal mengirim gambar.', error: err.toString() });
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
  
  
server.listen(PORT, () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});