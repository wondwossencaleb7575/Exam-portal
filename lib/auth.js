const crypto = require('crypto'), { promisify } = require('util');
const { db } = require('./db');
const { HttpError } = require('./http');
const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 12 * 3600e3;
const COOKIE_SECURE = process.env.NODE_ENV === 'production' && !process.env.COOKIE_INSECURE;

async function hashPw(pw) {
  const salt = crypto.randomBytes(16), h = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`;
}
async function verifyPw(pw, stored) {
  const [alg, s, h] = String(stored || '').split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(h, 'base64'), got = await scrypt(pw, Buffer.from(s, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}
const DUMMY = hashPw('dummy-password-for-timing');
const COMMON = ['password123', '1234567890', 'qwertyuiop', 'password1234', 'letmein1234'];
function pwProblem(pw) {
  pw = String(pw || '');
  if (pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 128) return 'Password is too long.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and at least one number.';
  if (COMMON.includes(pw.toLowerCase())) return 'That password is too common.';
  return null;
}
function tempPassword() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let p; do { p = Array.from(crypto.randomBytes(12), b => A[b % A.length]).join(''); } while (pwProblem(p));
  return p;
}
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url'), now = Date.now();
  await db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(sha(token), userId, now, now + SESSION_MS);
  return token;
}
// Expired sessions are already ignored when checked; this removes them so the table does not grow forever. Returns how many were deleted.
const sweepSessions = async (now = Date.now()) => (await db.prepare('DELETE FROM sessions WHERE expires<?').run(now)).changes;
const sessionCookie = (token, req) => `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${(COOKIE_SECURE || req?.secure) ? '; Secure' : ''}`;
const clearCookie = req => `sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${(COOKIE_SECURE || req?.secure) ? '; Secure' : ''}`;
// The e-mail-code challenge cookie. It is NOT a session: it only tells /api/auth/otp/* which pending code this browser may try.
// Path-scoped to /api/auth so it is never sent with exam or admin requests.
const otpCookie = (token, maxAge, req) => `otp_ch=${token}; HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=${maxAge}${(COOKIE_SECURE || req?.secure) ? '; Secure' : ''}`;
const clearOtpCookie = req => otpCookie('', 0, req);
const cookieOf = (req, n) => { for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (p.slice(0, i).trim() === n) return p.slice(i + 1).trim(); } };

// Authentication + server-side authorisation. Every protected route goes through this.
function requireAuth({ roles, allowMustChange = false } = {}) {
  return async (req, res, next) => {
    // The lookup is inside try/catch because Express 4 does not catch a rejected promise from async middleware (a database outage must become a 500, not a hang).
    const tok = cookieOf(req, 'sid'); let u;
    try { u = tok && await db.prepare(`SELECT u.id,u.email,u.name,u.role,u.status,u.must_change,u.student_number FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?`).get(sha(tok), Date.now()); }
    catch (e) { return next(e); }
    if (!u || u.status !== 'active') return next(new HttpError(401, 'Please sign in.'));
    if (u.must_change && !allowMustChange) return next(new HttpError(403, 'You must change your temporary password first.', { code: 'must_change' }));
    if (roles && !roles.includes(u.role)) return next(new HttpError(403, 'You do not have permission to do that.'));
    req.user = u; req.sid = tok; next();
  };
}
module.exports = { hashPw, verifyPw, DUMMY, pwProblem, tempPassword, createSession, sweepSessions, sessionCookie, clearCookie, requireAuth, sha, cookieOf, otpCookie, clearOtpCookie };
