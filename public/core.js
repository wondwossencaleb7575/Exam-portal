/* Eagle Labs Exam Portal: core client (helpers, router, auth, welcome) */
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { user: null, settings: null };
// Text size (display preference only, kept in this browser). Steps in px; html font-size follows --fs so every rem-based size scales together.
const SIZES = [14, 16, 18, 20, 22];
const setSize = px => document.documentElement.style.setProperty('--fs', px + 'px');
function bumpSize(d) { const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs')) || 16, i = Math.max(0, Math.min(SIZES.length - 1, SIZES.indexOf(cur) + d)); setSize(SIZES[i]); try { localStorage.setItem('eagle.fs', SIZES[i]); } catch {} announce('Text size ' + SIZES[i] + ' pixels'); }
try { const sv = Number(localStorage.getItem('eagle.fs')); if (SIZES.includes(sv)) setSize(sv); } catch {}
// The CSP forbids inline event handlers, so print buttons use data-print and this one delegated listener.
document.addEventListener('click', e => { if (e.target.closest('[data-print]')) print(); });
// Dates are shown and typed in the SCHOOL time zone (Settings), never the computer's. See tz.js.
const schoolTz = () => state.settings?.timezone || TZ.DEFAULT_TZ;
const fd = ms => TZ.format(ms, { tz: schoolTz(), locale: state.settings?.locale, calendar: state.settings?.calendar });
const toLocal = ms => ms ? TZ.toZoned(ms, schoolTz()) : '';
const fromLocal = s => s ? TZ.fromZoned(s, schoolTz()) : null;
const badge = (t, label) => `<span class="badge ${esc(t)}">${esc(label || String(t).replace(/_/g, ' '))}</span>`;
const num = x => x == null ? '–' : (Math.round(x * 100) / 100);

async function api(url, { method, body } = {}) {
  let r;
  try { r = await fetch(url, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'eagle' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' }); }
  catch { throw Object.assign(new Error('Cannot reach the server. Check your internet connection.'), { network: true }); }
  const ct = r.headers.get('content-type') || '', j = ct.includes('json') ? await r.json().catch(() => ({})) : {};
  if (!r.ok) {
    if (r.status === 401 && !url.includes('/auth/login') && !url.includes('/auth/otp/')) {
      // Expired or ended sign-in. In the middle of an exam say so plainly: nothing typed is lost (it is kept on this device and the server clock kept running).
      if (/^#\/s\/attempt\//.test(location.hash)) state.notice = 'Your sign-in ended during the exam. Sign in again to carry on. The exam clock kept running on the server, and answers typed on this device are kept and sent when you reopen your exam.';
      state.user = null; location.hash = '#/login';
    } // the code screen handles its own 401 so it can explain why
    if (r.status === 403 && j.code === 'must_change') { location.hash = '#/password'; }
    throw Object.assign(new Error(j.error || 'Request failed'), { status: r.status, data: j });
  }
  return j;
}
const get = u => api(u), post = (u, b) => api(u, { method: 'POST', body: b || {} }), put = (u, b) => api(u, { method: 'PUT', body: b }), patch = (u, b) => api(u, { method: 'PATCH', body: b }), del = u => api(u, { method: 'DELETE' });

/* ---- math (KaTeX only renders; nothing is ever evaluated) ---- */
const MATH = { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }], throwOnError: false, trust: false, strict: 'ignore', maxExpand: 1000 };
const math = el => { if (window.renderMathInElement && el) renderMathInElement(el, MATH); };
const TOOLS = [['x²', '$x^{2}$'], ['xⁿ', '$x^{n}$'], ['xₙ', '$x_{n}$'], ['√', '$\\sqrt{x}$'], ['a⁄b', '$\\frac{a}{b}$'], ['π', '$\\pi$'], ['≤', '$\\le$'], ['≥', '$\\ge$'], ['≠', '$\\ne$'], ['×', '$\\times$'], ['÷', '$\\div$'], ['°', '$^{\\circ}$'], ['∞', '$\\infty$'], ['∑', '$\\sum_{i=1}^{n}$'], ['∫', '$\\int_{a}^{b} f(x)\\,dx$'], ['lim', '$\\lim_{x\\to 0}$'], ['sin', '$\\sin\\theta$'], ['matrix', '$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$']];
const mathBar = () => `<div class="tb" role="toolbar" aria-label="Insert mathematical notation">${TOOLS.map((x, i) => `<button type="button" class="sec sm" data-ins="${i}" aria-label="Insert ${esc(x[0])}">${esc(x[0])}</button>`).join('')}</div>`;
// Inserts snippets into the last text field focused inside `root`.
function bindMathBar(root, fire = true) {
  let last = null;
  root.addEventListener('focusin', e => { if (e.target.matches('textarea,input[type=text],input:not([type])')) last = e.target; });
  root.addEventListener('mousedown', e => { if (e.target.closest('[data-ins]')) e.preventDefault(); });
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-ins]'); if (!b || !last || !root.contains(last)) return;
    const sn = TOOLS[b.dataset.ins][1], p = last.selectionStart ?? last.value.length;
    last.value = last.value.slice(0, p) + sn + last.value.slice(last.selectionEnd ?? p); last.focus(); last.selectionStart = last.selectionEnd = p + sn.length;
    if (fire) last.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const mathText = (s, cls = '') => `<span class="${cls}">${esc(s)}</span>`;

/* ---- UI helpers ---- */
function toast(msg, type = '') { const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg; $('#toasts').append(t); setTimeout(() => t.remove(), type ? 7000 : 4000); }
const announce = m => { const l = $('#live'); l.textContent = ''; setTimeout(() => l.textContent = m, 50); };
function modal(html, { wide = false } = {}) {
  const d = document.createElement('dialog'); if (wide) d.className = 'wide'; d.innerHTML = html; document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal(); math(d); return d;
}
// Confirmation for consequential actions.
const confirmDlg = (title, msg, { ok = 'Confirm', danger = false, html = false } = {}) => new Promise(res => {
  const d = modal(`<h2>${esc(title)}</h2><div>${html ? msg : `<p>${esc(msg)}</p>`}</div><div class="row l" style="margin-top:16px"><button id="y" class="${danger ? 'dng' : ''}">${esc(ok)}</button><button id="n" class="sec">Cancel</button></div>`);
  let v = false; $('#y', d).onclick = () => { v = true; d.close(); }; $('#n', d).onclick = () => d.close(); d.addEventListener('close', () => res(v));
});
// Small form dialog. `fields` is HTML; `read(dialog)` returns the body to send; `run(body)` performs the request.
const formDlg = (title, fields, run, { ok = 'Save' } = {}) => new Promise(res => {
  const d = modal(`<h2>${esc(title)}</h2><form id="fm">${fields}<div class="alert err" id="fe" hidden></div><div class="row l" style="margin-top:14px"><button type="submit">${esc(ok)}</button><button type="button" class="sec" id="n">Cancel</button></div></form>`);
  $('#n', d).onclick = () => d.close(); d.addEventListener('close', () => res(false));
  $('#fm', d).onsubmit = async e => { e.preventDefault(); const b = $('button[type=submit]', d); b.disabled = true;
    try { await run(Object.fromEntries(new FormData(e.target))); d.removeEventListener('close', () => {}); res(true); d.close(); } catch (x) { $('#fe', d).hidden = false; $('#fe', d).textContent = x.message; b.disabled = false; } };
});
const pager = (total, page, size) => { const pages = Math.max(1, Math.ceil(total / size)); return total > size ? `<div class="pager"><button class="sec sm" data-pg="${page - 1}" ${page <= 1 ? 'disabled' : ''}>← Previous</button><span class="mu">Page ${page} of ${pages} · ${total} total</span><button class="sec sm" data-pg="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next →</button></div>` : `<div class="mu" style="margin-top:8px">${total} total</div>`; };
const debounce = (f, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };

/* ---- layout + router ---- */
let cleanup = null; // set by views that own timers/listeners
function render(html, { title = 'Eagle Labs Exam Portal', home = false } = {}) {
  if (cleanup) { cleanup(); cleanup = null; }
  document.body.classList.toggle('home', home); document.title = title + ' · ' + (state.settings?.school_name || 'Eagle Labs'); $('#root').innerHTML = html; math($('#root')); scrollTo(0, 0);
  const h = $('#main h1'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
}
const NAV = { teacher: [['#/t', 'Dashboard'], ['#/t/exams', 'Exams'], ['#/t/bank', 'Question bank'], ['#/t/classes', 'Classes'], ['#/t/students', 'Students'], ['#/t/analytics', 'Analytics']], admin: [['#/a/users', 'Users'], ['#/a/students', 'Students'], ['#/a/classes', 'Classes'], ['#/a/audit', 'Audit log'], ['#/a/settings', 'Settings'], ['#/a/system', 'System']], student: [['#/s', 'My exams']] };
function page(inner, { title, narrow = false } = {}) {
  const u = state.user, here = location.hash;
  render(`<header class="top"><a class="brand" href="${NAV[u.role][0][0]}"><img src="/img/emblem.png" alt="" width="34" height="34"><span>${esc(state.settings?.school_name || 'Eagle Labs Exam Portal')}</span></a>
    <nav aria-label="Main">${NAV[u.role].map(([h, l]) => `<a href="${h}" ${here === h || (h.length > 4 && here.startsWith(h)) ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
    <div class="who"><span>${esc(u.name)}</span><button class="sec sm" id="lo">Sign out</button></div></header><main id="main" class="${narrow ? 'narrow' : ''}">${inner}</main>`, { title });
  $('#lo').insertAdjacentHTML('beforebegin', '<span class="tsz" role="group" aria-label="Text size"><button type="button" id="tsm" aria-label="Smaller text">A−</button><button type="button" id="tsp" aria-label="Larger text">A+</button></span>');
  $('#tsm').onclick = () => bumpSize(-1); $('#tsp').onclick = () => bumpSize(1);
  $('#lo').onclick = async () => { await post('/api/auth/logout').catch(() => {}); state.user = null; location.hash = '#/'; };
}
const loading = () => render('<main id="main"><p><span class="spin"></span> Loading…</p></main>');
const errorPage = (e, retry) => { const m = `<div class="alert err" role="alert">${esc(e.message)}</div><button class="sec" id="rt">Try again</button>`; if (state.user) page(`<h1>Something went wrong</h1>${m}`); else render(`<main id="main"><h1>Something went wrong</h1>${m}</main>`); $('#rt').onclick = retry; };

const routes = []; const R = (re, fn, roles) => routes.push([re, fn, roles]);
async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  if (state.user === null && !['/', '/login'].includes(hash)) { try { state.user = await meUser(); } catch { state.user = false; } }
  if (state.user === null) { try { state.user = await meUser(); } catch { state.user = false; } }
  for (const [re, fn, roles] of routes) {
    const m = re.exec(hash); if (!m) continue;
    if (roles) { if (!state.user) return (location.hash = '#/login'); if (state.user.must_change && hash !== '/password') return (location.hash = '#/password'); if (!roles.includes(state.user.role)) return (location.hash = '#/'); }
    try { await fn(...m.slice(1)); } catch (e) { if (e.status !== 401) errorPage(e, route); } return;
  }
  location.hash = '#/';
}
addEventListener('hashchange', route);
// Loads the signed-in user AND the school settings in one request; applies the school's brand colour if it keeps white text readable (WCAG AA, 4.5:1).
async function meUser() {
  const r = await get('/api/auth/me'); state.codeLogin = !!r.code_login; if (r.settings) { state.settings = r.settings; applyBrand(); } return r.user || false;
}
function applyBrand() {
  const c = state.settings?.brand_color, m = /^#([0-9a-f]{6})$/i.exec(c || ''); if (!m) return;
  const lin = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }, n = parseInt(m[1], 16), L = .2126 * lin(n >> 16) + .7152 * lin((n >> 8) & 255) + .0722 * lin(n & 255);
  if (1.05 / (L + .05) >= 4.5) document.documentElement.style.setProperty('--navy', c);
}
async function boot() { try { state.user = await meUser(); } catch { state.user = false; } route(); }
const homeFor = u => u.role === 'teacher' ? '#/t' : u.role === 'admin' ? '#/a/users' : '#/s';

/* ---- welcome + auth ---- */
R(/^\/$/, async () => {
  if (state.user === null) { try { state.user = await meUser(); } catch { state.user = false; } }
  if (state.user && !state.user.must_change) return (location.hash = homeFor(state.user));
  render(`<div class="wc"><header class="wh"><img src="/img/emblem.png" alt="Eagle Labs" width="64" height="64"></header>
  <div class="wg"><div class="wt"><div class="wbn"><h1 id="wh">Eagle Labs Exam Portal For HUMS</h1></div>
  <p class="wl2">Take your exams securely from any device. Sign in with the account your teacher gave you, open your assigned exam, and start when you are ready.</p>
  <div class="wa"><a class="wb p" href="#/login">Sign in</a></div>
  <ul class="wk"><li>The exam timer runs on the server, so refreshing the page never adds time.</li><li>Answers are saved automatically and marked on the server. Answer keys never reach your browser.</li><li>Results appear only when your teacher releases them.</li></ul></div>
  <div class="wi"><img src="/img/exam-illustration.svg" alt=""></div></div>
  <footer class="wf">Made by <b>Eagle Labs</b> and <b>Tch. Getamesay</b></footer></div>`, { home: true });
});
R(/^\/login$/, async () => {
  if (state.user === null) { try { state.user = await meUser(); } catch { state.user = false; } }
  if (state.user && !state.user.must_change) return (location.hash = homeFor(state.user));
  render(`<main id="main" class="narrow"><h1>Sign in</h1><form class="card" id="f" novalidate>
    <label class="f" for="em">Email</label><input id="em" type="email" autocomplete="username" required>
    <label class="f" for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required>
    ${state.notice ? `<div class="alert info" role="status">${esc(state.notice)}</div>` : ''}
    <div class="alert err" id="er" role="alert" hidden></div><div class="row l" style="margin-top:14px"><button type="submit">Sign in</button><a href="#/">← Home</a></div>
    <p class="mu">There is no public sign-up. Your teacher or administrator creates your account. Forgot your password? Ask them for a reset.</p></form>
    ${state.codeLogin ? `<form class="card" id="cf" novalidate><h2>No password? Use an email code</h2><p class="mu">Students can sign in with a 6-digit code sent to the email address on their account. Your first sign-in must use the temporary password from your teacher.</p>
    <label class="f" for="ce">Email</label><input id="ce" type="email" autocomplete="email" required><div class="alert err" id="ce-er" role="alert" hidden></div>
    <div class="row l" style="margin-top:14px"><button type="submit" class="sec">Email me a code</button></div></form>` : ''}</main>`, { title: 'Sign in' });
  state.notice = null;
  $('#f').onsubmit = async e => { e.preventDefault(); const b = $('button', e.target); b.disabled = true; $('#er').hidden = true;
    try { const r = await post('/api/auth/login', { email: $('#em').value, password: $('#pw').value });
      if (r.otp_required) { state.user = false; state.viaCode = false; location.hash = '#/verify'; return; } // password accepted, but NOT signed in yet: a code was emailed
      state.user = r.user; location.hash = r.user.must_change ? '#/password' : homeFor(r.user); }
    catch (x) { $('#er').hidden = false; $('#er').textContent = x.message; b.disabled = false; } };
  if ($('#cf')) $('#cf').onsubmit = async e => { e.preventDefault(); const b = $('button', e.target), er = $('#ce-er'); if (b.disabled) return; b.disabled = true; er.hidden = true;
    try { await post('/api/auth/code/request', { email: $('#ce').value }); state.user = false; state.viaCode = true; location.hash = '#/verify'; }  // the answer is the same for every address, so this never says whether an account exists
    catch (x) { er.hidden = false; er.textContent = x.message; b.disabled = false; } };
});
R(/^\/password$/, async () => {
  if (!state.user) return (location.hash = '#/login');
  render(`<main id="main" class="narrow"><h1>${state.user.must_change ? 'Choose a new password' : 'Change password'}</h1><form class="card" id="f">
    ${state.user.must_change ? '<div class="alert info">You are using a temporary password. Choose your own to continue.</div>' : ''}
    <label class="f" for="c">Current password</label><input id="c" type="password" autocomplete="current-password" required>
    <label class="f" for="n">New password</label><input id="n" type="password" autocomplete="new-password" required><div class="mu">At least 10 characters, with letters and a number.</div>
    <div class="alert err" id="er" role="alert" hidden></div><div class="row l" style="margin-top:14px"><button>Save password</button></div></form></main>`, { title: 'Password' });
  $('#f').onsubmit = async e => { e.preventDefault(); try { await post('/api/auth/change-password', { current: $('#c').value, next: $('#n').value }); state.user.must_change = false; toast('Password changed'); location.hash = homeFor(state.user); } catch (x) { $('#er').hidden = false; $('#er').textContent = x.message; } };
});
