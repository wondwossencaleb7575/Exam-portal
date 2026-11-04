'use strict';
// Exam-roster CSV: matches EXISTING student accounts only (by email and/or student number). Never creates accounts.
const crypto = require('crypto');
const { db } = require('./db');
const CSV = require('./csv');
const S = require('./students');
const E = require('./enroll');
const { HttpError } = require('./http');

const SPEC = { required: [], optional: ['email', 'student_number', 'full_name'], aliases: { email_address: 'email', e_mail: 'email', e_mail_address: 'email', student_email: 'email', student_no: 'student_number', student_num: 'student_number', studentnumber: 'student_number', name: 'full_name', student_name: 'full_name' } };
const low = s => String(s || '').trim().toLowerCase();
const NOMATCH = 'No student you can enroll matches this row. Roster files only match existing accounts and only students from your own classes.';

async function evaluate(actor, exam, row, ctx) {
  const d = row.data, out = { line: row.line, email: low(d.email), student_number: d.student_number || '', full_name: d.full_name || '', action: 'fail', errors: [], notes: [] };
  const err = (column, message) => { out.errors.push({ column, message }); return out; };
  if (row.parseError) return err('', row.parseError);
  if (!d.email && !d.student_number) return err('email', 'Give an email or a student_number.');
  if (/[\u0000-\u001F\u007F]/.test((d.email || '') + (d.student_number || ''))) return err('email', 'Contains a control character.');
  let byEmail = null, byNum = null;
  if (d.email) byEmail = await db.prepare("SELECT id FROM users WHERE email=? AND role='student'").get(out.email);
  if (d.student_number) { const m = await db.prepare("SELECT id FROM users WHERE lower(student_number)=lower(?) AND role='student'").all(d.student_number); if (m.length > 1 && !byEmail) return err('student_number', 'More than one student has this number. Use the email column.'); byNum = m.find(x => !byEmail || x.id === byEmail.id) || m[0] || null; }
  if (byEmail && byNum && byEmail.id !== byNum.id) return err('student_number', 'Conflict: the email and the student number belong to different students.');
  if (byEmail && d.student_number && !byNum) return err('student_number', 'The student number does not match the one on file for this email.');
  const id = (byEmail || byNum)?.id; if (!id || !await S.inScope(actor, id)) return err(d.email ? 'email' : 'student_number', NOMATCH);
  out.studentId = id; const u = await db.prepare('SELECT name,status FROM users WHERE id=?').get(id); out.full_name = u.name;
  if (ctx.seen.has(id)) { out.action = 'skip'; out.notes.push(`Duplicate of line ${ctx.seen.get(id)}.`); return out; } ctx.seen.set(id, row.line);
  if (u.status !== 'active') return err('email', 'Account is suspended.');
  const a = (await db.prepare('SELECT EXISTS(SELECT 1 FROM exam_students WHERE exam_id=? AND student_id=?) d').get(exam.id, id)).d;
  if (a) { out.action = 'skip'; out.notes.push('Already enrolled.'); return out; }
  if (await E.hasAccess(exam.id, id)) { out.action = 'skip'; out.notes.push('Already has access through an assigned class.'); return out; }
  out.action = 'enroll'; return out;
}
const digestOf = (t, id) => crypto.createHash('sha256').update(JSON.stringify({ t, id })).digest('hex');
function read(text) { const t = CSV.readTable(text, SPEC); if (!t.columns.includes('email') && !t.columns.includes('student_number')) throw new CSV.CsvError('Include an "email" or "student_number" column. Found: ' + (t.columns.join(', ') || '(none)') + '.'); return t; }
const brief = r => ({ line: r.line, action: r.action, email: r.email, student_number: r.student_number, full_name: r.full_name, errors: r.errors, notes: r.notes });
// Rows are evaluated strictly one after another: "duplicate of line N" depends on the order of the file.
async function evaluateAll(actor, exam, t) { const ctx = { seen: new Map() }, out = []; for (const r of t.rows) out.push(await evaluate(actor, exam, r, ctx)); return out; }
async function plan(actor, exam, text) {
  const t = read(text), rows = await evaluateAll(actor, exam, t);
  return { digest: digestOf(text, exam.id), columns: t.columns, ignored_columns: t.ignored, summary: { total: rows.length, enroll: rows.filter(r => r.action === 'enroll').length, skip: rows.filter(r => r.action === 'skip').length, fail: rows.filter(r => r.action === 'fail').length }, rows: rows.map(brief) };
}
async function run(actor, exam, text, digest) {
  if (digest && digest !== digestOf(text, exam.id)) throw new HttpError(409, 'The file changed since the preview. Preview it again before importing.');
  const t = read(text), ev = await evaluateAll(actor, exam, t);
  const r = await E.enroll(actor, exam, ev.filter(x => x.action === 'enroll').map(x => x.studentId), 'csv');
  const added = new Set(r.added.map(x => x.id)), why = new Map([...r.already, ...r.failed].map(x => [x.id, x.reason]));
  const results = ev.map(x => x.action === 'fail' ? { line: x.line, email: x.email, student_number: x.student_number, result: 'failed', reason: x.errors.map(e => e.message).join(' ') }
    : x.action === 'skip' ? { line: x.line, email: x.email, student_number: x.student_number, result: 'skipped', reason: x.notes.join(' ') }
    : { line: x.line, email: x.email, student_number: x.student_number, result: added.has(x.studentId) ? 'enrolled' : (r.failed.some(f => f.id === x.studentId) ? 'failed' : 'skipped'), reason: added.has(x.studentId) ? '' : why.get(x.studentId) || '' });
  const summary = { total: results.length, enrolled: results.filter(x => x.result === 'enrolled').length, skipped: results.filter(x => x.result === 'skipped').length, failed: results.filter(x => x.result === 'failed').length };
  const bad = results.filter(x => x.result !== 'enrolled');
  return { summary, results, report_csv: CSV.toCsv(['email', 'student_number', 'line', 'result', 'reason'], bad.map(x => [x.email, x.student_number, x.line, x.result, x.reason])) };
}
module.exports = { plan, run };
