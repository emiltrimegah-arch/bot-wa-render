const express = require('express');
const app = express();

// Port dinamis dari Render (Wajib!)
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Server WA Bot Aktif di Render!');
});

// Masukkan logika/script WhatsApp kamu di sini nanti

app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});

