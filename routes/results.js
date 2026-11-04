const express = require('express');
const { db, tx } = require('../lib/db');
const A = require('../lib/auth');
const { wrap, fail, notFound, conflict, idOf, paging, text } = require('../lib/http');
const { loadEqs, recompute, r2 } = require('../lib/grading');
const { audit } = require('../lib/audit');
const E = require('../lib/enroll');
const CSV = require('../lib/csv');
const P = require('../lib/policy');
const SET = require('../lib/settings');
const AN = require('../lib/analytics');
const r = express.Router();
r.use(A.requireAuth({ roles: ['teacher'] }));
const exam = async req => { const e = await db.prepare('SELECT * FROM exams WHERE id=? AND owner_id=?').get(idOf(req.params.id), req.user.id); if (!e) notFound(); return e; };
const attempt = async req => {
  const a = await db.prepare('SELECT a.*, e.owner_id FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.id=?').get(idOf(req.params.id));
  if (!a || a.owner_id !== req.user.id) notFound(); return a;
};
const pct = (s, t) => t ? Math.round(s / t * 1000) / 10 : null;

r.get('/dashboard', wrap(async (req, res) => {
  const u = req.user.id, n = async (sql, ...p) => (await db.prepare(sql).get(...p)).n, now = Date.now();
  res.json({
    classes: await n("SELECT COUNT(*) n FROM class_members WHERE user_id=? AND role='teacher'", u),
    students: await n("SELECT COUNT(DISTINCT m.user_id) n FROM class_members m WHERE m.role='student' AND m.class_id IN (SELECT class_id FROM class_members WHERE user_id=?)", u),
    exams: await n('SELECT COUNT(*) n FROM exams WHERE owner_id=?', u),
    draft: await n("SELECT COUNT(*) n FROM exams WHERE owner_id=? AND status='draft'", u),
    scheduled: await n("SELECT COUNT(*) n FROM exams WHERE owner_id=? AND status='published' AND opens>?", u, now),
    active: await n("SELECT COUNT(*) n FROM exams WHERE owner_id=? AND status='published' AND (opens IS NULL OR opens<=?) AND (closes IS NULL OR closes>=?)", u, now, now),
    in_progress: await n("SELECT COUNT(*) n FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE e.owner_id=? AND a.status='in_progress'", u),
    awaiting: await n("SELECT COUNT(*) n FROM grades g JOIN attempts a ON a.id=g.attempt_id JOIN exams e ON e.id=a.exam_id WHERE e.owner_id=? AND g.status='pending'", u),
    avg_pct: (await db.prepare("SELECT ROUND(AVG(a.score*100.0/a.total)::numeric,1) v FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE e.owner_id=? AND a.status!='in_progress' AND a.grading_status='graded' AND a.total>0").get(u)).v,
    upcoming: await db.prepare("SELECT id,title,opens,closes FROM exams WHERE owner_id=? AND status='published' AND (closes IS NULL OR closes>=?) ORDER BY COALESCE(opens,0) LIMIT 5").all(u, now),
    recent: await db.prepare(`SELECT e.id,e.title,COUNT(a.id) submitted, ROUND(AVG(CASE WHEN a.total>0 THEN a.score*100.0/a.total END)::numeric,1) avg_pct, COUNT(*) FILTER (WHERE a.grading_status='pending') pending
      FROM exams e JOIN attempts a ON a.exam_id=e.id AND a.status!='in_progress' WHERE e.owner_id=? GROUP BY e.id ORDER BY MAX(a.submitted_at) DESC LIMIT 5`).all(u)
  });
}));

r.get('/exams/:id/results', wrap(async (req, res) => {
  const e = await exam(req), { page, size, offset } = paging(req, 50, 200), q = `%${String(req.query.q || '').trim()}%`;
  const roster = (await E.summary(e.id)).eligible, set = await SET.get(), pm = P.passMarkFor(e, set);
  const w = 'a.exam_id=? AND (u.name ILIKE ? OR u.email ILIKE ? OR u.student_number ILIKE ?)', p = [e.id, q, q, q];
  const total = (await db.prepare(`SELECT COUNT(*) n FROM attempts a JOIN users u ON u.id=a.student_id WHERE ${w}`).get(...p)).n;
  const rows = (await db.prepare(`SELECT a.id,a.attempt_no,a.status,a.started,a.deadline,a.submitted_at,a.score,a.total,a.grading_status,a.finalized_at,a.released_at,a.extra_s,
      u.id student_id,u.name,u.email,u.student_number,
      (SELECT COUNT(*) FROM attempt_events v WHERE v.attempt_id=a.id) events
    FROM attempts a JOIN users u ON u.id=a.student_id WHERE ${w} ORDER BY u.name,a.attempt_no LIMIT ? OFFSET ?`).all(...p, size, offset)).map(x => {
      const live = x.status === 'in_progress', graded = !live && x.grading_status === 'graded', pc = graded ? pct(x.score, x.total) : null;
      // percent / result / letter exist only once grading is complete. Partial marks are labelled provisional and never given a pass/fail.
      return { ...x, percent: pc, provisional_percent: !live && !graded ? pct(x.score, x.total) : null, result: graded ? P.passFail(x.score, x.total, pm) : null, letter: graded ? P.letterFor(pc, set.grading_scale) : null };
    });
  const cnt = async c => (await db.prepare(`SELECT COUNT(*) n FROM attempts WHERE exam_id=? AND ${c}`).get(e.id)).n;
  res.json({ exam: { id: e.id, title: e.title, status: e.status, release_mode: e.release_mode, pass_mark: pm }, total, page, size, rows,
    summary: { roster, started: (await db.prepare('SELECT COUNT(DISTINCT student_id) n FROM attempts WHERE exam_id=?').get(e.id)).n, in_progress: await cnt("status='in_progress'"), submitted: await cnt("status!='in_progress'"),
      pending: await cnt("status!='in_progress' AND grading_status='pending'"), unfinalized: await cnt("status!='in_progress' AND finalized_at IS NULL"), finalized: await cnt('finalized_at IS NOT NULL'), unreleased: await cnt('finalized_at IS NOT NULL AND released_at IS NULL') } });
}));

// Cross-exam analytics over the teacher's own exams. Aggregates only; a class filter must be a class this teacher teaches.
r.get('/analytics', wrap(async (req, res) => {
  const f = AN.readFilters(req.query);
  if (f.class_id && !await db.prepare("SELECT 1 FROM class_members WHERE class_id=? AND user_id=? AND role='teacher'").get(f.class_id, req.user.id)) notFound('Class not found.');
  res.json({ ...await AN.report(req.user.id, f), facets: await AN.facets(req.user.id) });
}));
r.get('/exams/:id/analytics', wrap(async (req, res) => {
  const e = await exam(req), eqs = await loadEqs(e.id);
  const done = await db.prepare("SELECT id,score,total FROM attempts WHERE exam_id=? AND status!='in_progress' AND grading_status='graded' AND total>0").all(e.id);
  const excluded = (await db.prepare("SELECT COUNT(*) n FROM attempts WHERE exam_id=? AND status!='in_progress' AND grading_status='pending'").get(e.id)).n;
  const ps = done.map(a => a.score / a.total * 100).sort((a, b) => a - b), bins = Array(10).fill(0); ps.forEach(v => bins[Math.min(9, Math.floor(v / 10))]++);
  const med = ps.length ? (ps.length % 2 ? ps[(ps.length - 1) / 2] : (ps[ps.length / 2 - 1] + ps[ps.length / 2]) / 2) : null;
  const gq = await db.prepare("SELECT g.eq_id, AVG(g.marks) avg, COUNT(*) n FROM grades g JOIN attempts a ON a.id=g.attempt_id WHERE a.exam_id=? AND a.grading_status='graded' GROUP BY g.eq_id").all(e.id);
  const byQ = new Map(gq.map(x => [x.eq_id, x]));
  const questions = eqs.map((q, i) => { const g = byQ.get(q.id); return { n: i + 1, id: q.id, topic: q.topic, type: q.type, marks: q.marks, avg_marks: g ? r2(g.avg) : null, percent: g ? pct(g.avg, q.marks) : null, responses: g?.n || 0 }; });
  const topics = {}; for (const q of questions) if (q.avg_marks != null) { const t = q.topic || '(no topic)'; topics[t] = topics[t] || { topic: t, got: 0, max: 0 }; topics[t].got += q.avg_marks; topics[t].max += q.marks; }
  const pm = P.passMarkFor(e, await SET.get()), passN = done.filter(a => P.passFail(a.score, a.total, pm) === 'pass').length;
  res.json({ pass_mark: pm, pass_rate: done.length ? Math.round(passN / done.length * 1000) / 10 : null, pass_n: passN, n: done.length, excluded_pending: excluded, mean_percent: ps.length ? Math.round(ps.reduce((a, b) => a + b, 0) / ps.length * 10) / 10 : null, median_percent: med == null ? null : Math.round(med * 10) / 10,
    highest: ps.length ? Math.round(ps[ps.length - 1] * 10) / 10 : null, lowest: ps.length ? Math.round(ps[0] * 10) / 10 : null, distribution: bins,
    questions, topics: Object.values(topics).map(t => ({ topic: t.topic, percent: pct(t.got, t.max), n_questions: questions.filter(q => (q.topic || '(no topic)') === t.topic).length })),
    note: 'Statistics include only submissions whose grading is complete. Percentages are marks earned divided by marks available.' });
}));

// Results CSV: one row per attempt, plus a "not_started" row for every entitled student who has none. Only the owning teacher can export.
// Marks are shown only once grading is complete; otherwise the cell is blank and "Grading" says pending. Nothing unfinished is presented as a final score.
const RESULT_HEAD = ['Exam ID', 'Exam title', 'Student ID', 'Student number', 'Student name', 'Student email', 'Subject', 'Class', 'Attempt', 'Attempt status', 'Started (ISO)', 'Submitted at (ISO)', 'Marks', 'Total marks', 'Percent', 'Grading', 'Finalized', 'Result released', 'Extra minutes (accommodation)', 'Extra attempts (accommodation)', 'Pass mark (%)', 'Result', 'Letter grade'];
const isoT = ms => ms ? new Date(ms).toISOString() : '';
r.get('/exams/:id/export.csv', wrap(async (req, res) => {
  const e = await exam(req), set = await SET.get(), pm = P.passMarkFor(e, set), subj = e.subject_id ? (await db.prepare('SELECT name FROM subjects WHERE id=?').get(e.subject_id))?.name || '' : '';
  const rows = await db.prepare(`SELECT u.id sid,u.name,u.email,u.student_number,
      (SELECT STRING_AGG(k.name,'; ' ORDER BY k.name) FROM class_members m JOIN classes k ON k.id=m.class_id JOIN exam_classes ec ON ec.class_id=k.id AND ec.exam_id=?1 WHERE m.user_id=u.id AND m.role='student') classes,
      a.attempt_no,a.status,a.started,a.submitted_at,a.score,a.total,a.grading_status,a.finalized_at,a.released_at,
      COALESCE(ac.extra_minutes,0) xm,COALESCE(ac.extra_attempts,0) xa
    FROM users u LEFT JOIN attempts a ON a.student_id=u.id AND a.exam_id=?1 LEFT JOIN accommodations ac ON ac.exam_id=?1 AND ac.student_id=u.id
    WHERE u.role='student' AND (a.id IS NOT NULL OR ${E.ACCESS_U.replace(/\?/g, '?1')}) ORDER BY lower(u.name),u.id,a.attempt_no`).all(e.id);
  await audit(req.user, 'results.export', 'exam', e.id, { rows: 'streamed' });
  await CSV.sendCsv(res, `results-exam-${e.id}`, RESULT_HEAD, (function* () {
    for (const x of rows) {
      const live = x.status === 'in_progress', graded = x.grading_status === 'graded' && !live;
      yield [e.id, e.title, x.sid, x.student_number || '', x.name, x.email, subj, x.classes || '(direct enrollment)', x.attempt_no ?? '', x.status || 'not_started', isoT(x.started), isoT(x.submitted_at),
        graded ? x.score : '', x.status && !live ? x.total : '', graded ? pct(x.score, x.total) : '', !x.status ? 'not_started' : live ? 'in_progress' : (x.grading_status || ''), x.finalized_at ? 'yes' : 'no', x.released_at ? 'yes' : 'no', x.xm, x.xa, pm, graded ? (P.passFail(x.score, x.total, pm) || '') : '', graded ? (P.letterFor(pct(x.score, x.total), set.grading_scale) || '') : ''];
    }
  })());
}));

r.get('/attempts/:id', wrap(async (req, res) => {
  const a = await attempt(req), e = await db.prepare('SELECT id,title FROM exams WHERE id=?').get(a.exam_id);
  const stu = await db.prepare('SELECT id,name,email,student_number FROM users WHERE id=?').get(a.student_id);
  const ans = new Map((await db.prepare('SELECT * FROM answers WHERE attempt_id=?').all(a.id)).map(x => [x.eq_id, x]));
  const gr = new Map((await db.prepare('SELECT * FROM grades WHERE attempt_id=?').all(a.id)).map(x => [x.eq_id, x]));
  const items = [];
  for (const [i, q] of (await loadEqs(a.exam_id)).entries()) items.push({ n: i + 1, q, answer: ans.has(q.id) && ans.get(q.id).value != null ? JSON.parse(ans.get(q.id).value) : null, grade: gr.get(q.id) || null,
    history: await db.prepare('SELECT h.*,u.name by_name FROM grade_history h JOIN users u ON u.id=h.by_user WHERE attempt_id=? AND eq_id=? ORDER BY h.id').all(a.id, q.id) });
  res.json({ attempt: a, exam: e, student: stu, events: await db.prepare('SELECT kind,COUNT(*) n FROM attempt_events WHERE attempt_id=? GROUP BY kind').all(a.id), items });
}));
r.put('/attempts/:id/grade', wrap(async (req, res) => {
  const a = await attempt(req); if (a.status === 'in_progress') conflict('The student has not submitted yet.');
  const eqId = Number(req.body.eq_id), q = (await loadEqs(a.exam_id)).find(x => x.id === eqId);
  if (!q) notFound();
  const marks = Math.round(Number(req.body.marks) * 100) / 100; if (!Number.isFinite(marks) || marks < 0 || marks > q.marks) fail(`Marks must be between 0 and ${q.marks}.`);
  const reason = text(req.body.reason, 500); let g;
  await tx(async () => {
    g = await db.prepare('SELECT * FROM grades WHERE attempt_id=? AND eq_id=? FOR UPDATE').get(a.id, eqId); // two marking clicks at once are applied one after the other, each with its true "old mark"
    if (!g) notFound();
    if (g.status !== 'pending' && marks !== g.marks && !reason) fail('Give a reason for changing an existing mark.');
    await db.prepare("UPDATE grades SET marks=?,status='graded',feedback=?,graded_by=?,graded_at=? WHERE attempt_id=? AND eq_id=?").run(marks, text(req.body.feedback, 3000), req.user.id, Date.now(), a.id, eqId);
    await db.prepare('INSERT INTO grade_history(attempt_id,eq_id,old_marks,new_marks,old_status,by_user,at,reason) VALUES(?,?,?,?,?,?,?,?)').run(a.id, eqId, g.marks, marks, g.status, req.user.id, Date.now(), reason);
    await recompute(a.id);
  });
  await audit(req.user, 'grade.set', 'attempt', a.id, { eq_id: eqId, from: g.marks, to: marks, reason, finalized: !!a.finalized_at });
  res.json({ ok: true, attempt: await db.prepare('SELECT score,total,grading_status FROM attempts WHERE id=?').get(a.id) });
}));
// Time accommodation / technical-incident handling. Always needs a recorded reason.
r.post('/attempts/:id/extend', wrap(async (req, res) => {
  const a0 = await attempt(req), mins = Math.floor(Number(req.body.minutes)), reason = text(req.body.reason, 500, { min: 3, label: 'Reason' });
  if (!(mins >= 1 && mins <= 240)) fail('Extension must be 1 to 240 minutes.');
  let nd, reopened;
  await tx(async () => {
    // The attempt row is locked and read again here: the deadline sweeper or the student may have changed it since the check above.
    const a = await db.prepare('SELECT * FROM attempts WHERE id=? FOR UPDATE').get(a0.id);
    if (a.status === 'submitted') conflict('The student submitted deliberately. Grant an extra attempt instead.');
    if (a.finalized_at) conflict('Results are already finalized for this attempt.');
    nd = Math.max(a.deadline, Date.now()) + mins * 60000; reopened = a.status === 'auto_submitted';
    if (reopened) { await db.prepare('DELETE FROM grades WHERE attempt_id=?').run(a.id); await db.prepare("UPDATE attempts SET status='in_progress',submitted_at=NULL,receipt=NULL,score=NULL,total=NULL,grading_status=NULL WHERE id=?").run(a.id); }
    await db.prepare('UPDATE attempts SET deadline=?,extra_s=extra_s+? WHERE id=?').run(nd, mins * 60, a.id);
  });
  await audit(req.user, 'attempt.extend', 'attempt', a0.id, { minutes: mins, reason, reopened, new_deadline: nd }); res.json({ ok: true, deadline: nd });
}));
r.post('/exams/:id/accommodations', wrap(async (req, res) => {
  const e = await exam(req), sid = Number(req.body.student_id), em = Math.floor(Number(req.body.extra_minutes) || 0), ea = Math.floor(Number(req.body.extra_attempts) || 0);
  if (em < 0 || em > 240 || ea < 0 || ea > 3) fail('Extra minutes must be 0 to 240 and extra attempts 0 to 3.');
  if (!await E.hasAccess(e.id, sid)) fail('That student is not enrolled in this exam (directly or through an assigned class).');
  const note = text(req.body.note, 300, { min: 3, label: 'Reason' });
  await db.prepare('INSERT INTO accommodations(exam_id,student_id,extra_minutes,extra_attempts,note) VALUES(?,?,?,?,?) ON CONFLICT(exam_id,student_id) DO UPDATE SET extra_minutes=excluded.extra_minutes,extra_attempts=excluded.extra_attempts,note=excluded.note').run(e.id, sid, em, ea, note);
  await audit(req.user, 'exam.accommodation', 'exam', e.id, { student_id: sid, extra_minutes: em, extra_attempts: ea, note }); res.json({ ok: true });
}));
r.get('/exams/:id/roster', wrap(async (req, res) => {
  const e = await exam(req);
  res.json(await db.prepare(`SELECT u.id,u.name,u.email,u.student_number,COALESCE(ac.extra_minutes,0) extra_minutes,COALESCE(ac.extra_attempts,0) extra_attempts
    FROM users u LEFT JOIN accommodations ac ON ac.exam_id=? AND ac.student_id=u.id WHERE u.role='student' AND ${E.ACCESS_U} ORDER BY u.name`).all(e.id, e.id, e.id));
}));
// Finalise: only possible when nothing is ungraded. Totals are re-derived and checked first.
r.post('/exams/:id/finalize', wrap(async (req, res) => {
  const e = await exam(req), only = req.body.attempt_id ? Number(req.body.attempt_id) : null;
  const rows = await db.prepare("SELECT a.id,u.name FROM attempts a JOIN users u ON u.id=a.student_id WHERE a.exam_id=? AND a.status!='in_progress' AND a.finalized_at IS NULL AND (?::bigint IS NULL OR a.id=?)").all(e.id, only, only);
  const done = [], blocked = [];
  for (const a of rows) {
    let outcome = 'done';
    await tx(async () => {
      const cur = await db.prepare('SELECT finalized_at FROM attempts WHERE id=? FOR UPDATE').get(a.id); // checked and written under one lock
      if (cur.finalized_at) { outcome = 'skip'; return; }
      const pending = (await db.prepare("SELECT COUNT(*) n FROM grades WHERE attempt_id=? AND status='pending'").get(a.id)).n;
      if (pending) { outcome = { attempt_id: a.id, name: a.name, pending }; return; }
      await recompute(a.id);
      await db.prepare('UPDATE attempts SET finalized_at=?,finalized_by=?,released_at=CASE WHEN ?::int=1 THEN ?::bigint ELSE released_at END WHERE id=?').run(Date.now(), req.user.id, e.release_mode === 'on_finalize' ? 1 : 0, Date.now(), a.id);
    });
    if (outcome === 'done') done.push(a.id); else if (outcome !== 'skip') blocked.push(outcome);
  }
  await audit(req.user, 'results.finalize', 'exam', e.id, { finalized: done.length, blocked: blocked.length }); res.json({ finalized: done.length, blocked });
}));
r.post('/exams/:id/release', wrap(async (req, res) => {
  const e = await exam(req), only = req.body.attempt_id ? Number(req.body.attempt_id) : null;
  const n = (await db.prepare('UPDATE attempts SET released_at=? WHERE exam_id=? AND finalized_at IS NOT NULL AND released_at IS NULL AND (?::bigint IS NULL OR id=?)').run(Date.now(), e.id, only, only)).changes;
  await audit(req.user, 'results.release', 'exam', e.id, { released: n }); res.json({ released: n });
}));
r.post('/exams/:id/withhold', wrap(async (req, res) => {
  const e = await exam(req), n = (await db.prepare('UPDATE attempts SET released_at=NULL WHERE exam_id=?').run(e.id)).changes;
  await audit(req.user, 'results.withhold', 'exam', e.id, { attempts: n }); res.json({ withheld: n });
}));
module.exports = r;
