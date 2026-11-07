'use strict';
const crypto = require('crypto');
const { C, MIN, HOUR, DAY, v, fail, query, hashSecret, verifySecret, dummyHash, sha256, newId, rl, parseCookies, publicUser } = require('./core');

const COOKIE = 'vaulta_session';

async function createSession(ctx, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,ua) VALUES($1,$2,$3::bigint,$4::bigint,$5)',
    [sha256(token), userId, ctx.now, ctx.now + C.SESSION_MS, String(ctx.req.headers['user-agent'] || '').slice(0, 200)]);
  return token;
}

// Returns the logged-in user row (or null). Sets ctx.sessionHash.
async function loadSession(ctx) {
  const token = parseCookies(ctx.req.headers.cookie)[COOKIE];
  if (!token || token.length > 100) return null;
  const h = sha256(token);
  const r = await query('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash=$1 AND s.expires_at > $2::bigint', [h, ctx.now]);
  if (!r.rows[0]) return null;
  ctx.sessionHash = h;
  return r.rows[0];
}

async function housekeeping(now) {
  if (Math.random() > 0.05) return;
  await query('DELETE FROM sessions WHERE expires_at < $1::bigint', [now]);
  await query('DELETE FROM rate_limits WHERE window_start < $1::bigint', [now - DAY]);
}

async function signup(ctx) {
  const b = ctx.body;
  await rl.limit('signup:' + ctx.ip, 10, HOUR, ctx.now);
  const name = v.name(b.name), email = v.email(b.email), phone = v.phone(b.phone), password = v.password(b.password);
  const acct = v.acct(b.accountNumber, 'Account number');
  const nickname = v.text(b.nickname, 'a nickname', 0, 30) || 'Main Account';
  const theme = v.theme(b.theme);

  const dup = await query('SELECT email, account_number FROM users WHERE email=$1 OR account_number=$2', [email, acct]);
  for (const r of dup.rows) {
    if (r.email === email) fail(409, 'An account with this email already exists.', 'EMAIL_TAKEN');
    if (r.account_number === acct) fail(409, 'That number is already taken. Try another.', 'ACCT_TAKEN');
  }
  const id = newId('u');
  const passHash = await hashSecret(password);
  try {
    await query('INSERT INTO users(id,name,email,phone,pass_hash,account_number,nickname,theme,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint)',
      [id, name, email, phone, passHash, acct, nickname, theme, ctx.now]);
  } catch (e) {
    if (e && e.code === '23505') fail(409, 'That email or account number was just taken. Please try again.', 'TAKEN');
    throw e;
  }
  const token = await createSession(ctx, id);
  housekeeping(ctx.now).catch(() => {});
  return { status: 201, body: { ok: true }, setSession: token };
}

async function login(ctx) {
  const idv = typeof ctx.body.identifier === 'string' ? ctx.body.identifier.trim().toLowerCase() : '';
  const pw = ctx.body.password;
  if (!idv || idv.length > 254 || typeof pw !== 'string' || !pw || pw.length > 128) fail(400, 'Enter your email/account number and password.');
  const kId = 'login:id:' + idv, kIp = 'login:ip:' + ctx.ip, W = 15 * MIN;
  if ((await rl.peek(kId, 5, W, ctx.now)) || (await rl.peek(kIp, 30, W, ctx.now))) {
    fail(429, 'Too many failed attempts. Please wait a few minutes and try again.', 'RATE_LIMITED');
  }
  const u = (await query('SELECT * FROM users WHERE email=$1 OR account_number=$1 LIMIT 1', [idv])).rows[0];
  const ok = await verifySecret(pw, u ? u.pass_hash : await dummyHash());   // same work whether or not the user exists
  if (!u || !ok) {
    await rl.hit(kId, W, ctx.now); await rl.hit(kIp, W, ctx.now);
    fail(401, 'Incorrect details. Please try again.', 'BAD_LOGIN');
  }
  await rl.clear(kId);
  const token = await createSession(ctx, u.id);
  housekeeping(ctx.now).catch(() => {});
  return { status: 200, body: { ok: true, user: publicUser(u) }, setSession: token };
}

async function logout(ctx) {
  if (ctx.sessionHash) await query('DELETE FROM sessions WHERE token_hash=$1', [ctx.sessionHash]);
  return { status: 200, body: { ok: true }, clearSession: true };
}

module.exports = { COOKIE, loadSession, signup, login, logout };
