const express = require('express');
const { db } = require('../lib/db');
const A = require('../lib/auth');
const { wrap, fail, HttpError } = require('../lib/http');
const { audit } = require('../lib/audit');
const SET = require('../lib/settings');
const OTP = require('../lib/otp');
const r = express.Router();
const fails = new Map(); // login throttling by ip and by email
setInterval(() => { const n = Date.now(); for (const [k, v] of fails) if (n - v.at > 600000) fails.delete(k); }, 60000).unref();
// Wrong-password limits. Per ACCOUNT (default 8 per 10 minutes) is the real brute-force defence. Per network address is only a brake on one machine
// trying many accounts, and a whole school often shares ONE public address: a class typing its first temporary passwords can easily make 30 honest
// mistakes in 10 minutes, so the address limit is generous by default and tunable (LOGIN_MAX_FAILS_PER_IP / LOGIN_MAX_FAILS_PER_ACCOUNT).
const envInt = (name, def, lo, hi) => { const v = Number(process.env[name]); return process.env[name] !== undefined && process.env[name] !== '' && Number.isInteger(v) && v >= lo && v <= hi ? v : def; };
const maxFailsIp = () => envInt('LOGIN_MAX_FAILS_PER_IP', 150, 10, 5000), maxFailsAccount = () => envInt('LOGIN_MAX_FAILS_PER_ACCOUNT', 8, 3, 50);
const hit = k => { const t = fails.get(k); return t && Date.now() - t.at <= 600000 ? t : null; };
const miss = k => { const t = hit(k) || { n: 0, at: Date.now() }; t.n++; fails.set(k, t); };

r.post('/login', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
  const kIp = 'ip:' + req.ip, kEm = 'em:' + email;
  if ((hit(kIp)?.n || 0) >= maxFailsIp() || (hit(kEm)?.n || 0) >= maxFailsAccount()) throw new HttpError(429, 'Too many attempts. Please wait 10 minutes and try again.');
  const u = await db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const ok = await A.verifyPw(pw, u ? u.pw_hash : await A.DUMMY);
  if (!u || !ok) { miss(kIp); miss(kEm); throw new HttpError(401, 'Wrong email or password.'); }
  if (u.status !== 'active') throw new HttpError(403, 'This account is not active. Contact your teacher or administrator.');
  fails.delete(kEm);
  // Password accepted. If this account must also prove control of its mailbox, STOP HERE: e-mail a code and hand the browser only the
  // restricted challenge cookie. No session exists until POST /api/auth/otp/verify succeeds, so no protected route can be reached.
  if (OTP.requiredFor(u)) {
    const c = await OTP.start(u, 'login', req.ip); // throws 429 / 503 (and leaves nothing behind) if a code cannot be sent
    res.setHeader('Set-Cookie', A.otpCookie(c.token, c.maxAgeSeconds, req));
    return res.json({ ok: true, otp_required: true, otp: c.info });
  }
  await db.prepare('UPDATE users SET last_login=? WHERE id=?').run(Date.now(), u.id);
  res.setHeader('Set-Cookie', A.sessionCookie(await A.createSession(u.id), req));
  res.json({ ok: true, user: { id: u.id, email: u.email, name: u.name, role: u.role, must_change: !!u.must_change } });
}));

// ---- e-mail code (OTP) step. These routes take NO e-mail, user id or role from the request: the account is whatever the
// server-side challenge (found through the HttpOnly cookie) was created for after a correct password. ----
const bursts = new Map(); // cheap per-IP brake in front of the database-backed limits inside lib/otp.js
setInterval(() => { const n = Date.now(); for (const [k, v] of bursts) if (n - v.at > 600000) bursts.delete(k); }, 60000).unref();
const burstMax = () => { const v = Number(process.env.OTP_BURST_PER_IP_10MIN); return Number.isFinite(v) && v >= 20 ? Math.floor(v) : 600; };
r.use(['/otp', '/code'], (req, res, next) => {
  const k = 'otp:' + req.ip, now = Date.now(); let b = bursts.get(k);
  if (!b || now - b.at > 600000) { b = { n: 0, at: now }; bursts.set(k, b); }
  if (++b.n > burstMax()) return next(new HttpError(429, 'Too many requests. Please slow down and try again shortly.', { code: 'otp_rate_limited', retry_after: Math.max(1, Math.ceil((b.at + 600000 - now) / 1000)) }));
  next();
});
const sessionGone = (req, res, e) => { if (e?.extra?.code === 'otp_session_missing') res.append('Set-Cookie', A.clearOtpCookie(req)); return e; };
// ---- sign in with an e-mail code ONLY (no password): students by default (OTP_CODE_LOGIN_ROLES). The answer is the same for every
// well-formed address, registered or not, so this form cannot be used to find out who has an account. ----
r.post('/code/request', wrap(async (req, res) => {
  const c = await OTP.withFloor(() => OTP.requestCodeLogin(req.body?.email, req.ip));
  res.setHeader('Set-Cookie', A.otpCookie(c.token, c.maxAgeSeconds, req));
  res.json({ ok: true, otp_required: true, code_login: true, otp: c.info });
}));
r.get('/otp/status', wrap(async (req, res) => {
  const info = await OTP.status(A.cookieOf(req, 'otp_ch'), OTP.SIGN_IN);
  if (!info) { res.append('Set-Cookie', A.clearOtpCookie(req)); throw new HttpError(401, 'No verification is pending. Please sign in.', { code: 'otp_session_missing' }); }
  res.json({ ok: true, otp: info });
}));
r.post('/otp/verify', wrap(async (req, res) => {
  let out;
  try {
    out = await OTP.withFloor(() => OTP.verify(A.cookieOf(req, 'otp_ch'), req.body?.code, req.ip, {
      purpose: OTP.SIGN_IN,
      // Runs inside the same transaction that consumes the code: the code is spent if and only if the session exists.
      onSuccess: async user => { await db.prepare('UPDATE users SET last_login=? WHERE id=?').run(Date.now(), user.id); return await A.createSession(user.id); }
    }));
  } catch (e) { throw sessionGone(req, res, e); }
  const u = out.user;
  res.setHeader('Set-Cookie', [A.sessionCookie(out.extra, req), A.clearOtpCookie(req)]);
  res.json({ ok: true, user: { id: u.id, email: u.email, name: u.name, role: u.role, must_change: !!u.must_change } });
}));
r.post('/otp/resend', wrap(async (req, res) => {
  try { res.json({ ok: true, otp: await OTP.withFloor(() => OTP.resend(A.cookieOf(req, 'otp_ch'), req.ip, OTP.SIGN_IN)) }); } catch (e) { throw sessionGone(req, res, e); }
}));
// "Back": abandon the pending code and return to the password step. Cancelling can never sign anyone in.
r.post('/otp/cancel', wrap(async (req, res) => { await OTP.cancel(A.cookieOf(req, 'otp_ch'), OTP.SIGN_IN); res.append('Set-Cookie', A.clearOtpCookie(req)); res.json({ ok: true }); }));
r.post('/logout', wrap(async (req, res) => {
  const t = A.cookieOf(req, 'sid'); if (t) await db.prepare('DELETE FROM sessions WHERE token_hash=?').run(A.sha(t));
  res.setHeader('Set-Cookie', A.clearCookie(req)); res.json({ ok: true });
}));
// Who am I? Signed out is a normal answer (user: null), not an error; only a real server fault (e.g. the database) is passed on as one.
const whoAmI = A.requireAuth({ allowMustChange: true });
r.get('/me', (req, res, next) => whoAmI(req, res, err => { if (err && !(err instanceof HttpError)) return next(err); req.anonymous = !!err; next(); }),
  wrap(async (req, res) => res.json({ user: req.anonymous ? null : { ...req.user, must_change: !!req.user.must_change }, settings: await SET.get(), code_login: OTP.codeLoginEnabled() })));
r.post('/change-password', A.requireAuth({ allowMustChange: true }), wrap(async (req, res) => {
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!(await A.verifyPw(String(req.body.current || ''), u.pw_hash))) throw new HttpError(403, 'Your current password is wrong.');
  const next = String(req.body.next || ''), p = A.pwProblem(next); if (p) fail(p);
  if (next === req.body.current) fail('Choose a different password.');
  await db.prepare('UPDATE users SET pw_hash=?,must_change=0 WHERE id=?').run(await A.hashPw(next), u.id);
  await db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').run(u.id, A.sha(req.sid));
  await OTP.invalidateFor(u.id); // a code issued after the OLD password was entered must not outlive that password
  await audit(req.user, 'auth.password_change', 'user', u.id); res.json({ ok: true });
}));
module.exports = r;
