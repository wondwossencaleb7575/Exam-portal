/* Eagle Labs Exam Portal: animated eagle loading screen (controller).
   The markup is #eagle-splash in index.html (so it is on screen at first paint); the look is eagle-loader.css.

   It reflects REAL loading only. Nothing here fakes progress or holds the app back:
   - begin() starts a load; the screen appears only if the load is still running after `delay` ms (fast loads never flash it).
   - end() is called when the page is actually rendered; the screen then fades out over the already-rendered page.
   - fail() shows an honest error with Try again / Reload. A watchdog calls it if a load runs too long, so it can never spin forever.
   - It never appears over a live exam. Ordinary requests use the small inline spinner, not this.

   API (window.EagleLoader): begin({context, delay, retry}), end(), cancel(), fail({title, message, retry}), message(key), isActive(), isFailed()
   context: 'startup' | 'auth' | 'dashboard' | 'exam'.  Messages are in MSG below. */
(function () {
  'use strict';
  var root = document.getElementById('eagle-splash');
  function noop() {}
  if (!root) { window.EagleLoader = { begin: noop, end: noop, cancel: noop, fail: noop, message: noop, isActive: function () { return false; }, isFailed: function () { return false; } }; return; }

  var q = function (s) { return root.querySelector(s); };
  var msgEl = q('.es-msg'), errBox = q('.es-err'), errTitle = q('.es-errtitle'), errMsg = q('.es-errmsg'), errNote = q('.es-note'), btnRetry = q('.es-retry'), btnReload = q('.es-reload');
  var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  var T = { fade: 450, quickFade: 200, show: 250, sync: 3500, slow: 8000, minVisible: 420, timeout: { startup: 30000, auth: 25000, dashboard: 25000, exam: 25000 } };
  var MSG = {
    prepare: 'Preparing your examination environment...', dash: 'Loading your dashboard...', sync: 'Synchronizing your data...',
    almost: 'Almost ready...', slow: 'Still working. Your connection looks slow...'
  };
  var S = { phase: 'idle', ctx: 'startup', retry: null, shownAt: 0, t0: 0, timers: {}, leaveT: 0, locked: [], prevFocus: null };

  // ---- helpers ----
  function examLive() { return !!document.querySelector('.xwrap'); }   // the exam player is on screen: never cover it
  function setMsg(text, instant) {
    if (!msgEl || msgEl.textContent === text) return;
    if (instant || mq.matches || root.hidden) { msgEl.textContent = text; msgEl.classList.remove('is-swap'); return; }
    msgEl.classList.add('is-swap');
    setTimeout(function () { msgEl.textContent = text; msgEl.classList.remove('is-swap'); }, 160);
  }
  function startMsg(ctx) { return ctx === 'dashboard' ? MSG.dash : MSG.prepare; }
  function showErr(on) { if (errBox) errBox.hidden = !on; }
  function clearTimers() { for (var k in S.timers) clearTimeout(S.timers[k]); S.timers = {}; }

  // While the screen is up, the page underneath must not be reachable by keyboard or screen reader.
  function lock() {
    if (S.locked.length) return;
    Array.prototype.forEach.call(document.body.children, function (el) {
      if (el === root || el.tagName === 'SCRIPT' || el.tagName === 'NOSCRIPT' || el.hasAttribute('inert')) return;
      el.setAttribute('inert', ''); S.locked.push(el);
    });
  }
  function unlock() { S.locked.forEach(function (el) { el.removeAttribute('inert'); }); S.locked = []; }

  // ---- artwork: wait (briefly) for the layers to decode so the eagle never pops in half-drawn ----
  var artReady = false;
  function armArt() {
    var imgs = root.querySelectorAll('.es-lyr img'), pend = imgs.length, done = false;
    function ok() { if (done) return; done = true; artReady = true; root.classList.add('is-ready'); }
    function bad() { root.classList.add('no-art'); ok(); }               // artwork missing: fall back to the portal emblem
    function fin(img) { (img.decode ? img.decode() : Promise.resolve()).then(function () { if (--pend === 0) ok(); }, function () { bad(); }); }
    if (!pend) return ok();
    Array.prototype.forEach.call(imgs, function (img) {
      if (img.complete) { if (img.naturalWidth) fin(img); else bad(); return; }
      img.addEventListener('load', function () { fin(img); }, { once: true });
      img.addEventListener('error', bad, { once: true });
    });
    setTimeout(ok, 2500);                                                 // never wait forever for the art
  }
  function replay() {                                                     // restart the intro each time the screen is shown again
    if (!artReady) return;
    root.classList.remove('is-ready'); void root.offsetWidth; root.classList.add('is-ready');
  }

  // ---- watchdog: honest slow-connection messages, then a hard time-out ----
  function arm() {
    clearTimers();
    S.timers.sync = setTimeout(function () { if (S.phase === 'visible') setMsg(MSG.sync); }, T.sync);
    S.timers.slow = setTimeout(function () { if (S.phase === 'visible') setMsg(MSG.slow); }, T.slow);
    S.timers.out = setTimeout(timedOut, T.timeout[S.ctx] || 25000);
  }
  function timedOut() {
    if (S.phase !== 'pending' && S.phase !== 'visible') return;
    fail({ title: 'This is taking longer than expected', message: S.ctx === 'auth' ? 'Signing in is taking too long. Check your internet connection and try again.' : 'The portal is taking too long to respond. Check your internet connection and try again.' });
  }

  // ---- show / hide ----
  function show(first) {
    var a = document.activeElement; S.prevFocus = a && a !== document.body && !root.contains(a) ? a : null;
    clearTimeout(S.leaveT);
    root.hidden = false; root.classList.remove('is-leaving', 'is-quick', 'is-error');
    if (!first) { root.classList.add('is-entering'); setTimeout(function () { root.classList.remove('is-entering'); }, 320); }
    replay(); showErr(false); root.setAttribute('aria-busy', 'true'); lock();
    S.phase = 'visible'; S.shownAt = Date.now();
  }
  function restoreFocus() {                                               // after unlock: leave focus somewhere sensible
    var a = document.activeElement;
    if (a && a !== document.body && !root.contains(a)) return;
    var p = S.prevFocus; S.prevFocus = null;
    if (p && document.documentElement.contains(p)) { try { p.focus({ preventScroll: true }); return; } catch (e) { /* fall through */ } }
    var h = document.querySelector('#main h1'); if (h) { h.tabIndex = -1; try { h.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }
  function leave(quick) {
    clearTimers(); clearTimeout(S.leaveT);
    S.phase = 'leaving'; if (!quick) setMsg(MSG.almost, true);
    unlock(); restoreFocus();
    root.setAttribute('aria-busy', 'false'); root.classList.add('is-leaving'); if (quick) root.classList.add('is-quick');
    S.leaveT = setTimeout(done, (mq.matches ? 0 : (quick ? T.quickFade : T.fade)) + 40);
  }
  function done() {
    root.hidden = true; root.classList.remove('is-leaving', 'is-quick', 'is-error', 'is-entering', 'is-ready');
    showErr(false); S.phase = 'idle'; S.retry = null; S.prevFocus = null;
  }
  function reset() { clearTimers(); S.phase = 'idle'; S.retry = null; }  // never became visible: nothing on screen to undo

  // ---- public API ----
  function begin(o) {
    o = o || {};
    if (examLive()) return;
    var ctx = o.context || null;
    if (o.retry !== undefined) S.retry = o.retry;

    if (S.phase === 'idle') {
      S.ctx = ctx || 'startup'; S.t0 = Date.now(); arm(); setMsg(startMsg(S.ctx), true);
      var d = o.delay === undefined ? T.show : o.delay;
      S.phase = 'pending';
      if (d <= 0) show(false); else S.timers.show = setTimeout(function () { if (S.phase === 'pending') show(false); }, d);
      return;
    }
    if (S.phase === 'leaving') {                                          // navigated again mid-fade: keep the screen up and carry on
      clearTimeout(S.leaveT); root.classList.remove('is-leaving', 'is-quick'); S.ctx = ctx || S.ctx; S.t0 = Date.now(); lock(); S.phase = 'visible'; S.shownAt = Date.now(); arm(); setMsg(startMsg(S.ctx), true); root.setAttribute('aria-busy', 'true');
      return;
    }
    if (S.phase === 'error') {                                            // retry: back to loading
      root.classList.remove('is-error'); showErr(false); root.setAttribute('aria-busy', 'true'); S.phase = 'visible'; S.ctx = ctx || S.ctx; S.t0 = Date.now(); arm(); setMsg(startMsg(S.ctx), true);
      return;
    }
    // already pending/visible (start-up or sign-in): carry on, relabel by what is loading now (never downgrade a slow-connection message)
    if (S.phase === 'pending' && o.delay === 0) { clearTimeout(S.timers.show); show(false); }
    if (ctx && S.ctx !== 'exam') S.ctx = ctx;
    if (ctx && Date.now() - S.t0 < T.sync) setMsg(startMsg(ctx));
  }
  function end() {
    if (S.phase === 'idle' || S.phase === 'leaving') return;
    if (S.phase === 'pending') return reset();                            // finished before it ever appeared: no flicker, nothing to fade
    if (S.timers.end) return;
    var wait = S.ctx === 'startup' || S.phase === 'error' ? 0 : Math.max(0, T.minVisible - (Date.now() - S.shownAt));   // avoid a blink if it only just appeared; never delays start-up
    if (wait) S.timers.end = setTimeout(function () { delete S.timers.end; if (S.phase === 'visible' || S.phase === 'error') leave(false); }, wait); else leave(false);
  }
  function cancel() {                                                     // the action ended without a page change (e.g. wrong password): clear quickly, no "success" fade
    if (S.phase === 'idle' || S.phase === 'leaving') return;
    if (S.phase === 'pending') return reset();
    leave(true);
  }
  function fail(o) {
    o = o || {};
    if (S.phase === 'idle' || S.phase === 'leaving') { clearTimeout(S.leaveT); S.ctx = S.ctx || 'startup'; }
    clearTimers();
    if (o.retry !== undefined) S.retry = o.retry;
    if (S.phase !== 'visible' && S.phase !== 'error') show(false);
    S.phase = 'error'; root.classList.add('is-error'); root.setAttribute('aria-busy', 'false');
    errTitle.textContent = o.title || 'We could not finish loading';
    errMsg.textContent = o.message || 'Check your internet connection and try again.';
    errNote.textContent = S.ctx === 'exam' || /^#\/s\/attempt\//.test(location.hash) ? 'Your exam clock runs on the server, and answers you already entered are kept on this device.' : '';
    errNote.hidden = !errNote.textContent;
    btnRetry.textContent = S.retry ? 'Try again' : 'Close';
    showErr(true);
    try { btnRetry.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }

  btnRetry.addEventListener('click', function () {
    var r = S.retry;
    if (!r) return cancel();
    begin({ context: S.ctx });                                            // leaves the error state and restarts the watchdog
    Promise.resolve().then(r).catch(function (e) { fail({ message: (e && e.message) || undefined }); });
  });
  btnReload.addEventListener('click', function () { location.reload(); });
  document.addEventListener('visibilitychange', function () { root.classList.toggle('is-paused', document.hidden); });

  window.EagleLoader = {
    begin: begin, end: end, cancel: cancel, fail: fail,
    message: function (k) { if (S.phase === 'visible' && MSG[k]) setMsg(MSG[k]); },
    isActive: function () { return S.phase !== 'idle'; },
    isFailed: function () { return S.phase === 'error'; }
  };

  // The splash is in the HTML, so the app is already "loading" when this script runs. Start the watchdog now so a start-up that never completes is reported.
  S.phase = 'visible'; S.ctx = 'startup'; S.t0 = S.shownAt = Date.now();
  root.classList.add('js-on'); lock(); armArt(); arm();
})();
