/* Eagle Labs Exam Portal: loading-screen controller.
   Drives the #eagle-loader overlay that index.html ships. Plain script (no modules, no libraries, CSP-safe: no inline code).

   API (window.EagleLoader)
     begin(kind, retry, onDismiss)   show / keep the screen. kind: 'boot' | 'dash' | 'exam'
     cancel()                        leave at once (the load was refused or abandoned)
     done()                          the requested page is ready: fade out (never earlier than it was visible, see minVisible)
     fail(message, retry, onDismiss, dismissLabel)   stop the animation and show the error; never fades out as if it had worked
     isOn()                          true while the screen is up
   It follows REAL loading: nothing here is a timer that pretends to be progress. The only time-based parts are
   (1) a short grace delay so a fast load never flashes the screen, (2) minVisible so a screen that did appear does not
   blink away, and (3) the slow-connection and hard time-outs that stop it from ever loading forever. */
(function () {
  'use strict';
  const cfg = { grace: 120, minVisible: 500, slowMsg: 3500, softTimeout: 15000, hardTimeout: 40000, fadeOut: 450 };
  const el = document.getElementById('eagle-loader');
  const MSG = {
    boot: 'Preparing your examination environment...',
    dash: 'Loading your dashboard...',
    exam: 'Preparing your examination environment...',
    sync: 'Synchronizing your data...',
    almost: 'Almost ready...',
    slow: 'This is taking longer than usual. Please check your connection.',
    offline: 'You appear to be offline. Waiting for your connection...'
  };
  const reduced = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (!el) { window.EagleLoader = { begin() { return false; }, done() {}, cancel() {}, fail() {}, isOn() { return false; }, cfg }; return; }

  const $ = s => el.querySelector(s), msg = $('.el-msg'), etxt = $('.el-etxt'), retryBtn = $('.el-retry'), dismissBtn = $('.el-dismiss');
  let on = true, kind = 'boot', t0 = Date.now(), retry = null, dismiss = null, hideT = 0, slowT = 0, softT = 0, hardT = 0, goneT = 0, pending = false;

  const reload = () => location.reload();
  const root = () => document.getElementById('root');
  const lock = v => { const r = root(); if (r) { if (v) r.setAttribute('inert', ''); else r.removeAttribute('inert'); } };
  function say(t) { if (!msg || msg.textContent === t) return; msg.textContent = t; msg.classList.remove('el-swap'); void msg.offsetWidth; msg.classList.add('el-swap'); }
  const clear = () => { clearTimeout(slowT); clearTimeout(softT); clearTimeout(hardT); slowT = softT = hardT = 0; };

  function arm() {                                  // time-outs run from the start of the whole load, not from each sub-step
    clear();
    slowT = setTimeout(() => { if (on && el.dataset.state === 'loading') say(navigator.onLine === false ? MSG.offline : MSG.sync); }, cfg.slowMsg);
    softT = setTimeout(() => { if (on && el.dataset.state === 'loading') say(navigator.onLine === false ? MSG.offline : MSG.slow); }, cfg.softTimeout);
    hardT = setTimeout(() => { if (on && el.dataset.state === 'loading') fail('Loading is taking too long. Check your connection and try again.', retry, dismiss, 'Close'); }, cfg.hardTimeout);
  }

  function begin(k, r, d) {
    if (k !== 'boot' && document.querySelector('.xwrap')) return false;   // an exam is on screen: never cover it, never interrupt it
    clearTimeout(hideT); clearTimeout(goneT); pending = false;
    kind = k || kind;
    if (!on) { retry = r || reload; dismiss = d || null; }                  // a fresh load never inherits the previous load's callbacks
    else { if (r !== undefined) retry = r; if (d !== undefined) dismiss = d; }
    if (!on) {
      on = true; t0 = Date.now(); el.classList.remove('is-out'); el.dataset.state = 'loading'; el.hidden = false; lock(true); say(MSG[kind] || MSG.boot); arm();
    } else {                                       // already up (e.g. start-up splash, then dashboard): same screen, new honest text
      if (el.classList.contains('is-out')) { el.classList.remove('is-out'); t0 = Date.now(); arm(); }   // a new load arrived mid fade-out: bring the screen back instead of letting it finish vanishing
      if (el.dataset.state === 'error') { el.dataset.state = 'loading'; t0 = Date.now(); arm(); }
      say(MSG[kind] || MSG.boot);
    }
    el.setAttribute('aria-busy', 'true');
    return true;
  }

  function finish() {
    clearTimeout(hideT); clear(); pending = false;
    if (!on) return;
    const quick = reduced() || Date.now() - t0 <= cfg.grace;               // never became visible (or no motion to show): remove at once
    el.setAttribute('aria-busy', 'false');
    if (quick) return gone();
    el.classList.add('is-out');
    goneT = setTimeout(gone, cfg.fadeOut);
  }
  function gone() { on = false; el.hidden = true; el.classList.remove('is-out'); lock(false); clearTimeout(goneT); }

  function done() {
    if (!on || pending) return;
    pending = true;
    const shown = Date.now() - t0 - cfg.grace, wait = reduced() ? 0 : Math.max(0, cfg.minVisible - shown);
    if (shown > 0 && wait > 0) { say(MSG.almost); hideT = setTimeout(finish, wait); } else finish();
  }

  function cancel() { if (!on) return; clearTimeout(hideT); finish(); }   // the thing being waited for was abandoned or refused: leave without "Almost ready"

  function fail(message, r, d, label) {
    if (!on) { on = true; t0 = Date.now(); el.classList.remove('is-out'); el.hidden = false; lock(true); }
    clearTimeout(hideT); clearTimeout(goneT); clear(); pending = false;
    if (r !== undefined) retry = r; if (d !== undefined) dismiss = d;
    el.dataset.state = 'error'; el.setAttribute('aria-busy', 'false');
    etxt.textContent = message || 'Something went wrong while loading.';
    retryBtn.hidden = !retry; dismissBtn.hidden = !dismiss; dismissBtn.textContent = label || 'Close';
    (retryBtn.hidden ? dismissBtn : retryBtn).focus({ preventScroll: true });
  }

  retryBtn.addEventListener('click', () => { const r = retry; if (!r) return; el.dataset.state = 'loading'; t0 = Date.now(); say(MSG[kind] || MSG.boot); arm(); el.setAttribute('aria-busy', 'true'); try { r(); } catch (e) { fail(e && e.message, r, dismiss); } });
  dismissBtn.addEventListener('click', () => { const d = dismiss; clear(); gone(); if (d) d(); });
  addEventListener('offline', () => { if (on && el.dataset.state === 'loading') say(MSG.offline); });
  addEventListener('online', () => { if (on && el.dataset.state === 'loading') say(MSG[kind] || MSG.boot); });

  // The splash is already on screen (it is in the HTML), so start-up is "loading" from the first instant.
  // If the app script never arrives or never finishes, the time-outs above still end this screen with a reload option.
  retry = reload;
  el.dataset.state = 'loading'; lock(true); arm();
  window.EagleLoader = { begin, done, cancel, fail, isOn: () => on, cfg };
})();
