require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDB } = require('./db');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS — izinkan semua origin (wajib agar dashboard bisa akses) ──
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-password', 'Authorization']
}));
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────
app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);

// ── Health check (GET / dan GET /health) ──────────────────────────
app.get('/', (req, res) => {
  res.json({ ok: true, status: 'AVS Bot Server aktif 🚀', version: '2.0.0' });
});
app.get('/health', (req, res) => {
  res.json({ ok: true, message: 'AVS Bot Server aktif 🚀', version: '2.0.0', time: new Date().toISOString() });
});

// ── Start ─────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server jalan di port ${PORT}`);
  });
}).catch(err => {
  console.error('❌ Gagal init DB:', err);
  process.exit(1);
});
