'use strict';
const { C, HOUR, DAY, fmt, demoMode, v, fail, err, query, tx, rl, lockUser, checkPin, spentSince, post, publicTx } = require('./core');

/* Money rules enforced here (never in the browser):
   - the PIN is verified on the server, with escalating lockouts
   - both accounts are locked in a fixed order, so concurrent transfers can't double-spend or deadlock
   - balance and daily-limit checks happen after the lock
   - an optional idempotency key makes a retried request safe (it never pays twice) */

async function transfer(ctx) {
  const b = ctx.body, u = ctx.user;
  const toAcct = v.acct(b.toAccount, 'Recipient account number');
  const amount = v.cents(b.amount, 100, undefined, 'Minimum transfer is $1.00.');
  const note = v.text(b.narration, 'a narration', 0, 60);
  const pin = v.pin(b.pin), idem = v.idem(b.idemKey);
  await rl.limit('xfer:' + u.id, 30, HOUR, ctx.now);

  const rec = (await query('SELECT id FROM users WHERE account_number=$1', [toAcct])).rows[0];
  if (!rec) fail(404, 'Recipient account not found.', 'NOT_FOUND');
  if (rec.id === u.id) fail(400, "You can't send money to yourself.", 'SELF');

  return tx(async q => {
    const [first, second] = [u.id, rec.id].sort();               // fixed lock order = no deadlocks
    const rows = {};
    rows[first] = await lockUser(q, first);
    rows[second] = await lockUser(q, second);
    const s = rows[u.id], r = rows[rec.id];
    if (!s) fail(401, 'Please log in.', 'UNAUTH');
    if (!r || r.account_number !== toAcct) return err(404, 'Recipient account not found.', 'NOT_FOUND');

    const bad = await checkPin(q, s, pin, ctx.now);
    if (bad) return bad;
    if (idem) {
      const dup = (await q.query('SELECT * FROM transactions WHERE user_id=$1 AND idem_key=$2', [s.id, idem])).rows[0];
      if (dup) return { status: 200, body: { ok: true, tx: publicTx(dup), balance: Number(s.balance), replay: true } };
    }
    if (amount > Number(s.balance)) return err(400, 'Insufficient balance.', 'INSUFFICIENT');
    if ((await spentSince(q, s.id, ctx.now - DAY)) + amount > C.DAILY_LIMIT) return err(400, `This would exceed your daily limit of ${fmt(C.DAILY_LIMIT)}.`, 'LIMIT');

    const out = await post(q, s.id, 'debit', amount, { category: 'transfer', narration: note || 'Transfer', cpName: r.name, cpAcct: r.account_number, idem }, ctx.now);
    await post(q, r.id, 'credit', amount, { category: 'transfer', narration: note || 'Transfer', cpName: s.name, cpAcct: s.account_number }, ctx.now);
    return { status: 200, body: { ok: true, tx: out.tx, balance: out.balance } };
  });
}

async function billPay(ctx) {
  const b = ctx.body, u = ctx.user;
  const category = C.BILL_CATEGORIES.includes(b.category) ? b.category : fail(400, 'Choose a bill type.');
  const payee = v.text(b.payee, 'the payee name', 2, 40);
  const ref = v.text(b.reference, 'the account number from your bill', 4, 30);
  const amount = v.cents(b.amount, 100, undefined, 'Minimum payment is $1.00.');
  const pin = v.pin(b.pin), idem = v.idem(b.idemKey);
  await rl.limit('xfer:' + u.id, 30, HOUR, ctx.now);

  return tx(async q => {
    const s = await lockUser(q, u.id);
    if (!s) fail(401, 'Please log in.', 'UNAUTH');
    const bad = await checkPin(q, s, pin, ctx.now);
    if (bad) return bad;
    if (idem) {
      const dup = (await q.query('SELECT * FROM transactions WHERE user_id=$1 AND idem_key=$2', [s.id, idem])).rows[0];
      if (dup) return { status: 200, body: { ok: true, tx: publicTx(dup), balance: Number(s.balance), replay: true } };
    }
    if (amount > Number(s.balance)) return err(400, 'Insufficient balance.', 'INSUFFICIENT');
    if ((await spentSince(q, s.id, ctx.now - DAY)) + amount > C.DAILY_LIMIT) return err(400, `This would exceed your daily limit of ${fmt(C.DAILY_LIMIT)}.`, 'LIMIT');
    const out = await post(q, s.id, 'debit', amount, { category: 'bill', narration: `${category} bill`, cpName: payee, cpAcct: ref, idem }, ctx.now);
    return { status: 200, body: { ok: true, tx: out.tx, balance: out.balance } };
  });
}

/* Demo funding. No real money moves. Turn it off with the environment variable DEMO_MODE=off. */
async function deposit(ctx) {
  if (!demoMode()) fail(403, 'Deposits are not available.', 'DISABLED');
  const b = ctx.body, u = ctx.user;
  const amount = v.cents(b.amount, 100, C.MAX_DEPOSIT, 'Enter an amount of at least $1.00.');
  let narration, name;
  if (b.method === 'bank') {
    const bank = v.text(b.bankName, 'the bank name', 2, 30), l4 = typeof b.last4 === 'string' && /^\d{4}$/.test(b.last4) ? b.last4 : fail(400, 'Enter the last 4 digits.');
    narration = `ACH transfer from ${bank} ••${l4}`; name = bank;
  } else if (b.method === 'card') {
    const l4 = typeof b.last4 === 'string' && /^\d{4}$/.test(b.last4) ? b.last4 : fail(400, 'Enter the last 4 digits.');
    narration = `Debit card top-up ••${l4}`; name = `Debit card ••${l4}`;
  } else if (b.method === 'check') {
    const n = typeof b.checkNumber === 'string' && /^\d{1,6}$/.test(b.checkNumber) ? b.checkNumber : fail(400, 'Enter the check number.');
    narration = `Mobile check deposit #${n}`; name = `Check #${n}`;
  } else fail(400, 'Choose how to add money.');
  await rl.limit('dep:' + u.id, 20, HOUR, ctx.now);

  return tx(async q => {
    const s = await lockUser(q, u.id);
    if (!s) fail(401, 'Please log in.', 'UNAUTH');
    const day = Number((await q.query(`SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE user_id=$1 AND category='deposit' AND created_at >= $2::bigint`, [s.id, ctx.now - DAY])).rows[0].s);
    if (day + amount > C.DEPOSIT_DAY_CAP) return err(400, `Demo deposits are limited to ${fmt(C.DEPOSIT_DAY_CAP)} per day.`, 'LIMIT');
    const out = await post(q, s.id, 'credit', amount, { category: 'deposit', narration, cpName: name }, ctx.now);
    return { status: 200, body: { ok: true, tx: out.tx, balance: out.balance } };
  });
}

module.exports = { transfer, billPay, deposit };
