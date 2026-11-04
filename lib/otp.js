'use strict';
// Email one-time-password (OTP) verification.
//
// How a sign-in works with this module
//   1. routes/auth.js checks the PASSWORD. Nothing else has happened yet: there is no session.
//   2. If requiredFor(user), start() stores a *challenge* (see migrations/004) and emails a 6-digit code. The browser gets only an
//      HttpOnly cookie (`otp_ch`) that identifies the challenge. That cookie is NOT a session and opens no protected route.
//   3. verify() checks the code and, in the SAME database transaction, consumes the challenge and lets the caller create the session.
//      Either everything happens or nothing does; a code can never be used twice.
//
// Security properties (each is covered by tests/otp.test.js)
//   * Codes come from crypto.randomInt (CSPRNG), uniform over 000000-999999.
//   * Codes are never stored. We keep HMAC-SHA-256(server secret, user | purpose | challenge | code). A six-digit code has only one
//     million values, so an unkeyed or salted hash could be brute-forced instantly from a stolen database; the secret prevents that.
//   * Codes expire (default 5 min), are single-use, and are bound to one user, one e-mail address, one purpose and one browser.
//   * A new code replaces the old one in place, so two codes are never valid together.
//   * Wrong guesses are limited per code, per challenge, per account and per IP address. Sending is limited per challenge
//     (cooldown + resend cap), per account and per IP address.
//   * Nothing here logs a code, a hash, a secret or an address' password.
const crypto = require('crypto');
const { db, tx } = require('./db');
const A = require('./auth');
const mailer = require('./mailer');
const { otpEmail } = require('./emailTemplates');
const SET = require('./settings');
const { audit } = require('./audit');
const { log } = require('./log');
const { HttpError } = require('./http');

const HOUR = 3600e3, FAIL_WINDOW = 15 * 60e3, DAY = 24 * HOUR;
const PURPOSES = ['login', 'password_reset', 'code_login'];
const SIGN_IN = ['login', 'code_login']; // the two purposes that end in a session (password + code, or code only)

// ---------- configuration (read at call time, so tests and operators can change it without a restart of the module) ----------
const num = (name, def, min, max) => { const v = Number(process.env[name]); return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(v) && v >= min && v <= max ? Math.floor(v) : def; };
// Roles that may sign in with ONLY an emailed code (no password). Default: students. OTP_CODE_LOGIN_ROLES=none turns the feature off;
// "student,teacher" widens it. Administrators are included only if you list them explicitly.
function codeLoginRoles() {
  const v = String(process.env.OTP_CODE_LOGIN_ROLES ?? '').trim().toLowerCase();
  if (v === '') return ['student']; if (v === 'none') return [];
  return [...new Set(v.split(/[\s,]+/).filter(r => ['student', 'teacher', 'admin'].includes(r)))];
}
function config() {
  const m = String(process.env.OTP_LOGIN_MODE || 'staff').trim().toLowerCase();
  const ttl = num('OTP_TTL_SECONDS', 300, 60, 1800), maxAttempts = num('OTP_MAX_ATTEMPTS', 5, 1, 10);
  return {
    mode: ['off', 'staff', 'all'].includes(m) ? m : 'staff', // an unrecognised value never switches protection off
    ttlMs: ttl * 1000,
    challengeMs: Math.max(ttl, num('OTP_CHALLENGE_TTL_SECONDS', 900, 120, 3600)) * 1000,
    maxAttempts,
    maxTotalAttempts: Math.max(maxAttempts, num('OTP_MAX_TOTAL_ATTEMPTS', 10, 1, 30)),
    cooldownMs: num('OTP_RESEND_COOLDOWN_SECONDS', 60, 5, 600) * 1000,
    maxResends: num('OTP_MAX_RESENDS', 3, 0, 10),
    maxSendsPerUserHour: num('OTP_MAX_SENDS_PER_USER_HOUR', 6, 1, 30),
    maxRequestsPerIpHour: num('OTP_MAX_REQUESTS_PER_IP_HOUR', 100, 5, 2000),
    maxFailsPerUser: num('OTP_MAX_FAILS_PER_USER', 10, 3, 100),
    maxFailsPerIp: num('OTP_MAX_FAILS_PER_IP', 60, 10, 2000),
    codeLoginRoles: codeLoginRoles()
  };
}

// Which accounts must pass an e-mail code after the password?
//   off    : nobody (emergency switch; documented in docs/EMAIL_OTP.md)
//   staff  : administrators and teachers (default). Students sign in with a password only.
//   all    : everybody, except students an administrator marked `otp_exempt` (students who have no working mailbox).
const requiredFor = u => { const m = config().mode; if (m === 'off' || !u) return false; if (u.role === 'student' && u.otp_exempt) return false; return m === 'all' || u.role !== 'student'; };

// May this account sign in with a code alone? Active, an allowed role, a real (non-temporary) password already chosen, and not marked password-only.
const codeLoginAllowed = u => !!u && u.status === 'active' && !u.must_change && !u.otp_exempt && config().codeLoginRoles.includes(u.role);
const codeLoginEnabled = () => config().codeLoginRoles.length > 0;

// ---------- primitives ----------
let ephemeral = null;
function secret() {
  const s = process.env.OTP_SECRET;
  if (s && s.length >= 32) return s;
  // No (valid) OTP_SECRET: use a random per-process key. Codes live for minutes, so a restart merely invalidates pending codes.
  return ephemeral || (ephemeral = crypto.randomBytes(32).toString('hex'));
}
const hmac = (label, value) => crypto.createHmac('sha256', secret()).update(label + '\0' + value).digest('hex');
const ipHashOf = ip => hmac('ip', String(ip || 'unknown')).slice(0, 32);
const generateCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0'); // uniform; no modulo bias
const generateToken = () => crypto.randomBytes(32).toString('base64url');
const codeHash = (userId, purpose, tokenHash, code) => hmac('otp', `${userId}|${purpose}|${tokenHash}|${code}`);
function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex');
  if (x.length !== 32 || y.length !== 32) { crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32)); return false; }
  return crypto.timingSafeEqual(x, y);
}
function maskEmail(e) {
  const [l = '', d = ''] = String(e || '').split('@');
  return (l.length <= 1 ? '*' : l[0] + '***') + (d ? '@' + d : '');
}

// ---------- counters (persistent, so restarting the server does not reset them) ----------
const record = async (kind, userId, ipHash, now = Date.now()) => await db.prepare('INSERT INTO otp_events(ts,kind,user_id,ip_hash) VALUES(?,?,?,?)').run(now, kind, userId ?? null, ipHash ?? null);
// 0 when under the limit, otherwise the number of seconds until the oldest counted event ages out of the window.
async function wait(kind, who, windowMs, limit, now) {
  const rows = who.userId != null
    ? await db.prepare('SELECT ts FROM otp_events WHERE user_id=? AND kind=? AND ts>? ORDER BY ts DESC LIMIT ?').all(who.userId, kind, now - windowMs, limit)
    : await db.prepare('SELECT ts FROM otp_events WHERE ip_hash=? AND kind=? AND ts>? ORDER BY ts DESC LIMIT ?').all(who.ipHash, kind, now - windowMs, limit);
  return rows.length < limit ? 0 : Math.max(1, Math.ceil((rows[limit - 1].ts + windowMs - now) / 1000));
}
// The real path (several database round trips) and the decoy path (almost none) would otherwise differ measurably in time, which could be used to
// find out which addresses have accounts. Both are held to the same minimum duration. OTP_MIN_RESPONSE_MS=0 switches it off (tests only).
const minResponseMs = () => num('OTP_MIN_RESPONSE_MS', 600, 0, 5000);
async function withFloor(fn) {
  const t0 = Date.now();
  try { return await fn(); }
  finally { const d = minResponseMs() - (Date.now() - t0); if (d > 0) await new Promise(r => setTimeout(r, d)); }
}
const mins = s => s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${s} seconds`;

// ---------- errors (all JSON through the global handler; none carries a code, a hash or a stack) ----------
const E = {
  gone: (m = 'Your verification session has ended. Please sign in again.') => new HttpError(401, m, { code: 'otp_session_missing' }),
  unavailable: () => new HttpError(503, 'Email verification is not available right now. Please contact your administrator.', { code: 'otp_unavailable' }),
  rate: (s, m = 'Too many verification emails were requested.') => new HttpError(429, `${m} Please try again in ${mins(s)}.`, { code: 'otp_rate_limited', retry_after: s }),
  delivery: kind => new HttpError(503, kind === 'rejected' ? 'The email service did not accept the address on this account. Ask your administrator to check it.'
    : kind === 'quota' ? 'The email service has reached its sending limit for now. Please try again later or contact your administrator.'
    : 'We could not send the verification email. Please try again in a few minutes, or ask your administrator to check the email settings.', { code: 'otp_delivery_failed' })
};

function info(ch, c, now) {
  return {
    email_hint: maskEmail(ch.email),
    expires_in: Math.max(0, Math.ceil((ch.code_expires - now) / 1000)),
    resend_in: Math.max(0, Math.ceil((ch.last_sent + c.cooldownMs - now) / 1000)),
    attempts_left: Math.max(0, c.maxAttempts - ch.attempts),
    resends_left: Math.max(0, c.maxResends - ch.resends),
    session_expires_in: Math.max(0, Math.ceil((ch.challenge_expires - now) / 1000))
  };
}

// The account behind a challenge must still be allowed to complete it: active, still subject to OTP, same address as when the code was sent.
async function liveUser(ch) {
  const u = await db.prepare('SELECT id,email,name,role,status,must_change,otp_exempt FROM users WHERE id=?').get(ch.user_id);
  const allowed = ch.purpose === 'code_login' ? codeLoginAllowed(u) : requiredFor(u);
  return u && u.status === 'active' && allowed && u.email.toLowerCase() === ch.email.toLowerCase() ? u : null;
}
// `purposes` is one purpose or a list. A challenge can only be used by the endpoints that accept ITS purpose.
// lock=true (inside a transaction) takes the row FOR UPDATE: SQLite used to run one writer at a time, PostgreSQL does not, and without this lock
// N parallel wrong guesses would all read the same attempt counter and be counted as ONE.
async function findChallenge(token, purposes, lock = false) {
  if (!token) return null;
  const ch = await db.prepare('SELECT * FROM otp_challenges WHERE token_hash=?' + (lock ? ' FOR UPDATE' : '')).get(A.sha(String(token)));
  return ch && [].concat(purposes).includes(ch.purpose) ? ch : null;
}

// ---------- decoy challenges ----------
// Asking for a code by email must look the same whether or not the address belongs to an eligible account, otherwise the form would
// reveal who is registered. For other addresses we keep an in-memory decoy that answers status / resend / verify with the same shapes,
// cooldowns, attempt counts and expiry as a real challenge, but sends nothing and can never be verified. Bounded and short-lived.
const ghosts = new Map();
function ghostStart(email, c, now) {
  const token = generateToken(), ce = now + c.challengeMs;
  if (ghosts.size >= 5000) ghosts.delete(ghosts.keys().next().value);
  ghosts.set(A.sha(token), { email, code_expires: Math.min(now + c.ttlMs, ce), challenge_expires: ce, attempts: 0, total_attempts: 0, resends: 0, last_sent: now });
  return { token, info: info(ghosts.get(A.sha(token)), c, now), maxAgeSeconds: Math.ceil(c.challengeMs / 1000) };
}
const ghostOf = (token, purposes) => token && [].concat(purposes).includes('code_login') ? ghosts.get(A.sha(String(token))) : null;
const dropChallenge = async id => await db.prepare('DELETE FROM otp_challenges WHERE id=?').run(id);

// Rate-limit gates shared by start() and resend(). Throw before anything is written.
async function gateSending(userId, ipHash, c, now) {
  const wu = await wait('send', { userId }, HOUR, c.maxSendsPerUserHour, now); if (wu) throw E.rate(wu, 'Too many verification emails were sent to this account.');
  const wi = await wait('attempt', { ipHash }, HOUR, c.maxRequestsPerIpHour, now); if (wi) throw E.rate(wi, 'Too many verification requests came from your network.');
}
async function mail(user, code, purpose, c) {
  const s = await SET.get(), m = otpEmail({ name: user.name, code, minutes: Math.round(c.ttlMs / 60000), purpose, schoolName: s.school_name, brandColor: s.brand_color, baseUrl: mailer.baseUrl() });
  return await mailer.sendMail({ to: user.email, subject: m.subject, text: m.text, html: m.html });
}

// ---------- 1. start: create the challenge and e-mail the first code ----------
// Returns { token, info }. The caller puts `token` in the HttpOnly cookie. Throws (and leaves NO challenge behind) if the e-mail was not accepted.
async function start(user, purpose, ip, { background = false } = {}) {
  if (!PURPOSES.includes(purpose)) throw new Error('unknown OTP purpose');
  const c = config(), now = Date.now(), ipHash = ipHashOf(ip), fresh = {};
  if (!mailer.configured()) { log('error', 'otp unavailable: mail not configured', { user: user.id }); throw E.unavailable(); }
  const code = generateCode(), token = generateToken(), th = A.sha(token);
  await tx(async () => {
    await db.prepare('SELECT pg_advisory_xact_lock(1, ?::int)').get(user.id); // serialise per account (released at COMMIT)
    await gateSending(user.id, ipHash, c, now);
    await record('attempt', user.id, ipHash, now);
    await db.prepare('DELETE FROM otp_challenges WHERE user_id=? AND purpose=?').run(user.id, purpose); // replaces any earlier code for this account
    const challenge_expires = now + c.challengeMs;
    await db.prepare('INSERT INTO otp_challenges(token_hash,user_id,purpose,email,code_hash,code_expires,challenge_expires,last_sent,created) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(th, user.id, purpose, user.email, codeHash(user.id, purpose, th, code), Math.min(now + c.ttlMs, challenge_expires), challenge_expires, now, now);
    Object.assign(fresh, await db.prepare('SELECT * FROM otp_challenges WHERE token_hash=?').get(th));
  });
  const out = { token, info: info(fresh, c, Date.now()), maxAgeSeconds: Math.ceil(c.challengeMs / 1000) };
  const failed = async e => { await tx(async () => await db.prepare('DELETE FROM otp_challenges WHERE token_hash=?').run(th)); await audit({ id: user.id, email: user.email }, 'auth.otp_delivery_failed', 'user', user.id, { purpose, reason: e.kind || 'unknown' }); };
  const sent = async () => { await record('send', user.id, ipHash); await audit({ id: user.id, email: user.email }, 'auth.otp_sent', 'user', user.id, { purpose, resend: false }); };
  if (background) { // code-only sign-in: answer at once so response time cannot reveal whether the address is registered; a failure removes the challenge
    out.done = mail(user, code, purpose, c).then(sent, async e => { try { await failed(e); } catch {} }); // deliberately NOT awaited
    return out;
  }
  try { await mail(user, code, purpose, c); } catch (e) { await failed(e); throw E.delivery(e.kind); }
  await sent();
  return out;
}

// ---------- 1b. code-only sign-in: request a code for an e-mail address (no password) ----------
// ALWAYS answers the same way for every well-formed address. Only configuration problems and per-network limits (which do not depend on
// the account) produce an error.
async function requestCodeLogin(rawEmail, ip) {
  const c = config(), now = Date.now(), ipHash = ipHashOf(ip), email = (typeof rawEmail === 'string' ? rawEmail : '').trim().toLowerCase().slice(0, 254);
  if (!codeLoginEnabled()) throw new HttpError(404, 'Not found');
  if (!mailer.configured()) throw E.unavailable();
  if (!mailer.EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.', { code: 'email_format' });
  const wi = await wait('attempt', { ipHash }, HOUR, c.maxRequestsPerIpHour, now); if (wi) throw E.rate(wi, 'Too many verification requests came from your network.');
  await record('attempt', null, ipHash, now);
  const u = await db.prepare('SELECT id,email,name,role,status,must_change,otp_exempt FROM users WHERE email=?').get(email);
  // Not eligible, or already at the hourly email cap for that account: behave exactly as if a code was sent (nothing is).
  if (!codeLoginAllowed(u) || await wait('send', { userId: u.id }, HOUR, c.maxSendsPerUserHour, now)) return { ...ghostStart(email, c, now), done: Promise.resolve() };
  return await start(u, 'code_login', ip, { background: true });
}

// ---------- 2. resend: replace the code (the old one stops working immediately) ----------
// `purposes` = the purpose(s) this endpoint accepts. For code-only sign-in the email is sent in the background and a failure is not
// reported to the browser (so the response is identical for decoys); the stored code is simply made unusable.
async function resend(token, ip, purposes = 'login') {
  const c = config(), now = Date.now(), ipHash = ipHashOf(ip);
  if (!mailer.configured()) throw E.unavailable();
  const g = ghostOf(token, purposes);
  if (g) return await ghostResend(g, ipHash, c, now);
  let code = generateCode();
  // The transaction RETURNS refusals instead of throwing them, so cleanups such as dropping an expired challenge are committed.
  const p = await tx(async () => {
    const ch = await findChallenge(token, purposes, true); if (!ch) return { err: E.gone() };
    const purpose = ch.purpose, codeOnly = purpose === 'code_login';
    if (now >= ch.challenge_expires) { await dropChallenge(ch.id); return { err: E.gone('Your verification session expired. Please sign in again.') }; }
    const user = await liveUser(ch); if (!user) { await dropChallenge(ch.id); return { err: E.gone() }; }
    if (ch.total_attempts >= c.maxTotalAttempts) { await dropChallenge(ch.id); return { err: new HttpError(429, 'Too many incorrect codes. Please sign in again later.', { code: 'otp_locked' }) }; }
    const cd = Math.ceil((ch.last_sent + c.cooldownMs - now) / 1000);
    if (cd > 0) return { err: new HttpError(429, `Please wait ${mins(cd)} before requesting another code.`, { code: 'otp_cooldown', retry_after: cd }) };
    if (ch.resends >= c.maxResends) return { err: new HttpError(429, 'No more codes can be sent for this sign-in. Please go back and sign in again.', { code: 'otp_resend_limit' }) };
    let quiet = false; // code-only: at the per-account hourly cap we pretend to send, so the cap cannot be used to tell real accounts from decoys
    if (codeOnly) { const wi = await wait('attempt', { ipHash }, HOUR, c.maxRequestsPerIpHour, now); if (wi) return { err: E.rate(wi, 'Too many verification requests came from your network.') }; quiet = !!await wait('send', { userId: user.id }, HOUR, c.maxSendsPerUserHour, now); }
    else { try { await gateSending(user.id, ipHash, c, now); } catch (e) { return { err: e }; } }
    let h = codeHash(user.id, purpose, ch.token_hash, code);
    while (safeEqualHex(h, ch.code_hash)) { code = generateCode(); h = codeHash(user.id, purpose, ch.token_hash, code); } // a replacement is never equal to the code it replaces
    await db.prepare('UPDATE otp_challenges SET code_hash=?, code_expires=?, attempts=0, resends=resends+1, last_sent=? WHERE id=?')
      .run(h, Math.min(now + c.ttlMs, ch.challenge_expires), now, ch.id);
    await record('attempt', user.id, ipHash, now);
    return { ch: await db.prepare('SELECT * FROM otp_challenges WHERE id=?').get(ch.id), user, purpose, codeOnly, quiet, prevSent: ch.last_sent, h };
  });
  if (p.err) throw p.err;
  const failed = async e => { await tx(async () => await db.prepare("UPDATE otp_challenges SET code_hash='!', code_expires=0, last_sent=? WHERE id=? AND code_hash=?").run(p.prevSent, p.ch.id, p.h)); await audit({ id: p.user.id, email: p.user.email }, 'auth.otp_delivery_failed', 'user', p.user.id, { purpose: p.purpose, reason: e.kind || 'unknown', resend: true }); };
  const sent = async () => { await record('send', p.user.id, ipHash); await audit({ id: p.user.id, email: p.user.email }, 'auth.otp_sent', 'user', p.user.id, { purpose: p.purpose, resend: true }); };
  if (p.codeOnly) { // answer immediately; same timing as a decoy
    if (!p.quiet) mail(p.user, code, p.purpose, c).then(sent, async e => { try { await failed(e); } catch {} }); // deliberately NOT awaited
    return info(p.ch, c, Date.now());
  }
  try { await mail(p.user, code, p.purpose, c); }
  catch (e) { await failed(e); throw E.delivery(e.kind); } // the old code is already gone and the new one never arrived: it is made unusable, and an immediate retry is allowed
  await sent();
  return info(p.ch, c, Date.now());
}
async function ghostResend(g, ipHash, c, now) {
  if (now >= g.challenge_expires) throw E.gone('Your verification session expired. Please sign in again.');
  if (g.total_attempts >= c.maxTotalAttempts) throw new HttpError(429, 'Too many incorrect codes. Please sign in again later.', { code: 'otp_locked' });
  const cd = Math.ceil((g.last_sent + c.cooldownMs - now) / 1000);
  if (cd > 0) throw new HttpError(429, `Please wait ${mins(cd)} before requesting another code.`, { code: 'otp_cooldown', retry_after: cd });
  if (g.resends >= c.maxResends) throw new HttpError(429, 'No more codes can be sent for this sign-in. Please go back and sign in again.', { code: 'otp_resend_limit' });
  const wi = await wait('attempt', { ipHash }, HOUR, c.maxRequestsPerIpHour, now); if (wi) throw E.rate(wi, 'Too many verification requests came from your network.');
  Object.assign(g, { code_expires: Math.min(now + c.ttlMs, g.challenge_expires), attempts: 0, resends: g.resends + 1, last_sent: now }); await record('attempt', null, ipHash, now);
  return info(g, c, now);
}

// ---------- 3. verify: check the code and, atomically, consume the challenge ----------
// `onSuccess(user, now)` runs INSIDE the transaction (the login route creates the session there). Returns { user, extra }.
async function verify(token, code, ip, { purpose = 'login', onSuccess } = {}) {
  const c = config(), now = Date.now(), ipHash = ipHashOf(ip); code = typeof code === 'string' ? code.trim() : ''; // strictly a string: numbers lose leading zeros, arrays coerce
  const g = ghostOf(token, purpose); if (g) throw await ghostVerify(g, code, ipHash, c, now);
  const out = await tx(async () => {
    const ch = await findChallenge(token, purpose, true); if (!ch) return { err: E.gone() };
    const kind = ch.purpose;
    if (now >= ch.challenge_expires) { await dropChallenge(ch.id); return { err: E.gone('Your verification session expired. Please sign in again.') }; }
    const user = await liveUser(ch); if (!user) { await dropChallenge(ch.id); return { err: E.gone() }; }
    const wu = await wait('fail', { userId: user.id }, FAIL_WINDOW, c.maxFailsPerUser, now), wi = await wait('fail', { ipHash }, FAIL_WINDOW, c.maxFailsPerIp, now);
    if (wu || wi) return { err: new HttpError(429, `Too many incorrect codes. Please try again in ${mins(Math.max(wu, wi))}.`, { code: 'otp_locked', retry_after: Math.max(wu, wi) }), audit: ['auth.otp_locked', user] };
    if (ch.total_attempts >= c.maxTotalAttempts) { await dropChallenge(ch.id); return { err: new HttpError(429, 'Too many incorrect codes. Please sign in again later.', { code: 'otp_locked' }), audit: ['auth.otp_locked', user] }; }
    if (!/^\d{6}$/.test(code)) return { err: new HttpError(400, 'Enter the 6-digit code from the email.', { code: 'otp_format' }) }; // not a guess: not counted
    if (now >= ch.code_expires) return { err: new HttpError(410, 'That code has expired. Request a new one.', { code: 'otp_expired' }) };
    if (ch.attempts >= c.maxAttempts) return { err: new HttpError(429, 'Too many incorrect attempts for that code. Request a new one.', { code: 'otp_attempts_exhausted' }) };
    if (!safeEqualHex(codeHash(user.id, kind, ch.token_hash, code), ch.code_hash)) {
      const attempts = ch.attempts + 1, spent = attempts >= c.maxAttempts;
      await db.prepare(`UPDATE otp_challenges SET attempts=attempts+1, total_attempts=total_attempts+1${spent ? ", code_hash='!'" : ''} WHERE id=?`).run(ch.id); // a spent code can never be accepted, even if guessed later
      await record('fail', user.id, ipHash, now);
      return { err: new HttpError(400, spent ? 'That code is incorrect and has been cancelled. Request a new one.' : 'That code is incorrect.', { code: 'otp_invalid', attempts_left: c.maxAttempts - attempts }) };
    }
    // Correct. Single use: the challenge is deleted in the same transaction that lets the caller sign the user in.
    await dropChallenge(ch.id);
    await db.prepare("DELETE FROM otp_events WHERE user_id=? AND kind='fail'").run(user.id);
    await db.prepare('UPDATE users SET email_verified_at=? WHERE id=?').run(now, user.id);
    const extra = onSuccess ? await onSuccess(user, now) : null;
    await audit({ id: user.id, email: user.email }, 'auth.otp_verified', 'user', user.id, { purpose: kind });
    return { user, extra };
  });
  if (out.audit) await audit({ id: out.audit[1].id, email: out.audit[1].email }, out.audit[0], 'user', out.audit[1].id, { purpose: [].concat(purpose)[0] });
  if (out.err) throw out.err;
  return out;
}
// A decoy can never be verified; it only reproduces the failure responses (and counts failures against the network address).
async function ghostVerify(g, code, ipHash, c, now) {
  if (now >= g.challenge_expires) return E.gone('Your verification session expired. Please sign in again.');
  const wi = await wait('fail', { ipHash }, FAIL_WINDOW, c.maxFailsPerIp, now);
  if (wi || g.total_attempts >= c.maxTotalAttempts) return new HttpError(429, wi ? `Too many incorrect codes. Please try again in ${mins(wi)}.` : 'Too many incorrect codes. Please sign in again later.', { code: 'otp_locked', ...(wi ? { retry_after: wi } : {}) });
  if (!/^\d{6}$/.test(code)) return new HttpError(400, 'Enter the 6-digit code from the email.', { code: 'otp_format' });
  if (now >= g.code_expires) return new HttpError(410, 'That code has expired. Request a new one.', { code: 'otp_expired' });
  if (g.attempts >= c.maxAttempts) return new HttpError(429, 'Too many incorrect attempts for that code. Request a new one.', { code: 'otp_attempts_exhausted' });
  g.attempts++; g.total_attempts++; await record('fail', null, ipHash, now);
  const spent = g.attempts >= c.maxAttempts;
  return new HttpError(400, spent ? 'That code is incorrect and has been cancelled. Request a new one.' : 'That code is incorrect.', { code: 'otp_invalid', attempts_left: c.maxAttempts - g.attempts });
}

// ---------- helpers for the routes ----------
async function status(token, purposes = 'login') {
  const now = Date.now(), c = config(), g = ghostOf(token, purposes);
  if (g) return now < g.challenge_expires ? info(g, c, now) : null;
  const ch = await findChallenge(token, purposes);
  return ch && now < ch.challenge_expires && await liveUser(ch) ? info(ch, c, now) : null;
}
async function cancel(token, purposes = 'login') {
  const g = ghostOf(token, purposes); if (g) return ghosts.delete(A.sha(String(token)));
  const ch = await findChallenge(token, purposes); if (ch) await dropChallenge(ch.id);
}
// Call whenever something that a pending challenge depends on changes (password, e-mail, suspension).
const invalidateFor = async userId => await db.prepare('DELETE FROM otp_challenges WHERE user_id=?').run(userId);
async function sweep() {
  const now = Date.now();
  await db.prepare('DELETE FROM otp_challenges WHERE challenge_expires<?').run(now);
  await db.prepare('DELETE FROM otp_events WHERE ts<?').run(now - DAY);
  for (const [k, g] of ghosts) if (now >= g.challenge_expires) ghosts.delete(k);
}

// Logged once at start-up so a misconfiguration is obvious in the Render log instead of surfacing as locked-out users.
const UNDELIVERABLE = /@.*\.(local|invalid|test|example|localhost)$|@example\./i;
async function startupReport() {
  const c = config(), r = { mode: c.mode, mail_configured: mailer.configured(), secret: process.env.OTP_SECRET && process.env.OTP_SECRET.length >= 32 ? 'environment' : 'per-process (set OTP_SECRET)' };
  if (process.env.OTP_LOGIN_MODE && !['off', 'staff', 'all'].includes(String(process.env.OTP_LOGIN_MODE).trim().toLowerCase())) log('warn', 'OTP_LOGIN_MODE not recognised; using "staff"');
  if (c.mode === 'off') log('warn', 'OTP sign-in verification is OFF (OTP_LOGIN_MODE=off). Accounts sign in with a password only.');
  else if (!r.mail_configured) log('error', 'OTP sign-in is REQUIRED but GMAIL_USER / GMAIL_APP_PASSWORD are not set, so affected accounts cannot sign in. Set them, or set OTP_LOGIN_MODE=off temporarily.');
  if (c.mode !== 'off') {
    const rows = (await db.prepare("SELECT id,email FROM users WHERE status='active' AND otp_exempt=0 AND (?::text='all' OR role!='student')").all(c.mode)).filter(u => UNDELIVERABLE.test(u.email));
    if (rows.length) log('warn', 'accounts that need a code have addresses that look undeliverable; fix them or they cannot sign in', { count: rows.length, user_ids: rows.slice(0, 20).map(u => u.id).join(',') });
  }
  return r;
}

module.exports = { withFloor, config, requiredFor, codeLoginAllowed, codeLoginEnabled, requestCodeLogin, SIGN_IN, start, resend, verify, status, cancel, invalidateFor, sweep, startupReport, maskEmail, generateCode, codeHash, ipHashOf, record, wait, PURPOSES };
