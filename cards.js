'use strict';
const { C, HOUR, fmt, demoMode, v, fail, err, query, tx, rl, lockUser, checkPin, post, newId, luhnPan, encrypt, decrypt, cvvFor, publicCard, publicTx } = require('./core');

const crypto = require('crypto');
const DAY_MS = 86400000;
const orderNumber = () => 'VA-' + [...crypto.randomBytes(8)].map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
function addBusinessDays(ts, n) {            // skips Saturdays and Sundays
  const d = new Date(ts);
  while (n > 0) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) n--; }
  return d.getTime();
}

/* Card numbers are fictional (prefix 9999) and are stored encrypted. The CVV is derived on demand, never stored. */

async function requestCard(ctx) {
  const b = ctx.body, u = ctx.user;
  const tier = C.TIERS[b.tier] ? b.tier : fail(400, 'Choose a card type.');
  const t = C.TIERS[tier];
  const speed = b.speed === undefined ? 'standard' : (C.SHIPPING[b.speed] ? b.speed : fail(400, 'Choose a delivery speed.'));
  const ship = C.SHIPPING[speed];
  const design = b.design === undefined ? C.DESIGNS[tier][0] : (C.DESIGNS[tier].includes(b.design) ? b.design : fail(400, 'Choose a card design.'));
  const nameOnCard = String(b.nameOnCard || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z .'-]{2,21}$/.test(nameOnCard)) fail(400, 'Name on card must be 3-22 letters.');
  let delivery = null;
  if (t.physical) {
    const address = v.text(b.address, 'a street address', 5, 80), apt = v.text(b.apt, 'an apartment', 0, 30);
    const city = v.text(b.city, 'your city', 2, 50), zip = String(b.zip || '').trim(), state = String(b.state || '').trim();
    if (!C.STATES.includes(state)) fail(400, 'Choose your state.');
    if (!/^\d{5}$/.test(zip)) fail(400, 'Enter a 5-digit ZIP code.');
    delivery = { address, apt, city, state, zip, phone: v.phone(b.phone) };
  }
  const pin = v.pin(b.pin);
  await rl.limit('card:' + u.id, 10, HOUR, ctx.now);

  return tx(async q => {
    const s = await lockUser(q, u.id);
    if (!s) fail(401, 'Please log in.', 'UNAUTH');
    const bad = await checkPin(q, s, pin, ctx.now);
    if (bad) return bad;
    const n = Number((await q.query(`SELECT COUNT(*) AS n FROM cards WHERE user_id=$1 AND status<>'cancelled'`, [s.id])).rows[0].n);
    if (n >= C.MAX_CARDS) return err(400, `You can hold up to ${C.MAX_CARDS} cards.`, 'LIMIT');
    const total = t.fee + ship.fee;
    if (total > Number(s.balance)) return err(400, `Insufficient balance. This order totals ${fmt(total)}. Add money first.`, 'INSUFFICIENT');

    const id = newId('c'), pan = luhnPan(C.CARD_PREFIX), orderNo = orderNumber(), days = C.ETA_DAYS[tier][speed];
    const exp = new Date(ctx.now); exp.setUTCFullYear(exp.getUTCFullYear() + 4);
    const expiry = String(exp.getUTCMonth() + 1).padStart(2, '0') + '/' + String(exp.getUTCFullYear()).slice(-2);
    const ins = await q.query(
      `INSERT INTO cards(id,user_id,kind,tier,name_on_card,pan_enc,last4,expiry,status,delivery,requested_at,design,order_no,ship_speed,ship_fee,eta_min,eta_max,events)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::bigint,$12,$13,$14,$15::bigint,$16::bigint,$17::bigint,$18) RETURNING *`,
      [id, s.id, t.physical ? 'physical' : 'virtual', tier, nameOnCard, encrypt(pan), pan.slice(-4), expiry,
        t.physical ? 'requested' : 'active', delivery ? JSON.stringify(delivery) : null, ctx.now,
        design, orderNo, speed, ship.fee, addBusinessDays(ctx.now, days[0]), addBusinessDays(ctx.now, days[1]),
        JSON.stringify([{ stage: t.physical ? 'requested' : 'active', at: ctx.now }])]);
    const fee = await post(q, s.id, 'debit', total, { category: 'fee', narration: `Order ${orderNo}: ${t.label} debit card` + (ship.fee ? ' + express delivery' : ''), cpName: 'Vaulta' }, ctx.now);
    return { status: 201, body: { ok: true, card: publicCard(ins.rows[0]), tx: fee.tx, balance: fee.balance } };
  });
}

const STEP = { requested: 'processing', processing: 'shipped', shipped: 'delivered' };

async function cardAction(ctx) {
  const [cardId, action] = ctx.params, u = ctx.user;
  const pin = ['activate', 'reveal'].includes(action) ? v.pin(ctx.body.pin) : null;
  const limit = action === 'limit' ? v.cents(ctx.body.limit, 0, C.DAILY_LIMIT, `Limit must be between $0 and ${fmt(C.DAILY_LIMIT)}.`) : null;
  if (action === 'advance' && !demoMode()) fail(403, 'Not available.', 'DISABLED');

  return tx(async q => {
    const s = await lockUser(q, u.id);
    if (!s) fail(401, 'Please log in.', 'UNAUTH');
    const c = (await q.query('SELECT * FROM cards WHERE id=$1 AND user_id=$2 FOR UPDATE', [cardId, s.id])).rows[0];
    if (!c) return err(404, 'Card not found.', 'NOT_FOUND');
    if (c.status === 'cancelled') return err(400, 'This card is cancelled.', 'CANCELLED');

    if (pin) { const bad = await checkPin(q, s, pin, ctx.now); if (bad) return bad; }
    const done = async (sql, args) => {
      const r = await q.query(sql + ' RETURNING *', args);
      return { status: 200, body: { ok: true, card: publicCard(r.rows[0]) } };
    };

    switch (action) {
      case 'activate':
        if (c.status !== 'delivered') return err(400, 'This card is not ready to activate.', 'STATE');
        return done(`UPDATE cards SET status='active', events=$2 WHERE id=$1`, [c.id, JSON.stringify((c.events ? JSON.parse(c.events) : []).concat([{ stage: 'active', at: ctx.now }]))]);
      case 'freeze':
        if (c.status !== 'active') return err(400, 'Only active cards can be frozen.', 'STATE');
        return done('UPDATE cards SET frozen=$2 WHERE id=$1', [c.id, Number(c.frozen) === 1 ? 0 : 1]);
      case 'limit':
        return done('UPDATE cards SET spend_limit=$2::bigint WHERE id=$1', [c.id, limit]);
      case 'cancel':
        return done(`UPDATE cards SET status='cancelled' WHERE id=$1`, [c.id]);
      case 'advance': {
        const next = c.kind === 'physical' && STEP[c.status];
        if (!next) return err(400, 'Nothing to advance.', 'STATE');
        const ev = (c.events ? JSON.parse(c.events) : [{ stage: 'requested', at: Number(c.requested_at) }]).concat([{ stage: next, at: ctx.now }]);
        return done('UPDATE cards SET status=$2, events=$3 WHERE id=$1', [c.id, next, JSON.stringify(ev)]);
      }
      case 'reveal': {
        if (c.status !== 'active') return err(400, 'Details are available once the card is active.', 'STATE');
        const pan = decrypt(c.pan_enc);
        return { status: 200, body: { ok: true, number: pan, cvv: cvvFor(c.id, pan), expiry: c.expiry } };
      }
      default: return err(404, 'Unknown action.', 'NOT_FOUND');
    }
  });
}

module.exports = { requestCard, cardAction };
