const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

// ── Middleware admin auth ─────────────────────────────────────────
function adminAuth(req, res, next) {
  const pass = req.headers['x-admin-password'];
  if (!pass || pass !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ ok: false, error: 'Password admin salah' });
  next();
}

// ── GET ALL USERS ─────────────────────────────────────────────────
router.get('/users', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, plan, usage_today, last_reset, is_active, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ ok: true, users: result.rows });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── BUAT USER ─────────────────────────────────────────────────────
router.post('/create-user', adminAuth, async (req, res) => {
  try {
    const { username, password, plan = 'free' } = req.body;
    if (!username || !password)
      return res.json({ ok: false, error: 'Username dan password wajib' });
    if (password.length < 6)
      return res.json({ ok: false, error: 'Password minimal 6 karakter' });

    const hashed = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, password, plan) VALUES ($1, $2, $3)',
      [username, hashed, plan]
    );
    res.json({ ok: true, message: `User "${username}" [${plan.toUpperCase()}] berhasil dibuat!` });
  } catch (e) {
    if (e.code === '23505') return res.json({ ok: false, error: 'Username sudah ada' });
    res.json({ ok: false, error: e.message });
  }
});

// ── SET PLAN ──────────────────────────────────────────────────────
router.patch('/set-plan', adminAuth, async (req, res) => {
  try {
    const { username, plan } = req.body;
    if (!['free', 'pro'].includes(plan))
      return res.json({ ok: false, error: 'Plan harus free atau pro' });
    await pool.query('UPDATE users SET plan = $1 WHERE username = $2', [plan, username]);
    res.json({ ok: true, message: `${username} diubah ke ${plan.toUpperCase()}` });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── SET ACTIVE ────────────────────────────────────────────────────
router.patch('/set-active', adminAuth, async (req, res) => {
  try {
    const { username, is_active } = req.body;
    await pool.query('UPDATE users SET is_active = $1 WHERE username = $2', [is_active, username]);
    res.json({ ok: true, message: `${username} ${is_active ? 'diaktifkan' : 'dinonaktifkan'}` });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── RESET PASSWORD ────────────────────────────────────────────────
router.patch('/reset-password', adminAuth, async (req, res) => {
  try {
    const { username, new_password } = req.body;
    if (!new_password || new_password.length < 6)
      return res.json({ ok: false, error: 'Password minimal 6 karakter' });
    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password = $1 WHERE username = $2', [hashed, username]);
    res.json({ ok: true, message: `Password ${username} berhasil direset` });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── RESET USAGE ───────────────────────────────────────────────────
router.patch('/reset-usage', adminAuth, async (req, res) => {
  try {
    const { username } = req.body;
    await pool.query(
      'UPDATE users SET usage_today = 0, last_reset = CURRENT_DATE WHERE username = $1',
      [username]
    );
    res.json({ ok: true, message: `Usage ${username} direset ke 0` });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── HAPUS USER ────────────────────────────────────────────────────
router.delete('/delete-user', adminAuth, async (req, res) => {
  try {
    const { username } = req.body;
    await pool.query('DELETE FROM users WHERE username = $1', [username]);
    res.json({ ok: true, message: `User ${username} dihapus` });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
