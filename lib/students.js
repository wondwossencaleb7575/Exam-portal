'use strict';
// Central student directory. `users` stays the single source of truth (role='student').
// Authorisation model: an admin sees every student; a teacher sees only students who share a class with them.
// The SAME filter code serves the list API, the picker, and every export, so a CSV can never show more than the screen.
const { db } = require('./db');
const likeEsc = s => s.replace(/[\\%_]/g, '\\$&');
const ph = a => a.map(() => '?').join(',');

// Is class alias `a` visible to this user? (returns [sql, params])
const classVis = (u, a) => u.role === 'admin' ? ['true', []] : [`EXISTS(SELECT 1 FROM class_members tm WHERE tm.class_id=${a}.id AND tm.user_id=? AND tm.role='teacher')`, [u.id]];
const scope = u => u.role === 'admin' ? ['true', []] : [`EXISTS(SELECT 1 FROM class_members sm JOIN class_members tm ON tm.class_id=sm.class_id AND tm.role='teacher' AND tm.user_id=? WHERE sm.user_id=u.id AND sm.role='student')`, [u.id]];
const inScope = async (u, studentId) => { const [s, p] = scope(u); return !!await db.prepare(`SELECT 1 FROM users u WHERE u.id=? AND u.role='student' AND ${s}`).get(studentId, ...p); };

function readFilters(src = {}) {
  const s = k => String(src[k] ?? '').trim();
  return { q: s('q').slice(0, 100), class_id: Number(src.class_id) > 0 ? Number(src.class_id) : null, grade: s('grade').slice(0, 20), academic_year: s('academic_year').slice(0, 20),
    status: ['active', 'suspended'].includes(s('status')) ? s('status') : '', sort: s('sort') === 'student_number' ? 'student_number' : 'name', dir: s('dir') === 'desc' ? 'DESC' : 'ASC' };
}
const parseIds = (v, max = 500) => { const a = [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map(Number))].filter(n => Number.isSafeInteger(n) && n > 0); return a.slice(0, max); };

function build(user, f, ids, x = {}) {
  const [sc, sp] = scope(user), w = ["u.role='student'", sc], p = [...sp];
  if (f.q) { const l = `%${likeEsc(f.q)}%`; w.push("(u.name ILIKE ? ESCAPE '\\' OR u.email ILIKE ? ESCAPE '\\' OR COALESCE(u.student_number,'') ILIKE ? ESCAPE '\\')"); p.push(l, l, l); }
  if (f.status) { w.push('u.status=?'); p.push(f.status); }
  if (f.class_id || f.grade || f.academic_year) {
    const cw = [], cp = [];
    if (f.class_id) { cw.push('c.id=?'); cp.push(f.class_id); } if (f.grade) { cw.push('lower(c.grade)=lower(?)'); cp.push(f.grade); } if (f.academic_year) { cw.push('lower(c.academic_year)=lower(?)'); cp.push(f.academic_year); }
    const [v, vp] = classVis(user, 'c');
    w.push(`EXISTS(SELECT 1 FROM class_members m JOIN classes c ON c.id=m.class_id WHERE m.user_id=u.id AND m.role='student' AND ${[...cw, v].join(' AND ')})`); p.push(...cp, ...vp);
  }
  if (x.hideAccessTo) { w.push("NOT (EXISTS(SELECT 1 FROM exam_students es WHERE es.exam_id=? AND es.student_id=u.id) OR EXISTS(SELECT 1 FROM exam_classes ec JOIN class_members m ON m.class_id=ec.class_id AND m.role='student' WHERE ec.exam_id=? AND m.user_id=u.id))"); p.push(x.hideAccessTo, x.hideAccessTo); }
  if (ids) { if (!ids.length) w.push('false'); else { w.push(`u.id IN (${ph(ids)})`); p.push(...ids); } }
  const order = f.sort === 'student_number' ? `(u.student_number IS NULL OR u.student_number=''), lower(u.student_number) ${f.dir}, lower(u.name), u.id` : `lower(u.name) ${f.dir}, u.id`;
  return { from: `FROM users u WHERE ${w.join(' AND ')}`, params: p, order };
}
// Explicit column list: pw_hash, sessions and tokens are never selected.
const COLS = 'u.id,u.name,u.email,u.student_number,u.status,u.created,u.last_login';
async function withClasses(user, rows) {
  if (!rows.length) return rows;
  const [v, vp] = classVis(user, 'c'), ids = rows.map(r => r.id);
  const cl = await db.prepare(`SELECT m.user_id uid,c.id,c.name,c.grade,c.academic_year,c.archived FROM class_members m JOIN classes c ON c.id=m.class_id WHERE m.role='student' AND m.user_id IN (${ph(ids)}) AND ${v} ORDER BY lower(c.name),c.id`).all(...ids, ...vp);
  const by = new Map(); for (const c of cl) { if (!by.has(c.uid)) by.set(c.uid, []); by.get(c.uid).push({ id: c.id, name: c.name, grade: c.grade || '', academic_year: c.academic_year || '', archived: !!c.archived }); }
  return rows.map(r => ({ ...r, last_login: user.role === 'admin' ? r.last_login : undefined, classes: by.get(r.id) || [] }));
}
async function list(user, f, { size, offset }, ids, x) {
  const b = build(user, f, ids, x), total = (await db.prepare(`SELECT COUNT(*) n ${b.from}`).get(...b.params)).n;
  return { total, items: await withClasses(user, await db.prepare(`SELECT ${COLS} ${b.from} ORDER BY ${b.order} LIMIT ? OFFSET ?`).all(...b.params, size, offset)) };
}
async function allIds(user, f, cap, x) { const b = build(user, f, null, x); return (await db.prepare(`SELECT u.id ${b.from} ORDER BY ${b.order} LIMIT ?`).all(...b.params, cap)).map(r => r.id); }
async function facets(user) {
  const [v, vp] = classVis(user, 'c'), cs = await db.prepare(`SELECT c.id,c.name,c.grade,c.academic_year,c.archived FROM classes c WHERE ${v} ORDER BY c.archived,lower(c.name)`).all(...vp);
  const uniq = k => [...new Set(cs.map(c => c[k]).filter(Boolean))].sort();
  return { classes: cs.map(c => ({ id: c.id, name: c.name, grade: c.grade || '', academic_year: c.academic_year || '', archived: !!c.archived })), grades: uniq('grade'), academic_years: uniq('academic_year') };
}
// Streams export rows (arrays) in the documented column order; batches of 500 keep memory flat.
const EXPORT_HEAD = admin => ['student_id', 'student_number', 'full_name', 'email', 'account_status', 'class_names', 'grades', 'academic_years', 'created_at', ...(admin ? ['last_login'] : [])];
const iso = ms => ms ? new Date(ms).toISOString() : '';
async function* exportRows(user, ids) {
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500), rows = await db.prepare(`SELECT ${COLS} FROM users u WHERE u.id IN (${ph(chunk)})`).all(...chunk), by = new Map(rows.map(r => [r.id, r]));
    for (const r of await withClasses(user, chunk.map(id => by.get(id)).filter(Boolean)))
      yield [r.id, r.student_number || '', r.name, r.email, r.status, r.classes.map(c => c.name).join('; '), r.classes.map(c => c.grade).join('; '), r.classes.map(c => c.academic_year).join('; '), iso(r.created), ...(user.role === 'admin' ? [iso(r.last_login)] : [])];
  }
}
async function detail(user, id) {
  if (!await inScope(user, id)) return null;
  const s = (await withClasses(user, await db.prepare(`SELECT ${COLS} FROM users u WHERE u.id=?`).all(id)))[0];
  const teacher = user.role === 'teacher';
  // Exam participation: teachers see their own exams (with marks); administrators see participation only (no marks), matching existing permissions.
  const exams = (await db.prepare(`SELECT * FROM (SELECT e.id,e.title,e.status,e.updated,
      EXISTS(SELECT 1 FROM exam_students es WHERE es.exam_id=e.id AND es.student_id=?1) direct,
      EXISTS(SELECT 1 FROM exam_classes ec JOIN class_members m ON m.class_id=ec.class_id AND m.role='student' WHERE ec.exam_id=e.id AND m.user_id=?1) via_class,
      (SELECT COUNT(*) FROM attempts a WHERE a.exam_id=e.id AND a.student_id=?1) attempts,
      (SELECT COUNT(*) FROM attempts a WHERE a.exam_id=e.id AND a.student_id=?1 AND a.status!='in_progress') submitted,
      (SELECT a.status FROM attempts a WHERE a.exam_id=e.id AND a.student_id=?1 ORDER BY a.attempt_no DESC LIMIT 1) latest_status,
      (SELECT CASE WHEN a.grading_status='graded' THEN a.score END FROM attempts a WHERE a.exam_id=e.id AND a.student_id=?1 AND a.status!='in_progress' ORDER BY a.attempt_no DESC LIMIT 1) score,
      (SELECT a.total FROM attempts a WHERE a.exam_id=e.id AND a.student_id=?1 AND a.status!='in_progress' ORDER BY a.attempt_no DESC LIMIT 1) total
    FROM exams e WHERE (?2=0 OR e.owner_id=?3)) q WHERE (direct OR via_class OR attempts>0) ORDER BY updated DESC LIMIT 100`).all(id, teacher ? 1 : 0, user.id))
    .map(e => ({ id: e.id, title: e.title, status: e.status, source: e.direct && e.via_class ? 'direct + class' : e.direct ? 'direct' : e.via_class ? 'class' : 'attempt record only', attempts: e.attempts, submitted: e.submitted, latest_status: e.latest_status, ...(teacher ? { score: e.score, total: e.score == null ? null : e.total } : {}) }));
  return { student: s, exams };
}
module.exports = { readFilters, parseIds, list, allIds, facets, exportRows, EXPORT_HEAD, detail, inScope, scope, classVis, likeEsc, ph };
