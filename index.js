require('dotenv').config();

const express = require('express');
const {
  default: makeWASocket,
  initAuthCreds,
  BufferJSON,
  proto,
  DisconnectReason,
  fetchLatestBaileysVersion, // <-- TAMBAHKAN INI
  Browsers                   // <-- TAMBAHKAN INI
} = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());

let sock = null;
let qrCodeData = '';
let isConnected = false;
let mongoDb = null;
let connectionRetryCount = 0;
let isConnecting = false;     // Guard agar tidak ada koneksi ganda
let reconnectTimeout = null; // Timer reconnect terpusat

// ==========================================
// MIDDLEWARE: BASIC AUTH
// ==========================================
const basicAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const ADMIN_USER = process.env.ADMIN_USER || 'admin';
  const ADMIN_PASS = process.env.ADMIN_PASS || 'rahasia123';

  if (authHeader) {
    const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    if (auth[0] === ADMIN_USER && auth[1] === ADMIN_PASS) {
      return next();
    }
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Akses Terproteksi"');
  return res.status(401).send('<h1>Akses Ditolak! Username atau Password salah.</h1>');
};

// ==========================================
// DATABASE CONNECT
// ==========================================
async function connectToMongo() {
  if (mongoDb) return true;

  const MONGO_URI = process.env.MONGO_URI;
  if (!MONGO_URI) {
    console.error("⚠️ MONGO_URI belum diatur!");
    return false;
  }

  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    mongoDb = client.db('wa_bot_db');
    console.log('✅ Berhasil terhubung ke MongoDB Server!');
    return true;
  } catch (err) {
    console.error('❌ Gagal terhubung ke MongoDB:', err);
    return false;
  }
}

// ==========================================
// AUTH STATE MANAGEMENT
// ==========================================
async function useMongoAuthState() {
  const collection = mongoDb.collection('auth_session');

  const writeData = (data, id) => {
    return collection.replaceOne(
      { _id: id },
      { _id: id, data: JSON.stringify(data, BufferJSON.replacer) },
      { upsert: true }
    );
  };

  const readData = async (id) => {
    try {
      const doc = await collection.findOne({ _id: id });
      if (!doc) return null;
      return JSON.parse(doc.data, BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const removeData = async (id) => {
    try {
      await collection.deleteOne({ _id: id });
    } catch { }
  };

  let creds = await readData('creds');

  if (!creds) {
    if (process.env.MY_WA) {
      try {
        creds = JSON.parse(process.env.MY_WA, BufferJSON.reviver);
        console.log('📦 Mengimpor sesi dari MY_WA ke MongoDB...');
        await writeData(creds, 'creds');
      } catch (error) {
        creds = initAuthCreds();
      }
    } else {
      console.log('🆕 Sesi kosong. Menyiapkan QR Code baru...');
      creds = initAuthCreds();
    }
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds'),
  };
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

// Helper Reconnect Terjadwal
function scheduleReconnect(ms = 3000) {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  reconnectTimeout = setTimeout(() => {
    connectToWhatsApp();
  }, ms);
}

// ==========================================
// KONEKSI BOT WHATSAPP
// ==========================================
async function connectToWhatsApp() {
  if (isConnecting) {
    console.log('⏳ Koneksi sedang diproses, mengabaikan request ganda...');
    return;
  }
  isConnecting = true;

  // Bersihkan socket lama jika ada
  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.end(undefined);
    } catch (e) { }
    sock = null;
  }

  const isMongoReady = await connectToMongo();
  if (!isMongoReady) {
    isConnecting = false;
    return;
  }

  const { state, saveCreds } = await useMongoAuthState();

  // 1. Ambil versi WhatsApp Web resmi yang paling baru
  let version = [2, 3000, 1015901307]; // fallback default
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
    console.log(`ℹ️ Menggunakan WA Web v${version.join('.')}`);
  } catch (err) {
    console.log('⚠️ Gagal mengambil versi WA terbaru, menggunakan versi fallback');
  }

  // 2. Inisialisasi Socket dengan Versi + Browser Bawaan Baileys
  sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.ubuntu('Chrome'), // Gunakan signature resmi Baileys
    syncFullHistory: false,             // Matikan sync riwayat pesan berat
  });

  isConnecting = false;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📸 QR Code Baru Berhasil Dibuat!');
      qrCodeData = await QRCode.toDataURL(qr);
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      connectionRetryCount++;
      console.log(`⚠️ Koneksi terputus (Gagal ke-${connectionRetryCount}). Status: ${statusCode}`);

      if (isLoggedOut || connectionRetryCount >= 3) {
        console.log('🚨 Sesi corrupt/logged out! Menghapus dari MongoDB...');
        if (mongoDb) {
          try {
            await mongoDb.collection('auth_session').deleteMany({});
            console.log('🗑️ Sesi MongoDB berhasil dibersihkan!');
          } catch (err) {
            console.error('Gagal membersihkan sesi:', err);
          }
        }
        connectionRetryCount = 0;
        qrCodeData = '';
        scheduleReconnect(3000);
      } else {
        scheduleReconnect(3000);
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp Bot Berhasil Terhubung (Sesi Live)!');
      isConnected = true;
      qrCodeData = '';
      connectionRetryCount = 0;

      // PAKSA STATUS MENJADI OFFLINE / UNAVAILABLE
      await sock.sendPresenceUpdate('unavailable');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.key.fromMe && m.type === 'notify') {
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      if (text && text.toLowerCase() === 'ping') {
        await sock.sendMessage(msg.key.remoteJid, { text: 'pong! 🏓 Bot Aktif!' });
      }
    }
  });
}

connectToWhatsApp();

// ==========================================
// ENDPOINT DARURAT: RESET SESI
// ==========================================
app.get('/reset-session', basicAuth, async (req, res) => {
  try {
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    isConnecting = false;

    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.end(undefined);
      } catch (e) { }
      sock = null;
    }

    if (mongoDb) {
      await mongoDb.collection('auth_session').deleteMany({});
      console.log('🧹 Sesi di MongoDB dibersihkan total via Web Reset!');
      mongoDb = null; // Force reconnect fresh ke MongoDB
    }

    isConnected = false;
    qrCodeData = '';
    connectionRetryCount = 0;

    scheduleReconnect(1000);

    return res.send(`
      <div style="text-align:center; padding-top:50px; font-family:sans-serif;">
        <h1 style="color:green;">✅ Sesi Berhasil Di-reset Total!</h1>
        <p>Database sesi lama sudah dibersihkan.</p>
        <a href="/" style="display:inline-block; padding:10px 20px; background:#007bff; color:white; text-decoration:none; border-radius:5px;">
          Klik di sini untuk melihat QR Code Baru
        </a>
      </div>
    `);
  } catch (err) {
    return res.status(500).send('Gagal reset sesi: ' + err.message);
  }
});

// ==========================================
// ENDPOINT 1: KIRIM OTP
// ==========================================
app.post('/send-otp', async (req, res) => {
  const { phone, otp, secretKey } = req.body;
  const MY_SECRET = process.env.SECRET_KEY || 'RAHASIA_KITA_123';

  if (secretKey !== MY_SECRET) {
    return res.status(401).json({ status: false, message: 'Unauthorized: Secret Key salah!' });
  }
  if (!phone || !otp) {
    return res.status(400).json({ status: false, message: 'Nomor HP dan kode OTP wajib diisi!' });
  }
  if (!isConnected || !sock) {
    return res.status(503).json({ status: false, message: 'Bot WhatsApp belum terhubung.' });
  }

  const jid = formatToJid(phone);
  const message = `*KODE VERIFIKASI (OTP)*\n\nKode OTP Anda adalah: *${otp}*\n\nJangan berikan kode ini kepada siapa pun. Kode ini berlaku selama 5 menit.`;

  try {
    await sock.sendMessage(jid, { text: message });

    if (mongoDb) {
      await mongoDb.collection('otp_logs').insertOne({
        phone: phone,
        otp: otp,
        status: 'SUCCESS',
        timestamp: new Date()
      });
    }

    return res.json({ status: true, message: 'OTP berhasil dikirim!', target: phone });
  } catch (error) {
    console.error('Gagal mengirim OTP:', error);

    if (mongoDb) {
      await mongoDb.collection('otp_logs').insertOne({
        phone: phone,
        otp: otp,
        status: 'FAILED',
        error_detail: error.message,
        timestamp: new Date()
      });
    }

    return res.status(500).json({ status: false, message: 'Gagal mengirim pesan', error: error.message });
  }
});

// ==========================================
// ENDPOINT 2: API DATA LOGS
// ==========================================
app.get('/api/logs', basicAuth, async (req, res) => {
  if (!mongoDb) return res.status(500).json({ error: 'Database belum siap' });

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || '';

  try {
    let query = {};
    if (search) {
      query = { phone: { $regex: search, $options: 'i' } };
    }

    const skip = (page - 1) * limit;
    const totalData = await mongoDb.collection('otp_logs').countDocuments(query);
    const totalPages = Math.ceil(totalData / limit);

    const logs = await mongoDb.collection('otp_logs')
      .find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    res.json({ page, limit, totalData, totalPages, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ENDPOINT 3: UI HISTORY
// ==========================================
app.get('/history', basicAuth, (req, res) => {
  const html = `
    <!DOCTYPE html>
    <html lang="id">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>History OTP Bot</title>
      <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    </head>
    <body class="bg-light">
      <div class="container mt-5">
        <h2 class="mb-4">📜 Riwayat Pengiriman OTP</h2>
        
        <div class="row mb-3">
          <div class="col-md-4">
            <input type="text" id="searchInput" class="form-control" placeholder="Cari nomor HP...">
          </div>
          <div class="col-md-2">
            <button class="btn btn-primary w-100" onclick="fetchLogs(1)">Cari</button>
          </div>
        </div>

        <div class="card shadow-sm">
          <div class="card-body p-0 table-responsive">
            <table class="table table-striped table-hover mb-0">
              <thead class="table-dark">
                <tr>
                  <th>Waktu</th>
                  <th>Nomor HP</th>
                  <th>OTP</th>
                  <th>Status</th>
                  <th>Error Detail</th>
                </tr>
              </thead>
              <tbody id="tableBody">
                <tr><td colspan="5" class="text-center">Memuat data...</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="d-flex justify-content-between align-items-center mt-3 mb-5">
          <span id="pageInfo" class="text-muted"></span>
          <div>
            <button id="prevBtn" class="btn btn-outline-secondary btn-sm" onclick="changePage(-1)">Sebelumnya</button>
            <button id="nextBtn" class="btn btn-outline-secondary btn-sm" onclick="changePage(1)">Selanjutnya</button>
          </div>
        </div>
      </div>

      <script>
        let currentPage = 1;
        let totalPages = 1;

        async function fetchLogs(page) {
          currentPage = page;
          const search = document.getElementById('searchInput').value;
          
          try {
            const res = await fetch(\`/api/logs?page=\${page}&limit=10&search=\${search}\`, {
              credentials: 'same-origin'
            });
            const data = await res.json();
            
            totalPages = data.totalPages;
            renderTable(data.logs);
            document.getElementById('pageInfo').innerText = \`Halaman \${data.page} dari \${data.totalPages || 1} (Total: \${data.totalData} data)\`;
            
            document.getElementById('prevBtn').disabled = currentPage === 1;
            document.getElementById('nextBtn').disabled = currentPage === totalPages || totalPages === 0;
          } catch (err) {
            console.error(err);
          }
        }

        function renderTable(logs) {
          const tbody = document.getElementById('tableBody');
          tbody.innerHTML = '';
          
          if (!logs || logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center text-danger py-4">Data tidak ditemukan</td></tr>';
            return;
          }

          logs.forEach(log => {
            const date = new Date(log.timestamp).toLocaleString('id-ID');
            const statusBadge = log.status === 'SUCCESS' ? '<span class="badge bg-success">SUCCESS</span>' : '<span class="badge bg-danger">FAILED</span>';
            const errorText = log.error_detail || '-';
            
            tbody.innerHTML += \`
              <tr>
                <td>\${date}</td>
                <td>\${log.phone}</td>
                <td class="fw-bold">\${log.otp}</td>
                <td>\${statusBadge}</td>
                <td><small class="text-muted">\${errorText}</small></td>
              </tr>
            \`;
          });
        }

        function changePage(delta) {
          const newPage = currentPage + delta;
          if (newPage >= 1 && newPage <= totalPages) {
            fetchLogs(newPage);
          }
        }

        fetchLogs(1);
      </script>
    </body>
    </html>
  `;
  res.send(html);
});

// ==========================================
// ENDPOINT 4: HALAMAN UTAMA / QR CODE
// ==========================================
app.get('/', basicAuth, (req, res) => {
  if (isConnected) {
    return res.send(`
      <div style="text-align:center; padding-top: 50px; font-family:sans-serif;">
        <h1>Status: WhatsApp Bot Terhubung ✅</h1>
        <p>Sesi aman tersimpan di MongoDB. Auto Log aktif.</p>
        <a href="/history" style="display:inline-block; padding:10px 20px; background:#007bff; color:white; text-decoration:none; border-radius:5px;">Lihat Riwayat OTP</a>
      </div>
    `);
  }
  if (qrCodeData) {
    return res.send(`
      <div style="text-align:center; font-family:sans-serif; padding-top: 50px;">
        <h2>Scan QR Code Ini Sekali Saja:</h2>
        <img src="${qrCodeData}" alt="QR Code" style="border: 2px solid #333; padding: 10px; border-radius: 8px; margin-bottom: 20px;" />
        <br>
        <small class="text-muted">Jangan berikan akses URL ini ke orang lain.</small>
      </div>
    `);
  }

  // Menambahkan meta refresh 3 detik otomatis
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta http-equiv="refresh" content="3">
      <title>Menyiapkan Bot...</title>
    </head>
    <body style="text-align:center; font-family:sans-serif; padding-top:50px;">
      <h1>Menyiapkan server & Database...</h1>
      <p style="color:#666;">Halaman akan refresh otomatis dalam 3 detik untuk memuat QR Code.</p>
    </body>
    </html>
  `);
});

// Endpoint UptimeRobot
app.get('/ping', (req, res) => {
  res.status(200).send('PONG');
});

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});