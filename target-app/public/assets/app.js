/* =========================================================================
   MyFiat — online banking web UI (DEMO). Fictional institution, fake data.
   Thin client over the MyFiat API. Session token (from POST /api/login) is
   kept in localStorage and sent as a Bearer token on every API call.
   A `?mock=1` flag serves an in-memory dataset so the UI can be previewed
   without the backend; by default every page calls the real same-origin API.
   ========================================================================= */
'use strict';

const SESSION_KEY = 'myfiat_session';
// Local dev runs the assistant on its own port; deployed, Caddy serves it same-origin.
const ASSIST_URL = location.hostname === 'localhost' ? 'http://localhost:8072/assistant/chat' : '/assistant/chat';

/* ---- mock mode ---------------------------------------------------------- */
const MOCK = (() => {
  try {
    const u = new URL(location.href);
    if (u.searchParams.get('mock') === '1') sessionStorage.setItem('myfiat_mock', '1');
    if (u.searchParams.get('mock') === '0') sessionStorage.removeItem('myfiat_mock');
    return sessionStorage.getItem('myfiat_mock') === '1';
  } catch { return false; }
})();
function mockQS() { return MOCK ? (location.search.includes('mock=1') ? '' : '?mock=1') : ''; }

/* ---- session ------------------------------------------------------------ */
function getSession() {
  if (MOCK) return { token: 'mock-token', user: { id: 1, name: 'Avery Chen', email: 'avery@myfiat.io', role: 'customer' } };
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
  catch { return null; }
}
function setSession(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {} }
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch {} }
function requireAuth() {
  const s = getSession();
  if (!s || !s.user) { location.replace('/' + mockQS()); return null; }
  return s;
}
function logout() { clearSession(); location.replace('/'); }

/* ---- api ---------------------------------------------------------------- */
async function api(path, opts = {}) {
  if (MOCK) return mockApi(path, opts);
  const s = getSession();
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (s?.token) headers['Authorization'] = 'Bearer ' + s.token;
  let res;
  try { res = await fetch(path, { ...opts, headers }); }
  catch (e) { return { ok: false, status: 0, body: { error: 'network error' } }; }
  let body = null;
  try { body = await res.json(); } catch {}
  if (res.status === 401 && !path.includes('/login')) { clearSession(); location.replace('/'); }
  return { ok: res.ok, status: res.status, body };
}

/* ---- formatting --------------------------------------------------------- */
function fmtMoney(cents, { sign = false, cents2 = true } = {}) {
  const v = (Number(cents) || 0) / 100;
  const s = v.toLocaleString('en-US', { style: 'currency', currency: 'USD',
    minimumFractionDigits: cents2 ? 2 : 0, maximumFractionDigits: cents2 ? 2 : 0 });
  if (sign && v > 0) return '+' + s;
  return s;
}
function fmtMoneyShort(cents) {
  const v = Math.abs(Number(cents) || 0) / 100;
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return '$' + v.toFixed(0);
}
function fmtPct(p, { sign = true } = {}) {
  const n = Number(p) || 0;
  return (sign && n > 0 ? '+' : '') + n.toFixed(2) + '%';
}
function fmtDate(iso, long = false) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', long ? { year: 'numeric', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
}
function fmtRel(iso) {
  const d = new Date(iso); if (isNaN(d)) return '';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd ago';
  return fmtDate(iso);
}
function fmtDue(iso) {
  const d = new Date(iso); if (isNaN(d)) return '';
  const days = Math.ceil((d - Date.now()) / 86400000);
  if (days <= 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  if (days < 14) return 'in ' + days + ' days';
  return 'on ' + fmtDate(iso);
}
function initials(name) {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function isCredit(tx) {
  const d = (tx.description || '') + ' ' + (tx.merchant || '');
  if (/payroll|deposit|refund|transfer in|interest/i.test(d)) return true;
  if (tx.status === 'refunded') return true;
  if (tx.direction === 'credit') return true;
  return false;
}
function hueFor(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function brandColor(str) { const h = hueFor(str); return `hsl(${h} 42% 42%)`; }

/* ---- toast & modal ------------------------------------------------------ */
function toast(msg, isErr = false) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 4200);
}
function openModal(title, bodyHtml) {
  closeModal();
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <div class="modal__head"><h3>${esc(title)}</h3><button class="modal__x" aria-label="Close">${ICONS.x}</button></div>
      <div class="modal__body">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(back);
  back.addEventListener('click', e => { if (e.target === back) closeModal(); });
  back.querySelector('.modal__x').addEventListener('click', closeModal);
  document.addEventListener('keydown', escClose);
  if (!document.getElementById('modal-style')) {
    const st = document.createElement('style'); st.id = 'modal-style';
    st.textContent = `.modal-back{position:fixed;inset:0;background:rgba(14,16,20,.5);backdrop-filter:blur(3px);z-index:110;display:grid;place-items:center;padding:20px;animation:fade .15s}
      @keyframes fade{from{opacity:0}to{opacity:1}}
      .modal{background:var(--surface);border:1px solid var(--line);border-radius:18px;width:100%;max-width:440px;box-shadow:var(--shadow-lg);overflow:hidden;animation:asstin .2s}
      .modal__head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid var(--line)}
      .modal__head h3{margin:0;font-size:1.1rem}
      .modal__x{background:var(--surface-3);border:none;width:32px;height:32px;border-radius:9px;cursor:pointer;display:grid;place-items:center;color:var(--muted)}
      .modal__x svg{width:16px;height:16px}.modal__x:hover{background:var(--paper-2)}
      .modal__body{padding:20px}`;
    document.head.appendChild(st);
  }
  return back;
}
function closeModal() { document.querySelector('.modal-back')?.remove(); document.removeEventListener('keydown', escClose); }
function escClose(e) { if (e.key === 'Escape') closeModal(); }

/* ---- shared chrome ------------------------------------------------------ */
function paintChrome(session) {
  const u = session.user;
  document.querySelectorAll('[data-fill="name"]').forEach(e => e.textContent = u.name);
  document.querySelectorAll('[data-fill="email"]').forEach(e => e.textContent = u.email);
  document.querySelectorAll('[data-fill="initials"]').forEach(e => e.textContent = initials(u.name));
  document.querySelectorAll('[data-fill="role"]').forEach(e => e.textContent = u.role);
  document.querySelectorAll('[data-action="logout"]').forEach(e =>
    e.addEventListener('click', ev => { ev.preventDefault(); logout(); }));
}

/* ---- icons -------------------------------------------------------------- */
const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
  card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20"/></svg>',
  repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/></svg>',
  pie: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9h-9Z"/><path d="M13 3a8 8 0 0 1 8 8h-8Z"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5S20 17 20 21"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/></svg>',
  snow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M4.9 5.6l14.2 12.8M19.1 5.6 4.9 18.4M2 12h20"/></svg>',
  bill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l5 5v15H6Z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6Z"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  logoutIco: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/></svg>',
  arrowUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  arrowDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.5a2 2 0 0 0-1.8-1H7.3a2 2 0 0 0-1.8 1Z"/></svg>',
};
const NET_ICON = {
  visa: '<span class="cc-net" style="font-style:italic">VISA</span>',
  mastercard: '<svg width="40" height="26" viewBox="0 0 40 26"><circle cx="15" cy="13" r="10" fill="#EB001B" opacity=".9"/><circle cx="25" cy="13" r="10" fill="#F79E1B" opacity=".85"/></svg>',
  amex: '<span class="cc-net" style="font-style:normal;font-size:.8rem;letter-spacing:.02em">AMEX</span>',
};

/* ---- brand -------------------------------------------------------------- */
function logoMark(cls = '') {
  const id = 'mfg' + Math.random().toString(36).slice(2, 7);
  return `<svg class="mark ${cls}" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#15917a"/><stop offset="1" stop-color="#0a4c3d"/></linearGradient></defs>
    <rect width="32" height="32" rx="9" fill="url(#${id})"/>
    <path d="M7.5 22.5V12l4.4 4.6L16 10l4.1 6.6L24.5 12v10.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="16" cy="22.6" r="1.5" fill="#6fe3c2"/>
  </svg>`;
}
function brandMark(light = false) {
  return `<span class="brand ${light ? 'brand--light' : ''}">${logoMark()}<span class="word">My<b>Fiat</b></span></span>`;
}

const NAV = [
  ['MONEY', [
    ['/dashboard.html', 'home', 'Dashboard'],
    ['/transactions.html', 'list', 'Transactions'],
    ['/cards.html', 'card', 'Cards'],
  ]],
  ['GROW', [
    ['/investments.html', 'chart', 'Investments'],
    ['/markets.html', 'spark', 'Markets'],
    ['/subscriptions.html', 'repeat', 'Subscriptions'],
    ['/insights.html', 'pie', 'Insights'],
  ]],
  ['ACCOUNT', [
    ['/profile.html', 'user', 'Profile'],
  ]],
];

function renderShell(active, session) {
  const groups = NAV.map(([label, links]) => `
    <div class="nav__label">${label}</div>
    <nav class="nav">${links.map(([href, icon, txt]) =>
      `<a href="${href}${mockQS()}" class="${href === active ? 'active' : ''}">${ICONS[icon]}<span>${txt}</span></a>`).join('')}
    </nav>`).join('');

  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.innerHTML = `
      <a href="/dashboard.html${mockQS()}">${brandMark()}</a>
      ${groups}
      <div class="sidebar__foot">
        <div class="usercard">
          <div class="avatar" data-fill="initials"></div>
          <div class="meta"><b data-fill="name"></b><span data-fill="email"></span></div>
        </div>
        <a href="#" class="signout" data-action="logout">${ICONS.logoutIco}<span>Sign out</span></a>
      </div>`;
  }
  const mobile = document.getElementById('mobilebar');
  if (mobile) {
    const flat = NAV.flatMap(([, l]) => l);
    mobile.innerHTML = `${brandMark()}<div class="mnav">${flat.map(([href, , txt]) =>
      `<a href="${href}${mockQS()}" class="${href === active ? 'active' : ''}">${txt}</a>`).join('')}</div>`;
  }
  paintChrome(session);
  mountAssistant(session);
}

/* synth a short price series from a current price + change, for sparklines */
function synthSeries(priceCents, changePct, n = 16) {
  const p = priceCents / 100, start = p / (1 + (changePct || 0) / 100), out = [];
  for (let i = 0; i < n; i++) { const t = i / (n - 1); out.push(start + (p - start) * t + (Math.random() - 0.5) * p * 0.012); }
  out[n - 1] = p; return out;
}

/* ---- sparkline ---------------------------------------------------------- */
function sparkSvg(series, positive, w = 70, h = 30) {
  if (!series || series.length < 2) series = [1, 1];
  const min = Math.min(...series), max = Math.max(...series), span = (max - min) || 1;
  const pts = series.map((v, i) => `${(i / (series.length - 1) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(' ');
  const col = positive ? 'var(--pos)' : 'var(--neg)';
  const id = 'sg' + Math.random().toString(36).slice(2, 7);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".22"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <polygon points="1,${h - 1} ${pts} ${w - 1},${h - 1}" fill="url(#${id})"/>
    <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/* =========================================================================
   ASSISTANT WIDGET  (customer-side "MyFiat Assistant" / Ari)
   ========================================================================= */
const ASSIST_PROMPTS = ['What are my subscriptions?', 'How are my stocks doing?', 'Renew my expiring card', 'Any suspicious charges?'];
let _asstBooted = false;
function mountAssistant(session) {
  if (_asstBooted || document.getElementById('asstFab')) return;
  _asstBooted = true;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <button class="asst-fab" id="asstFab">${ICONS.spark}<span>Ask MyFiat</span></button>
    <div class="asst-panel" id="asstPanel" aria-live="polite">
      <div class="asst-head">
        <div class="ava">${ICONS.spark}</div>
        <div class="t"><b>MyFiat Assistant</b><span id="asstStatus"><span class="blip"></span> Online</span></div>
        <button class="x" id="asstClose">${ICONS.x}</button>
      </div>
      <div class="asst-body" id="asstBody"></div>
      <div class="chips" id="asstChips"></div>
      <div class="asst-foot">
        <textarea id="asstInput" rows="1" placeholder="Ask about your money…"></textarea>
        <button class="asst-send" id="asstSend">${ICONS.send}</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const fab = wrap.querySelector('#asstFab');
  const panel = wrap.querySelector('#asstPanel');
  const body = wrap.querySelector('#asstBody');
  const chips = wrap.querySelector('#asstChips');
  const input = wrap.querySelector('#asstInput');
  const send = wrap.querySelector('#asstSend');

  let greeted = false;
  function open() {
    panel.classList.add('open'); fab.classList.add('hide'); input.focus();
    if (!greeted) {
      greeted = true;
      addMsg('bot', `Hi ${session.user.name.split(' ')[0]} — I'm your MyFiat Assistant. I can check balances, subscriptions, investments and card activity for you. What would you like to do?`);
      renderChips();
    }
  }
  function close() { panel.classList.remove('open'); fab.classList.remove('hide'); }
  fab.addEventListener('click', open);
  wrap.querySelector('#asstClose').addEventListener('click', close);

  function renderChips() { chips.innerHTML = ASSIST_PROMPTS.map(p => `<button class="chip">${esc(p)}</button>`).join(''); chips.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { input.value = c.textContent; submit(); })); }
  function addMsg(role, text) { const m = document.createElement('div'); m.className = 'msg ' + role; m.textContent = text; body.appendChild(m); body.scrollTop = body.scrollHeight; return m; }
  function addActions(actions) {
    if (!actions || !actions.length) return;
    const last = body.querySelector('.msg.bot:last-of-type') || body.lastElementChild;
    const box = document.createElement('div'); box.className = 'action-chips';
    actions.forEach(a => {
      const b = document.createElement('button'); b.className = 'action-chip';
      b.innerHTML = `${ICONS.check}<span>${esc(a.label || a.title || 'Confirm')}</span>`;
      b.addEventListener('click', () => { b.disabled = true; b.style.opacity = '.6'; confirmAction(a); });
      box.appendChild(b);
    });
    last.appendChild(box); body.scrollTop = body.scrollHeight;
  }
  async function confirmAction(a) {
    addMsg('me', (a.label || 'Confirm') + ' ✓');
    // Best-effort: run a known endpoint if the action names one, else acknowledge.
    try {
      if (a.endpoint) { const { ok } = await api(a.endpoint, { method: a.method || 'POST', body: a.body ? JSON.stringify(a.body) : undefined }); addMsg('bot', ok ? 'Done — that action is complete.' : 'I could not complete that just now.'); }
      else addMsg('bot', 'Confirmed. I’ve noted that for you.');
    } catch { addMsg('bot', 'Something went wrong completing that.'); }
  }

  let busy = false;
  async function submit() {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true; send.disabled = true;
    addMsg('me', text); input.value = ''; input.style.height = 'auto';
    chips.innerHTML = '';
    const typing = document.createElement('div'); typing.className = 'typing'; typing.innerHTML = '<i></i><i></i><i></i>';
    body.appendChild(typing); body.scrollTop = body.scrollHeight;
    setStatus(true);
    const session2 = getSession();
    let reply = null, offline = false;
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(ASSIST_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, token: session2?.token }), signal: ctrl.signal,
      });
      clearTimeout(to);
      reply = await res.json().catch(() => null);
    } catch { offline = true; }
    typing.remove(); busy = false; send.disabled = false;
    if (offline || !reply) {
      setStatus(false);
      addMsg('err', 'The MyFiat Assistant is offline right now. Your request wasn’t sent — please try again in a moment.');
      return;
    }
    setStatus(true);
    const msg = reply.reply || reply.message || reply.text || reply.answer || (typeof reply === 'string' ? reply : 'I’m not sure how to help with that yet.');
    addMsg('bot', msg);
    addActions(reply.actions || reply.action_chips);
  }
  function setStatus(online) {
    const s = document.getElementById('asstStatus');
    if (!s) return;
    s.className = online ? '' : 'off';
    s.innerHTML = `<span class="blip"></span> ${online ? 'Online' : 'Offline'}`;
  }

  send.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 110) + 'px'; });

  // open automatically if URL asks (?assistant=1) — handy for screenshots.
  try { if (new URL(location.href).searchParams.get('assistant') === '1') open(); } catch {}
  window.MyFiatAssistant = { open };
}

/* =========================================================================
   MOCK API  (?mock=1)  — in-memory, mutable so actions reflect live.
   ========================================================================= */
const _M = (() => {
  const now = Date.now(), day = 86400000;
  const mkSeries = (base, vol, up) => { const a = []; let v = base; for (let i = 0; i < 16; i++) { v += (Math.random() - (up ? .42 : .58)) * vol; a.push(Math.max(v, base * .5)); } return a; };
  return {
    user: { id: 1, name: 'Avery Chen', email: 'avery@myfiat.io', role: 'customer' },
    accounts: [
      { id: 1, kind: 'checking', name: 'Everyday Checking', mask: '4821', balance_cents: 1248022, apy_bps: 10 },
      { id: 2, kind: 'savings', name: 'High-Yield Savings', mask: '8842', balance_cents: 3892000, apy_bps: 385 },
      { id: 3, kind: 'credit', name: 'MyFiat Signature Card', mask: '0417', balance_cents: -120455, apy_bps: 0 },
    ],
    cards: [
      { id: 1, brand: 'visa', last4: '4821', exp_month: 8, exp_year: 2028, status: 'active', kind: 'Debit · Everyday', visual: 'v-emerald' },
      { id: 2, brand: 'mastercard', last4: '0417', exp_month: 11, exp_year: 2026, status: 'active', kind: 'Credit · Signature', visual: 'v-ink' },
      { id: 3, brand: 'visa', last4: '3390', exp_month: 3, exp_year: 2027, status: 'frozen', kind: 'Virtual · Online', visual: 'v-sand' },
    ],
    subs: [
      { id: 1, merchant_name: 'Streamly', amount_cents: 1599, cadence: 'monthly', next_charge_at: new Date(now + 6 * day).toISOString(), status: 'active', category: 'Entertainment' },
      { id: 2, merchant_name: 'Contoso Cloud', amount_cents: 4900, cadence: 'monthly', next_charge_at: new Date(now + 2 * day).toISOString(), status: 'active', category: 'Software' },
      { id: 3, merchant_name: 'Vantage Fitness', amount_cents: 3900, cadence: 'monthly', next_charge_at: new Date(now + 11 * day).toISOString(), status: 'active', category: 'Fitness' },
      { id: 4, merchant_name: 'Stark Mobile', amount_cents: 6000, cadence: 'monthly', next_charge_at: new Date(now + 18 * day).toISOString(), status: 'active', category: 'Telecom' },
      { id: 5, merchant_name: 'Umbrella Pharmacy+', amount_cents: 3600, cadence: 'quarterly', next_charge_at: new Date(now + 24 * day).toISOString(), status: 'active', category: 'Healthcare' },
      { id: 6, merchant_name: 'Lumen News', amount_cents: 1200, cadence: 'monthly', next_charge_at: new Date(now + 9 * day).toISOString(), status: 'active', category: 'News' },
    ],
    holdings: {
      stocks: [
        { symbol: 'AAPL', name: 'Apple Inc.', quantity: 42, price_cents: 23140, series: mkSeries(210, 6, true) },
        { symbol: 'NVDA', name: 'NVIDIA Corp.', quantity: 28, price_cents: 94550, series: mkSeries(880, 40, true) },
        { symbol: 'MSFT', name: 'Microsoft Corp.', quantity: 15, price_cents: 42310, series: mkSeries(410, 10, true) },
        { symbol: 'TSLA', name: 'Tesla Inc.', quantity: 20, price_cents: 24880, series: mkSeries(260, 14, false) },
      ],
      crypto: [
        { symbol: 'BTC', name: 'Bitcoin', quantity: 0.34 },
        { symbol: 'ETH', name: 'Ethereum', quantity: 4.2 },
        { symbol: 'SOL', name: 'Solana', quantity: 65 },
      ],
    },
    alerts: [
      { id: 1, kind: 'suspicious_charge', severity: 'high', title: 'Possible fraudulent charge', detail: '$1,299.00 at Northwind Electronics (Lagos, NG) — far from your usual activity. Was this you?', txn_id: 9001, card_id: 2, status: 'open', created_at: new Date(now - 2 * 3600e3).toISOString() },
      { id: 2, kind: 'card_expiring', severity: 'warn', title: 'Your Signature card expires soon', detail: 'Card ending 0417 expires 11/2026. Renew now to avoid interrupted payments.', txn_id: null, card_id: 2, status: 'open', created_at: new Date(now - 26 * 3600e3).toISOString() },
    ],
    txns: null,
  };
})();
(function seedTxns() {
  const merchants = [
    ['Blue Bottle Coffee', 'food_and_drink', 540], ['Greenleaf Grocery', 'groceries', 8215],
    ['RideNow', 'transport', 1840], ['Streamly', 'entertainment', 1599], ['Lumen Energy', 'utilities', 9420],
    ['Stark Mobile', 'telecom', 6000], ['Vantage Fitness', 'fitness', 3900], ['Soylent Diner', 'food_and_drink', 3210],
    ['Northwind Electronics', 'retail', 12999], ['Globex Airlines', 'travel', 48900], ['Contoso Cloud', 'software', 4900],
    ['Fabrikam Home', 'retail', 7600], ['Umbrella Pharmacy', 'healthcare', 2240], ['Initech Payroll', 'income', 412000],
    ['MyFiat Transfer', 'transfer', 50000],
  ];
  const statuses = ['succeeded', 'succeeded', 'succeeded', 'succeeded', 'pending', 'failed', 'refunded'];
  const out = []; const now = Date.now();
  for (let i = 0; i < 68; i++) {
    const m = merchants[i % merchants.length];
    const credit = m[1] === 'income' || m[1] === 'transfer';
    out.push({
      id: 1000 + i, amount_cents: Math.round(m[2] * (0.7 + Math.random() * 0.6)),
      currency: 'USD', status: statuses[Math.floor(Math.random() * statuses.length)],
      description: credit ? (m[1] === 'income' ? 'Payroll deposit' : 'Transfer in') : m[0],
      merchant: m[0], category: m[1], direction: credit ? 'credit' : 'debit',
      user_name: 'Avery Chen', user_email: 'avery@myfiat.io',
      created_at: new Date(now - i * 10.4 * 3600e3 - Math.random() * 3600e3).toISOString(),
    });
  }
  out.unshift({ id: 9001, amount_cents: 129900, currency: 'USD', status: 'pending', description: 'Northwind Electronics', merchant: 'Northwind Electronics', category: 'retail', direction: 'debit', user_name: 'Avery Chen', user_email: 'avery@myfiat.io', created_at: new Date(now - 2 * 3600e3).toISOString() });
  _M.txns = out;
})();
/* live crypto market (prices in cents) — single source of truth for Markets + holdings */
_M.market = [
  { symbol: 'BTC', name: 'Bitcoin', price_cents: 6821000, change_24h_pct: 2.14 },
  { symbol: 'ETH', name: 'Ethereum', price_cents: 341200, change_24h_pct: -1.32 },
  { symbol: 'SOL', name: 'Solana', price_cents: 18940, change_24h_pct: 4.88 },
  { symbol: 'AVAX', name: 'Avalanche', price_cents: 3820, change_24h_pct: 1.05 },
  { symbol: 'LINK', name: 'Chainlink', price_cents: 1785, change_24h_pct: -0.74 },
  { symbol: 'XRP', name: 'Ripple', price_cents: 6240, change_24h_pct: 0.42 },
  { symbol: 'ADA', name: 'Cardano', price_cents: 5810, change_24h_pct: -2.11 },
  { symbol: 'DOGE', name: 'Dogecoin', price_cents: 1620, change_24h_pct: 6.37 },
];
_M.cryptoQty = { BTC: 0.34, ETH: 4.2, SOL: 65 };
_M.trades = [
  { id: 5001, asset_class: 'crypto', symbol: 'SOL', side: 'buy', quantity: 15, price_cents: 17820, total_cents: 267300, status: 'filled', created_at: new Date(Date.now() - 3 * 3600e3).toISOString() },
  { id: 5002, asset_class: 'crypto', symbol: 'ETH', side: 'sell', quantity: 1.1, price_cents: 345100, total_cents: 379610, status: 'filled', created_at: new Date(Date.now() - 30 * 3600e3).toISOString() },
];
function mPx(sym) { return (_M.market.find(c => c.symbol === sym) || {}).price_cents || 0; }

function mockDelay(body, status = 200) { return new Promise(r => setTimeout(() => r({ ok: status < 400, status, body }), 230 + Math.random() * 260)); }
function mockApi(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const [p, qs] = path.split('?');
  const q = new URLSearchParams(qs || '');
  const jitter = c => Math.round(c * (1 + (Math.random() - 0.5) * 0.015));

  if (p === '/api/login') return mockDelay({ token: 'mock-token', user: _M.user });
  if (p === '/api/me') {
    const cash = _M.accounts.filter(a => a.kind !== 'credit').reduce((s, a) => s + a.balance_cents, 0) + _M.accounts.filter(a => a.kind === 'credit').reduce((s, a) => s + a.balance_cents, 0);
    const inv = holdTotals().total_cents;
    return mockDelay({ user: _M.user, accounts: _M.accounts, totals: { cash_cents: cash, investments_cents: inv, net_worth_cents: cash + inv } });
  }
  if (p === '/api/accounts') return mockDelay(_M.accounts);
  if (p === '/api/cards' && method === 'GET') return mockDelay(_M.cards);
  let m;
  if ((m = p.match(/^\/api\/cards\/(\d+)\/(renew|freeze|unfreeze)$/))) {
    const card = _M.cards.find(c => c.id === +m[1]);
    if (!card) return mockDelay({ error: 'not found' }, 404);
    if (m[2] === 'freeze') card.status = 'frozen';
    if (m[2] === 'unfreeze') card.status = 'active';
    if (m[2] === 'renew') { card.exp_year = 2030; card.exp_month = 11; card.status = 'active'; card.last4 = String(1000 + Math.floor(Math.random() * 8999)); }
    return mockDelay(card);
  }
  if (p === '/api/subscriptions' && method === 'GET') {
    const active = _M.subs.filter(s => s.status === 'active');
    const monthly = active.reduce((s, x) => s + (x.cadence === 'yearly' ? x.amount_cents / 12 : x.cadence === 'quarterly' ? x.amount_cents / 3 : x.amount_cents), 0);
    return mockDelay({ subscriptions: _M.subs, monthly_total_cents: Math.round(monthly) });
  }
  if ((m = p.match(/^\/api\/subscriptions\/(\d+)\/cancel$/))) {
    const s = _M.subs.find(x => x.id === +m[1]); if (s) s.status = 'cancelled';
    return mockDelay(s || { error: 'not found' }, s ? 200 : 404);
  }
  if (p === '/api/holdings') {
    const stocks = _M.holdings.stocks.map(jitterHold);
    const crypto = _M.holdings.crypto.map(h => {
      const mk = _M.market.find(c => c.symbol === h.symbol) || { price_cents: 0, change_24h_pct: 0, name: h.name };
      const price = jitter(mk.price_cents);
      const series = synthSeries(price, mk.change_24h_pct);
      return { symbol: h.symbol, name: mk.name, quantity: h.quantity, price_cents: price, value_cents: Math.round(price * h.quantity), change_pct: mk.change_24h_pct, series };
    });
    const clone = { stocks, crypto };
    clone.totals = holdTotals(clone);
    return mockDelay(clone);
  }
  if (p === '/api/crypto/prices') {
    _M.market.forEach(c => { c.price_cents = jitter(c.price_cents); c.change_24h_pct = +(c.change_24h_pct + (Math.random() - 0.5) * 0.4).toFixed(2); });
    return mockDelay({ source: 'live', as_of: new Date().toISOString(), prices: _M.market.map(c => ({ symbol: c.symbol, name: c.name, price_cents: c.price_cents, change_24h_pct: c.change_24h_pct })) });
  }
  if (p === '/api/trades' && method === 'GET') return mockDelay({ trades: _M.trades.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)) });
  if (p === '/api/trade' && method === 'POST') {
    const b = JSON.parse(opts.body || '{}');
    const sym = (b.symbol || '').toUpperCase();
    const mk = _M.market.find(c => c.symbol === sym);
    const qty = Number(b.quantity);
    const side = b.side === 'sell' ? 'sell' : 'buy';
    if (!mk) return mockDelay({ error: 'Unknown asset ' + sym }, 400);
    if (!qty || qty <= 0 || !isFinite(qty)) return mockDelay({ error: 'Enter a quantity greater than zero.' }, 400);
    const cost = Math.round(mk.price_cents * qty);
    const checking = _M.accounts.find(a => a.kind === 'checking');
    if (side === 'buy' && cost > checking.balance_cents) return mockDelay({ error: 'Insufficient funds. This trade needs ' + fmtMoney(cost) + ' but your checking balance is ' + fmtMoney(checking.balance_cents) + '.' }, 400);
    const held = _M.cryptoQty[sym] || 0;
    if (side === 'sell' && qty > held + 1e-9) return mockDelay({ error: 'You only hold ' + held + ' ' + sym + '.' }, 400);
    checking.balance_cents += side === 'buy' ? -cost : cost;
    _M.cryptoQty[sym] = +(held + (side === 'buy' ? qty : -qty)).toFixed(8);
    if (!_M.holdings.crypto.find(h => h.symbol === sym) && _M.cryptoQty[sym] > 0) _M.holdings.crypto.push({ symbol: sym, name: mk.name, quantity: _M.cryptoQty[sym] });
    _M.holdings.crypto.forEach(h => { if (_M.cryptoQty[h.symbol] != null) h.quantity = _M.cryptoQty[h.symbol]; });
    _M.holdings.crypto = _M.holdings.crypto.filter(h => h.quantity > 1e-9);
    const trade = { id: Date.now(), asset_class: 'crypto', symbol: sym, side, quantity: qty, price_cents: mk.price_cents, total_cents: cost, status: 'filled', created_at: new Date().toISOString() };
    _M.trades.push(trade);
    return mockDelay({ ok: true, trade, cash_cents: checking.balance_cents, holding_qty: _M.cryptoQty[sym] }, 201);
  }
  if (p === '/api/alerts' && method === 'GET') return mockDelay(_M.alerts);
  if ((m = p.match(/^\/api\/alerts\/(\d+)\/resolve$/))) {
    const a = _M.alerts.find(x => x.id === +m[1]); if (a) a.status = 'resolved';
    return mockDelay(a || { error: 'not found' }, a ? 200 : 404);
  }
  if (p === '/api/insights') {
    return mockDelay({
      spend_by_category: [
        { category: 'Housing', amount_cents: 185000 }, { category: 'Groceries', amount_cents: 61240 },
        { category: 'Dining', amount_cents: 38900 }, { category: 'Transport', amount_cents: 24100 },
        { category: 'Utilities', amount_cents: 19420 }, { category: 'Software', amount_cents: 14880 },
        { category: 'Entertainment', amount_cents: 9800 },
      ],
      month_over_month: [
        { month: 'May', amount_cents: 318000 }, { month: 'Jun', amount_cents: 342500 },
        { month: 'Jul', amount_cents: 299400 }, { month: 'Aug', amount_cents: 361200 },
        { month: 'Sep', amount_cents: 334800 }, { month: 'Oct', amount_cents: 353340 },
      ],
      upcoming_bills: [
        { merchant: 'Wayne Property Mgmt', amount_cents: 185000, due_at: new Date(Date.now() + 4 * 86400e3).toISOString() },
        { merchant: 'Contoso Cloud', amount_cents: 4900, due_at: new Date(Date.now() + 2 * 86400e3).toISOString() },
        { merchant: 'Lumen Energy', amount_cents: 9420, due_at: new Date(Date.now() + 7 * 86400e3).toISOString() },
        { merchant: 'Stark Mobile', amount_cents: 6000, due_at: new Date(Date.now() + 12 * 86400e3).toISOString() },
      ],
      income_cents: 824000, spend_cents: 353340,
    });
  }
  if (p === '/api/transactions' && method === 'GET') {
    let rows = _M.txns.slice();
    const term = (q.get('user') || q.get('search') || q.get('q') || '').toLowerCase().trim();
    const status = q.get('status');
    if (term) {
      if (term.includes("'")) return mockDelay({ error: `SQLITE_ERROR: unrecognized token near "'${term}'" — SELECT ... WHERE u.full_name LIKE '%${term}%'`, sql_hint: 'query failed' }, 500);
      rows = rows.filter(t => (t.merchant + ' ' + t.description + ' ' + t.user_name + ' ' + t.user_email + ' ' + t.category).toLowerCase().includes(term));
    }
    if (status) rows = rows.filter(t => t.status === status);
    const pageSize = Math.min(Math.max(parseInt(q.get('pageSize')) || 25, 1), 100);
    const page = Math.max(parseInt(q.get('page')) || 1, 1);
    const total = rows.length;
    const slice = rows.slice((page - 1) * pageSize, page * pageSize);
    return mockDelay({ page, pageSize, count: slice.length, total, transactions: slice });
  }
  if ((m = p.match(/^\/api\/transactions\/(\d+)\/dispute$/))) return mockDelay({ ok: true, id: +m[1], status: 'disputed' });
  if (p === '/api/payments' && method === 'POST') {
    const b = JSON.parse(opts.body || '{}');
    return mockDelay({ ok: true, transaction: { id: Date.now(), amount_cents: b.amount_cents, status: 'succeeded' } }, 201);
  }
  if (p === '/api/merchants') return mockDelay({ merchants: [
    { id: 1, name: 'Blue Bottle Coffee', category: 'food_and_drink', country: 'US' },
    { id: 2, name: 'Greenleaf Grocery', category: 'groceries', country: 'US' },
    { id: 8, name: 'Wayne Property Mgmt', category: 'housing', country: 'US' },
    { id: 11, name: 'Globex Airlines', category: 'travel', country: 'US' },
    { id: 7, name: 'Stark Mobile', category: 'telecom', country: 'US' },
  ] });
  if (p.match(/^\/api\/users\/\d+$/)) return mockDelay({ id: 1, email: _M.user.email, full_name: _M.user.name, role: 'customer', ssn_last4: '4417', card_last4: '4821', balance_cents: 1248022, created_at: '2023-02-14T10:00:00Z' });
  return mockDelay({ error: 'mock: no route for ' + p }, 404);

  function jitterHold(h) { const price = jitter(h.price_cents); const value = Math.round(price * h.quantity); const first = h.series[0] * 100; const change = ((price - first) / first) * 100; return { symbol: h.symbol, name: h.name, quantity: h.quantity, price_cents: price, value_cents: value, change_pct: +change.toFixed(2), series: h.series.map(x => jitter(x * 100) / 100) }; }
}
function holdTotals(h) {
  h = h || { stocks: _M.holdings.stocks.map(s => ({ value_cents: s.price_cents * s.quantity })), crypto: _M.holdings.crypto.map(s => ({ value_cents: mPx(s.symbol) * s.quantity })) };
  const sc = h.stocks.reduce((s, x) => s + x.value_cents, 0);
  const cc = h.crypto.reduce((s, x) => s + x.value_cents, 0);
  return { stocks_cents: Math.round(sc), crypto_cents: Math.round(cc), total_cents: Math.round(sc + cc), day_change_pct: +(((Math.random() - 0.4) * 2.4)).toFixed(2) };
}
