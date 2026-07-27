const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 10000;

let qrCodeData = '';
let isConnected = false;

async function connectToWhatsApp() {
  // Menyimpan sesi login WhatsApp
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Jika ada QR code baru, ubah ke gambar base64
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

  // Logika membalas pesan otomatis
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.key.fromMe && m.type === 'notify') {
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

      // Contoh: Jika ada yang chat "ping", bot akan balas "pong! 🏓"
      if (text && text.toLowerCase() === 'ping') {
        await sock.sendMessage(msg.key.remoteJid, { text: 'pong! 🏓' });
      }
    }
  });
}

connectToWhatsApp();

// Tampilan web untuk scan QR Code
app.get('/', (req, res) => {
  if (isConnected) {
    return res.send('<h1>Status: WhatsApp Bot Sudah Terhubung! ✅</h1>');
  }
  if (qrCodeData) {
    return res.send(`
      <div style="text-align:center; font-family:sans-serif; padding-top: 50px;">
        <h2>Scan QR Code ini dengan WhatsApp kamu:</h2>
        <img src="${qrCodeData}" alt="QR Code" style="border: 2px solid #333; padding: 10px; border-radius: 8px;" />
        <p>Buka WA di HP -> Perangkat Tertaut -> Tautkan Perangkat</p>
        <p><i>Refresh halaman jika QR expired.</i></p>
      </div>
    `);
  }
  res.send('<h1>Sedang menyiapkan QR Code... Silakan refresh halaman dalam 5 detik.</h1>');
});

app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});
