const express = require('express');
const { db, tx } = require('../lib/db');
const A = require('../lib/auth');
const { wrap, fail, notFound, conflict, idOf, paging, text, bool, timeOrNull, HttpError } = require('../lib/http');
const { cleanQuestion, examIssues } = require('../lib/validate');
const { loadEqs } = require('../lib/grading');
const { studentQuestions } = require('../lib/exam');
const { audit } = require('../lib/audit');
const E = require('../lib/enroll');
const S = require('../lib/students');
const SET = require('../lib/settings');
const CSV = require('../lib/csv');
const EI = require('../lib/enrollImport');
const r = express.Router();
r.use(A.requireAuth({ roles: ['teacher'] }));
const J = JSON.stringify;
const own = async req => { const e = await db.prepare('SELECT * FROM exams WHERE id=? AND owner_id=?').get(idOf(req.params.id), req.user.id); if (!e) notFound(); return e; };
const phase = (e, now = Date.now()) => e.status === 'published' ? (e.opens && now < e.opens ? 'scheduled' : (e.closes && now > e.closes ? 'closed' : 'active')) : e.status;
const classIds = async id => (await db.prepare('SELECT class_id FROM exam_classes WHERE exam_id=?').all(id)).map(x => x.class_id);
const RELEASE = ['manual', 'on_finalize', 'immediate'];

async function applyMeta(b, e) {
  const minutes = Math.floor(Number(b.minutes)); if (!(minutes >= 1 && minutes <= 600)) fail('Duration must be between 1 and 600 minutes.');
  const ma = Math.floor(Number(b.max_attempts) || 1); if (ma < 1 || ma > 5) fail('Attempts must be between 1 and 5.');
  const opens = timeOrNull(b.opens), closes = timeOrNull(b.closes); if (opens && closes && closes <= opens) fail('The closing time must be after the opening time.');
  if (!RELEASE.includes(b.release_mode)) fail('Choose a result-release mode.');
  const dt = b.declared_total === '' || b.declared_total == null ? null : Number(b.declared_total); if (dt != null && !(dt > 0)) fail('Expected total marks must be positive.');
  const sid = b.subject_id ? Number(b.subject_id) : null; if (sid && !await db.prepare('SELECT 1 FROM subjects WHERE id=?').get(sid)) fail('Unknown subject.');
  const pm = b.pass_mark === '' || b.pass_mark == null ? null : Number(b.pass_mark); if (pm != null && !(pm >= 0 && pm <= 100)) fail('The pass mark must be between 0 and 100 percent.');
  const term = text(b.term ?? '', 30); if (term && !(await SET.get()).terms.includes(term)) fail('Choose a term from the school list.');
  const gr = b.grace_s === undefined || b.grace_s === '' || b.grace_s === null ? (e?.grace_s ?? 15) : Math.floor(Number(b.grace_s)); if (!(gr >= 0 && gr <= 300)) fail('The late grace period must be between 0 and 300 seconds.');
  return { pass_mark: pm, academic_year: text(b.academic_year ?? '', 20), term, grade: text(b.grade ?? '', 20), grace_s: gr, title: text(b.title, 120, { min: 1, label: 'Title' }), instructions: text(b.instructions, 5000), minutes, max_attempts: ma, opens, closes, release_mode: b.release_mode,
    show_answers: bool(b.show_answers), shuffle_q: bool(b.shuffle_q), shuffle_o: bool(b.shuffle_o), declared_total: dt, subject_id: sid };
}
const full = async e => {
  const eqs = await loadEqs(e.id);
  return { exam: { ...e, phase: phase(e) }, class_ids: await classIds(e.id), direct_count: await E.directCount(e.id), questions: eqs, total_marks: Math.round(eqs.reduce((t, q) => t + q.marks, 0) * 100) / 100,
    attempts: (await db.prepare("SELECT COUNT(*) n FROM attempts WHERE exam_id=?").get(e.id)).n };
};

r.get('/', wrap(async (req, res) => {
  const { page, size, offset } = paging(req, 20), f = ['e.owner_id=?'], p = [req.user.id];
  if (req.query.q) { f.push('e.title ILIKE ?'); p.push(`%${req.query.q}%`); }
  if (req.query.subject_id) { f.push('e.subject_id=?'); p.push(Number(req.query.subject_id)); }
  if (req.query.class_id) { f.push('EXISTS(SELECT 1 FROM exam_classes c WHERE c.exam_id=e.id AND c.class_id=?)'); p.push(Number(req.query.class_id)); }
  if (req.query.year) { f.push('EXISTS(SELECT 1 FROM exam_classes c JOIN classes k ON k.id=c.class_id WHERE c.exam_id=e.id AND k.academic_year=?)'); p.push(String(req.query.year)); }
  if (Number(req.query.from)) { f.push('COALESCE(e.opens,e.created)>=?'); p.push(Number(req.query.from)); }
  if (Number(req.query.to)) { f.push('COALESCE(e.opens,e.created)<=?'); p.push(Number(req.query.to)); }
  const sub = (c) => `(SELECT COUNT(*) FROM attempts a WHERE a.exam_id=e.id AND ${c})`;
  let rows = (await db.prepare(`SELECT e.*, s.name subject_name,
    (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id=e.id) qcount, (SELECT COALESCE(SUM(marks),0) FROM exam_questions q WHERE q.exam_id=e.id) total_marks,
    ${sub("a.status!='in_progress'")} submitted, ${sub("a.status='in_progress'")} in_progress, ${sub("a.status!='in_progress' AND a.grading_status='pending'")} pending,
    ${sub("a.status!='in_progress' AND a.finalized_at IS NULL")} unfinalized,
    (SELECT STRING_AGG(k.name, ', ' ORDER BY k.name) FROM exam_classes c JOIN classes k ON k.id=c.class_id WHERE c.exam_id=e.id) class_names
    FROM exams e LEFT JOIN subjects s ON s.id=e.subject_id WHERE ${f.join(' AND ')} ORDER BY e.updated DESC`).all(...p))
    .map(e => ({ ...e, phase: phase(e), awaiting_grading: e.pending > 0, graded: e.submitted > 0 && e.unfinalized === 0 }));
  const st = req.query.status; if (st) rows = rows.filter(e => st === 'awaiting_grading' ? e.awaiting_grading : st === 'graded' ? e.graded : e.phase === st);
  res.json({ total: rows.length, page, size, items: rows.slice(offset, offset + size) });
}));
r.post('/', wrap(async (req, res) => {
  const now = Date.now();
  const id = (await db.prepare("INSERT INTO exams(owner_id,title,minutes,created,updated) VALUES(?,?,30,?,?) RETURNING id").run(req.user.id, text(req.body.title, 120) || 'Untitled exam', now, now)).lastInsertRowid;
  await audit(req.user, 'exam.create', 'exam', id); res.json({ id });
}));
r.get('/:id', wrap(async (req, res) => res.json(await full(await own(req)))));

// Drafts are fully editable. Published exams are locked (see PATCH /:id/settings for the limited changes allowed).
r.put('/:id', wrap(async (req, res) => {
  const e = await own(req); if (e.status !== 'draft') conflict('Published exams cannot be edited. Duplicate the exam to make a changed version.');
  const m = await applyMeta(req.body, e), qs = Array.isArray(req.body.questions) ? req.body.questions : fail('Questions are missing.');
  if (qs.length > 200) fail('An exam can have at most 200 questions.');
  const cids = [...new Set((req.body.class_ids || []).map(Number))];
  for (const c of cids) if (!await db.prepare('SELECT 1 FROM class_members WHERE class_id=? AND user_id=?').get(c, req.user.id)) fail('You can only assign exams to your own classes.');
  const cleaned = [];
  for (const q of qs) cleaned.push({ ...await cleanQuestion(q, { strict: false, ownerId: req.user.id }), section: text(q.section, 80), source_qid: q.source_qid ? Number(q.source_qid) : null, source_version: q.source_version ? Number(q.source_version) : null });
  await tx(async () => {
    // Lock the exam row and re-check its status: a publish (or a second save) running at the same moment must not interleave with this rewrite.
    const cur = await db.prepare('SELECT status FROM exams WHERE id=? FOR UPDATE').get(e.id);
    if (!cur || cur.status !== 'draft') conflict('Published exams cannot be edited. Duplicate the exam to make a changed version.');
    await db.prepare('UPDATE exams SET subject_id=?,title=?,instructions=?,minutes=?,opens=?,closes=?,max_attempts=?,shuffle_q=?,shuffle_o=?,release_mode=?,show_answers=?,declared_total=?,pass_mark=?,academic_year=?,term=?,grade=?,grace_s=?,updated=? WHERE id=?')
      .run(m.subject_id, m.title, m.instructions, m.minutes, m.opens, m.closes, m.max_attempts, m.shuffle_q, m.shuffle_o, m.release_mode, m.show_answers, m.declared_total, m.pass_mark, m.academic_year || null, m.term || null, m.grade || null, m.grace_s, Date.now(), e.id);
    await db.prepare('DELETE FROM exam_classes WHERE exam_id=?').run(e.id);
    for (const c of cids) await db.prepare('INSERT INTO exam_classes(exam_id,class_id) VALUES(?,?)').run(e.id, c);
    await db.prepare('DELETE FROM exam_questions WHERE exam_id=?').run(e.id);
    const ins = db.prepare('INSERT INTO exam_questions(exam_id,pos,section,source_qid,source_version,type,stem,options,key,settings,marks,topic,difficulty,explanation,image_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i < cleaned.length; i++) { const c = cleaned[i]; await ins.run(e.id, i, c.section, c.source_qid, c.source_version, c.type, c.stem, J(c.options), J(c.key), J(c.settings), c.marks, c.topic, c.difficulty, c.explanation, c.image_id); }
  });
  res.json(await full(await own(req)));
}));
r.post('/:id/validate', wrap(async (req, res) => { const e = await own(req), x = await full(e); res.json({ issues: await examIssues(e, x.questions, x.class_ids.length + x.direct_count), total_marks: x.total_marks }); }));
r.post('/:id/publish', wrap(async (req, res) => {
  const e = await own(req); if (e.status !== 'draft') conflict('Only drafts can be published.');
  const x = await full(e), issues = await examIssues(e, x.questions, x.class_ids.length + x.direct_count);
  if (issues.length) return res.status(400).json({ error: 'Fix these problems before publishing.', issues });
  await tx(async () => { // questions typed directly into the exam also join the reusable bank
    const cur = await db.prepare('SELECT status FROM exams WHERE id=? FOR UPDATE').get(e.id); // two simultaneous publishes (or a save) cannot both go through
    if (!cur || cur.status !== 'draft') conflict('Only drafts can be published.');
    for (const q of x.questions) if (!q.source_qid) {
      const id = (await db.prepare('INSERT INTO questions(owner_id,subject_id,type,stem,options,key,settings,marks,topic,difficulty,explanation,image_id,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id')
        .run(req.user.id, e.subject_id, q.type, q.stem, J(q.options), J(q.key), J(q.settings), q.marks, q.topic, q.difficulty, q.explanation, q.image_id, Date.now(), Date.now())).lastInsertRowid;
      await db.prepare('UPDATE exam_questions SET source_qid=?,source_version=1 WHERE id=?').run(id, q.id);
    }
    await db.prepare("UPDATE exams SET status='published',published_at=?,updated=?,version=version+1 WHERE id=?").run(Date.now(), Date.now(), e.id);
  });
  await audit(req.user, 'exam.publish', 'exam', e.id, { questions: x.questions.length, total: x.total_marks, classes: x.class_ids, direct_students: x.direct_count }); res.json({ ok: true });
}));
// Limited post-publication changes: availability window, release policy. Each is audited.
r.patch('/:id/settings', wrap(async (req, res) => {
  const e = await own(req); if (!['published', 'closed'].includes(e.status)) conflict('Only published or closed exams can use this.');
  const opens = 'opens' in req.body ? timeOrNull(req.body.opens) : e.opens, closes = 'closes' in req.body ? timeOrNull(req.body.closes) : e.closes;
  if (opens && closes && closes <= opens) fail('The closing time must be after the opening time.');
  const rm = req.body.release_mode ?? e.release_mode; if (!RELEASE.includes(rm)) fail('Choose a result-release mode.');
  const sa = 'show_answers' in req.body ? bool(req.body.show_answers) : e.show_answers;
  let pm = e.pass_mark;
  if (req.body.pass_mark !== undefined) {
    const v = req.body.pass_mark === '' || req.body.pass_mark === null ? null : Number(req.body.pass_mark); if (v != null && !(v >= 0 && v <= 100)) fail('The pass mark must be between 0 and 100 percent.');
    if (v !== pm && await db.prepare('SELECT 1 FROM attempts WHERE exam_id=? AND released_at IS NOT NULL LIMIT 1').get(e.id)) throw new HttpError(409, 'Results have already been released, so the pass mark is locked. Withhold the results first if it must change.');
    pm = v;
  }
  await db.prepare('UPDATE exams SET opens=?,closes=?,release_mode=?,show_answers=?,pass_mark=?,updated=? WHERE id=?').run(opens, closes, rm, sa, pm, Date.now(), e.id);
  await audit(req.user, 'exam.settings', 'exam', e.id, { before: { opens: e.opens, closes: e.closes, release_mode: e.release_mode, show_answers: e.show_answers, pass_mark: e.pass_mark }, after: { opens, closes, release_mode: rm, show_answers: sa, pass_mark: pm } });
  res.json({ ok: true });
}));
r.post('/:id/close', wrap(async (req, res) => { const e = await own(req); if (e.status !== 'published') conflict('Only published exams can be closed.'); await db.prepare("UPDATE exams SET status='closed',updated=? WHERE id=?").run(Date.now(), e.id); await audit(req.user, 'exam.close', 'exam', e.id); res.json({ ok: true }); }));
r.post('/:id/reopen', wrap(async (req, res) => { const e = await own(req); if (e.status !== 'closed') conflict('Only closed exams can be reopened.'); await db.prepare("UPDATE exams SET status='published',updated=? WHERE id=?").run(Date.now(), e.id); await audit(req.user, 'exam.reopen', 'exam', e.id); res.json({ ok: true }); }));
r.post('/:id/archive', wrap(async (req, res) => {
  const e = await own(req); if (e.status === 'published') conflict('Close the exam before archiving it.');
  await db.prepare("UPDATE exams SET status='archived',updated=? WHERE id=?").run(Date.now(), e.id); await audit(req.user, 'exam.archive', 'exam', e.id); res.json({ ok: true });
}));
r.post('/:id/duplicate', wrap(async (req, res) => {
  const e = await own(req), now = Date.now();
  const id = await tx(async () => {
    const n = (await db.prepare('INSERT INTO exams(owner_id,subject_id,title,instructions,minutes,max_attempts,shuffle_q,shuffle_o,release_mode,show_answers,declared_total,pass_mark,academic_year,term,grade,grace_s,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id')
      .run(req.user.id, e.subject_id, `Copy of ${e.title}`.slice(0, 120), e.instructions, e.minutes, e.max_attempts, e.shuffle_q, e.shuffle_o, e.release_mode, e.show_answers, e.declared_total, e.pass_mark, e.academic_year, e.term, e.grade, e.grace_s, now, now)).lastInsertRowid;
    await db.prepare('INSERT INTO exam_classes(exam_id,class_id) SELECT ?::bigint,class_id FROM exam_classes WHERE exam_id=?').run(n, e.id);
    await db.prepare('INSERT INTO exam_students(exam_id,student_id,enrolled_by,enrolled_at) SELECT ?::bigint,student_id,?::bigint,?::bigint FROM exam_students WHERE exam_id=?').run(n, req.user.id, now, e.id);
    await db.prepare('INSERT INTO exam_questions(exam_id,pos,section,source_qid,source_version,type,stem,options,key,settings,marks,topic,difficulty,explanation,image_id) SELECT ?::bigint,pos,section,source_qid,source_version,type,stem,options,key,settings,marks,topic,difficulty,explanation,image_id FROM exam_questions WHERE exam_id=? ORDER BY pos').run(n, e.id);
    return n;
  });
  await audit(req.user, 'exam.duplicate', 'exam', id, { from: e.id }); res.json({ id });
}));
r.delete('/:id', wrap(async (req, res) => {
  const e = await own(req); if (e.status !== 'draft') conflict('Only drafts can be deleted. Archive other exams instead.');
  await db.prepare('DELETE FROM exams WHERE id=?').run(e.id); await audit(req.user, 'exam.delete', 'exam', e.id, { title: e.title }); res.json({ ok: true });
}));
// Teacher preview: exactly what a student sees (no answer key).
r.get('/:id/preview', wrap(async (req, res) => { const e = await own(req); res.json({ exam: { id: e.id, title: e.title, instructions: e.instructions, minutes: e.minutes }, questions: studentQuestions(await loadEqs(e.id), e, 12345) }); }));

/* ---------- Students & exam enrollment (direct, per-exam). Owner-only; students are limited to the teacher's own classes. ---------- */
const EXAM_CSV_HEAD = ['exam_id', 'exam_title', 'student_id', 'student_number', 'student_name', 'student_email', 'enrollment_source', 'enrolled_at', 'participation_status', 'attempt_count', 'submission_status'];
const iso = ms => ms ? new Date(ms).toISOString() : '';
const intIds = v => { if (!Array.isArray(v) || v.length > 500) fail('Choose between 1 and 500 students.'); const a = [...new Set(v.map(Number))]; if (!a.length || a.some(n => !Number.isSafeInteger(n) || n <= 0)) fail('Invalid student selection.'); return a; };
const csvText = req => { if (typeof req.body.csv !== 'string') fail('Choose a CSV file first.'); return req.body.csv; };
r.get('/:id/enrollment', wrap(async (req, res) => {
  const e = await own(req), { page, size, offset } = paging(req, 15, 100), x = await E.roster(e.id, { q: String(req.query.q || '').trim().slice(0, 100), filter: String(req.query.filter || ''), size, offset });
  // not_enrolled = this teacher's own students who cannot take the exam yet (no direct enrollment and no assigned class)
  const notEnrolled = (await S.list(req.user, S.readFilters({}), { size: 1, offset: 0 }, null, { hideAccessTo: e.id })).total;
  res.json({ exam: { id: e.id, title: e.title, status: e.status, phase: phase(e) }, summary: { ...await E.summary(e.id), not_enrolled: notEnrolled }, page, size, total: x.total, items: x.items.map(i => ({ id: i.id, name: i.name, email: i.email, student_number: i.student_number, account_status: i.status, source: i.source, direct: i.direct, via_class: i.via_class, enrolled_at: i.enrolled_at, enrolled_by: i.enrolled_by_name, attempts: i.attempts, submitted: i.submitted, in_progress: i.in_progress, can_remove: i.direct && i.attempts === 0 })) });
}));
// Student picker: the teacher's own students, with filters, paging and per-exam enrollment status.
r.get('/:id/candidates', wrap(async (req, res) => {
  const e = await own(req), f = S.readFilters(req.query), { page, size, offset } = paging(req, 10, 50), x = req.query.hide_enrolled === '1' ? { hideAccessTo: e.id } : undefined;
  const l = await S.list(req.user, f, { size, offset }, null, x);
  res.json({ page, size, total: l.total, items: await E.statusFor(e.id, l.items.map(s => ({ id: s.id, name: s.name, email: s.email, student_number: s.student_number, status: s.status, classes: s.classes }))), facets: await S.facets(req.user) });
}));
// Enroll: exactly one of student_ids (picker / single Add), filters (select-all-matching), class_id (whole class).
r.post('/:id/enrollment', wrap(async (req, res) => {
  const e = await own(req), b = req.body || {}, modes = ['student_ids', 'filters', 'class_id'].filter(k => b[k] != null);
  if (modes.length !== 1) fail('Choose students, a filter result, or a class to add.');
  let ids, how = modes[0];
  if (how === 'student_ids') ids = intIds(b.student_ids);
  else if (how === 'filters') { ids = await S.allIds(req.user, S.readFilters(b.filters || {}), 1001, { hideAccessTo: e.id }); if (ids.length > 1000) fail('More than 1000 students match. Narrow the search (for example by class) and try again.'); if (!ids.length) fail('No students match those filters.'); }
  else {
    const cid = Number(b.class_id); if (!Number.isSafeInteger(cid) || cid <= 0 || !await db.prepare("SELECT 1 FROM class_members WHERE class_id=? AND user_id=? AND role='teacher'").get(cid, req.user.id)) notFound('Class not found.');
    ids = (await db.prepare("SELECT user_id FROM class_members WHERE class_id=? AND role='student'").all(cid)).map(x => x.user_id); if (!ids.length) fail('That class has no students.'); how = `class:${cid}`;
  }
  const out = await E.enroll(req.user, e, ids, how);
  res.json({ ...out, summary: { added: out.added.length, already: out.already.length, failed: out.failed.length } });
}));
r.delete('/:id/enrollment/:sid', wrap(async (req, res) => res.json(await E.unenroll(req.user, await own(req), idOf(req.params.sid)))));
r.get('/:id/enrollment/template.csv', wrap(async (req, res) => { await own(req); res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="exam-enrollment-template.csv"' }).send(CSV.toCsv(['email', 'student_number'], [])); }));
r.post('/:id/enrollment/import/preview', wrap(async (req, res) => res.json(await CSV.guard(async () => await EI.plan(req.user, await own(req), csvText(req))))));
r.post('/:id/enrollment/import/commit', wrap(async (req, res) => { const e = await own(req), t = csvText(req); await CSV.guard(async () => await EI.plan(req.user, e, t)); const out = await CSV.guard(async () => await EI.run(req.user, e, t, req.body.digest)); res.json(out); }));
r.get('/:id/roster.csv', wrap(async (req, res) => {
  const e = await own(req), rows = await E.roster(e.id, { all: true });
  await audit(req.user, 'roster.export', 'exam', e.id, { rows: (await E.summary(e.id)).eligible });
  await CSV.sendCsv(res, `roster-exam-${e.id}`, EXAM_CSV_HEAD, (function* () { for (const x of rows) yield [e.id, e.title, x.id, x.student_number || '', x.name, x.email, E.sourceOf(x).replace(' + ', '+').replace(/ /g, '_'), iso(x.enrolled_at), x.in_progress ? 'in_progress' : x.submitted ? 'completed' : 'not_started', x.attempts, x.latest_status || 'not_started']; })());
}));
module.exports = r; module.exports.phase = phase;
