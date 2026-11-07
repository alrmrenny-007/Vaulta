'use strict';
/* Vaulta server core: config, errors, validation, security, database, rate limits.
   Money is always integer cents. Nothing here trusts the browser. */
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

/* ============================== config ============================== */
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const C = {
  ROUTING: '999000014',            // fictional, passes the ABA checksum
  DAILY_LIMIT: 500000,             // $5,000 rolling 24h (transfers + bill pay)
  MAX_DEPOSIT: 500000,             // $5,000 per demo deposit
  DEPOSIT_DAY_CAP: 2500000,        // $25,000 rolling 24h demo deposits
  MAX_CARDS: 3,
  MAX_BENEFICIARIES: 12,
  SESSION_MS: 7 * DAY,
  CARD_PREFIX: '9999',
  TIERS: {
    virtual:  { label: 'Virtual',  fee: 500,  physical: false },
    standard: { label: 'Standard', fee: 1500, physical: true },
    platinum: { label: 'Premier',  fee: 3500, physical: true }
  },
  BILL_CATEGORIES: ['Electric', 'Gas & Water', 'Internet & Cable', 'Mobile Phone', 'Credit Card', 'Rent & Other'],
  STAGES: ['requested', 'processing', 'shipped', 'delivered', 'active'],
  THEMES: ['emerald', 'ocean', 'sunset', 'violet'],
  STATES: 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ')
};
const demoMode = () => String(process.env.DEMO_MODE || 'on').toLowerCase() !== 'off';
const fmt = cents => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ============================== errors / http ============================== */
class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
class ConfigError extends Error {}
const fail = (status, message, code) => { throw new HttpError(status, message, code); };
// A "soft" failure result (returned, not thrown) so the surrounding transaction still commits.
const err = (status, error, code) => ({ status, body: { ok: false, error, code } });

async function readJson(req, limit = 100 * 1024) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') {
    try { const o = JSON.parse(req.body || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : fail(400, 'Invalid JSON body.'); }
    catch (e) { if (e instanceof HttpError) throw e; fail(400, 'Invalid JSON body.'); }
  }
  // Oversized bodies are read (not stored) up to a hard cap, so the 413 reply reaches the client reliably.
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size <= limit) chunks.push(c);
    if (size > 5 * 1024 * 1024) break;
  }
  if (size > limit) fail(413, 'Request too large.');
  if (!size) return {};
  try {
    const o = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : fail(400, 'Invalid JSON body.');
  } catch (e) { if (e instanceof HttpError) throw e; fail(400, 'Invalid JSON body.'); }
}
function send(res, status, payload, headers) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const k in (headers || {})) res.setHeader(k, headers[k]);
  res.end(body);
}
const clientIp = req => String((req.headers['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || 'unknown').trim();
const isHttps = req => String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https' || !!(req.socket && req.socket.encrypted);
const parseCookies = h => Object.fromEntries(String(h || '').split(';').map(s => s.trim()).filter(Boolean).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
const setCookie = (name, value, maxAgeSec, secure) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;

/* ============================== validation ============================== */
const str = x => (typeof x === 'string' ? x.trim().replace(/[\u0000-\u001f\u007f]/g, '') : '');
const v = {
  text(x, label, min, max) {
    const s = x === undefined || x === null ? '' : (typeof x === 'string' ? str(x) : fail(400, `${label} is invalid.`));
    if (s.length < min) fail(400, `Enter ${label}.`);
    if (s.length > max) fail(400, `${label[0].toUpperCase() + label.slice(1)} is too long.`);
    return s;
  },
  name(x) { const s = str(x); if (s.length < 2 || s.length > 80) fail(400, 'Please enter your full name.'); return s; },
  email(x) { const s = str(x).toLowerCase(); if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) fail(400, 'Enter a valid email address.'); return s; },
  phone(x) {
    const s = str(x), d = s.replace(/\D/g, '');
    if (!/^[\d\s()+.\-]{10,24}$/.test(s) || d.length < 10 || d.length > 15) fail(400, 'Enter a valid phone number.');
    return s;
  },
  password(x) {
    if (typeof x !== 'string' || x.length < 8) fail(400, 'Password must be at least 8 characters.');
    if (x.length > 128) fail(400, 'Password is too long (max 128 characters).');
    return x;
  },
  acct(x, label) {
    const s = typeof x === 'string' || typeof x === 'number' ? String(x).trim() : '';
    if (!/^\d{8,12}$/.test(s)) fail(400, `${label || 'Account number'} must be 8 to 12 digits.`);
    return s;
  },
  pin(x) { if (typeof x !== 'string' || !/^\d{4}$/.test(x)) fail(400, 'Enter your 4-digit PIN.'); return x; },
  cents(x, min, max, minMsg) {
    if (typeof x !== 'number' || !Number.isSafeInteger(x)) fail(400, 'Enter a valid amount.');
    if (x < min) fail(400, minMsg || 'Amount is too small.');
    if (max !== undefined && x > max) fail(400, `Amount can't be more than ${fmt(max)}.`);
    return x;
  },
  theme(x) { return C.THEMES.includes(x) ? x : 'emerald'; },
  idem(x) {
    if (x === undefined || x === null || x === '') return null;
    if (typeof x !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(x)) fail(400, 'Invalid request key.');
    return x;
  }
};

/* ============================== ids ============================== */
const rndDigits = n => { let s = ''; for (let i = 0; i < n; i++) s += crypto.randomInt(0, 10); return s; };
const newId = p => p + '_' + crypto.randomBytes(9).toString('base64url');
const newRef = () => 'VLT' + crypto.randomBytes(7).toString('hex').toUpperCase();
function luhnPan(prefix) {
  const body = prefix + rndDigits(15 - prefix.length);
  let sum = 0;
  for (let i = 0; i < body.length; i++) { let d = +body[body.length - 1 - i]; if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; } sum += d; }
  return body + ((10 - (sum % 10)) % 10);
}

/* ============================== security ============================== */
function secret() {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 16) throw new ConfigError('APP_SECRET is missing or too short (use at least 16 random characters).');
  return s;
}
const derive = label => Buffer.from(crypto.hkdfSync('sha256', secret(), 'vaulta-v1', label, 32));
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const preHash = (value, pepper) => (pepper ? crypto.createHmac('sha256', derive('pin-pepper')).update(value).digest() : value);

async function hashSecret(value, pepper) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(preHash(value, pepper), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
async function verifySecret(value, stored, pepper) {
  const [tag, N, r, p, salt, hash] = String(stored).split('$');
  if (tag !== 'scrypt' || !hash) return false;
  const exp = Buffer.from(hash, 'base64url');
  const got = await scrypt(preHash(value, pepper), Buffer.from(salt, 'base64url'), exp.length, { N: +N, r: +r, p: +p });
  return got.length === exp.length && crypto.timingSafeEqual(got, exp);
}
let dummy = null;
const dummyHash = () => (dummy = dummy || hashSecret('vaulta-timing-equalizer'));

function encrypt(plain) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', derive('card-enc'), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b => b.toString('base64url')).join('.');
}
function decrypt(s) {
  const [iv, tag, ct] = String(s).split('.').map(x => Buffer.from(x, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', derive('card-enc'), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
// CVV is derived, never stored.
const cvvFor = (cardId, pan) => String(crypto.createHmac('sha256', derive('card-cvv')).update(cardId + ':' + pan).digest().readUInt32BE(0) % 1000).padStart(3, '0');

/* ============================== database ============================== */
let driver = null;
const setDriver = d => { driver = d; };
function pgDriver() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new ConfigError('DATABASE_URL is not set (connect a Neon database in Vercel > Storage).');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000 });
  pool.on('error', () => {});
  return {
    query: (t, p) => pool.query(t, p),
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn({ query: (t, p) => c.query(t, p) });
        await c.query('COMMIT');
        return r;
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
        throw e;
      } finally { c.release(); }
    }
  };
}
const getDriver = () => driver || (driver = pgDriver());
const query = (t, p) => getDriver().query(t, p);
const tx = fn => getDriver().tx(fn);

/* ---- rate limits (stored in the database so they work across serverless instances) ---- */
const rl = {
  async hit(key, windowMs, now) {
    const r = await query(
      `INSERT INTO rate_limits(key,count,window_start) VALUES($1,1,$2::bigint)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start < $2::bigint - $3::bigint THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN rate_limits.window_start < $2::bigint - $3::bigint THEN $2::bigint ELSE rate_limits.window_start END
       RETURNING count, window_start`, [key, now, windowMs]);
    return { count: Number(r.rows[0].count), retryMs: Number(r.rows[0].window_start) + windowMs - now };
  },
  async peek(key, max, windowMs, now) {
    const r = await query('SELECT count, window_start FROM rate_limits WHERE key=$1', [key]);
    const row = r.rows[0];
    return !!row && Number(row.window_start) >= now - windowMs && Number(row.count) >= max;
  },
  async clear(key) { await query('DELETE FROM rate_limits WHERE key=$1', [key]); },
  // Count this call and block when it goes over `max` in the window.
  async limit(key, max, windowMs, now) {
    const { count, retryMs } = await rl.hit(key, windowMs, now);
    if (count > max) fail(429, `Too many attempts. Try again in ${Math.max(1, Math.ceil(retryMs / MIN))} min.`, 'RATE_LIMITED');
  }
};

/* ---- shared money/ledger helpers (always called with a transaction handle `q`) ---- */
const lockUser = async (q, id) => (await q.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id])).rows[0] || null;

async function checkPin(q, u, pin, now) {
  if (!u.pin_hash) return err(400, 'Set a transaction PIN first.', 'NO_PIN');
  const lockUntil = Number(u.pin_lock_until);
  if (lockUntil > now) return err(429, `PIN locked. Try again in ${Math.ceil((lockUntil - now) / MIN)} min.`, 'PIN_LOCKED');
  if (await verifySecret(pin, u.pin_hash, true)) {
    if (Number(u.pin_fails) || Number(u.pin_lock_count)) await q.query('UPDATE users SET pin_fails=0, pin_lock_count=0, pin_lock_until=0 WHERE id=$1', [u.id]);
    return null;
  }
  const fails = Number(u.pin_fails) + 1;
  if (fails >= 5) {
    const count = Number(u.pin_lock_count), ms = Math.min(5 * MIN * Math.pow(2, count), DAY);   // 5 min, 10, 20 ... up to 24h
    await q.query('UPDATE users SET pin_fails=0, pin_lock_count=$2, pin_lock_until=$3::bigint WHERE id=$1', [u.id, count + 1, now + ms]);
    return err(429, `Too many wrong attempts. PIN locked for ${Math.round(ms / MIN)} minutes.`, 'PIN_LOCKED');
  }
  await q.query('UPDATE users SET pin_fails=$2 WHERE id=$1', [u.id, fails]);
  return err(403, `Incorrect PIN. ${5 - fails} attempt${5 - fails === 1 ? '' : 's'} left.`, 'BAD_PIN');
}

const spentSince = async (q, userId, since) => Number((await q.query(
  `SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE user_id=$1 AND type='debit' AND category IN ('transfer','bill') AND created_at >= $2::bigint`,
  [userId, since])).rows[0].s);

// Moves money on one account and writes its ledger line. Balance can never go below 0 (also a DB CHECK).
async function post(q, userId, type, amount, m, now) {
  const r = await q.query(`UPDATE users SET balance = balance ${type === 'credit' ? '+' : '-'} $1::bigint WHERE id=$2 RETURNING balance`, [amount, userId]);
  const balance = Number(r.rows[0].balance);
  const ins = await q.query(
    `INSERT INTO transactions(id,user_id,type,category,amount,balance_after,narration,cp_name,cp_acct,status,created_at,idem_key)
     VALUES($1,$2,$3,$4,$5::bigint,$6::bigint,$7,$8,$9,'Successful',$10::bigint,$11) RETURNING *`,
    [newRef(), userId, type, m.category, amount, balance, m.narration || '', m.cpName || '', m.cpAcct || '', now, m.idem || null]);
  return { tx: publicTx(ins.rows[0]), balance };
}

/* ============================== response shapes ============================== */
const publicUser = u => ({
  id: u.id, name: u.name, email: u.email, phone: u.phone, accountNumber: u.account_number,
  nickname: u.nickname, theme: u.theme, balance: Number(u.balance), hasPin: !!u.pin_hash, createdAt: Number(u.created_at)
});
const publicTx = r => ({
  id: r.id, seq: Number(r.seq), type: r.type, category: r.category, amount: Number(r.amount),
  balanceAfter: Number(r.balance_after), narration: r.narration,
  counterparty: { name: r.cp_name, acct: r.cp_acct }, status: r.status, date: Number(r.created_at)
});
const publicCard = r => ({
  id: r.id, kind: r.kind, tier: r.tier, nameOnCard: r.name_on_card,
  number: C.CARD_PREFIX + '••••••••' + r.last4, last4: r.last4,
  expiry: r.expiry, status: r.status, frozen: Number(r.frozen) === 1, limit: Number(r.spend_limit),
  delivery: r.delivery ? JSON.parse(r.delivery) : null, requestedAt: Number(r.requested_at)
});
const publicConfig = () => ({
  routing: C.ROUTING, dailyLimit: C.DAILY_LIMIT, maxDeposit: C.MAX_DEPOSIT, maxCards: C.MAX_CARDS,
  tiers: C.TIERS, billCategories: C.BILL_CATEGORIES, states: C.STATES, demo: demoMode()
});

module.exports = {
  C, MIN, HOUR, DAY, demoMode, fmt,
  HttpError, ConfigError, fail, err, readJson, send, clientIp, isHttps, parseCookies, setCookie,
  v, str, rndDigits, newId, newRef, luhnPan,
  secret, sha256, hashSecret, verifySecret, dummyHash, encrypt, decrypt, cvvFor,
  setDriver, query, tx, rl,
  lockUser, checkPin, spentSince, post,
  publicUser, publicTx, publicCard, publicConfig
};
