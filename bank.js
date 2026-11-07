/* Vaulta banking client. Every rule (PIN, limits, fees, balances) is enforced by the server.
   This file sends requests and keeps display values; the server sends the real fees and
   limits each time the dashboard loads (see applyConfig). */
const Bank = (() => {
  const B = {
    ROUTING: '999000014',
    DAILY_LIMIT: 50000000,
    MAX_TOPUP: 500000,
    MAX_CARDS: 3,
    BILL_CATEGORIES: ['Electric', 'Gas & Water', 'Internet & Cable', 'Mobile Phone', 'Credit Card', 'Rent & Other'],
    STATES: 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '),
    // fee / label / physical come from the server; the colours and notes are display only
    TIERS: {
      standard: { label: 'Standard', fee: 1500, physical: true,  bg: 'linear-gradient(135deg,#1c2538,#3e4e70)', note: 'Physical card. Arrives in 10-15 business days.' },
      platinum: { label: 'Premier',  fee: 3500, physical: true,  bg: 'linear-gradient(135deg,#2a2210,#c09a45)', note: 'Premium design. Expedited, 5-10 business days.' }
    },
    STAGES: ['requested', 'processing', 'shipped', 'delivered', 'active'],
    STAGE_LABEL: { requested: 'Requested', processing: 'Processing', shipped: 'On the way', delivered: 'Delivered', active: 'Active' }
  };

  B.fmt = k => (k < 0 ? '-' : '') + '$' + (Math.abs(k) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  B.toKobo = s => { const n = Math.round(parseFloat(String(s).replace(/,/g, '')) * 100); return Number.isFinite(n) ? n : NaN; };   // dollars text -> cents
  B.newKey = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));

  B.applyConfig = c => {
    if (!c) return;
    B.ROUTING = c.routing; B.DAILY_LIMIT = c.dailyLimit; B.MAX_TOPUP = c.maxDeposit; B.MAX_CARDS = c.maxCards;
    B.BILL_CATEGORIES = c.billCategories; B.STATES = c.states;
    Object.keys(c.tiers).forEach(k => { if (B.TIERS[k]) Object.assign(B.TIERS[k], c.tiers[k]); });
  };

  // Loads everything the dashboard needs. On success: r.me
  B.load = async () => {
    const r = await API.get('/me');
    if (!r.ok) return r;
    B.applyConfig(r.config);
    r.me = Object.assign({}, r.user, { cards: r.cards, beneficiaries: r.beneficiaries, transactions: r.transactions, hasMoreTx: r.hasMoreTx, spentToday: r.spentToday });
    return r;
  };
  B.spentToday = me => (me && me.spentToday) || 0;

  // The first argument (user id) is kept for older call sites; the server uses the login session instead.
  B.setPin = (_id, pin, current) => API.post('/me/pin', { pin, current });
  B.changePassword = (_id, current, next) => API.post('/me/password', { current, next });
  B.lookup = acct => API.get('/lookup?acct=' + encodeURIComponent(acct));
  B.transfer = (_id, acct, amount, narration, pin, idemKey) => API.post('/transfer', { toAccount: acct, amount, narration, pin, idemKey });
  B.billPay = (_id, category, payee, reference, amount, pin, idemKey) => API.post('/bills', { category, payee, reference, amount, pin, idemKey });
  B.fund = (_id, amount, src) => API.post('/deposit', Object.assign({}, src, { amount }));
  B.addBeneficiary = (_id, rec) => API.post('/beneficiaries', { acct: rec.acct });
  B.requestCard = (_id, o, pin) => API.post('/cards', Object.assign({}, o, { pin }));
  B.advanceCard = (_id, cid) => API.post(`/cards/${cid}/advance`);
  B.activateCard = (_id, cid, pin) => API.post(`/cards/${cid}/activate`, { pin });
  B.toggleFreeze = (_id, cid) => API.post(`/cards/${cid}/freeze`);
  B.setCardLimit = (_id, cid, limit) => API.post(`/cards/${cid}/limit`, { limit });
  B.cancelCard = (_id, cid) => API.post(`/cards/${cid}/cancel`);
  B.revealCard = (_id, cid, pin) => API.post(`/cards/${cid}/reveal`, { pin });
  return B;
})();
