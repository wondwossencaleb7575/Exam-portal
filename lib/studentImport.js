'use strict';
// ONE student-import engine, used by: admin "Import Students (CSV)", class CSV import, and the legacy paste box.
// plan() is a dry run (preview). run() re-validates every row against the live database inside per-row transactions.
const crypto = require('crypto');
const { db, tx, guarded } = require('./db');
const A = require('./auth');
const { audit } = require('./audit');
const CSV = require('./csv');
const { insertUser, EMAIL_RE, friendly } = require('./users');
const { HttpError } = require('./http');

const COLUMNS = ['student_number', 'full_name', 'email', 'class_name', 'grade', 'academic_year', 'status'];
const SPEC = { required: ['full_name', 'email'], optional: ['student_number', 'class_name', 'grade', 'academic_year', 'status'],
  aliases: { name: 'full_name', student_name: 'full_name', fullname: 'full_name', email_address: 'email', e_mail: 'email', e_mail_address: 'email', student_no: 'student_number', student_num: 'student_number', studentnumber: 'student_number', class: 'class_name', classname: 'class_name', year: 'academic_year', account_status: 'status' } };
const EXAMPLE_DOMAIN = /@example\.invalid$/i, CTRL = /[\u0000-\u001F\u007F]/, NUM_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._\/-]{0,29}$/u;
// COLUMN_OF is a fixed whitelist of updatable columns; request data is never interpolated into SQL.
const COLUMN_OF = { full_name: 'name', student_number: 'student_number', status: 'status' };
const low = s => String(s || '').trim().toLowerCase();

function templateRows(example) { return example ? [['EXAMPLE-001', 'EXAMPLE Student One', 'example.one@example.invalid', 'Grade 10A', '10', '2026/27', 'active'], ['EXAMPLE-002', 'EXAMPLE, "Quoted" Name', 'example.two@example.invalid', '', '', '', '']] : []; }

async function teacherOf(actor, classId) { return actor.role === 'admin' || !!await db.prepare("SELECT 1 FROM class_members WHERE class_id=? AND user_id=? AND role='teacher'").get(classId, actor.id); }
async function resolveClass(actor, r, force, errors) {
  if (force) {
    if (r.class_name && low(r.class_name) !== low(force.name)) errors.push({ column: 'class_name', message: `This import targets "${force.name}", but the row names "${r.class_name}".` });
    return force;
  }
  if (!r.class_name) return null;
  // A real loop on purpose: an async callback inside .filter() returns Promises, which are always truthy, so EVERY class would pass the
  // "can this teacher manage it?" test.
  let c = []; for (const x of await db.prepare('SELECT * FROM classes WHERE lower(name)=lower(?)').all(r.class_name)) if (await teacherOf(actor, x.id)) c.push(x);
  if (r.grade) c = c.filter(x => low(x.grade) === low(r.grade)); if (r.academic_year) c = c.filter(x => low(x.academic_year) === low(r.academic_year));
  if (!c.length) { errors.push({ column: 'class_name', message: `No class named "${r.class_name}"${r.grade ? ` for grade ${r.grade}` : ''}${r.academic_year ? ` in ${r.academic_year}` : ''} that you can manage. Create the class first; the import never creates classes.` }); return null; }
  if (c.length > 1) { errors.push({ column: 'class_name', message: `More than one class is named "${r.class_name}". Add grade and academic_year to say which one.` }); return null; }
  if (c[0].archived) { errors.push({ column: 'class_name', message: `Class "${c[0].name}" is archived.` }); return null; }
  return c[0];
}
// Pure(ish) evaluation of one row against the current database + what earlier rows in the file already claim (ctx).
async function evaluate(actor, row, ctx) {
  const d = row.data, errors = [], notes = [], changes = [];
  const out = { line: row.line, email: low(d.email), full_name: d.full_name || '', student_number: d.student_number || '', class_name: d.class_name || '', grade: d.grade || '', academic_year: d.academic_year || '', status: low(d.status), action: 'fail', errors, notes, changes, classId: null, className: '' };
  const e = (column, message) => errors.push({ column, message });
  if (row.parseError) e('', row.parseError);
  for (const [k, v] of Object.entries(d)) if (CTRL.test(v)) e(k, 'Contains a control or line-break character.');
  const lim = { full_name: 80, email: 254, student_number: 30, class_name: 80, grade: 20, academic_year: 20 };
  for (const [k, m] of Object.entries(lim)) if ((d[k] || '').length > m) e(k, `Too long (maximum ${m} characters).`);
  if (!d.email) e('email', 'Email is required.'); else if (!EMAIL_RE.test(out.email)) e('email', 'Not a valid email address.'); else if (EXAMPLE_DOMAIN.test(out.email)) e('email', 'This is an example row from the template. Delete it or replace it with a real student.');
  if (!d.full_name) e('full_name', 'Full name is required.');
  if (d.student_number && !NUM_RE.test(d.student_number)) e('student_number', 'Use letters, digits, space, . _ / - only (maximum 30).');
  if (d.status && !['active', 'suspended'].includes(out.status)) e('status', 'Must be "active" or "suspended" (or blank).');
  if (errors.length) return out;

  const num = low(d.student_number), prior = ctx.numbers.get(num);
  if (num && prior && prior.email !== out.email) { e('student_number', `Duplicate student number: also used for a different email on line ${prior.line} of this file.`); return out; }
  const cls = await resolveClass(actor, d, ctx.force, errors); if (errors.length) return out;
  if (cls) { out.classId = cls.id; out.className = cls.name; if (d.grade && cls.grade && low(cls.grade) !== low(d.grade)) e('grade', `Class "${cls.name}" is grade ${cls.grade}.`); if (d.academic_year && cls.academic_year && low(cls.academic_year) !== low(d.academic_year)) e('academic_year', `Class "${cls.name}" is ${cls.academic_year}.`); if (errors.length) return out; }
  if (!cls && (d.grade || d.academic_year)) notes.push('grade / academic_year ignored because class_name is blank.');

  const ex = await db.prepare('SELECT id,name,role,status,student_number FROM users WHERE email=?').get(out.email), pend = ctx.pending.get(out.email);
  const numOwner = num ? await db.prepare('SELECT id,email FROM users WHERE lower(student_number)=lower(?)').get(d.student_number) : null;
  if (ex) {
    if (ex.role !== 'student') { e('email', `This email belongs to ${ex.role === 'admin' ? 'an administrator' : 'a teacher'} account. Administrators and teachers cannot be imported as students.`); return out; }
    out.userId = ex.id;
    if (d.student_number) {
      if (ex.student_number && low(ex.student_number) !== num) { e('student_number', `Conflict: this email already has student number "${ex.student_number}". Identifiers are never overwritten by an import.`); return out; }
      if (!ex.student_number) { if (numOwner && numOwner.id !== ex.id) { e('student_number', 'Conflict: that student number is already assigned to a different account.'); return out; } changes.push({ field: 'student_number', from: '', to: d.student_number }); }
    }
    if (low(ex.name) !== low(d.full_name)) changes.push({ field: 'full_name', from: ex.name, to: d.full_name });
    if (out.status && out.status !== ex.status) changes.push({ field: 'status', from: ex.status, to: out.status });
    const member = cls && await db.prepare('SELECT 1 FROM class_members WHERE class_id=? AND user_id=?').get(cls.id, ex.id);
    out.addMembership = !!cls && !member; if (member) notes.push(`Already a member of "${cls.name}".`);
    out.applyChanges = ctx.allowUpdate ? changes : [];
    if (!ctx.allowUpdate && changes.length) notes.push('Account exists with different details; they were left unchanged (enable "update existing students" to apply).');
    out.action = out.applyChanges.length || out.addMembership ? 'update' : 'skip'; out.exists = true;
  } else if (pend) {
    if (low(pend.name) !== low(d.full_name) || (num && pend.number && pend.number !== num)) { e('email', `This email appears earlier in the file (line ${pend.line}) with a different name or student number.`); return out; }
    const key = out.email + '|' + (cls?.id || 0); if (ctx.members.has(key)) { out.action = 'skip'; notes.push('Duplicate of an earlier row.'); return out; }
    out.addMembership = !!cls; out.action = cls ? 'update' : 'skip'; notes.push(`Same student as line ${pend.line}${cls ? '; added to this class too' : ''}.`); out.exists = true;
  } else {
    if (!ctx.allowCreate) { e('email', 'No existing account with this email, and this import cannot create accounts.'); return out; }
    if (numOwner) { e('student_number', 'Conflict: that student number is already assigned to another account.'); return out; }
    out.action = 'create'; out.addMembership = !!cls;
  }
  if (num) ctx.numbers.set(num, { email: out.email, line: row.line });
  if (cls) ctx.members.add(out.email + '|' + cls.id);
  if (!ex) ctx.pending.set(out.email, { name: d.full_name, number: num, line: row.line });
  return out;
}
const mkCtx = o => ({ numbers: new Map(), pending: new Map(), members: new Set(), allowUpdate: !!o.allowUpdate, allowCreate: o.allowCreate !== false, force: o.forceClass || null });
const digestOf = (text, o) => crypto.createHash('sha256').update(JSON.stringify({ text, u: !!o.allowUpdate, c: o.forceClass?.id || null })).digest('hex');
const tally = rows => ({ total: rows.length, create: rows.filter(r => r.action === 'create').length, update: rows.filter(r => r.action === 'update').length, skip: rows.filter(r => r.action === 'skip').length, fail: rows.filter(r => r.action === 'fail').length });
const brief = r => ({ line: r.line, action: r.action, email: r.email, full_name: r.full_name, student_number: r.student_number, class_name: r.className || r.class_name, errors: r.errors, notes: r.notes, changes: r.action === 'update' || r.action === 'skip' ? r.changes.map(c => ({ ...c, applied: !!r.applyChanges?.includes(c) })) : [] });

async function plan(actor, text, opts = {}) {
  // One row after another: later rows are checked against what earlier rows in the same file already claim (ctx).
  const t = CSV.readTable(text, SPEC), ctx = mkCtx(opts), rows = []; for (const r of t.rows) rows.push(await evaluate(actor, r, ctx));
  return { digest: digestOf(text, opts), columns: t.columns, ignored_columns: t.ignored, summary: tally(rows), rows: rows.map(brief) };
}
// Commit. Each row is its own transaction (one bad row never blocks the rest); passwords are hashed BEFORE the transaction because scrypt is async.
async function run(actor, text, opts = {}, digest) {
  if (digest && digest !== digestOf(text, opts)) { throw new HttpError(409, 'The file or options changed since the preview. Preview it again before importing.'); }
  const t = CSV.readTable(text, SPEC), ctx = mkCtx(opts), results = [], credentials = [];
  for (const row of t.rows) {
    let ev = await evaluate(actor, row, ctx), hash = null, temp = null;
    if (ev.action === 'create') { temp = A.tempPassword(); hash = await A.hashPw(temp); }
    const res = { line: row.line, email: ev.email || row.data.email || '', full_name: ev.full_name, student_number: ev.student_number, class_name: ev.className || ev.class_name, grade: ev.grade, academic_year: ev.academic_year, status_in: ev.status, result: 'failed', reason: '' };
    if (ev.action === 'fail') { res.reason = ev.errors.map(x => (x.column ? x.column + ': ' : '') + x.message).join(' '); results.push(res); continue; }
    try {
      await tx(async () => {
        const fresh = await evaluate(actor, row, mkCtx({ ...opts, allowCreate: opts.allowCreate })); // re-check against live data inside the lock
        if (fresh.action === 'fail') throw new Error(fresh.errors.map(x => x.message).join(' '));
        let uid = ev.userId;
        if (ev.action === 'create') {
          if (await db.prepare('SELECT 1 FROM users WHERE email=?').get(ev.email)) throw new Error('An account with this email was created in the meantime.');
          uid = await insertUser(actor, { email: ev.email, name: ev.full_name, role: 'student', student_number: ev.student_number, pw_hash: hash, status: ev.status === 'suspended' ? 'suspended' : 'active' });
          res.result = 'created';
        } else { uid = uid || (await db.prepare('SELECT id FROM users WHERE email=?').get(ev.email))?.id; res.result = ev.action === 'update' ? 'updated' : 'skipped'; }
        if (ev.action === 'update' && ev.applyChanges?.length) {
          for (const c of ev.applyChanges) { await guarded(async () => await db.prepare(`UPDATE users SET ${COLUMN_OF[c.field]}=? WHERE id=?`).run(c.to, uid)).catch(e => { throw friendly(e); }); if (c.field === 'status' && c.to === 'suspended') await db.prepare('DELETE FROM sessions WHERE user_id=?').run(uid); }
          await audit(actor, 'user.import_update', 'user', uid, { changes: ev.applyChanges.map(c => ({ field: c.field, from: c.from, to: c.to })) });
        }
        if (ev.classId && uid) await db.prepare("INSERT INTO class_members(class_id,user_id,role) VALUES(?,?,'student') ON CONFLICT DO NOTHING").run(ev.classId, uid);
        if (res.result === 'skipped') res.reason = ev.notes.join(' ');
        else if (res.result === 'updated') res.reason = [ev.addMembership ? `Added to "${ev.className}".` : '', ...(ev.applyChanges || []).map(c => `${c.field}: "${c.from}" → "${c.to}"`)].filter(Boolean).join(' ');
        else res.reason = ev.className ? `Added to "${ev.className}".` : '';
      });
      if (res.result === 'created') credentials.push({ line: row.line, email: ev.email, full_name: ev.full_name, temp_password: temp });
    } catch (x) { res.result = 'failed'; res.reason = x instanceof HttpError || !x.code ? x.message : 'This row could not be saved (database error). Nothing was changed for it.'; } // never show raw database errors to the user
    results.push(res);
  }
  const summary = { total: results.length, created: results.filter(r => r.result === 'created').length, updated: results.filter(r => r.result === 'updated').length, skipped: results.filter(r => r.result === 'skipped').length, failed: results.filter(r => r.result === 'failed').length };
  await audit(actor, 'students.import', 'class', opts.forceClass?.id ?? null, { ...summary, update_existing: !!opts.allowUpdate, class: opts.forceClass?.name || null });
  const bad = results.filter(r => r.result === 'failed' || r.result === 'skipped');
  const report_csv = CSV.toCsv([...COLUMNS, 'line', 'result', 'reason'], bad.map(r => [r.student_number, r.full_name, r.email, r.class_name, r.grade, r.academic_year, r.status_in, r.line, r.result, r.reason]));
  return { summary, results: results.map(({ status_in, ...r }) => r), credentials, report_csv };
}
module.exports = { plan, run, COLUMNS, SPEC, templateRows, teacherOf };
