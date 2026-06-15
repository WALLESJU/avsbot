const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const LIMIT = { free: 5, pro: 15 };

// ── FIX: fungsi ini harus return user ────────────────────────────
async function checkAndReset(user) {
  const today = new Date().toISOString().split('T')[0];
  const lastReset = user.last_reset
    ? new Date(user.last_reset).toISOString().split('T')[0]
    : null;
  if (lastReset !== today) {
    await pool.query(
      'UPDATE users SET usage_today = 0, last_reset = CURRENT_DATE WHERE id = $1',
      [user.id]
    );
    user.usage_today = 0;
  }
  return user; // ← FIX: ada return yang hilang di kode lama!
}

// ── LOGIN ─────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.json({ ok: false, error: 'Username dan password wajib diisi' });

    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];

    if (!user) return res.json({ ok: false, error: 'Username tidak ditemukan' });
    if (!user.is_active) return res.json({ ok: false, error: 'Akun dinonaktifkan. Hubungi admin.' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.json({ ok: false, error: 'Password salah' });

    const token = jwt.sign(
      { id: user.id, username: user.username, plan: user.plan },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ ok: true, token, username: user.username, plan: user.plan });
  } catch (e) {
    res.json({ ok: false, error: 'Server error: ' + e.message });
  }
});

// ── VERIFY TOKEN ──────────────────────────────────────────────────
router.post('/verify', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.json({ ok: false, error: 'Token tidak ada' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.id]);
    const user = result.rows[0];

    if (!user || !user.is_active)
      return res.json({ ok: false, error: 'Akun tidak valid atau dinonaktifkan' });

    res.json({ ok: true, username: user.username, plan: user.plan });
  } catch (e) {
    res.json({ ok: false, error: 'Token tidak valid atau expired' });
  }
});

// ── CHECK LIMIT ───────────────────────────────────────────────────
router.post('/check-limit', async (req, res) => {
  try {
    const { token } = req.body;
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    let result = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.id]);
    let user = result.rows[0];
    if (!user || !user.is_active)
      return res.json({ ok: false, error: 'Akun tidak valid' });

    user = await checkAndReset(user);
    const limit = LIMIT[user.plan] || LIMIT.free;
    const remaining = limit - user.usage_today;

    res.json({ ok: true, allowed: remaining > 0, plan: user.plan, usage: user.usage_today, limit, remaining: Math.max(0, remaining) });
  } catch (e) {
    res.json({ ok: false, error: 'Token tidak valid' });
  }
});

// ── USE (catat 1 analisa) ─────────────────────────────────────────
router.post('/use', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.json({ ok: false, error: 'Token tidak ada' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    let result = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.id]);
    let user = result.rows[0];

    if (!user || !user.is_active)
      return res.json({ ok: false, error: 'Akun tidak valid' });

    user = await checkAndReset(user);
    const limit = LIMIT[user.plan] || LIMIT.free;

    if (user.usage_today >= limit) {
      return res.json({
        ok: false,
        error: `Limit ${user.plan.toUpperCase()} habis (${user.usage_today}/${limit}x hari ini). ${user.plan === 'free' ? 'Upgrade ke PRO untuk 15x analisa!' : 'Coba lagi besok jam 00:00.'}`
      });
    }

    await pool.query('UPDATE users SET usage_today = usage_today + 1 WHERE id = $1', [user.id]);

    res.json({
      ok: true,
      usage: user.usage_today + 1,
      limit,
      remaining: limit - user.usage_today - 1
    });
  } catch (e) {
    res.json({ ok: false, error: 'Server error: ' + e.message });
  }
});

module.exports = router;
