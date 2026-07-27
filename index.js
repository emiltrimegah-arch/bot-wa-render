require('dotenv').config();

const express = require('express');
const {
  default: makeWASocket,
  initAuthCreds,
  BufferJSON,
  proto,
  DisconnectReason
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

// ==========================================
// MIDDLEWARE: PROTEKSI HALAMAN (BASIC AUTH)
// ==========================================
const basicAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  // Default: admin / rahasia123 jika environment belum di-set
  const ADMIN_USER = process.env.ADMIN_USER || 'admin';
  const ADMIN_PASS = process.env.ADMIN_PASS || 'rahasia123';

  if (authHeader) {
    const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    const user = auth[0];
    const pass = auth[1];

    if (user === ADMIN_USER && pass === ADMIN_PASS) {
      return next(); // Lanjut jika password benar
    }
  }

  // Jika salah/belum login, paksa browser munculkan pop-up login
  res.setHeader('WWW-Authenticate', 'Basic realm="Akses Terproteksi"');
  return res.status(401).send('<h1>Akses Ditolak! Username atau Password salah.</h1>');
};

// ==========================================
// INISIALISASI MONGODB
// ==========================================
async function connectToMongo() {
  const MONGO_URI = process.env.MONGO_URI;
  if (!MONGO_URI) {
    console.error("⚠️ MONGO_URI belum diatur di Environment Variables!");
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
// FUNGSI PENYIMPANAN SESI WA (MONGODB)
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

  // Migrasi MY_WA jika database masih kosong
  if (!creds) {
    if (process.env.MY_WA) {
      try {
        creds = JSON.parse(process.env.MY_WA, BufferJSON.reviver);
        console.log('✅ Migrasi sesi dari MY_WA ke MongoDB berhasil!');
        await writeData(creds, 'creds');
      } catch (error) {
        creds = initAuthCreds();
      }
    } else {
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

// ==========================================
// KONEKSI BOT WHATSAPP
// ==========================================
async function connectToWhatsApp() {
  const isMongoReady = await connectToMongo();
  if (!isMongoReady) return;

  const { state, saveCreds } = await useMongoAuthState();

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
      console.log('WhatsApp Bot Berhasil Terhubung (Sesi MongoDB Live)!');
      isConnected = true;
      qrCodeData = '';
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
// ENDPOINT 1: KIRIM OTP (Terbuka untuk API Backend-mu)
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
// ENDPOINT 2: API DATA LOGS (Dilindungi Basic Auth)
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
// ENDPOINT 3: HALAMAN UI HISTORY (Dilindungi Basic Auth)
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
            // credentials: 'same-origin' memastikan login Basic Auth terbawa ke API
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

        fetchLogs(1); // Load pertama kali
      </script>
    </body>
    </html>
  `;
  res.send(html);
});

// ==========================================
// ENDPOINT 4: HALAMAN UTAMA / QR CODE (Dilindungi Basic Auth)
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
  res.send('<h1 style="text-align:center; padding-top:50px; font-family:sans-serif;">Menyiapkan server & Database... Refresh dalam 5 detik.</h1>');
});

// Endpoint khusus UptimeRobot (Tanpa Login / Publik)
app.get('/ping', (req, res) => {
  res.status(200).send('PONG');
});

// ==========================================
// JALANKAN SERVER
// ==========================================
app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});