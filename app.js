/* Vaulta shared browser code.
   All accounts, balances and rules live on the server (/api). This file only sends requests
   and holds small UI helpers. Nothing sensitive is kept in the browser. */

const THEMES = {
  emerald: 'linear-gradient(135deg,#0d7a56,#2ee59d)',
  ocean: 'linear-gradient(135deg,#0b4f8a,#18b4ff)',
  sunset: 'linear-gradient(135deg,#b3341f,#ffb347)',
  violet: 'linear-gradient(135deg,#4b2a9a,#b983ff)'
};

const API = {
  async call(method, path, body) {
    let res;
    try {
      res = await fetch('/api' + path, {
        method, credentials: 'same-origin',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      return { ok: false, status: 0, code: 'NETWORK', msg: 'Network problem. Check your connection and try again.' };
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (res.ok && data.ok !== false) return Object.assign({}, data, { ok: true, status: res.status });
    const fallback = res.status === 404 ? 'The server part of the site is not set up yet (API not found).' : 'Something went wrong. Please try again.';
    return Object.assign({}, data, { ok: false, status: res.status, msg: data.error || fallback });
  },
  get(p) { return API.call('GET', p); },
  post(p, b) { return API.call('POST', p, b || {}); },
  patch(p, b) { return API.call('PATCH', p, b || {}); },
  del(p) { return API.call('DELETE', p); }
};

const Account = {
  MIN: 8, MAX: 12,
  fromPhone(phone) { const d = (phone || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; },
  format: n => n || '',
  // Quick checks in the browser. The server checks everything again.
  localCheck(n) {
    if (!n) return { ok: false, msg: 'Enter an account number (8 to 12 digits).' };
    if (!/^\d+$/.test(n)) return { ok: false, msg: 'Digits only.' };
    if (n.length < 8) return { ok: false, msg: `At least 8 digits needed (${8 - n.length} more).` };
    if (n.length > 12) return { ok: false, msg: 'Maximum 12 digits.' };
    return { ok: true, msg: '' };
  },
  async check(n) {
    const l = Account.localCheck(n);
    if (!l.ok) return l;
    const r = await API.get('/account/check?n=' + encodeURIComponent(n));
    if (!r.ok) return { ok: false, msg: r.msg };
    return { ok: r.available, msg: r.message };
  },
  async random() { const r = await API.get('/account/random'); return r.ok ? r.accountNumber : ''; },
  async suggest(prefix) { const r = await API.get('/account/suggest?prefix=' + encodeURIComponent(prefix || '')); return r.ok ? r.suggestions : []; }
};

function togglePw(btn) {
  const input = btn.parentElement.querySelector('input');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? 'HIDE' : 'SHOW';
}
function showAlert(el, type, msg) { el.className = 'alert ' + type; el.textContent = msg; }

/* ---- UI effects (motion helpers shared by all pages) ---- */
const FX = {
  reduced: typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  countUp(el, value, fmtFn, ms = 900) {
    const set = v => { el.textContent = fmtFn(v); };
    if (FX.reduced || typeof requestAnimationFrame !== 'function' || !value) { set(value); return; }
    const t0 = performance.now();
    const tick = now => {
      const p = Math.min(1, (now - t0) / ms);
      set(Math.round(value * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },
  tilt(root) {
    if (FX.reduced || !root || !root.querySelectorAll) return;
    root.querySelectorAll('[data-tilt]').forEach(el => {
      if (el._tilt) return; el._tilt = true;
      el.addEventListener('pointermove', e => {
        if (e.pointerType === 'touch') return;
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
        el.style.transform = `perspective(900px) rotateY(${x * 12}deg) rotateX(${-y * 12}deg) translateY(-3px)`;
      });
      el.addEventListener('pointerleave', () => { el.style.transform = ''; });
    });
  },
  reveal(root) {
    const els = (root || document).querySelectorAll('.reveal:not(.in)');
    if (FX.reduced || !('IntersectionObserver' in window)) { els.forEach(e => e.classList.add('in')); return; }
    const io = new IntersectionObserver(list => list.forEach(en => {
      if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    }), { threshold: 0.15 });
    els.forEach(e => io.observe(e));
  },
  scramble(el, target) {
    if (FX.reduced) { el.textContent = target; return; }
    let f = 0;
    const t = setInterval(() => {
      f++;
      el.textContent = target.split('').map((c, i) => (c === ' ' || i < f / 1.5) ? c : Math.floor(Math.random() * 10)).join('');
      if (f > target.length * 1.5 + 1) { clearInterval(t); el.textContent = target; }
    }, 45);
  }
};
