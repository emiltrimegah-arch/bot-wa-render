const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware wajib agar Express bisa membaca body bertipe JSON
app.use(express.json());

let sock = null; // Variabel global untuk menyimpan koneksi WA
let qrCodeData = '';
let isConnected = false;

// Helper function untuk format nomor HP ke WhatsApp JID
function formatToJid(phone) {
  let cleaned = phone.toString().replace(/\D/g, ''); // Hapus semua karakter non-angka
  if (cleaned.startsWith('0')) {
    cleaned = '62' + cleaned.slice(1); // Ubah 0812... jadi 62812...
  }
  if (!cleaned.endsWith('@s.whatsapp.net')) {
    cleaned += '@s.whatsapp.net';
  }
  return cleaned;
}

async function connectToWhatsApp() {
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

// ==========================================
// ENDPOINT KIRIM OTP
// ==========================================
app.post('/send-otp', async (req, res) => {
  const { phone, otp, secretKey } = req.body;

  // 1. Pengaman sederhana (opsional tapi disarankan agar endpoint tidak dispam orang)
  const MY_SECRET = process.env.SECRET_KEY || 'RAHASIA_KITA_123';
  if (secretKey !== MY_SECRET) {
    return res.status(401).json({ status: false, message: 'Unauthorized: Secret Key salah!' });
  }

  // 2. Validasi input
  if (!phone || !otp) {
    return res.status(400).json({ status: false, message: 'Nomor HP (phone) dan kode (otp) wajib diisi!' });
  }

  // 3. Cek status bot
  if (!isConnected || !sock) {
    return res.status(503).json({ status: false, message: 'Bot WhatsApp belum terhubung/online.' });
  }

  try {
    const jid = formatToJid(phone);
    const message = `*KODE VERIFIKASI (OTP)*\n\nKode OTP Anda adalah: *${otp}*\n\nJangan berikan kode ini kepada siapa pun, termasuk pihak kami. Kode ini berlaku selama 5 menit.`;

    await sock.sendMessage(jid, { text: message });

    return res.json({
      status: true,
      message: 'OTP berhasil dikirim via WhatsApp!',
      target: phone
    });
  } catch (error) {
    console.error('Gagal mengirim OTP:', error);
    return res.status(500).json({ status: false, message: 'Gagal mengirim pesan', error: error.message });
  }
});

// Tampilan web QR Code
app.get('/', (req, res) => {
  if (isConnected) {
    return res.send('<h1>Status: WhatsApp Bot Sudah Terhubung! ✅</h1>');
  }
  if (qrCodeData) {
    return res.send(`
      <div style="text-align:center; font-family:sans-serif; padding-top: 50px;">
        <h2>Scan QR Code ini dengan WhatsApp kamu:</h2>
        <img src="${qrCodeData}" alt="QR Code" style="border: 2px solid #333; padding: 10px; border-radius: 8px;" />
      </div>
    `);
  }
  res.send('<h1>Sedang menyiapkan QR Code... Silakan refresh halaman.</h1>');
});

app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});