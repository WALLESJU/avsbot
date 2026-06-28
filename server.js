const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// ── ENV ──────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Bismilah2026';
const JWT_SECRET = process.env.JWT_SECRET || 'avsgpt2026rahasia123';

// ── MIDDLEWARE ───────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','PATCH','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','x-admin-password','Authorization'] }));
app.use(express.json());

// ── IN-MEMORY DB ─────────────────────────────────────────────────
let users = {};

// ── PAIR BOX CACHE [v5.0] ─────────────────────────────────────────
const pairBox = {};
const BOX_TTL = parseInt(process.env.BOX_TTL_MIN || '3') * 60 * 1000;

function boxFresh(sym) {
  const b = pairBox[sym];
  return b && (Date.now() - b.ts) < BOX_TTL;
}

// ── TIMEZONE + MARKET HELPERS [v6.0] ─────────────────────────────
function getWIBStr(dateObj) {
  return dateObj.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false });
}

function getWIBISOStr(dateObj) {
  const d = new Date(dateObj.getTime() + 7 * 3600000);
  return d.toISOString().slice(0, 19) + '+07:00';
}

function isForexMarketOpen() {
  const d = new Date();
  const day = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (day === 6) return false;
  if (day === 5 && mins >= 22 * 60) return false;
  if (day === 0 && mins < 22 * 60) return false;
  return true;
}

const pairLock = {};

function resetIfNewDay(user) {
  const today = new Date().toDateString();
  if (user.last_reset !== today) {
    user.usage_today = 0;
    user.last_reset = today;
  }
}

let PLAN_LIMIT = {
  free: parseInt(process.env.LIMIT_FREE || '10'),
  pro: parseInt(process.env.LIMIT_PRO || '30')
};

// ── MIDDLEWARE ADMIN AUTH ────────────────────────────────────────
function adminAuth(req, res, next) {
  const pass = req.headers['x-admin-password'];
  if (!pass || pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Password admin salah' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────
// ROOT ENDPOINT — FIX: tambah GET / agar tidak 404
// ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'AVS Bot Server aktif 🚀',
    version: '7.2.1',
    time: new Date().toISOString(),
    endpoints: [
      'GET  /health',
      'POST /auth/login',
      'POST /auth/verify',
      'POST /auth/use',
      'POST /bot/signal',
      'POST /bot/snr-signal',
      'POST /bot/momentum-plan',
      'GET  /admin/users',
      'POST /admin/create-user',
    ]
  });
});

// ─────────────────────────────────────────────────────────────────
// PUBLIC ENDPOINTS
// ─────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ ok: true, message: 'AVS Bot Server aktif 🚀', time: new Date().toISOString(), userCount: Object.keys(users).length });
});

app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ ok: false, error: 'Username & password wajib' });
    const user = users[username];
    if (!user) return res.json({ ok: false, error: 'Username tidak ditemukan' });
    if (!user.is_active) return res.json({ ok: false, error: 'Akun dinonaktifkan. Hubungi admin.' });
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.json({ ok: false, error: 'Password salah' });
    const token = jwt.sign({ username, plan: user.plan }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token, username, plan: user.plan });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/auth/verify', (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.json({ ok: false, error: 'Token tidak ada' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = users[decoded.username];
    if (!user || !user.is_active) return res.json({ ok: false, error: 'Akun tidak aktif' });
    resetIfNewDay(user);
    const limit = PLAN_LIMIT[user.plan] || 5;
    res.json({ ok: true, username: decoded.username, plan: user.plan, usage: user.usage_today, limit });
  } catch (e) {
    res.json({ ok: false, error: 'Token tidak valid atau expired' });
  }
});

app.post('/auth/use', (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.json({ ok: false, error: 'Token tidak ada' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = users[decoded.username];
    if (!user || !user.is_active) return res.json({ ok: false, error: 'Akun tidak aktif' });
    resetIfNewDay(user);
    const limit = PLAN_LIMIT[user.plan] || 5;
    if (user.usage_today >= limit) {
      return res.json({ ok: false, error: `Limit harian habis! (${user.usage_today}/${limit}). Reset besok jam 00:00.`, usage: user.usage_today, limit });
    }
    user.usage_today++;
    res.json({ ok: true, usage: user.usage_today, limit, remaining: limit - user.usage_today });
  } catch (e) {
    res.json({ ok: false, error: 'Token tidak valid' });
  }
});

// ─────────────────────────────────────────────────────────────────
// BOT SIGNAL — GPT + TwelveData
// ─────────────────────────────────────────────────────────────────
const OPENAI_URL = process.env.OPENAI_URL || 'https://lite.koboillm.com/v1/chat/completions';
const OPENAI_KEY = process.env.OPENAI_KEY || 'sk-bbcQ_tgzKrXpMRTPXrxHvg';
const TWELVE_KEY = process.env.TWELVE_KEY || 'a99e7352827544e28063d1227ef76a4a';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'openai/gpt-4o-mini';

app.post('/bot/signal', async (req, res) => {
  try {
    const { token, expirymin, symbol } = req.body;
    if (!token) return res.json({ ok: false, error: 'Token tidak ada' });

    let decoded;
    try { decoded = jwt.verify(token, JWT_SECRET); }
    catch(e) { return res.json({ ok: false, error: 'Token tidak valid atau expired' }); }

    const user = users[decoded.username];
    if (!user || !user.is_active) return res.json({ ok: false, error: 'Akun tidak aktif' });

    resetIfNewDay(user);
    const limit = PLAN_LIMIT[user.plan] || 5;

    if (user.usage_today >= limit) {
      return res.json({ ok: false, error: `Limit harian habis! (${user.usage_today}/${limit}). Reset besok jam 00:00.`, usage: user.usage_today, limit });
    }

    const sym = symbol || 'EUR/USD';
    const EXPMIN = expirymin || 5;

    if (!isForexMarketOpen()) {
      return res.json({ ok: false, status: 'SKIP_MARKET_CLOSED', error: 'MARKET CLOSED — Forex tutup akhir pekan' });
    }

    if (boxFresh(sym)) {
      const cached = pairBox[sym];
      const ageS = Math.round((Date.now() - cached.ts) / 1000);
      const sig = cached.data.signal;
      if (sig === 'BUY' || sig === 'SELL') user.usage_today++;
      return res.json({
        ok: true, signal: cached.data, candles_1m: cached.candles_1m,
        source: 'cache', box_age_sec: ageS,
        usage: user.usage_today, limit, remaining: limit - user.usage_today
      });
    }

    if (!OPENAI_KEY || !TWELVE_KEY) {
      return res.json({ ok: false, error: 'Server belum dikonfigurasi (OPENAI_KEY / TWELVE_KEY kosong)' });
    }

    if (pairLock[sym]) {
      return res.json({ ok: false, status: 'SKIP_GPT_IN_PROGRESS', error: 'Analisis sedang berjalan untuk pair ini, coba lagi sebentar' });
    }

    pairLock[sym] = true;

    const https = require('https');

    function fetchCandle(interval, size) {
      return new Promise((resolve, reject) => {
        const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${interval}&outputsize=${size}&apikey=${TWELVE_KEY}`;
        https.get(url, (r) => {
          let data = '';
          r.on('data', d => data += d);
          r.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.status === 'error') return reject(new Error('TwelveData: ' + json.message));
              const candles = json.values.map(v => ({
                o: parseFloat(v.open), h: parseFloat(v.high),
                l: parseFloat(v.low), c: parseFloat(v.close)
              })).reverse();
              resolve(candles);
            } catch(e) { reject(e); }
          });
        }).on('error', reject);
      });
    }

    const [c1m, c5m, c15m] = await Promise.all([
      fetchCandle('1min', 30),
      fetchCandle('5min', 30),
      fetchCandle('15min', 30),
    ]);

    function fmtC(candles, label) {
      let o = label + '\n';
      candles.slice(-10).forEach((c, i) => {
        o += `${i+1} O:${c.o.toFixed(5)} H:${c.h.toFixed(5)} L:${c.l.toFixed(5)} C:${c.c.toFixed(5)}\n`;
      });
      return o;
    }

    const now = new Date();
    const target = new Date(now.getTime() + 2 * 60 * 1000);
    const expiryStr = getWIBStr(target);
    const nowWIBStr = getWIBStr(now);
    const data = fmtC(c15m, 'TF 15m') + fmtC(c5m, 'TF 5m') + fmtC(c1m, 'TF 1m');

    const prompt = `Kamu AI analyst binary option ${sym}. Waktu: ${nowWIBStr} WIB.
Strategi: HANYA membaca candle MERAH (CO = buyer). Abaikan konsep lain.

DEFINISI SUPPORT & RESISTANCE (dari BODY candle saja, abaikan sumbu/wick):
- SUPPORT = level di mana close candle MERAH bertemu open candle HIJAU berikutnya
- RESISTANCE = level di mana close candle HIJAU bertemu open candle MERAH berikutnya

ATURAN INFORMASI candle (baca sumbu, bukan warna):
- Candle HIJAU (C>O): sumbu atas [H-C] LEBIH PANJANG dari sumbu bawah [O-L] → informasi NAIK
- Candle HIJAU (C>O): sumbu bawah [O-L] LEBIH PANJANG dari sumbu atas [H-C] → informasi TURUN
- Candle MERAH (C<O): sumbu atas [H-O] LEBIH PANJANG → informasi TURUN
- Candle MERAH (C<O): sumbu bawah [C-L] LEBIH PANJANG → informasi NAIK

ATURAN KONFIRMASI:
- Setelah candle informasi, TUNGGU candle konfirmasi (candle berikutnya)
- Konfirmasi NAIK = candle hijau setelah informasi naik
- Konfirmasi TURUN = candle merah setelah informasi turun
- Jika belum ada konfirmasi = HOLD

Data candle:
${data}

Waktu expiry: ${expiryStr} WIB

Balas HANYA JSON valid (tanpa markdown):
{"signal":"BUY/SELL/HOLD","confidence":0-100,"reason":"alasan singkat","expirytarget":"${expiryStr}"}`;

    const gptResult = await new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 320,
        temperature: 0.3
      });
      const urlObj = new URL(OPENAI_URL);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_KEY}`,
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 15000
      };
      const reqHttp = https.request(options, (r) => {
        let d = '';
        r.on('data', chunk => d += chunk);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      reqHttp.on('error', reject);
      reqHttp.on('timeout', () => reject(new Error('GPT timeout')));
      reqHttp.write(body);
      reqHttp.end();
    });

    const raw = gptResult.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
    const gpt = JSON.parse(raw);
    gpt.expirytarget = expiryStr;

    const candles1mBox = c1m.slice(-10);
    pairBox[sym] = { ts: Date.now(), data: gpt, candles_1m: candles1mBox };
    console.log(`[PairBox] ${sym} rebuilt — signal:${gpt.signal} conf:${gpt.confidence}% expiry:${expiryStr} WIB`);

    const finalSig = gpt.signal;
    if (finalSig === 'BUY' || finalSig === 'SELL') {
      user.usage_today++;
      console.log(`[Usage] ${decoded.username} → ${user.usage_today}/${limit} (GPT signal=${finalSig})`);
    } else {
      console.log(`[Usage] ${decoded.username} → unchanged (HOLD_NO_SIGNAL)`);
    }

    pairLock[sym] = false;
    res.json({
      ok: true, signal: gpt, candles_1m: candles1mBox, source: 'fresh',
      usage: user.usage_today, limit, remaining: limit - user.usage_today
    });
  } catch (e) {
    pairLock[req.body.symbol || 'EUR/USD'] = false;
    console.error('/bot/signal error:', e.message);
    res.json({ ok: false, status: 'GPT_FAILED', error: 'Gagal ambil sinyal: ' + e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// SNR SIGNAL — rule-based (tanpa GPT)
// ─────────────────────────────────────────────────────────────────
const snrBox = {};
const SNR_TTL = 60 * 1000;
function snrBoxFresh(sym) {
  const b = snrBox[sym];
  return b && (Date.now() - b.ts) < SNR_TTL;
}
const snrLock = {};

function analyzeSNR(c1m, c5m) {
  const isGreen = c => c.c > c.o;
  const isRed = c => c.c < c.o;
  const upperW = c => c.h - Math.max(c.o, c.c);
  const lowerW = c => Math.min(c.o, c.c) - c.l;

  const last1m = c1m.slice(-10);
  const last5m = c5m.slice(-5);
  const cur = last1m[last1m.length - 1];
  const prev = last1m[last1m.length - 2];

  let support = null, resistance = null;
  for (let i = 0; i < last1m.length - 1; i++) {
    const a = last1m[i], b = last1m[i + 1];
    if (isRed(a) && isGreen(b)) {
      const lvl = (a.c + b.o) / 2;
      if (support === null || Math.abs(lvl - cur.c) < Math.abs(support - cur.c)) support = lvl;
    }
    if (isGreen(a) && isRed(b)) {
      const lvl = (a.c + b.o) / 2;
      if (resistance === null || Math.abs(lvl - cur.c) < Math.abs(resistance - cur.c)) resistance = lvl;
    }
  }

  let info = 'TIDAK_JELAS';
  const pU = upperW(prev), pL = lowerW(prev);
  if (Math.abs(pU - pL) > 0.00002) {
    if (isGreen(prev)) info = pU > pL ? 'NAIK' : 'TURUN';
    else info = pU < pL ? 'NAIK' : 'TURUN';
  }

  const confirmed = (info === 'NAIK' && isGreen(cur)) || (info === 'TURUN' && isRed(cur));

  const g5 = last5m.filter(isGreen).length;
  const r5 = last5m.filter(isRed).length;
  const trend5m = g5 > r5 ? 'UP' : (r5 > g5 ? 'DOWN' : 'SIDEWAYS');

  const last3 = last1m.slice(-3);
  const g1 = last3.filter(isGreen).length;
  const trend1m = g1 >= 2 ? 'UP' : (g1 === 0 ? 'DOWN' : 'SIDEWAYS');

  const curPrice = cur.c;

  let signal = 'HOLD', reason = '';
  if (info !== 'TIDAK_JELAS' && confirmed) {
    if (info === 'NAIK' && (trend1m === 'UP' || trend5m === 'UP')) {
      if (!resistance || curPrice < resistance * 1.00005) {
        signal = 'BUY';
        reason = 'Info naik, konfirmasi hijau, trend mendukung naik, menuju resistance';
      } else { reason = 'Info naik tapi harga sudah di resistance — HOLD'; }
    } else if (info === 'TURUN' && (trend1m === 'DOWN' || trend5m === 'DOWN')) {
      if (!support || curPrice > support * 0.99995) {
        signal = 'SELL';
        reason = 'Info turun, konfirmasi merah, trend mendukung turun, menuju support';
      } else { reason = 'Info turun tapi harga sudah di support — HOLD'; }
    } else {
      reason = 'Info + konfirmasi ada tapi trend berlawanan — HOLD';
    }
  } else if (info === 'TIDAK_JELAS') {
    reason = 'Informasi candle tidak jelas (sumbu hampir sama)';
  } else {
    reason = 'Konfirmasi belum ada (candle berlawanan dengan informasi)';
  }

  return {
    signal, support, resistance,
    informasi: info, konfirmasi: confirmed,
    trend1m, trend5m,
    reason, currentPrice: curPrice
  };
}

app.post('/bot/snr-signal', async (req, res) => {
  try {
    const { token, symbol } = req.body;
    if (!token) return res.json({ ok: false, error: 'Token tidak ada' });

    let decoded;
    try { decoded = jwt.verify(token, JWT_SECRET); }
    catch(e) { return res.json({ ok: false, error: 'Token tidak valid atau expired' }); }

    const user = users[decoded.username];
    if (!user || !user.is_active) return res.json({ ok: false, error: 'Akun tidak aktif' });

    if (!isForexMarketOpen()) {
      return res.json({ ok: false, status: 'SKIP_MARKET_CLOSED', error: 'MARKET CLOSED — Forex tutup akhir pekan' });
    }

    const sym = symbol || 'EUR/USD';

    if (snrBoxFresh(sym)) {
      const cached = snrBox[sym];
      const ageS = Math.round((Date.now() - cached.ts) / 1000);
      return res.json({ ok: true, signal: cached.data, candles_1m: cached.candles_1m, source: 'cache', box_age_sec: ageS });
    }

    if (snrLock[sym]) {
      return res.json({ ok: false, status: 'SKIP_IN_PROGRESS', error: 'SNR analisa sedang berjalan, coba lagi sebentar' });
    }

    snrLock[sym] = true;

    if (!TWELVE_KEY) {
      snrLock[sym] = false;
      return res.json({ ok: false, error: 'Server belum dikonfigurasi (TWELVE_KEY kosong)' });
    }

    const https = require('https');
    function fetchCandle(interval, size) {
      return new Promise((resolve, reject) => {
        const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${interval}&outputsize=${size}&apikey=${TWELVE_KEY}`;
        https.get(url, (r) => {
          let data = '';
          r.on('data', d => data += d);
          r.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.status === 'error') return reject(new Error('TwelveData: ' + json.message));
              const candles = json.values.map(v => ({
                o: parseFloat(v.open), h: parseFloat(v.high),
                l: parseFloat(v.low), c: parseFloat(v.close)
              })).reverse();
              resolve(candles);
            } catch(e) { reject(e); }
          });
        }).on('error', reject);
      });
    }

    const [c1m, c5m] = await Promise.all([fetchCandle('1min', 15), fetchCandle('5min', 10)]);

    const result = analyzeSNR(c1m, c5m);

    const now = new Date();
    const expTgt = new Date(now.getTime() + 2 * 60 * 1000);
    result.expiry = getWIBStr(expTgt);

    const candles1mBox = c1m.slice(-5);
    snrBox[sym] = { ts: Date.now(), data: result, candles_1m: candles1mBox };
    console.log(`[SNR] ${sym} rebuilt — signal:${result.signal} info:${result.informasi} conf:${result.konfirmasi}`);

    snrLock[sym] = false;
    res.json({ ok: true, signal: result, candles_1m: candles1mBox, source: 'fresh' });

  } catch(e) {
    const sym = req.body.symbol || 'EUR/USD';
    snrLock[sym] = false;
    console.error('/bot/snr-signal error:', e.message);
    res.json({ ok: false, error: 'Gagal analisa SNR: ' + e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// MOMENTUM PLAN
// ─────────────────────────────────────────────────────────────────
const momentumPlans = {};
const momentumLock = {};

app.post('/bot/momentum-plan', async (req, res) => {
  try {
    const { token, pair, trend, interval_minutes, duration_hours } = req.body;
    if (!token) return res.json({ ok: false, error: 'Token tidak ada' });

    let decoded;
    try { decoded = jwt.verify(token, JWT_SECRET); }
    catch(e) { return res.json({ ok: false, error: 'Token tidak valid atau expired' }); }

    const user = users[decoded.username];
    if (!user || !user.is_active) return res.json({ ok: false, error: 'Akun tidak aktif' });

    resetIfNewDay(user);
    const limit = PLAN_LIMIT[user.plan] || 5;
    if (user.usage_today >= limit) {
      return res.json({ ok: false, error: `Limit harian habis! (${user.usage_today}/${limit}).`, usage: user.usage_today, limit });
    }

    if (!isForexMarketOpen()) {
      console.log(`[Momentum] ${decoded.username} generate plan saat market closed — allowed`);
    }

    const sym = pair || 'EUR/USD';
    const trendDir = (trend === 'UP' || trend === 'DOWN') ? trend : 'UP';
    const interval = parseInt(interval_minutes) || 5;
    const durationH = parseFloat(duration_hours) || 5;
    const planKey = sym + '|' + trendDir;

    if (momentumLock[planKey]) {
      return res.json({ ok: false, status: 'SKIP_GPT_IN_PROGRESS', error: 'Momentum plan sedang dibuat untuk pair ini' });
    }

    momentumLock[planKey] = true;

    const https = require('https');
    function fetchCandle(iv, size) {
      return new Promise((resolve, reject) => {
        const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${iv}&outputsize=${size}&apikey=${TWELVE_KEY}`;
        https.get(url, (r) => {
          let data = '';
          r.on('data', d => data += d);
          r.on('end', () => {
            try {
              const j = JSON.parse(data);
              if (j.status === 'error') return reject(new Error('TwelveData: ' + j.message));
              resolve(j.values.map(v => ({ o:parseFloat(v.open),h:parseFloat(v.high),l:parseFloat(v.low),c:parseFloat(v.close) })).reverse());
            } catch(e) { reject(e); }
          });
        }).on('error', reject);
      });
    }

    const [c1m, c5m, c15m] = await Promise.all([
      fetchCandle('1min',15), fetchCandle('5min',15), fetchCandle('15min',15)
    ]);

    const now = new Date();
    const msPerInterval = interval * 60000;
    const startMs_raw = now.getTime() + interval * 60000;
    const startMs = Math.ceil(startMs_raw / msPerInterval) * msPerInterval;
    const endMs = now.getTime() + durationH * 3600000;
    const totalSig = Math.max(1, Math.floor((endMs - startMs) / msPerInterval) + 1);
    const sigTimes = [];
    for (let i = 0; i < totalSig; i++) {
      sigTimes.push(getWIBISOStr(new Date(startMs + i * msPerInterval)));
    }

    const nowWIBStr = getWIBStr(now);
    const snapshotRow = (candles, label) => {
      const last = candles[candles.length - 1];
      return `${label} last: O:${last.o.toFixed(5)} H:${last.h.toFixed(5)} L:${last.l.toFixed(5)} C:${last.c.toFixed(5)}`;
    };
    const snapshot = [snapshotRow(c15m,'15m'), snapshotRow(c5m,'5m'), snapshotRow(c1m,'1m')].join(' | ');

    const prompt = `Kamu AI scalper binary option ${sym}.
Waktu WIB: ${nowWIBStr} | Trend ditetapkan user: ${trendDir === 'UP' ? 'NAIK (BULLISH)' : 'TURUN (BEARISH)'}
Snapshot market: ${snapshot}

Buat signal plan ${durationH} jam dengan interval ${interval} menit.
Karena trend ${trendDir}, mayoritas signal harus ${trendDir === 'UP' ? 'BUY' : 'SELL'}. Boleh HOLD jika area kurang ideal.
Timestamp WIB yang harus diisi (TEPAT ${totalSig} signal, jangan kurang jangan lebih): ${sigTimes.join(', ')}

ATURAN OUTPUT (WAJIB):
- Balas HANYA dengan JSON valid, tidak ada teks lain.
- JSON harus SATU BARIS saja.
- DILARANG memakai markdown, code fence, komentar.
- Setiap signal HANYA boleh berisi field "time" dan "action".
- Array "signals" harus berisi TEPAT ${totalSig} item.

Format JSON:
{"strategy":"MOMENTUM","pair":"${sym}","trend":"${trendDir}","generated_at":"${getWIBISOStr(now)}","valid_from":"${sigTimes[0]}","valid_until":"${sigTimes[sigTimes.length-1]}","timezone":"Asia/Jakarta","interval_minutes":${interval},"signals":[{"time":"${sigTimes[0]}","action":"BUY"}]}`;

    const gptResult = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 2600, temperature: 0.3 });
      const urlObj = new URL(OPENAI_URL);
      const opts = {
        hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${OPENAI_KEY}`, 'Content-Length': Buffer.byteLength(body) },
        timeout: 45000
      };
      const req2 = https.request(opts, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(); reject(new Error('GPT momentum timeout')); });
      req2.write(body); req2.end();
    });

    let raw = gptResult.choices[0].message.content.trim().replace(/\`\`\`json|\`\`\`/g, '').trim();
    const _firstBrace = raw.indexOf('{');
    const _lastBrace = raw.lastIndexOf('}');
    if (_firstBrace !== -1 && _lastBrace !== -1 && _lastBrace > _firstBrace) {
      raw = raw.substring(_firstBrace, _lastBrace + 1);
    }

    let plan;
    try {
      plan = JSON.parse(raw);
    } catch (parseErr) {
      momentumLock[planKey] = false;
      return res.json({ ok: false, status: 'GPT_FAILED', error: 'Output GPT bukan JSON valid: ' + parseErr.message });
    }

    if (!plan || plan.strategy !== 'MOMENTUM' || !Array.isArray(plan.signals) || plan.signals.length < 1) {
      momentumLock[planKey] = false;
      return res.json({ ok: false, status: 'GPT_FAILED', error: 'Output GPT tidak valid atau tidak sesuai format' });
    }

    const validActions = ['BUY','SELL','HOLD'];
    for (const sig of plan.signals) {
      if (!sig.time || !validActions.includes(sig.action)) {
        momentumLock[planKey] = false;
        return res.json({ ok: false, status: 'GPT_FAILED', error: 'Signal dalam plan tidak valid: ' + JSON.stringify(sig) });
      }
    }

    momentumPlans[planKey] = { plan, ts: Date.now() };

    const hasActionable = plan.signals.some(s => s.action === 'BUY' || s.action === 'SELL');
    if (hasActionable) {
      user.usage_today++;
      console.log(`[Momentum] ${decoded.username} plan generated ${sym} trend=${trendDir} → usage ${user.usage_today}/${limit}`);
    } else {
      console.log(`[Momentum] ${decoded.username} plan all-HOLD, usage tidak naik`);
    }

    momentumLock[planKey] = false;
    res.json({ ok: true, plan, usage: user.usage_today, limit, remaining: limit - user.usage_today });
  } catch (e) {
    const key = (req.body.pair || 'EUR/USD') + '|' + (req.body.trend || 'UP');
    momentumLock[key] = false;
    console.error('/bot/momentum-plan error:', e.message);
    res.json({ ok: false, status: 'GPT_FAILED', error: 'Gagal generate plan: ' + e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// ADMIN ENDPOINTS
// ─────────────────────────────────────────────────────────────────

app.get('/admin/users', adminAuth, (req, res) => {
  const list = Object.entries(users).map(([username, u]) => {
    resetIfNewDay(u);
    return { username, plan: u.plan, is_active: u.is_active, usage_today: u.usage_today, limit: PLAN_LIMIT[u.plan] || 5, created_at: u.created_at };
  });
  res.json({ ok: true, users: list });
});

app.post('/admin/create-user', adminAuth, async (req, res) => {
  try {
    const { username, password, plan = 'free' } = req.body;
    if (!username || !password) return res.json({ ok: false, error: 'Username & password wajib' });
    if (users[username]) return res.json({ ok: false, error: 'Username sudah ada' });
    if (password.length < 6) return res.json({ ok: false, error: 'Password minimal 6 karakter' });
    const passwordHash = await bcrypt.hash(password, 10);
    users[username] = { passwordHash, plan: ['free','pro'].includes(plan) ? plan : 'free', is_active: true, usage_today: 0, last_reset: new Date().toDateString(), created_at: new Date().toISOString() };
    res.json({ ok: true, message: `User "${username}" [${plan.toUpperCase()}] berhasil dibuat!` });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.patch('/admin/set-plan', adminAuth, (req, res) => {
  const { username, plan } = req.body;
  if (!users[username]) return res.json({ ok: false, error: 'User tidak ditemukan' });
  if (!['free','pro'].includes(plan)) return res.json({ ok: false, error: 'Plan tidak valid' });
  users[username].plan = plan;
  res.json({ ok: true, message: `Plan ${username} diubah ke ${plan.toUpperCase()}` });
});

app.patch('/admin/set-active', adminAuth, (req, res) => {
  const { username, is_active } = req.body;
  if (!users[username]) return res.json({ ok: false, error: 'User tidak ditemukan' });
  users[username].is_active = !!is_active;
  res.json({ ok: true, message: `User ${username} ${is_active ? 'diaktifkan' : 'dinonaktifkan'}` });
});

app.patch('/admin/reset-password', adminAuth, async (req, res) => {
  try {
    const { username, new_password } = req.body;
    if (!users[username]) return res.json({ ok: false, error: 'User tidak ditemukan' });
    if (!new_password || new_password.length < 6) return res.json({ ok: false, error: 'Password minimal 6 karakter' });
    users[username].passwordHash = await bcrypt.hash(new_password, 10);
    res.json({ ok: true, message: `Password ${username} berhasil direset` });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.patch('/admin/reset-usage', adminAuth, (req, res) => {
  const { username } = req.body;
  if (!users[username]) return res.json({ ok: false, error: 'User tidak ditemukan' });
  users[username].usage_today = 0;
  users[username].last_reset = new Date().toDateString();
  res.json({ ok: true, message: `Usage ${username} direset ke 0` });
});

app.delete('/admin/delete-user', adminAuth, (req, res) => {
  const { username } = req.body;
  if (!users[username]) return res.json({ ok: false, error: 'User tidak ditemukan' });
  delete users[username];
  res.json({ ok: true, message: `User ${username} dihapus` });
});

app.patch('/admin/set-plan-limit', adminAuth, (req, res) => {
  const { free, pro } = req.body;
  if (free !== undefined) {
    const n = parseInt(free);
    if (isNaN(n) || n < 1) return res.json({ ok: false, error: 'Nilai free tidak valid' });
    PLAN_LIMIT.free = n;
  }
  if (pro !== undefined) {
    const n = parseInt(pro);
    if (isNaN(n) || n < 1) return res.json({ ok: false, error: 'Nilai pro tidak valid' });
    PLAN_LIMIT.pro = n;
  }
  res.json({ ok: true, message: 'Limit berhasil diupdate', plan_limit: PLAN_LIMIT });
});

app.get('/admin/box-status', adminAuth, (req, res) => {
  const now = Date.now();
  const ttlSec = BOX_TTL / 1000;
  const boxes = Object.entries(pairBox).map(([sym, b]) => ({
    symbol: sym,
    signal: b.data.signal,
    confidence: b.data.confidence,
    age_sec: Math.round((now - b.ts) / 1000),
    ttl_sec: ttlSec,
    fresh: boxFresh(sym),
    expires_in: Math.max(0, Math.round((b.ts + BOX_TTL - now) / 1000)) + 's'
  }));
  res.json({ ok: true, box_ttl_sec: ttlSec, plan_limit: PLAN_LIMIT, boxes });
});

// ── 404 HANDLER ──────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Endpoint "${req.method} ${req.path}" tidak ditemukan` });
});

app.listen(PORT, () => {
  console.log(`✅ AVS Bot Server v7.2.1 jalan di port ${PORT}`);
  console.log(`🔑 Admin password: ${ADMIN_PASSWORD}`);
  console.log(`📊 Plan limit — FREE: ${PLAN_LIMIT.free} | PRO: ${PLAN_LIMIT.pro}`);
  console.log(`⏱ Box TTL: ${BOX_TTL / 1000}s`);
  console.log(`🌐 Root endpoint GET / tersedia`);
});
