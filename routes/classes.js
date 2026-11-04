const express = require('express');
const { db } = require('../lib/db');
const A = require('../lib/auth');
const { wrap, fail, notFound, forbidden, idOf, text } = require('../lib/http');
const { audit } = require('../lib/audit');
const { resetPassword } = require('./admin');
const CSV = require('../lib/csv');
const I = require('../lib/studentImport');
const r = express.Router();
r.use(A.requireAuth());
const staff = A.requireAuth({ roles: ['teacher', 'admin'] });
async function canSee(user, cid) { return user.role === 'admin' || !!await db.prepare('SELECT 1 FROM class_members WHERE class_id=? AND user_id=?').get(cid, user.id); }
async function cls(req) { const id = idOf(req.params.id); if (!await canSee(req.user, id)) notFound(); const c = await db.prepare('SELECT * FROM classes WHERE id=?').get(id); if (!c) notFound(); return c; }

r.get('/', wrap(async (req, res) => {
  const base = `SELECT c.*, s.name subject_name, (SELECT COUNT(*) FROM class_members m WHERE m.class_id=c.id AND m.role='student') students FROM classes c LEFT JOIN subjects s ON s.id=c.subject_id`;
  const rows = req.user.role === 'admin' ? await db.prepare(`${base} ORDER BY c.archived, c.name`).all()
    : await db.prepare(`${base} JOIN class_members me ON me.class_id=c.id AND me.user_id=? ORDER BY c.archived, c.name`).all(req.user.id);
  res.json({ items: rows, subjects: await db.prepare('SELECT * FROM subjects ORDER BY name').all() });
}));
r.post('/', staff, wrap(async (req, res) => {
  const name = text(req.body.name, 80, { min: 1, label: 'Class name' }), sid = req.body.subject_id ? Number(req.body.subject_id) : null;
  if (sid && !await db.prepare('SELECT 1 FROM subjects WHERE id=?').get(sid)) fail('Unknown subject.');
  const id = (await db.prepare('INSERT INTO classes(name,grade,academic_year,subject_id,created_by,created) VALUES(?,?,?,?,?,?) RETURNING id').run(name, text(req.body.grade, 20), text(req.body.academic_year, 20), sid, req.user.id, Date.now())).lastInsertRowid;
  if (req.user.role === 'teacher') await db.prepare("INSERT INTO class_members VALUES(?,?, 'teacher')").run(id, req.user.id);
  await audit(req.user, 'class.create', 'class', id, { name }); res.json({ id });
}));
// ---- CSV: class list, class rosters, templates, membership import (authorised classes only) ----
const iso = ms => ms ? new Date(ms).toISOString() : '';
const classBase = `SELECT c.*, s.name subject_name, (SELECT COUNT(*) FROM class_members m WHERE m.class_id=c.id AND m.role='student') students, (SELECT STRING_AGG(u.name,'; ' ORDER BY u.name) FROM class_members m JOIN users u ON u.id=m.user_id WHERE m.class_id=c.id AND m.role='teacher') teachers FROM classes c LEFT JOIN subjects s ON s.id=c.subject_id`;
r.get('/export.csv', staff, wrap(async (req, res) => {
  const rows = req.user.role === 'admin' ? await db.prepare(`${classBase} ORDER BY c.archived,lower(c.name)`).all() : await db.prepare(`${classBase} JOIN class_members me ON me.class_id=c.id AND me.user_id=? ORDER BY c.archived,lower(c.name)`).all(req.user.id);
  await audit(req.user, 'class.export', 'class', null, { rows: rows.length });
  await CSV.sendCsv(res, 'classes', ['class_id', 'class_name', 'grade', 'academic_year', 'subject', 'student_count', 'teachers', 'archived', 'created_at'], rows.map(c => [c.id, c.name, c.grade || '', c.academic_year || '', c.subject_name || '', c.students, c.teachers || '', c.archived ? 'yes' : 'no', iso(c.created)]));
}));
r.get('/members-template.csv', staff, wrap((req, res) => res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="class-members-template.csv"' }).send(CSV.toCsv(['student_number', 'full_name', 'email'], []))));
r.get('/:id/members.csv', staff, wrap(async (req, res) => {
  const c = await cls(req), rows = await db.prepare("SELECT u.id,u.name,u.email,u.student_number,u.status FROM class_members m JOIN users u ON u.id=m.user_id WHERE m.class_id=? AND m.role='student' ORDER BY lower(u.name),u.id").all(c.id);
  await audit(req.user, 'class.export_roster', 'class', c.id, { rows: rows.length });
  await CSV.sendCsv(res, `class-${c.id}-members`, ['class_id', 'class_name', 'grade', 'academic_year', 'student_id', 'student_number', 'full_name', 'email', 'account_status'], rows.map(u => [c.id, c.name, c.grade || '', c.academic_year || '', u.id, u.student_number || '', u.name, u.email, u.status]));
}));
const manage = async req => { const c = await cls(req); if (!await I.teacherOf(req.user, c.id)) notFound(); if (c.archived) fail('This class is archived. Unarchive it first.'); return c; };
const csvText = req => { if (typeof req.body.csv !== 'string') fail('Choose a CSV file first.'); return req.body.csv; };
r.post('/:id/import-csv/preview', staff, wrap(async (req, res) => res.json(await CSV.guard(async () => await I.plan(req.user, csvText(req), { forceClass: await manage(req) })))));
r.post('/:id/import-csv/commit', staff, wrap(async (req, res) => {
  const c = await manage(req), text = csvText(req), opts = { forceClass: c }; await CSV.guard(async () => await I.plan(req.user, text, opts));
  try { res.json(await I.run(req.user, text, opts, req.body.digest)); } catch (e) { if (e instanceof CSV.CsvError) fail(e.message); throw e; }
}));
r.get('/:id', staff, wrap(async (req, res) => {
  const c = await cls(req);
  res.json({ class: c, members: await db.prepare(`SELECT u.id,u.name,u.email,u.student_number,u.status,m.role FROM class_members m JOIN users u ON u.id=m.user_id WHERE m.class_id=? ORDER BY m.role DESC,u.name`).all(c.id) });
}));
r.patch('/:id', staff, wrap(async (req, res) => {
  const c = await cls(req); await db.prepare('UPDATE classes SET archived=? WHERE id=?').run(req.body.archived ? 1 : 0, c.id);
  await audit(req.user, 'class.archive', 'class', c.id, { archived: !!req.body.archived }); res.json({ ok: true });
}));
r.post('/:id/members', staff, wrap(async (req, res) => {
  const c = await cls(req), u = await db.prepare('SELECT * FROM users WHERE email=?').get(String(req.body.email || '').trim().toLowerCase());
  if (!u) fail('No account with that email. Use "Import students" to create accounts.');
  if (u.role === 'admin') fail('Administrators cannot be class members.');
  if (u.role === 'teacher' && req.user.role !== 'admin') forbidden('Only an administrator can add teachers to a class.');
  await db.prepare('INSERT INTO class_members(class_id,user_id,role) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(c.id, u.id, u.role);
  await audit(req.user, 'class.member_add', 'class', c.id, { user: u.email }); res.json({ ok: true });
}));
r.delete('/:id/members/:uid', staff, wrap(async (req, res) => {
  const c = await cls(req), uid = idOf(req.params.uid);
  await db.prepare('DELETE FROM class_members WHERE class_id=? AND user_id=?').run(c.id, uid);
  await audit(req.user, 'class.member_remove', 'class', c.id, { user_id: uid }); res.json({ ok: true });
}));
r.post('/:id/members/:uid/reset-password', staff, wrap(async (req, res) => {
  const c = await cls(req), uid = idOf(req.params.uid);
  const m = await db.prepare("SELECT 1 FROM class_members WHERE class_id=? AND user_id=? AND role='student'").get(c.id, uid); if (!m) notFound();
  res.json({ temp_password: await resetPassword(req.user, uid) });
}));
// Paste box (legacy format): one student per line "Full name, email, student number (optional)".
// It now runs through the SAME import engine as the CSV workflow (proper CSV parsing, same rules and conflict checks).
r.post('/:id/import', staff, wrap(async (req, res) => {
  const c = await manage(req), lines = String(req.body.text || '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) fail('Paste at least one line.'); if (lines.length > 300) fail('Import at most 300 students at a time.');
  const d = CSV.detectDelimiter(lines[0]), out = await I.run(req.user, ['full_name', 'email', 'student_number'].join(d) + '\r\n' + lines.join('\r\n'), { forceClass: c });
  const creds = new Map(out.credentials.map(x => [x.email, x.temp_password]));
  await audit(req.user, 'class.import', 'class', c.id, { count: out.summary.created + out.summary.updated + out.summary.skipped });
  res.json({ results: out.results.map(x => x.result === 'failed' ? { line: lines[x.line - 2] ?? '', email: x.email || undefined, status: 'error', error: x.reason }
    : x.result === 'created' ? { name: x.full_name, email: x.email, status: 'created', temp_password: creds.get(x.email) } : { name: x.full_name, email: x.email, status: 'added' }) });
}));
module.exports = r;
