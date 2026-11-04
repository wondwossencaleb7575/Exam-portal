const express = require('express');
const crypto = require('crypto');
const { db, uniqueViolation } = require('../lib/db');
const A = require('../lib/auth');
const { wrap, fail, notFound, conflict, forbidden, idOf, HttpError } = require('../lib/http');
const { loadEqs, validateValue, submitAttempt } = require('../lib/grading');
const { studentQuestions, answersVisibility } = require('../lib/exam');
const { saveAnswers } = require('../lib/answers');
const { phase } = require('./exams');
const { audit } = require('../lib/audit');
const E = require('../lib/enroll');
const P = require('../lib/policy');
const SET = require('../lib/settings');
const r = express.Router();
r.use(A.requireAuth({ roles: ['student'] }));

// Access = individually enrolled OR covered by an assigned class (enforced here on every student exam route).
const assigned = async (examId, uid) => await E.hasAccess(examId, uid);
async function myExam(req) {
  const e = await db.prepare("SELECT * FROM exams WHERE id=? AND status IN ('published','closed')").get(idOf(req.params.id));
  if (!e || !await assigned(e.id, req.user.id)) notFound(); return e;
}
async function myAttempt(req) { const a = await db.prepare('SELECT * FROM attempts WHERE id=? AND student_id=?').get(idOf(req.params.id), req.user.id); if (!a) notFound(); return a; }
const resultState = async (a, e) => {
  if (a.status === 'in_progress') return { state: 'in_progress' };
  if (a.released_at) { const set = await SET.get(), pm = P.passMarkFor(e, set), pc = a.total ? Math.round(a.score / a.total * 1000) / 10 : null; return { state: 'released', score: a.score, total: a.total, percent: pc, pass_mark: pm, result: P.passFail(a.score, a.total, pm), letter: P.letterFor(pc, set.grading_scale) }; }
  if (e.release_mode === 'immediate') {
    const o = (await db.prepare("SELECT COALESCE(SUM(marks),0) s FROM grades WHERE attempt_id=? AND status='auto'").get(a.id)).s, t = (await db.prepare('SELECT COALESCE(SUM(marks),0) t FROM exam_questions WHERE exam_id=?').get(e.id)).t;
    return { state: 'provisional', score: o, total: t, note: 'Objective questions only. Written and reviewed answers are still being marked.' };
  }
  return { state: 'awaiting' };
};
const payload = async (a, e) => {
  const mine = Object.fromEntries((await db.prepare('SELECT eq_id,value,seq,flagged FROM answers WHERE attempt_id=?').all(a.id)).map(x => [x.eq_id, { value: x.value == null ? null : JSON.parse(x.value), seq: x.seq, flagged: !!x.flagged }]));
  return { attempt: { id: a.id, deadline: a.deadline, status: a.status, serverNow: Date.now() }, exam: { id: e.id, title: e.title, minutes: e.minutes }, questions: studentQuestions(await loadEqs(e.id), e, a.seed), answers: mine };
};
// Lazily finalise one attempt if its deadline passed.
async function expireIfDue(a, e) { if (a.status === 'in_progress' && Date.now() > a.deadline + e.grace_s * 1000) { if ((await submitAttempt(a.id, 'auto_submitted')).changed) await audit(null, 'attempt.auto_submit', 'attempt', a.id, { reason: 'deadline passed' }); return true; } return false; }

r.get('/exams', wrap(async (req, res) => {
  const now = Date.now(), uid = req.user.id;
  const rows = await db.prepare(`SELECT e.*, s.name subject_name FROM exams e LEFT JOIN subjects s ON s.id=e.subject_id WHERE e.status IN ('published','closed') AND (EXISTS(SELECT 1 FROM exam_students es WHERE es.exam_id=e.id AND es.student_id=?1) OR EXISTS(SELECT 1 FROM exam_classes ec JOIN class_members m ON m.class_id=ec.class_id AND m.role='student' WHERE ec.exam_id=e.id AND m.user_id=?1)) ORDER BY COALESCE(e.opens,e.published_at) DESC`).all(uid);
  const items = [];
  for (const e of rows) { // one exam after another: an overdue attempt is auto-submitted before it is counted
    const as = [];
    for (const a0 of await db.prepare('SELECT * FROM attempts WHERE exam_id=? AND student_id=? ORDER BY attempt_no').all(e.id, uid)) { await expireIfDue(a0, e); as.push(await db.prepare('SELECT * FROM attempts WHERE id=?').get(a0.id)); }
    const acc = await db.prepare('SELECT * FROM accommodations WHERE exam_id=? AND student_id=?').get(e.id, uid), live = as.find(a => a.status === 'in_progress'), last = as.filter(a => a.status !== 'in_progress').pop();
    items.push({ id: e.id, title: e.title, subject: e.subject_name, minutes: e.minutes + (acc?.extra_minutes || 0), opens: e.opens, closes: e.closes, phase: phase(e, now), max_attempts: e.max_attempts + (acc?.extra_attempts || 0),
      attempts_used: as.filter(a => a.status !== 'in_progress').length, in_progress_attempt: live?.id || null,
      total_marks: (await db.prepare('SELECT COALESCE(SUM(marks),0) t FROM exam_questions WHERE exam_id=?').get(e.id)).t, last_attempt_id: last?.id || null, result: last ? await resultState(last, e) : null });
  }
  res.json({ items, classes: await db.prepare("SELECT c.id,c.name,c.grade FROM classes c JOIN class_members m ON m.class_id=c.id WHERE m.user_id=? AND c.archived=0").all(uid) });
}));
r.get('/exams/:id', wrap(async (req, res) => {
  const e = await myExam(req), acc = await db.prepare('SELECT * FROM accommodations WHERE exam_id=? AND student_id=?').get(e.id, req.user.id);
  res.json({ id: e.id, title: e.title, instructions: e.instructions, minutes: e.minutes + (acc?.extra_minutes || 0), opens: e.opens, closes: e.closes, phase: phase(e), max_attempts: e.max_attempts + (acc?.extra_attempts || 0),
    total_marks: (await db.prepare('SELECT COALESCE(SUM(marks),0) t FROM exam_questions WHERE exam_id=?').get(e.id)).t, questions: (await db.prepare('SELECT COUNT(*) n FROM exam_questions WHERE exam_id=?').get(e.id)).n,
    attempts_used: (await db.prepare("SELECT COUNT(*) n FROM attempts WHERE exam_id=? AND student_id=? AND status!='in_progress'").get(e.id, req.user.id)).n, release_mode: e.release_mode });
}));
// Starting is always a deliberate POST. Resuming returns the same attempt with the server's remaining time.
r.post('/exams/:id/start', wrap(async (req, res) => {
  const e = await myExam(req), uid = req.user.id, now = Date.now();
  const live = await db.prepare("SELECT * FROM attempts WHERE exam_id=? AND student_id=? AND status='in_progress'").get(e.id, uid);
  if (live) { if (await expireIfDue(live, e)) throw new HttpError(409, 'Your time ran out and your answers were submitted automatically.'); return res.json(await payload(live, e)); }
  if (phase(e, now) !== 'active') conflict(phase(e, now) === 'scheduled' ? 'This exam has not opened yet.' : 'This exam is closed.');
  const acc = await db.prepare('SELECT * FROM accommodations WHERE exam_id=? AND student_id=?').get(e.id, uid);
  const used = (await db.prepare('SELECT COUNT(*) n FROM attempts WHERE exam_id=? AND student_id=?').get(e.id, uid)).n;
  if (used >= e.max_attempts + (acc?.extra_attempts || 0)) conflict('You have used all your attempts for this exam.');
  let a;
  try {
    const id = (await db.prepare('INSERT INTO attempts(exam_id,student_id,attempt_no,started,deadline,extra_s,seed) VALUES(?,?,?,?,?,?,?) RETURNING id')
      .run(e.id, uid, used + 1, now, now + (e.minutes + (acc?.extra_minutes || 0)) * 60000, (acc?.extra_minutes || 0) * 60, crypto.randomInt(1, 2 ** 31))).lastInsertRowid;
    a = await db.prepare('SELECT * FROM attempts WHERE id=?').get(id);
  } catch (err) {
    // Only the "already started / that attempt number is taken" collision is expected here (double click, two tabs): answer with the attempt that won.
    // Anything else (for example the database being unreachable) is a real error and must not be disguised.
    if (!uniqueViolation(err)) throw err;
    a = await db.prepare("SELECT * FROM attempts WHERE exam_id=? AND student_id=? AND status='in_progress'").get(e.id, uid); if (!a) throw new HttpError(409, 'Could not start. Try again.');
  }
  res.json(await payload(a, e));
}));
r.get('/attempts/:id', wrap(async (req, res) => {
  const a = await myAttempt(req), e = await db.prepare('SELECT * FROM exams WHERE id=?').get(a.exam_id);
  if (await expireIfDue(a, e)) throw new HttpError(409, 'Your time ran out and your answers were submitted automatically.', { finalized: true });
  if (a.status !== 'in_progress') throw new HttpError(409, 'This attempt is already submitted.', { finalized: true });
  res.json(await payload(a, e));
}));
// Autosave: sequence-guarded saves (lib/answers.js). The response says which items are saved, which are stale (the server holds newer data) and which were rejected.
const saveItems = async (a, e, items) => await saveAnswers(a.id, await loadEqs(e.id), items);
r.put('/attempts/:id/answers', wrap(async (req, res) => {
  const a = await myAttempt(req), e = await db.prepare('SELECT * FROM exams WHERE id=?').get(a.exam_id);
  if (await expireIfDue(a, e) || a.status !== 'in_progress') throw new HttpError(409, 'This attempt is closed. Your last saved answers were submitted.', { finalized: true });
  const out = await saveItems(a, e, req.body.items);
  if (out.closed) throw new HttpError(409, 'This attempt is closed. Your last saved answers were submitted.', { finalized: true }); // submitted while this save was in flight
  res.json({ ...out, serverNow: Date.now(), deadline: a.deadline });
}));
r.post('/attempts/:id/submit', wrap(async (req, res) => {
  const a = await myAttempt(req), e = await db.prepare('SELECT * FROM exams WHERE id=?').get(a.exam_id);
  if (a.status !== 'in_progress') return res.json({ ok: true, already: true, status: a.status, submitted_at: a.submitted_at, receipt: a.receipt }); // safe to retry
  const late = Date.now() > a.deadline + e.grace_s * 1000;
  if (!late && Array.isArray(req.body.items)) await saveItems(a, e, req.body.items); // final flush, only inside the allowed time
  const x = await submitAttempt(a.id, late ? 'auto_submitted' : 'submitted'), f = x.attempt;
  // already:true tells a duplicate request (double click, retry after a lost response, another tab) that someone else's submit did the work
  res.json({ ok: true, late, ...(x.changed ? {} : { already: true }), status: f.status, submitted_at: f.submitted_at, receipt: f.receipt });
}));
r.post('/attempts/:id/events', wrap(async (req, res) => {
  const a = await myAttempt(req), kind = String(req.body.kind || '');
  if (a.status !== 'in_progress' || !['hidden', 'visible', 'blur', 'fullscreen_exit', 'offline', 'online'].includes(kind)) return res.json({ ok: true });
  if ((await db.prepare('SELECT COUNT(*) n FROM attempt_events WHERE attempt_id=?').get(a.id)).n < 200) await db.prepare('INSERT INTO attempt_events(attempt_id,ts,kind) VALUES(?,?,?)').run(a.id, Date.now(), kind);
  res.json({ ok: true });
}));
// Results: the answer key and explanations are only sent after release AND only if the teacher enabled "show answers".
r.get('/attempts/:id/result', wrap(async (req, res) => {
  const a = await myAttempt(req), e = await db.prepare('SELECT * FROM exams WHERE id=?').get(a.exam_id); await expireIfDue(a, e);
  const fresh = await db.prepare('SELECT * FROM attempts WHERE id=?').get(a.id), st = await resultState(fresh, e);
  const base = { exam: { id: e.id, title: e.title }, submitted_at: fresh.submitted_at, receipt: fresh.receipt, result: st };
  if (st.state !== 'released') return res.json(base);
  const ans = new Map((await db.prepare('SELECT * FROM answers WHERE attempt_id=?').all(a.id)).map(x => [x.eq_id, x.value == null ? null : JSON.parse(x.value)])), gr = new Map((await db.prepare('SELECT * FROM grades WHERE attempt_id=?').all(a.id)).map(x => [x.eq_id, x]));
  const av = answersVisibility({ showAnswers: !!e.show_answers, phaseNow: phase(e), anyInProgress: !!await db.prepare("SELECT 1 FROM attempts WHERE exam_id=? AND status='in_progress' LIMIT 1").get(e.id) });
  res.json({ ...base, answers_withheld: av.reason, items: (await loadEqs(e.id)).map((q, i) => ({ n: i + 1, stem: q.stem, type: q.type, options: q.options, image_id: q.image_id, marks: q.marks, answer: ans.get(q.id) ?? null, got: gr.get(q.id)?.marks ?? 0, feedback: gr.get(q.id)?.feedback || '',
    ...(av.visible ? { key: q.key, explanation: q.explanation } : {}) })) });
}));
module.exports = r;
