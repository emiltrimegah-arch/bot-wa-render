const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

let sock = null;
let qrCodeData = '';
let isConnected = false;

// ==========================================
// AUTO-RESTORE SESI DARI RENDER (MY_WA)
// ==========================================
function restoreSessionFromEnv() {
  const authDir = path.join(__dirname, 'auth_info_baileys');
  const credsFile = path.join(authDir, 'creds.json');

  // Mengambil data dari Environment Variable MY_WA
  if (process.env.MY_WA) {
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }
    // Tulis ulang file creds.json secara otomatis
    fs.writeFileSync(credsFile, process.env.MY_WA, 'utf8');
    console.log('✅ Sesi WhatsApp berhasil dimuat dari MY_WA!');
  }
}

function formatToJid(phone) {
  let cleaned = phone.toString().replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '62' + cleaned.slice(1);
  }
  if (!cleaned.endsWith('@s.whatsapp.net')) {
    cleaned += '@s.whatsapp.net';
  }
  return cleaned;
}

async function connectToWhatsApp() {
  // Restore file creds.json dari MY_WA saat server nyala
  restoreSessionFromEnv();

  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = await QRCode.toDataURL(qr);
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
      console.log('Koneksi terputus, mencoba terhubung kembali...', shouldReconnect);
      isConnected = false;
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('WhatsApp Bot Berhasil Terhubung!');
      isConnected = true;
      qrCodeData = '';
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.key.fromMe && m.type === 'notify') {
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      if (text && text.toLowerCase() === 'ping') {
        await sock.sendMessage(msg.key.remoteJid, { text: 'pong! 🏓' });
      }
    }
  });
}

connectToWhatsApp();

// ENDPOINT KIRIM OTP
app.post('/send-otp', async (req, res) => {
  const { phone, otp, secretKey } = req.body;
  const MY_SECRET = process.env.SECRET_KEY || 'RAHASIA_KITA_123';

  if (secretKey !== MY_SECRET) {
    return res.status(401).json({ status: false, message: 'Unauthorized: Secret Key salah!' });
  }

  if (!phone || !otp) {
    return res.status(400).json({ status: false, message: 'Nomor HP (phone) dan kode (otp) wajib diisi!' });
  }

  if (!isConnected || !sock) {
    return res.status(503).json({ status: false, message: 'Bot WhatsApp belum terhubung/online.' });
  }

  try {
    const jid = formatToJid(phone);
    const message = `*KODE VERIFIKASI (OTP)*\n\nKode OTP Anda adalah: *${otp}*\n\nJangan berikan kode ini kepada siapa pun. Kode ini berlaku selama 5 menit.`;

    await sock.sendMessage(jid, { text: message });

    return res.json({ status: true, message: 'OTP berhasil dikirim!', target: phone });
  } catch (error) {
    console.error('Gagal mengirim OTP:', error);
    return res.status(500).json({ status: false, message: 'Gagal mengirim pesan', error: error.message });
  }
});

app.get('/', (req, res) => {
  if (isConnected) {
    return res.send('<h1>Status: WhatsApp Bot Sudah Terhubung (Sesi Persisten)! ✅</h1>');
  }
  if (qrCodeData) {
    return res.send(`
      <div style="text-align:center; font-family:sans-serif; padding-top: 50px;">
        <h2>Scan QR Code ini:</h2>
        <img src="${qrCodeData}" alt="QR Code" style="border: 2px solid #333; padding: 10px; border-radius: 8px;" />
      </div>
    `);
  }
  res.send('<h1>Sedang menyiapkan QR Code... Silakan refresh halaman.</h1>');
});

app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});