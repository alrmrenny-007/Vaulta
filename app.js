/* Vaulta shared logic
   DEMO ONLY: data lives in this browser's localStorage.
   Replace with a real backend before handling real users or money. */

const USERS_KEY = 'vaulta_users';
const SESSION_KEY = 'vaulta_session';
const THEMES = {
  emerald: 'linear-gradient(135deg,#0d7a56,#2ee59d)',
  ocean: 'linear-gradient(135deg,#0b4f8a,#18b4ff)',
  sunset: 'linear-gradient(135deg,#b3341f,#ffb347)',
  violet: 'linear-gradient(135deg,#4b2a9a,#b983ff)'
};

const Store = {
  users() { try { return JSON.parse(localStorage.getItem(USERS_KEY)) || []; } catch { return []; } },
  save(users) { localStorage.setItem(USERS_KEY, JSON.stringify(users)); },
  session() { return localStorage.getItem(SESSION_KEY); },
  setSession(id) { localStorage.setItem(SESSION_KEY, id); },
  clearSession() { localStorage.removeItem(SESSION_KEY); },
  currentUser() { const id = Store.session(); return Store.users().find(u => u.id === id) || null; },
  updateUser(id, patch) {
    const users = Store.users();
    const i = users.findIndex(u => u.id === id);
    if (i === -1) return;
    users[i] = { ...users[i], ...patch };
    Store.save(users);
  }
};

async function hashPassword(pw, salt) {
  const data = new TextEncoder().encode(salt + ':' + pw);
  if (!window.crypto || !crypto.subtle) return btoa(unescape(encodeURIComponent(salt + pw)));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const Account = {
  MIN: 8, MAX: 12,
  isValidFormat: n => /^\d{8,12}$/.test(n),
  isTaken(n, exceptUserId) { return Store.users().some(u => u.accountNumber === n && u.id !== exceptUserId); },
  random() {
    let n;
    do {
      n = String(1 + Math.floor(Math.random() * 9));
      for (let i = 1; i < 10; i++) n += Math.floor(Math.random() * 10);
    } while (Account.isTaken(n));
    return n;
  },
  fromPhone(phone) {
    const d = (phone || '').replace(/\D/g, '');
    return d.length >= 10 ? d.slice(-10) : '';
  },
  // Suggest free numbers that keep the user's chosen leading digits
  suggest(prefix, count = 4) {
    const base = (prefix || '').replace(/\D/g, '').slice(0, 9);
    const out = new Set();
    let guard = 0;
    while (out.size < count && guard++ < 200) {
      let n = base;
      while (n.length < 10) n += Math.floor(Math.random() * 10);
      if (n[0] === '0' && !base) continue;
      if (!Account.isTaken(n)) out.add(n);
    }
    return [...out];
  },
  format: n => (n || '').replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3'),
  // Returns {ok, msg}
  check(n, exceptUserId) {
    if (!n) return { ok: false, msg: 'Enter an account number (8 to 12 digits).' };
    if (!/^\d+$/.test(n)) return { ok: false, msg: 'Digits only.' };
    if (n.length < 8) return { ok: false, msg: `At least 8 digits needed (${8 - n.length} more).` };
    if (n.length > 12) return { ok: false, msg: 'Maximum 12 digits.' };
    if (Account.isTaken(n, exceptUserId)) return { ok: false, msg: 'That number is already taken. Try another.' };
    return { ok: true, msg: 'Available. This can be your account number.' };
  }
};

function togglePw(btn) {
  const input = btn.parentElement.querySelector('input');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? 'HIDE' : 'SHOW';
}

function showAlert(el, type, msg) { el.className = 'alert ' + type; el.textContent = msg; }
function newId() { return 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

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
