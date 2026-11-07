'use strict';
const crypto = require('crypto');
const { C, MIN, HOUR, DAY, v, fail, err, query, tx, rl, hashSecret, verifySecret, lockUser, checkPin, spentSince,
  rndDigits, publicUser, publicTx, publicCard, publicConfig } = require('./core');

const TX_PAGE = 200;

/* ---------------- full account snapshot ---------------- */
async function me(ctx) {
  const u = ctx.user;
  const [cards, bens, txs, spent] = await Promise.all([
    query('SELECT * FROM cards WHERE user_id=$1 ORDER BY requested_at ASC, id ASC', [u.id]),
    query(`SELECT t.name, t.account_number FROM beneficiaries b JOIN users t ON t.id=b.target_id WHERE b.user_id=$1 ORDER BY b.created_at DESC`, [u.id]),
    query('SELECT * FROM transactions WHERE user_id=$1 ORDER BY seq DESC LIMIT $2::int', [u.id, TX_PAGE]),
    spentSince({ query }, u.id, ctx.now - DAY)
  ]);
  return {
    status: 200,
    body: {
      ok: true,
      user: publicUser(u),
      cards: cards.rows.map(publicCard),
      beneficiaries: bens.rows.map(r => ({ name: r.name, acct: r.account_number })),
      transactions: txs.rows.map(publicTx),
      hasMoreTx: txs.rows.length === TX_PAGE,
      spentToday: spent,
      config: publicConfig()
    }
  };
}

/* ---------------- profile / account / security ---------------- */
async function updateProfile(ctx) {
  const name = v.name(ctx.body.name), phone = v.phone(ctx.body.phone);
  await query('UPDATE users SET name=$1, phone=$2 WHERE id=$3', [name, phone, ctx.user.id]);
  return { status: 200, body: { ok: true } };
}

async function updateAccount(ctx) {
  const b = ctx.body, u = ctx.user;
  const nickname = v.text(b.nickname, 'a nickname', 0, 30) || 'Main Account';
  const theme = v.theme(b.theme);
  const acct = b.accountNumber === undefined ? u.account_number : v.acct(b.accountNumber, 'Account number');
  return tx(async q => {
    const s = await lockUser(q, u.id);
    if (!s) fail(401, 'Please log in.', 'UNAUTH');
    if (acct !== s.account_number) {
      const bad = await checkPin(q, s, v.pin(b.pin), ctx.now);      // changing the number needs the PIN
      if (bad) return bad;
      const taken = await q.query('SELECT 1 FROM users WHERE account_number=$1 AND id<>$2', [acct, s.id]);
      if (taken.rows.length) return err(409, 'That number is already taken. Try another.', 'ACCT_TAKEN');
    }
    try {
      await q.query('UPDATE users SET account_number=$1, nickname=$2, theme=$3 WHERE id=$4', [acct, nickname, theme, s.id]);
    } catch (e) {
      if (e && e.code === '23505') fail(409, 'That number is already taken. Try another.', 'ACCT_TAKEN');
      throw e;
    }
    return { status: 200, body: { ok: true } };
  });
}

async function setPin(ctx) {
  const pin = v.pin(ctx.body.pin);
  return tx(async q => {
    const s = await lockUser(q, ctx.user.id);
    if (!s) fail(401, 'Please log in.', 'UNAUTH');
    if (s.pin_hash) {
      const cur = typeof ctx.body.current === 'string' && /^\d{4}$/.test(ctx.body.current) ? ctx.body.current : fail(400, 'Enter your current PIN.');
      const bad = await checkPin(q, s, cur, ctx.now);
      if (bad) return bad;
    }
    await q.query('UPDATE users SET pin_hash=$1, pin_fails=0, pin_lock_count=0, pin_lock_until=0 WHERE id=$2', [await hashSecret(pin, true), s.id]);
    return { status: 200, body: { ok: true } };
  });
}

async function changePassword(ctx) {
  const cur = ctx.body.current, next = v.password(ctx.body.next);
  if (typeof cur !== 'string' || !cur || cur.length > 128) fail(400, 'Enter your current password.');
  await rl.limit('pw:' + ctx.user.id, 5, 15 * MIN, ctx.now);
  if (!(await verifySecret(cur, ctx.user.pass_hash))) return err(403, 'Current password is incorrect.', 'BAD_PASSWORD');
  await query('UPDATE users SET pass_hash=$1 WHERE id=$2', [await hashSecret(next), ctx.user.id]);
  await query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [ctx.user.id, ctx.sessionHash]);   // sign out everywhere else
  return { status: 200, body: { ok: true } };
}

/* ---------------- account number tools (used by sign up + settings) ---------------- */
async function acctCheck(ctx) {
  await rl.limit('acct:' + ctx.ip, 120, 10 * MIN, ctx.now);
  const n = String(ctx.query.n || '');
  let msg = null;
  if (!n) msg = 'Enter an account number (8 to 12 digits).';
  else if (!/^\d+$/.test(n)) msg = 'Digits only.';
  else if (n.length < 8) msg = `At least 8 digits needed (${8 - n.length} more).`;
  else if (n.length > 12) msg = 'Maximum 12 digits.';
  if (msg) return { status: 200, body: { ok: true, available: false, message: msg } };
  const own = ctx.user && ctx.user.account_number === n;
  const taken = !own && (await query('SELECT 1 FROM users WHERE account_number=$1', [n])).rows.length > 0;
  return { status: 200, body: { ok: true, available: !taken, message: taken ? 'That number is already taken. Try another.' : 'Available. This can be your account number.' } };
}

async function freeNumbers(prefix, count) {
  const base = String(prefix || '').replace(/\D/g, '').slice(0, 9);
  const cands = new Set();
  let guard = 0;
  while (cands.size < count * 3 && guard++ < 200) {
    let n = base || String(1 + crypto.randomInt(0, 9));
    n += rndDigits(10 - n.length);
    cands.add(n);
  }
  const list = [...cands];
  const r = await query(`SELECT account_number FROM users WHERE account_number IN (${list.map((_, i) => '$' + (i + 1)).join(',')})`, list);
  const used = new Set(r.rows.map(x => x.account_number));
  return list.filter(n => !used.has(n)).slice(0, count);
}
async function acctRandom(ctx) {
  await rl.limit('acct:' + ctx.ip, 120, 10 * MIN, ctx.now);
  const [n] = await freeNumbers('', 1);
  return { status: 200, body: { ok: true, accountNumber: n || '' } };
}
async function acctSuggest(ctx) {
  await rl.limit('acct:' + ctx.ip, 120, 10 * MIN, ctx.now);
  return { status: 200, body: { ok: true, suggestions: await freeNumbers(ctx.query.prefix, 4) } };
}

/* ---------------- recipients ---------------- */
async function lookup(ctx) {
  await rl.limit('lookup:' + ctx.user.id, 60, 10 * MIN, ctx.now);
  const acct = v.acct(ctx.query.acct, 'Account number');
  const r = (await query('SELECT id, name, account_number FROM users WHERE account_number=$1', [acct])).rows[0];
  if (!r) return err(404, 'Account not found.', 'NOT_FOUND');
  if (r.id === ctx.user.id) return err(400, "That's your own account.", 'SELF');
  return { status: 200, body: { ok: true, name: r.name, acct: r.account_number } };
}
async function addBeneficiary(ctx) {
  const acct = v.acct(ctx.body.acct, 'Account number');
  const r = (await query('SELECT id FROM users WHERE account_number=$1', [acct])).rows[0];
  if (!r || r.id === ctx.user.id) return err(404, 'Account not found.', 'NOT_FOUND');
  const n = Number((await query('SELECT COUNT(*) AS n FROM beneficiaries WHERE user_id=$1', [ctx.user.id])).rows[0].n);
  if (n >= C.MAX_BENEFICIARIES) return err(400, `You can save up to ${C.MAX_BENEFICIARIES} beneficiaries.`, 'LIMIT');
  await query('INSERT INTO beneficiaries(user_id,target_id,created_at) VALUES($1,$2,$3::bigint) ON CONFLICT DO NOTHING', [ctx.user.id, r.id, ctx.now]);
  return { status: 200, body: { ok: true } };
}
async function removeBeneficiary(ctx) {
  await query('DELETE FROM beneficiaries WHERE user_id=$1 AND target_id=(SELECT id FROM users WHERE account_number=$2)', [ctx.user.id, ctx.params[0]]);
  return { status: 200, body: { ok: true } };
}

/* ---------------- history + statement export ---------------- */
function txFilter(ctx) {
  const where = ['user_id=$1'], args = [ctx.user.id];
  const f = ctx.query.filter;
  if (f === 'credit' || f === 'debit') { args.push(f); where.push(`type=$${args.length}`); }
  const q = String(ctx.query.q || '').trim().slice(0, 60);
  if (q) { args.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%'); const p = '$' + args.length; where.push(`(narration ILIKE ${p} OR cp_name ILIKE ${p} OR id ILIKE ${p})`); }
  const before = Number(ctx.query.before);
  if (Number.isSafeInteger(before) && before > 0) { args.push(before); where.push(`seq < $${args.length}::bigint`); }
  return { where: where.join(' AND '), args };
}
async function listTransactions(ctx) {
  const { where, args } = txFilter(ctx);
  const limit = Math.min(Math.max(parseInt(ctx.query.limit, 10) || 50, 1), TX_PAGE);
  args.push(limit);
  const r = await query(`SELECT * FROM transactions WHERE ${where} ORDER BY seq DESC LIMIT $${args.length}::int`, args);
  return { status: 200, body: { ok: true, transactions: r.rows.map(publicTx), hasMore: r.rows.length === limit } };
}

const csvCell = (x, text) => {
  let s = String(x === null || x === undefined ? '' : x);
  if (text && /^[=+\-@\t\r]/.test(s)) s = "'" + s;           // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
async function exportTransactions(ctx) {
  const { where, args } = txFilter(ctx);
  const r = await query(`SELECT * FROM transactions WHERE ${where} ORDER BY seq DESC LIMIT 5000`, args);
  const rows = [['Date', 'Reference', 'Type', 'Category', 'Counterparty', 'Narration', 'Amount (USD)', 'Balance after (USD)', 'Status']];
  for (const t of r.rows.map(publicTx)) {
    rows.push([new Date(t.date).toISOString(), t.id, t.type, t.category, t.counterparty.name, t.narration,
      ((t.type === 'credit' ? 1 : -1) * t.amount / 100).toFixed(2), (t.balanceAfter / 100).toFixed(2), t.status]);
  }
  const csv = rows.map((row, i) => row.map((c, j) => csvCell(c, i > 0 && [1, 2, 3, 4, 5, 8].includes(j))).join(',')).join('\r\n');
  return {
    status: 200, raw: csv,
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="vaulta-statement-${ctx.user.account_number}.csv"` }
  };
}

module.exports = { me, updateProfile, updateAccount, setPin, changePassword, acctCheck, acctRandom, acctSuggest,
  lookup, addBeneficiary, removeBeneficiary, listTransactions, exportTransactions };
