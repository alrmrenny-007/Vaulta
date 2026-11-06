/* Vaulta banking logic. DEMO ONLY: runs in the browser on top of localStorage (see app.js).
   All money amounts are stored as integer cents (US dollars x 100).
   Card numbers and the routing number are fictional and cannot be used for real payments. */

const Bank = (() => {
  const DAILY_LIMIT = 500000;      // $5,000 per day (transfers + bill pay)
  const MAX_TOPUP = 500000;        // $5,000 per demo top-up
  const ROUTING = '999000014';     // fictional 9-digit routing number (valid ABA checksum, unallocated range)
  const BILL_CATEGORIES = ['Electric', 'Gas & Water', 'Internet & Cable', 'Mobile Phone', 'Credit Card', 'Rent & Other'];
  const MAX_CARDS = 3;

  const TIERS = {
    virtual:  { label: 'Virtual',  fee: 1000, physical: false, bg: 'linear-gradient(135deg,#0d7a56,#18b4ff)', note: 'Instant. For online and in-app payments.' },
    standard: { label: 'Standard', fee: 2500, physical: true,  bg: 'linear-gradient(135deg,#1c2538,#3e4e70)', note: 'Physical card. Arrives in 7-10 business days.' },
    platinum: { label: 'Premier',  fee: 5000, physical: true,  bg: 'linear-gradient(135deg,#2a2210,#c09a45)', note: 'Premium design. Expedited, 3-5 business days.' }
  };
  const STAGES = ['requested', 'processing', 'shipped', 'delivered', 'active'];
  const STAGE_LABEL = { requested: 'Requested', processing: 'Processing', shipped: 'On the way', delivered: 'Delivered', active: 'Active' };

  const fmt = k => (k < 0 ? '-' : '') + '$' + (Math.abs(k) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const toKobo = s => { const n = Math.round(parseFloat(String(s).replace(/,/g, '')) * 100); return Number.isFinite(n) ? n : NaN; };
  const fail = msg => ({ ok: false, msg });
  const rnd = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b % 10).join('');
  const ref = () => 'VLT' + Date.now().toString(36).toUpperCase() + rnd(4);

  function fill(u) {
    u.transactions = u.transactions || [];
    u.beneficiaries = u.beneficiaries || [];
    u.cards = u.cards || [];
    u.balance = u.balance || 0;
    return u;
  }
  const me = () => { const u = Store.currentUser(); return u ? fill(u) : null; };
  const get = id => { const u = Store.users().find(x => x.id === id); return u ? fill(u) : null; };

  function save(u) {
    const users = Store.users();
    const i = users.findIndex(x => x.id === u.id);
    if (i >= 0) { users[i] = u; Store.save(users); }
  }

  function addTx(u, t) {
    u.balance += t.type === 'credit' ? t.amount : -t.amount;
    const tx = { id: ref(), date: Date.now(), status: 'Successful', ...t, balanceAfter: u.balance };
    u.transactions.unshift(tx);
    return tx;
  }

  function spentToday(u) {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return fill(u).transactions
      .filter(t => t.type === 'debit' && (t.category === 'transfer' || t.category === 'bill') && t.date >= start.getTime())
      .reduce((s, t) => s + t.amount, 0);
  }

  /* ---------- PIN ---------- */
  async function setPin(id, pin, current) {
    if (!/^\d{4}$/.test(pin)) return fail('PIN must be exactly 4 digits.');
    const u = get(id);
    if (u.pinHash) {
      const c = await checkPin(id, current || '');
      if (!c.ok) return c;
    }
    const salt = Math.random().toString(36).slice(2);
    Store.updateUser(id, { pinSalt: salt, pinHash: await hashPassword(pin, salt), pinFails: 0, pinLockUntil: 0 });
    return { ok: true };
  }

  async function checkPin(id, pin) {
    const u = get(id);
    if (!u || !u.pinHash) return fail('Set a transaction PIN first.');
    const now = Date.now();
    if (u.pinLockUntil && u.pinLockUntil > now) return fail(`PIN locked. Try again in ${Math.ceil((u.pinLockUntil - now) / 60000)} min.`);
    if ((await hashPassword(pin, u.pinSalt)) === u.pinHash) {
      if (u.pinFails) Store.updateUser(id, { pinFails: 0, pinLockUntil: 0 });
      return { ok: true };
    }
    const f = (u.pinFails || 0) + 1;
    if (f >= 5) { Store.updateUser(id, { pinFails: 0, pinLockUntil: now + 5 * 60000 }); return fail('Too many wrong attempts. PIN locked for 5 minutes.'); }
    Store.updateUser(id, { pinFails: f });
    return fail(`Incorrect PIN. ${5 - f} attempt${5 - f === 1 ? '' : 's'} left.`);
  }

  async function changePassword(id, current, next) {
    const u = get(id);
    if ((await hashPassword(current, u.salt)) !== u.passwordHash) return fail('Current password is incorrect.');
    if (next.length < 8) return fail('New password must be at least 8 characters.');
    const salt = Math.random().toString(36).slice(2);
    Store.updateUser(id, { salt, passwordHash: await hashPassword(next, salt) });
    return { ok: true };
  }

  /* ---------- Money movement ---------- */
  function lookup(acct) {
    const u = Store.users().find(x => x.accountNumber === acct);
    return u ? { id: u.id, name: u.name, acct: u.accountNumber } : null;
  }

  async function transfer(fromId, acct, amount, narration, pin) {
    const c = await checkPin(fromId, pin);
    if (!c.ok) return c;
    const users = Store.users();
    const s = users.find(u => u.id === fromId);
    const r = users.find(u => u.accountNumber === acct);
    if (!s) return fail('Session expired. Please log in again.');
    if (!r) return fail('Recipient account not found.');
    if (r.id === s.id) return fail("You can't send money to yourself.");
    if (!Number.isInteger(amount) || amount < 100) return fail('Minimum transfer is $1.00.');
    fill(s); fill(r);
    if (amount > s.balance) return fail('Insufficient balance.');
    if (spentToday(s) + amount > DAILY_LIMIT) return fail(`This would exceed your daily limit of ${fmt(DAILY_LIMIT)}.`);
    const note = (narration || '').slice(0, 60);
    const tx = addTx(s, { type: 'debit', category: 'transfer', amount, narration: note || 'Transfer', counterparty: { name: r.name, acct: r.accountNumber } });
    addTx(r, { type: 'credit', category: 'transfer', amount, narration: note || 'Transfer', counterparty: { name: s.name, acct: s.accountNumber } });
    Store.save(users);
    return { ok: true, tx };
  }

  // Demo funding so the features can be tried. Not real money.
  // src: { narration, name } describes where the money "came from".
  function fund(id, amount, src) {
    if (!Number.isInteger(amount) || amount < 100) return fail('Enter a valid amount.');
    if (amount > MAX_TOPUP) return fail(`Demo deposits are limited to ${fmt(MAX_TOPUP)} each.`);
    const u = get(id);
    const narration = String((src && src.narration) || 'Demo deposit').slice(0, 60);
    const name = String((src && src.name) || 'Demo funds').slice(0, 40);
    const tx = addTx(u, { type: 'credit', category: 'deposit', amount, narration, counterparty: { name, acct: '' } });
    save(u);
    return { ok: true, tx };
  }

  async function billPay(id, category, payee, accountRef, amount, pin) {
    const c = await checkPin(id, pin);
    if (!c.ok) return c;
    if (!BILL_CATEGORIES.includes(category)) return fail('Choose a bill type.');
    payee = (payee || '').trim().slice(0, 40);
    accountRef = (accountRef || '').trim().slice(0, 30);
    if (payee.length < 2) return fail('Enter the payee name.');
    if (accountRef.length < 4) return fail('Enter the account number from your bill.');
    if (!Number.isInteger(amount) || amount < 100) return fail('Minimum payment is $1.00.');
    const u = get(id);
    if (amount > u.balance) return fail('Insufficient balance.');
    if (spentToday(u) + amount > DAILY_LIMIT) return fail(`This would exceed your daily limit of ${fmt(DAILY_LIMIT)}.`);
    const tx = addTx(u, { type: 'debit', category: 'bill', amount, narration: `${category} bill`, counterparty: { name: payee, acct: accountRef } });
    save(u);
    return { ok: true, tx };
  }

  /* ---------- Beneficiaries ---------- */
  function addBeneficiary(id, b) {
    const u = get(id);
    if (u.beneficiaries.some(x => x.acct === b.acct)) return;
    u.beneficiaries.unshift({ name: b.name, acct: b.acct });
    u.beneficiaries = u.beneficiaries.slice(0, 12);
    save(u);
  }
  function removeBeneficiary(id, acct) {
    const u = get(id);
    u.beneficiaries = u.beneficiaries.filter(x => x.acct !== acct);
    save(u);
  }

  /* ---------- Debit cards ---------- */
  async function requestCard(id, o, pin) {
    const c = await checkPin(id, pin);
    if (!c.ok) return c;
    const tier = TIERS[o.tier];
    if (!tier) return fail('Choose a card type.');
    const u = get(id);
    if (u.cards.filter(x => x.status !== 'cancelled').length >= MAX_CARDS) return fail(`You can hold up to ${MAX_CARDS} cards.`);
    const name = (o.nameOnCard || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z .'-]{2,21}$/.test(name)) return fail('Name on card must be 3-22 letters.');
    if (tier.physical) {
      if ((o.address || '').trim().length < 5) return fail('Enter a full street address.');
      if ((o.city || '').trim().length < 2) return fail('Enter your city.');
      if (!/^[A-Z]{2}$/.test((o.state || '').trim())) return fail('Choose your state.');
      if (!/^\d{5}$/.test((o.zip || '').trim())) return fail('Enter a 5-digit ZIP code.');
      if ((o.phone || '').replace(/\D/g, '').length < 10) return fail('Enter a valid 10-digit phone number.');
    }
    if (tier.fee > u.balance) return fail(`Insufficient balance. This card has a ${fmt(tier.fee)} issuance fee. Add money first.`);

    const exp = new Date(); exp.setFullYear(exp.getFullYear() + 4);
    const card = {
      id: 'c_' + Date.now().toString(36) + rnd(3),
      kind: tier.physical ? 'physical' : 'virtual',
      tier: o.tier,
      nameOnCard: name,
      number: '9999' + rnd(12),
      cvv: rnd(3),
      expiry: String(exp.getMonth() + 1).padStart(2, '0') + '/' + String(exp.getFullYear()).slice(-2),
      status: tier.physical ? 'requested' : 'active',
      frozen: false,
      limit: 0,
      requestedAt: Date.now(),
      delivery: tier.physical ? { address: o.address.trim(), apt: (o.apt || '').trim(), city: o.city.trim(), state: o.state.trim(), zip: o.zip.trim(), phone: o.phone.trim() } : null
    };
    u.cards.push(card);
    let tx = null;
    if (tier.fee > 0) tx = addTx(u, { type: 'debit', category: 'fee', amount: tier.fee, narration: `${tier.label} debit card issuance fee`, counterparty: { name: 'Vaulta', acct: '' } });
    save(u);
    return { ok: true, card, tx };
  }

  function patchCard(id, cardId, fn) {
    const u = get(id);
    const c = u.cards.find(x => x.id === cardId);
    if (!c) return fail('Card not found.');
    const r = fn(c, u);
    if (r && r.ok === false) return r;
    save(u);
    return { ok: true, card: c };
  }

  // Demo helper: moves a physical card one delivery stage forward (up to "delivered").
  const advanceCard = (id, cardId) => patchCard(id, cardId, c => {
    const i = STAGES.indexOf(c.status);
    if (c.kind !== 'physical' || i < 0 || i >= STAGES.indexOf('delivered')) return fail('Nothing to advance.');
    c.status = STAGES[i + 1];
  });

  async function activateCard(id, cardId, pin) {
    const k = await checkPin(id, pin);
    if (!k.ok) return k;
    return patchCard(id, cardId, c => { if (c.status !== 'delivered') return fail('This card is not ready to activate.'); c.status = 'active'; });
  }
  const toggleFreeze = (id, cardId) => patchCard(id, cardId, c => {
    if (c.status !== 'active') return fail('Only active cards can be frozen.');
    c.frozen = !c.frozen;
  });
  const setCardLimit = (id, cardId, limit) => patchCard(id, cardId, c => {
    if (!Number.isInteger(limit) || limit < 0 || limit > DAILY_LIMIT) return fail(`Limit must be between $0 and ${fmt(DAILY_LIMIT)}.`);
    c.limit = limit;
  });
  const cancelCard = (id, cardId) => patchCard(id, cardId, c => { c.status = 'cancelled'; });

  async function revealCard(id, cardId, pin) {
    const k = await checkPin(id, pin);
    if (!k.ok) return k;
    const c = get(id).cards.find(x => x.id === cardId);
    if (!c || c.status !== 'active') return fail('Details are available once the card is active.');
    return { ok: true, number: c.number, cvv: c.cvv, expiry: c.expiry };
  }

  /* ---------- Statements ---------- */
  function toCsv(u, txs) {
    const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const rows = [['Date', 'Reference', 'Type', 'Category', 'Counterparty', 'Narration', 'Amount (USD)', 'Balance after (USD)', 'Status']];
    txs.forEach(t => rows.push([
      new Date(t.date).toISOString(), t.id, t.type, t.category, (t.counterparty && t.counterparty.name) || '', t.narration || '',
      ((t.type === 'credit' ? 1 : -1) * t.amount / 100).toFixed(2), (t.balanceAfter / 100).toFixed(2), t.status
    ]));
    return rows.map(r => r.map(q).join(',')).join('\n');
  }

  return {
    DAILY_LIMIT, MAX_TOPUP, MAX_CARDS, ROUTING, BILL_CATEGORIES, TIERS, STAGES, STAGE_LABEL,
    fmt, toKobo, me, get, spentToday,
    setPin, checkPin, changePassword,
    lookup, transfer, fund, billPay, addBeneficiary, removeBeneficiary,
    requestCard, advanceCard, activateCard, toggleFreeze, setCardLimit, cancelCard, revealCard,
    toCsv
  };
})();
