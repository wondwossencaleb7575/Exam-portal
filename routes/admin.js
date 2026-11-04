const express = require('express');
const fs = require('fs');
const { db } = require('../lib/db');
const A = require('../lib/auth');
const { wrap, fail, notFound, idOf, paging, text } = require('../lib/http');
const { audit } = require('../lib/audit');
const B = require('../lib/backup');
const { insertUser, EMAIL_RE, friendly } = require('../lib/users');
const SET = require('../lib/settings');
const CSV = require('../lib/csv');
const OTP = require('../lib/otp');
const mailer = require('../lib/mailer');
const { testEmail } = require('../lib/emailTemplates');
const { HttpError } = require('../lib/http');
const r = express.Router();
r.use(A.requireAuth({ roles: ['admin'] }));

async function createUser(actor, { email, name, role, student_number }) {
  email = String(email || '').trim().toLowerCase(); if (!EMAIL_RE.test(email)) fail('Enter a valid email address.');
  name = text(name, 80, { min: 1, label: 'Name' });
  if (await db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) fail('An account with that email already exists.');
  const temp = A.tempPassword(), id = await insertUser(actor, { email, name, role, student_number, pw_hash: await A.hashPw(temp) });
  return { id, email, name, role, temp_password: temp };
}
async function resetPassword(actor, userId) {
  const u = await db.prepare('SELECT id,email FROM users WHERE id=?').get(userId); if (!u) notFound();
  const temp = A.tempPassword();
  await db.prepare('UPDATE users SET pw_hash=?,must_change=1 WHERE id=?').run(await A.hashPw(temp), u.id);
  await db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  await OTP.invalidateFor(u.id); // a code issued under the old password must not survive the reset
  await audit(actor, 'user.password_reset', 'user', u.id, { email: u.email });
  return temp;
}
r.get('/users', wrap(async (req, res) => {
  const { page, size, offset } = paging(req), q = `%${String(req.query.q || '').trim()}%`, role = ['admin', 'teacher', 'student'].includes(req.query.role) ? req.query.role : null;
  const w = 'WHERE (name ILIKE ? OR email ILIKE ? OR student_number ILIKE ?) AND (?::text IS NULL OR role=?)', p = [q, q, q, role, role];
  const total = (await db.prepare(`SELECT COUNT(*) n FROM users ${w}`).get(...p)).n;
  res.json({ total, page, size, items: (await db.prepare(`SELECT id,email,name,role,student_number,status,created,last_login,email_verified_at,otp_exempt FROM users ${w} ORDER BY role,name LIMIT ? OFFSET ?`).all(...p, size, offset)).map(u => ({ ...u, otp_required: OTP.requiredFor(u) })), otp_mode: OTP.config().mode });
}));
// Administrative user list for download: no password hashes, tokens or temporary credentials.
r.get('/users/export.csv', wrap(async (req, res) => {
  const role = ['admin', 'teacher', 'student'].includes(req.query.role) ? req.query.role : null, q = `%${String(req.query.q || '').trim()}%`, iso = ms => ms ? new Date(ms).toISOString() : '';
  const rows = await db.prepare("SELECT id,name,email,role,student_number,status,created,last_login FROM users WHERE (name ILIKE ? OR email ILIKE ? OR COALESCE(student_number,'') ILIKE ?) AND (?::text IS NULL OR role=?) ORDER BY role,lower(name),id").all(q, q, q, role, role);
  await audit(req.user, 'users.export', 'user', null, { role });
  await CSV.sendCsv(res, 'users', ['user_id', 'full_name', 'email', 'role', 'student_number', 'account_status', 'created_at', 'last_login'], (function* () { for (const u of rows) yield [u.id, u.name, u.email, u.role, u.student_number || '', u.status, iso(u.created), iso(u.last_login)]; })());
}));
r.post('/users', wrap(async (req, res) => {
  if (!['admin', 'teacher', 'student'].includes(req.body.role)) fail('Choose a role.');
  res.json(await createUser(req.user, req.body));
}));
r.patch('/users/:id', wrap(async (req, res) => {
  const id = idOf(req.params.id), u = await db.prepare('SELECT * FROM users WHERE id=?').get(id); if (!u) notFound();
  if (req.body.status) {
    if (!['active', 'suspended'].includes(req.body.status)) fail('Invalid status.');
    if (id === req.user.id) fail('You cannot suspend your own account.');
    await db.prepare('UPDATE users SET status=? WHERE id=?').run(req.body.status, id);
    if (req.body.status === 'suspended') { await db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); await OTP.invalidateFor(id); }
    await audit(req.user, 'user.status', 'user', id, { from: u.status, to: req.body.status });
  }
  const changes = {};
  if (req.body.name !== undefined) { const n = text(req.body.name, 80, { min: 1, label: 'Name' }); if (n !== u.name) { await db.prepare('UPDATE users SET name=? WHERE id=?').run(n, id); changes.name = [u.name, n]; } }
  if (req.body.email !== undefined) {
    const em = String(req.body.email).trim().toLowerCase(); if (!EMAIL_RE.test(em) || em.length > 254) fail('Enter a valid email address.');
    // A new address has not proven anything yet: forget the old verification and cancel any code that was sent to the old address.
    if (em !== u.email) { try { await db.prepare('UPDATE users SET email=?, email_verified_at=NULL WHERE id=?').run(em, id); } catch (e) { throw friendly(e); } await OTP.invalidateFor(id); changes.email = [u.email, em]; }
  }
  if (req.body.student_number !== undefined) {
    if (u.role !== 'student') fail('Only student accounts have a student number.');
    const sn = String(req.body.student_number ?? '').trim(); if (sn && !/^[\p{L}\p{N}][\p{L}\p{N} ._\/-]{0,29}$/u.test(sn)) fail('Use letters, digits, space and . _ / - only (maximum 30 characters).');
    if ((sn || null) !== (u.student_number || null)) { try { await db.prepare('UPDATE users SET student_number=? WHERE id=?').run(sn || null, id); } catch (e) { throw friendly(e); } changes.student_number = [u.student_number, sn || null]; }
  }
  if (req.body.otp_exempt !== undefined) {
    // Students without a working mailbox can be allowed to sign in with a password only. Never staff (also enforced by a database trigger).
    if (u.role !== 'student') fail('Only student accounts can be exempt from email verification.');
    const ex = req.body.otp_exempt === true || req.body.otp_exempt === 1 || req.body.otp_exempt === 'true' ? 1 : 0;
    if (ex !== u.otp_exempt) { await db.prepare('UPDATE users SET otp_exempt=? WHERE id=?').run(ex, id); await OTP.invalidateFor(id); changes.otp_exempt = [!!u.otp_exempt, !!ex]; }
  }
  if (Object.keys(changes).length) await audit(req.user, 'user.update', 'user', id, { changes });
  res.json({ ok: true });
}));
r.post('/users/:id/reset-password', wrap(async (req, res) => res.json({ temp_password: await resetPassword(req.user, idOf(req.params.id)) })));
// ---- email delivery diagnostics (administrator only). Never returns the app password, only whether one is set. ----
let lastEmailCheck = null;
const emailState = () => ({ mode: OTP.config().mode, configured: mailer.configured(), sender: mailer.configured() ? OTP.maskEmail(mailer.senderAddress()) : null, app_base_url: mailer.baseUrl() || null,
  secret_from_environment: !!(process.env.OTP_SECRET && process.env.OTP_SECRET.length >= 32), last_check: lastEmailCheck,
  limits: (({ ttlMs, challengeMs, cooldownMs, ...rest }) => ({ ...rest, ttl_seconds: ttlMs / 1000, session_seconds: challengeMs / 1000, resend_cooldown_seconds: cooldownMs / 1000 }))(OTP.config()) });
r.get('/email-status', wrap((req, res) => res.json(emailState())));
r.post('/email-status/verify', wrap(async (req, res) => { // opens an authenticated SMTP session and closes it; sends nothing
  const v = await mailer.verify(); lastEmailCheck = { at: Date.now(), ok: v.ok, kind: v.kind || null, message: v.ok ? 'Connected and signed in to the mail server.' : v.message };
  await audit(req.user, 'system.email_check', 'system', null, { ok: v.ok, kind: v.kind || null }); res.json(emailState());
}));
r.post('/email-test', wrap(async (req, res) => { // sends one real message to the administrator's own address; limited to 5 per hour
  if (!mailer.configured()) throw new HttpError(503, mailer.MESSAGES.not_configured, { code: 'otp_unavailable' });
  const now = Date.now(), w = await OTP.wait('test', { userId: req.user.id }, 3600e3, 5, now); if (w) throw new HttpError(429, `Test emails are limited to 5 per hour. Try again in ${Math.ceil(w / 60)} minutes.`);
  const set = await SET.get(), m = testEmail({ schoolName: set.school_name, brandColor: set.brand_color, baseUrl: mailer.baseUrl() });
  await OTP.record('test', req.user.id, null, now);
  try { await mailer.sendMail({ to: req.user.email, ...m }); }
  catch (e) { lastEmailCheck = { at: Date.now(), ok: false, kind: e.kind || 'unknown', message: e.message }; await audit(req.user, 'system.email_test', 'system', null, { ok: false, kind: e.kind || 'unknown' }); throw new HttpError(502, `${e.message} Check the server log for details.`, { code: 'otp_delivery_failed' }); }
  lastEmailCheck = { at: Date.now(), ok: true, kind: null, message: 'The mail server accepted the test message.' };
  await audit(req.user, 'system.email_test', 'system', null, { ok: true }); res.json({ ok: true, to: OTP.maskEmail(req.user.email) });
}));
r.post('/subjects', wrap(async (req, res) => {
  const name = text(req.body.name, 60, { min: 1, label: 'Subject name' });
  try { const id = (await db.prepare('INSERT INTO subjects(name) VALUES(?) RETURNING id').run(name)).lastInsertRowid; await audit(req.user, 'subject.create', 'subject', id, { name }); res.json({ id }); }
  catch { fail('That subject already exists.'); }
}));
r.get('/audit', wrap(async (req, res) => {
  const { page, size, offset } = paging(req, 50, 200), f = [], p = [];
  if (req.query.action) { f.push('action ILIKE ?'); p.push(`${String(req.query.action)}%`); }
  if (req.query.actor) { f.push('actor_email ILIKE ?'); p.push(`%${String(req.query.actor)}%`); }
  if (Number(req.query.from)) { f.push('ts>=?'); p.push(Number(req.query.from)); }
  if (Number(req.query.to)) { f.push('ts<=?'); p.push(Number(req.query.to)); }
  const w = f.length ? 'WHERE ' + f.join(' AND ') : '';
  res.json({ total: (await db.prepare(`SELECT COUNT(*) n FROM audit ${w}`).get(...p)).n, page, size, items: await db.prepare(`SELECT * FROM audit ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...p, size, offset) });
}));
// School settings (time zone, language, calendar, pass mark, grading scale, terms, branding). Everyone signed in can READ them; only administrators change them.
r.put('/settings', wrap(async (req, res) => { const { before, after } = await SET.update(req.body || {}); await audit(req.user, 'settings.update', 'system', null, { before, after }); res.json(after); }));
r.get('/health', wrap(async (req, res) => {
  const n = async t => (await db.prepare(`SELECT COUNT(*) n FROM ${t}`).get()).n;
  const last = await db.prepare("SELECT MAX(ts) t FROM audit WHERE action='system.db_check'").get();
  res.json({ ok: true, uptime_s: Math.round(process.uptime()), db_bytes: (await db.prepare('SELECT pg_database_size(current_database()) n').get()).n, users: await n('users'), exams: await n('exams'), attempts_in_progress: (await db.prepare("SELECT COUNT(*) n FROM attempts WHERE status='in_progress'").get()).n, last_check: last?.t || null, node: process.version });
}));
// Read-only consistency check of the database (see lib/backup.js). Backups themselves are made by Supabase and by `npm run backup` (docs/RECOVERY.md).
r.post('/backup', wrap(async (req, res) => {
  const v = await B.check(db); await audit(req.user, 'system.db_check', 'system', null, { ok: v.ok, issues: v.issues.length });
  res.json({ verify: v });
}));
module.exports = r; module.exports.createUser = createUser; module.exports.resetPassword = resetPassword;
