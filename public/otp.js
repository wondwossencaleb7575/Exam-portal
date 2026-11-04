/* Eagle Labs Exam Portal: email verification code screen (#/verify).
   The code is only ever checked by the server. This file never sees a code except what the person types, and never decides anything. */
R(/^\/verify$/, async () => {
  if (state.user === null) { try { state.user = await meUser(); } catch { state.user = false; } }
  if (state.user && !state.user.must_change) return (location.hash = homeFor(state.user));
  // Always ask the server what is pending (it knows from the HttpOnly cookie). A reload or a stale link lands back on the sign-in page.
  let o;
  try { o = (await get('/api/auth/otp/status')).otp; } catch (e) { state.notice = e.network ? e.message : null; location.hash = '#/login'; return; }
  const now0 = Date.now(), school = state.settings?.school_name || 'Eagle Labs Exam Portal';
  let codeEnd = now0 + o.expires_in * 1000, resendAt = now0 + o.resend_in * 1000, hint = o.email_hint, attemptsLeft = o.attempts_left, resendsLeft = o.resends_left, busy = false, announced = false, done = false;

  render(`<main id="main" class="narrow"><div class="card otp-card">
    <div class="otp-brand"><img src="/img/emblem.png" alt="" width="48" height="48"><span>${esc(school)}</span></div>
    <h1>Check your email</h1>
    ${state.viaCode ? `<p>If an account can sign in with a code, we sent a 6-digit code to <b id="otp-to">${esc(hint)}</b>. It can take a minute to arrive.</p>` : `<p>We sent a 6-digit verification code to <b id="otp-to">${esc(hint)}</b>. Enter it to finish signing in.</p>`}
    <form id="otp-f" novalidate>
      <label class="f" for="otp-code" style="text-align:center">Verification code</label>
      <input id="otp-code" class="otp-in" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" spellcheck="false" autocapitalize="off" aria-describedby="otp-help otp-timer" aria-required="true" placeholder="······">
      <div id="otp-help" class="mu">Six digits. You can paste the code from the email.</div>
      <div class="otp-meta"><span id="otp-timer" role="timer" aria-live="off"></span><span id="otp-left" class="mu"></span></div>
      <div class="alert" id="otp-msg" role="alert" hidden></div>
      <button type="submit" id="otp-go" style="width:100%;margin-top:8px" disabled>Verify</button>
    </form>
    <div class="otp-actions"><button type="button" class="sec" id="otp-re" disabled>Resend code</button><button type="button" class="sec" id="otp-back">← Use a different account</button></div>
    <p class="mu" style="margin-top:14px">Nothing in your inbox? Check the spam folder. For your safety, never share this code with anyone.</p>
  </div></main>`, { title: 'Verify your email' });

  const code = $('#otp-code'), go = $('#otp-go'), re = $('#otp-re'), back = $('#otp-back'), msg = $('#otp-msg'), timer = $('#otp-timer'), left = $('#otp-left');
  const digits = () => code.value.replace(/\D/g, '').slice(0, 6);
  const show = (type, text) => { msg.className = 'alert ' + type; msg.textContent = text; msg.hidden = !text; };
  const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const expired = () => Date.now() >= codeEnd;
  function paint() { // one place decides what is enabled, so loading, expiry and cooldown can never disagree
    const secs = Math.max(0, Math.ceil((codeEnd - Date.now()) / 1000)), wait = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
    timer.textContent = secs ? `Code expires in ${mmss(secs)}` : 'This code has expired.'; timer.className = secs && secs <= 60 ? 'low' : secs ? '' : 'low';
    if (secs && secs <= 60 && !announced) { announced = true; announce('One minute left to enter your code.'); }
    left.textContent = attemptsLeft < 5 && secs ? `${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left` : '';
    go.disabled = busy || done || secs === 0 || digits().length !== 6;
    re.disabled = busy || done || wait > 0 || resendsLeft <= 0;
    re.textContent = resendsLeft <= 0 ? 'No more codes' : wait > 0 ? `Resend code in ${wait}s` : 'Resend code';
    code.disabled = busy || done; back.disabled = busy || done;
    if (secs === 0 && !done && !msg.dataset.keep) { show('warn', 'That code has expired. Use "Resend code" to get a new one.'); msg.dataset.keep = '1'; announce('The code has expired.'); }
  }
  const tick = setInterval(paint, 1000); cleanup = () => clearInterval(tick);
  const apply = x => { const t = Date.now(); codeEnd = t + x.expires_in * 1000; resendAt = t + x.resend_in * 1000; attemptsLeft = x.attempts_left; resendsLeft = x.resends_left; announced = false; delete msg.dataset.keep; };
  const lost = e => { state.notice = e.message; state.otp = null; location.hash = '#/login'; }; // the server says the sign-in attempt is over

  code.addEventListener('input', () => { const d = digits(); if (code.value !== d) code.value = d; paint(); });
  code.addEventListener('paste', e => { e.preventDefault(); const t = (e.clipboardData || window.clipboardData)?.getData('text') || ''; code.value = t.replace(/\D/g, '').slice(0, 6); paint(); }); // "123 456" or "123-456" both work
  code.addEventListener('keydown', e => { if (e.key === 'Enter' && !go.disabled) { e.preventDefault(); $('#otp-f').requestSubmit(); } });

  $('#otp-f').onsubmit = async e => {
    e.preventDefault(); if (busy || done || digits().length !== 6) return; // the guard that stops double submits
    busy = true; go.textContent = 'Verifying…'; go.setAttribute('aria-busy', 'true'); show('', ''); paint();
    try {
      const r = await post('/api/auth/otp/verify', { code: digits() });
      done = true; state.user = r.user; show('ok', 'Verified. Signing you in…'); announce('Verified. Signing you in.');
      location.hash = r.user.must_change ? '#/password' : homeFor(r.user);
    } catch (x) {
      busy = false; go.textContent = 'Verify'; go.removeAttribute('aria-busy');
      const c = x.data?.code;
      if (c === 'otp_session_missing') return lost(x);
      if (c === 'otp_invalid') { attemptsLeft = x.data.attempts_left ?? attemptsLeft; show('err', x.data.attempts_left > 0 ? `That code is incorrect. ${x.data.attempts_left} attempt${x.data.attempts_left === 1 ? '' : 's'} left.` : x.message); }
      else if (c === 'otp_expired') { codeEnd = Date.now(); show('warn', x.message); }
      else if (c === 'otp_attempts_exhausted') { attemptsLeft = 0; show('err', x.message); }
      else show('err', x.message);
      code.value = ''; paint(); code.focus();
    }
  };
  re.onclick = async () => {
    if (busy || done) return; busy = true; re.textContent = 'Sending…'; show('info', 'Sending a new code…'); paint();
    try { const r = await post('/api/auth/otp/resend'); apply(r.otp); code.value = ''; show('ok', 'A new code was sent. The previous code no longer works.'); announce('A new code was sent.'); busy = false; paint(); code.focus(); }
    catch (x) {
      busy = false; if (x.data?.code === 'otp_session_missing' || x.data?.code === 'otp_locked') return lost(x);
      if (x.data?.retry_after) resendAt = Date.now() + x.data.retry_after * 1000;
      if (x.data?.code === 'otp_resend_limit') resendsLeft = 0;
      if (x.data?.code === 'otp_delivery_failed') { codeEnd = Date.now(); resendAt = Date.now(); } // the old code was replaced, the new one did not arrive
      show('err', x.message); paint();
    }
  };
  back.onclick = async () => { if (busy || done) return; busy = true; paint(); await post('/api/auth/otp/cancel').catch(() => {}); state.otp = null; state.notice = null; location.hash = '#/login'; };
  paint(); code.focus();
});
