'use strict';
// Exam access = direct enrollment (exam_students) OR a class assignment (exam_classes). Enforced on the server.
// Enrollment never creates an attempt and never starts a timer.
const { db, tx } = require('./db');
const { audit } = require('./audit');
const { HttpError } = require('./http');
const S = require('./students');

const DIRECT = 'EXISTS(SELECT 1 FROM exam_students es WHERE es.exam_id=? AND es.student_id=?)';
const VIA_CLASS = "EXISTS(SELECT 1 FROM exam_classes ec JOIN class_members m ON m.class_id=ec.class_id AND m.role='student' WHERE ec.exam_id=? AND m.user_id=?)";
const hasAccess = async (examId, uid) => !!(await db.prepare(`SELECT (${DIRECT} OR ${VIA_CLASS}) a`).get(examId, uid, examId, uid)).a;
const directCount = async examId => (await db.prepare('SELECT COUNT(*) n FROM exam_students WHERE exam_id=?').get(examId)).n;
// SQL fragment (for `FROM users u`) meaning "u may take exam ?": uses 2 params (examId, examId).
const ACCESS_U = `(EXISTS(SELECT 1 FROM exam_students es WHERE es.exam_id=? AND es.student_id=u.id) OR EXISTS(SELECT 1 FROM exam_classes ec JOIN class_members m ON m.class_id=ec.class_id AND m.role='student' WHERE ec.exam_id=? AND m.user_id=u.id))`;

// Full roster: everyone entitled (direct or class) plus anyone who has an attempt record (never hidden from results).
const ROSTER = `SELECT u.id,u.name,u.email,u.student_number,u.status,
  (SELECT es.enrolled_at FROM exam_students es WHERE es.exam_id=?1 AND es.student_id=u.id) enrolled_at,
  (SELECT b.name FROM exam_students es JOIN users b ON b.id=es.enrolled_by WHERE es.exam_id=?1 AND es.student_id=u.id) enrolled_by_name,
  (EXISTS(SELECT 1 FROM exam_students es WHERE es.exam_id=?1 AND es.student_id=u.id))::int direct,
  (EXISTS(SELECT 1 FROM exam_classes ec JOIN class_members m ON m.class_id=ec.class_id AND m.role='student' WHERE ec.exam_id=?1 AND m.user_id=u.id))::int via_class,
  (SELECT COUNT(*) FROM attempts a WHERE a.exam_id=?1 AND a.student_id=u.id) attempts,
  (SELECT COUNT(*) FROM attempts a WHERE a.exam_id=?1 AND a.student_id=u.id AND a.status='in_progress') in_progress,
  (SELECT COUNT(*) FROM attempts a WHERE a.exam_id=?1 AND a.student_id=u.id AND a.status!='in_progress') submitted,
  (SELECT COUNT(*) FROM attempts a WHERE a.exam_id=?1 AND a.student_id=u.id AND a.status!='in_progress' AND a.grading_status='pending') pending,
  (SELECT a.status FROM attempts a WHERE a.exam_id=?1 AND a.student_id=u.id ORDER BY a.attempt_no DESC LIMIT 1) latest_status
  FROM users u WHERE u.role='student'`;
const sourceOf = r => r.direct && r.via_class ? 'direct + class' : r.direct ? 'direct' : r.via_class ? 'class' : 'attempt record only';
const FILTERS = { not_started: 'r.attempts=0 AND (r.direct=1 OR r.via_class=1)', started: 'r.attempts>0', submitted: 'r.submitted>0', in_progress: 'r.in_progress>0', direct: 'r.direct=1', class: 'r.via_class=1' };

async function roster(examId, { q = '', filter = '', size = 25, offset = 0, all = false } = {}) {
  const w = ['(r.direct=1 OR r.via_class=1 OR r.attempts>0)'], p = [examId];
  if (q) { const l = `%${S.likeEsc(q)}%`; w.push("(r.name ILIKE ? ESCAPE '\\' OR r.email ILIKE ? ESCAPE '\\' OR COALESCE(r.student_number,'') ILIKE ? ESCAPE '\\')"); p.push(l, l, l); }
  if (FILTERS[filter]) w.push(FILTERS[filter]);
  const base = `FROM (${ROSTER}) r WHERE ${w.join(' AND ')}`;
  if (all) return await db.prepare(`SELECT r.* ${base} ORDER BY lower(r.name),r.id`).all(...p); // the full list, for CSV export
  const total = (await db.prepare(`SELECT COUNT(*) n ${base}`).get(...p)).n;
  return { total, items: (await db.prepare(`SELECT r.* ${base} ORDER BY lower(r.name),r.id LIMIT ? OFFSET ?`).all(...p, size, offset)).map(r => ({ ...r, source: sourceOf(r), direct: !!r.direct, via_class: !!r.via_class })) };
}
async function summary(examId) {
  const s = await db.prepare(`SELECT COUNT(*) total, COUNT(*) FILTER (WHERE r.direct=1 OR r.via_class=1) eligible, COUNT(*) FILTER (WHERE r.direct=1) direct, COUNT(*) FILTER (WHERE r.via_class=1) via_class,
    COUNT(*) FILTER (WHERE r.attempts>0) started, COUNT(*) FILTER (WHERE r.submitted>0) submitted, COUNT(*) FILTER (WHERE (r.direct=1 OR r.via_class=1) AND r.attempts=0) not_started,
    COUNT(*) FILTER (WHERE r.in_progress>0) attempting, COUNT(*) FILTER (WHERE r.pending>0) awaiting_grading
    FROM (${ROSTER}) r WHERE (r.direct=1 OR r.via_class=1 OR r.attempts>0)`).get(examId);
  return { eligible: s.eligible, enrolled_direct: s.direct, via_class: s.via_class, started: s.started, submitted: s.submitted, not_started: s.not_started, attempting: s.attempting, awaiting_grading: s.awaiting_grading };
}
// Per-student status for the picker (Not enrolled / Enrolled / Already attempted / Submitted / Ineligible).
async function statusFor(examId, students) {
  if (!students.length) return students;
  const ids = students.map(s => s.id), rows = await db.prepare(`SELECT * FROM (${ROSTER}) r WHERE r.id IN (${S.ph(ids)})`).all(examId, ...ids), by = new Map(rows.map(r => [r.id, r]));
  return students.map(s => {
    const r = by.get(s.id) || {}, src = sourceOf(r);
    const st = r.submitted ? { key: 'submitted', label: 'Submitted' } : r.attempts ? { key: 'attempted', label: 'Already attempted' } : (r.direct || r.via_class) ? { key: 'enrolled', label: src === 'class' ? 'Enrolled (via class)' : 'Enrolled' }
      : s.status !== 'active' ? { key: 'ineligible', label: 'Ineligible', reason: 'Account is suspended' } : { key: 'not_enrolled', label: 'Not enrolled' };
    return { ...s, enroll: { ...st, source: src, direct: !!r.direct, via_class: !!r.via_class, attempts: r.attempts || 0 } };
  });
}

const locked = exam => { if (exam.status === 'archived') throw new HttpError(409, 'This exam is archived. Duplicate it to run it again.'); };
// Adds direct enrollments. Safe to call twice or concurrently: one transaction, ON CONFLICT DO NOTHING on the (exam_id, student_id) key.
async function enroll(actor, exam, ids, how = 'selected') {
  locked(exam); const out = { added: [], already: [], failed: [] }; ids = [...new Set(ids)];
  await tx(async () => {
    for (const id of ids) {
      const u = await db.prepare('SELECT id,name,role,status FROM users WHERE id=?').get(id);
      if (!u || u.role !== 'student' || !await S.inScope(actor, id)) { out.failed.push({ id, reason: 'Student not found or not available to you.' }); continue; }
      const item = { id, name: u.name };
      if (u.status !== 'active') { out.failed.push({ ...item, reason: 'Account is suspended.' }); continue; }
      if ((await db.prepare(`SELECT ${DIRECT} a`).get(exam.id, id)).a) { out.already.push({ ...item, reason: 'Already enrolled.' }); continue; }
      if ((await db.prepare(`SELECT ${VIA_CLASS} a`).get(exam.id, id)).a) { out.already.push({ ...item, reason: 'Already has access through an assigned class.' }); continue; }
      const r = await db.prepare('INSERT INTO exam_students(exam_id,student_id,enrolled_by,enrolled_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(exam.id, id, actor.id, Date.now());
      (r.changes ? out.added : out.already).push(r.changes ? item : { ...item, reason: 'Already enrolled.' });
    }
    if (out.added.length) await audit(actor, 'exam.enroll', 'exam', exam.id, { how, exam_status: exam.status, count: out.added.length, student_ids: out.added.slice(0, 60).map(x => x.id) });
  });
  return out;
}
// Removes a DIRECT enrollment only when the student has no attempt on this exam; attempts, answers, grades and history are never touched.
async function unenroll(actor, exam, sid) {
  locked(exam); let viaClass = false;
  await tx(async () => {
    const row = await db.prepare('SELECT 1 FROM exam_students WHERE exam_id=? AND student_id=?').get(exam.id, sid);
    if (!row) throw new HttpError(404, (await db.prepare(`SELECT ${VIA_CLASS} a`).get(exam.id, sid)).a ? 'This student has access through an assigned class, not a direct enrollment. Change the class assignment (on the draft) or the class membership instead.' : 'That student is not directly enrolled in this exam.');
    const n = (await db.prepare('SELECT COUNT(*) n FROM attempts WHERE exam_id=? AND student_id=?').get(exam.id, sid)).n;
    if (n) throw new HttpError(409, `This student already has ${n} attempt${n > 1 ? 's' : ''} on this exam, so the enrollment is kept. Attempts, answers and grades are never deleted.`);
    await db.prepare('DELETE FROM exam_students WHERE exam_id=? AND student_id=?').run(exam.id, sid);
    viaClass = !!(await db.prepare(`SELECT ${VIA_CLASS} a`).get(exam.id, sid)).a;
    await audit(actor, 'exam.unenroll', 'exam', exam.id, { student_id: sid, exam_status: exam.status });
  });
  return { ok: true, still_has_access_via_class: viaClass };
}
module.exports = { hasAccess, directCount, ACCESS_U, roster, summary, statusFor, enroll, unenroll, sourceOf };
