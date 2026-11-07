'use strict';
/* The one and only serverless function. It routes every /api/* request, so the project
   stays far below Vercel's per-deployment function limit. */
const core = require('./_lib/core');
const { ensureSchema } = require('./_lib/schema');
const auth = require('./_lib/auth');
const account = require('./_lib/account');
const money = require('./_lib/money');
const cards = require('./_lib/cards');
const { HttpError, ConfigError, fail, send, readJson, clientIp, isHttps, setCookie } = core;

async function health() {
  const out = { ok: true, database: false, secret: false };
  const s = process.env.APP_SECRET;
  out.secret = !!s && s.length >= 16;
  try { await ensureSchema(); out.database = true; }
  catch (e) { out.hint = e instanceof ConfigError ? e.message : 'Could not connect to the database.'; }
  out.ok = out.database && out.secret;
  if (!out.secret) out.hint = (out.hint ? out.hint + ' ' : '') + 'APP_SECRET is missing or too short.';
  return { status: out.ok ? 200 : 503, body: out };
}

// [method, path (string or RegExp), { fn, auth: true | 'optional', body: true }]
const ROUTES = [
  ['GET', '/api/health', { fn: health }],
  ['POST', '/api/auth/signup', { fn: auth.signup, body: true }],
  ['POST', '/api/auth/login', { fn: auth.login, body: true }],
  ['POST', '/api/auth/logout', { fn: auth.logout, auth: 'optional' }],
  ['GET', '/api/me', { fn: account.me, auth: true }],
  ['PATCH', '/api/me/profile', { fn: account.updateProfile, auth: true, body: true }],
  ['PATCH', '/api/me/account', { fn: account.updateAccount, auth: true, body: true }],
  ['POST', '/api/me/pin', { fn: account.setPin, auth: true, body: true }],
  ['POST', '/api/me/password', { fn: account.changePassword, auth: true, body: true }],
  ['GET', '/api/account/check', { fn: account.acctCheck, auth: 'optional' }],
  ['GET', '/api/account/random', { fn: account.acctRandom }],
  ['GET', '/api/account/suggest', { fn: account.acctSuggest }],
  ['GET', '/api/lookup', { fn: account.lookup, auth: true }],
  ['POST', '/api/beneficiaries', { fn: account.addBeneficiary, auth: true, body: true }],
  ['DELETE', /^\/api\/beneficiaries\/(\d{8,12})$/, { fn: account.removeBeneficiary, auth: true }],
  ['GET', '/api/transactions', { fn: account.listTransactions, auth: true }],
  ['GET', '/api/transactions/export', { fn: account.exportTransactions, auth: true }],
  ['POST', '/api/transfer', { fn: money.transfer, auth: true, body: true }],
  ['POST', '/api/bills', { fn: money.billPay, auth: true, body: true }],
  ['POST', '/api/deposit', { fn: money.deposit, auth: true, body: true }],
  ['POST', '/api/cards', { fn: cards.requestCard, auth: true, body: true }],
  ['POST', /^\/api\/cards\/([\w-]{3,40})\/(activate|freeze|limit|cancel|reveal|advance)$/, { fn: cards.cardAction, auth: true, body: true }]
];

function match(method, path) {
  for (const [m, p, def] of ROUTES) {
    if (m !== method) continue;
    if (typeof p === 'string') { if (p === path) return { def, params: [] }; }
    else { const x = p.exec(path); if (x) return { def, params: x.slice(1) }; }
  }
  return null;
}

// Blocks cross-site requests. Cookies are also SameSite=Strict.
function csrfCheck(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.origin;
  if (origin) {
    let host; try { host = new URL(origin).host; } catch (_) { fail(403, 'Request blocked.'); }
    if (host !== req.headers.host) fail(403, 'Cross-site request blocked.');
  }
  if (Number(req.headers['content-length'] || 0) > 0 && !/^application\/json/i.test(req.headers['content-type'] || '')) fail(415, 'Content-Type must be application/json.');
}

function respond(res, req, out) {
  const headers = Object.assign({}, out.headers);
  if (out.setSession) headers['Set-Cookie'] = setCookie(auth.COOKIE, out.setSession, Math.floor(core.C.SESSION_MS / 1000), isHttps(req));
  if (out.clearSession) headers['Set-Cookie'] = setCookie(auth.COOKIE, '', 0, isHttps(req));
  return send(res, out.status || 200, out.raw !== undefined ? out.raw : out.body, headers);
}

function handleError(res, e) {
  if (e instanceof HttpError) return send(res, e.status, { ok: false, error: e.message, code: e.code });
  if (e instanceof ConfigError) { console.error('[config]', e.message); return send(res, 503, { ok: false, error: 'The server is not set up yet. ' + e.message, code: 'CONFIG' }); }
  console.error('[error]', (e && e.stack) || e);
  return send(res, 500, { ok: false, error: 'Something went wrong. Please try again.' });
}

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = url.pathname.replace(/\/+$/, '') || '/';
    if (!path.startsWith('/api/') && url.searchParams.get('route')) path = '/api/' + url.searchParams.get('route').replace(/^\/+|\/+$/g, '');
    const route = match(req.method, path);
    if (!route) return send(res, 404, { ok: false, error: 'Not found.' });
    csrfCheck(req);

    const ctx = { req, res, now: Date.now(), ip: clientIp(req), query: Object.fromEntries(url.searchParams), params: route.params, body: {}, user: null, sessionHash: null };
    if (route.def.body) ctx.body = await readJson(req);
    if (route.def.fn !== health) await ensureSchema();
    if (route.def.auth) {
      ctx.user = await auth.loadSession(ctx);
      if (!ctx.user && route.def.auth === true) fail(401, 'Please log in.', 'UNAUTH');
    }
    return respond(res, req, await route.def.fn(ctx));
  } catch (e) {
    return handleError(res, e);
  }
};
