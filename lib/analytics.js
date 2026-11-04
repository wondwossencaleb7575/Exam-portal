'use strict';
// Cross-exam analytics for a teacher's OWN exams. Aggregates only: no student names or ids leave this module.
// Population rules (also returned to the UI so nothing is implied that is not true):
//  * Only submitted attempts whose grading is complete count toward scores. Attempts still awaiting grading are excluded and counted separately.
//  * One attempt per student per exam: their highest-scoring graded attempt.
//  * Pass/fail uses each exam's own pass mark (or the school default), so exams with different pass marks combine correctly.
const { db } = require('./db');
const P = require('./policy');
const SETT = require('./settings');
const E = require('./enroll');
const MIN_N = 5;   // a question/topic needs at least this many responses to be ranked
const CAP = 300;   // exams per report
const r1 = v => v == null ? null : Math.round(v * 10) / 10;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const ph = n => Array(n).fill('?').join(',');

function readFilters(q = {}) {
  const n = k => Number(q[k]) > 0 ? Number(q[k]) : null, t = k => String(q[k] ?? '').trim().slice(0, 30), ms = k => Number(q[k]) > 0 ? Number(q[k]) : null;
  return { subject_id: n('subject_id'), grade: t('grade'), academic_year: t('academic_year'), term: t('term'), class_id: n('class_id'), exam_id: n('exam_id'), from: ms('from'), to: ms('to') };
}
async function facets(userId) {
  const col = async c => (await db.prepare(`SELECT DISTINCT ${c} v FROM exams WHERE owner_id=? AND ${c} IS NOT NULL AND ${c}!='' ORDER BY ${c}`).all(userId)).map(r => r.v);
  return { subjects: await db.prepare("SELECT DISTINCT s.id,s.name FROM exams e JOIN subjects s ON s.id=e.subject_id WHERE e.owner_id=? ORDER BY s.name").all(userId), grades: await col('grade'), academic_years: await col('academic_year'), terms: (await SETT.get()).terms,
    exams: await db.prepare("SELECT id,title FROM exams WHERE owner_id=? AND status IN ('published','closed') ORDER BY id DESC LIMIT 200").all(userId),
    classes: await db.prepare("SELECT c.id,c.name FROM classes c JOIN class_members m ON m.class_id=c.id AND m.user_id=? AND m.role='teacher' ORDER BY c.name").all(userId) };
}
async function report(userId, f) {
  const set = await SETT.get(), w = ["e.owner_id=?", "e.status IN ('published','closed')"], p = [userId];
  if (f.subject_id) { w.push('e.subject_id=?'); p.push(f.subject_id); } if (f.grade) { w.push('lower(e.grade)=lower(?)'); p.push(f.grade); }
  if (f.academic_year) { w.push('lower(e.academic_year)=lower(?)'); p.push(f.academic_year); } if (f.term) { w.push('e.term=?'); p.push(f.term); } if (f.exam_id) { w.push('e.id=?'); p.push(f.exam_id); }
  const exams = await db.prepare(`SELECT e.* FROM exams e WHERE ${w.join(' AND ')} ORDER BY e.id DESC LIMIT ${CAP + 1}`).all(...p), truncated = exams.length > CAP; if (truncated) exams.pop();
  const ids = exams.map(e => e.id), byId = new Map(exams.map(e => [e.id, e]));
  const out = { filters: f, exams_in_scope: exams.length, truncated, population: '', enrollments: 0, students_submitted: 0, submission_rate: null, attempts_pending: 0, grades_pending: 0, oldest_pending_days: null, n: 0, mean: null, median: null, min: null, max: null, pass_rate: null, pass_n: 0, distribution: Array(10).fill(0), letters: [], per_exam: [], hardest_questions: [], topics: [], min_sample: MIN_N };
  if (!ids.length) { out.population = 'No published or closed exams match these filters.'; return out; }

  // class filter must be a class this teacher teaches (the route checks); restricts every figure to that class's students
  const clsSql = f.class_id ? ' AND EXISTS(SELECT 1 FROM class_members cm WHERE cm.class_id=? AND cm.user_id=a.student_id AND cm.role=\'student\')' : '';
  const range = (f.from ? ' AND a.submitted_at>=?' : '') + (f.to ? ' AND a.submitted_at<=?' : '');
  const extra = [...(f.class_id ? [f.class_id] : []), ...(f.from ? [f.from] : []), ...(f.to ? [f.to] : [])];
  const attempts = await db.prepare(`SELECT a.id,a.exam_id,a.student_id,a.score,a.total,a.grading_status,a.submitted_at FROM attempts a WHERE a.exam_id IN (${ph(ids.length)}) AND a.status!='in_progress'${clsSql}${range}`).all(...ids, ...extra);
  const best = new Map(); let pending = 0;
  for (const a of attempts) {
    if (a.grading_status !== 'graded' || !(a.total > 0)) { if (a.grading_status === 'pending') pending++; continue; }
    const k = a.exam_id + ':' + a.student_id, cur = best.get(k); if (!cur || a.score / a.total > cur.score / cur.total) best.set(k, a);
  }
  const chosen = [...best.values()], pcts = [];
  const per = new Map(ids.map(id => [id, { exam_id: id, title: byId.get(id).title, pass_mark: P.passMarkFor(byId.get(id), set), pcts: [], submitted_students: new Set(), pending: 0 }]));
  for (const a of attempts) { const x = per.get(a.exam_id); x.submitted_students.add(a.student_id); if (a.grading_status === 'pending') x.pending++; }
  const letterCount = new Map();
  for (const a of chosen) {
    const pc = a.score / a.total * 100, x = per.get(a.exam_id); pcts.push(pc); x.pcts.push(pc);
    out.distribution[Math.min(9, Math.floor(pc / 10))]++;
    if (P.passFail(a.score, a.total, x.pass_mark) === 'pass') { out.pass_n++; x.pass = (x.pass || 0) + 1; }
    const l = P.letterFor(pc, set.grading_scale); if (l) letterCount.set(l, (letterCount.get(l) || 0) + 1);
  }
  out.n = chosen.length; out.mean = r1(mean(pcts)); out.median = r1(median(pcts)); out.min = r1(pcts.length ? Math.min(...pcts) : null); out.max = r1(pcts.length ? Math.max(...pcts) : null);
  out.pass_rate = out.n ? r1(out.pass_n / out.n * 100) : null; out.attempts_pending = pending;
  out.letters = set.grading_scale.map(g => ({ label: g.label, min: g.min, count: letterCount.get(g.label) || 0 }));
  // enrollments = students entitled to each exam in scope (direct or class); submission rate = those with at least one submitted attempt
  let enrolled = 0, submitted = 0;
  for (const e of exams) { const s = await E.summary(e.id); enrolled += s.eligible; const x = per.get(e.id); submitted += x.submitted_students.size; }
  out.enrollments = enrolled; out.students_submitted = submitted; out.submission_rate = enrolled ? r1(submitted / enrolled * 100) : null;
  out.per_exam = [...per.values()].map(x => ({ exam_id: x.exam_id, title: x.title, pass_mark: x.pass_mark, graded: x.pcts.length, pending_attempts: x.pending, mean: r1(mean(x.pcts)), median: r1(median(x.pcts)), pass_rate: x.pcts.length ? r1((x.pass || 0) / x.pcts.length * 100) : null }));

  // pending workload (not limited by the class filter: it is the teacher's marking queue for these exams)
  const pg = await db.prepare(`SELECT COUNT(*) n, MIN(a.submitted_at) oldest FROM grades g JOIN attempts a ON a.id=g.attempt_id WHERE g.status='pending' AND a.exam_id IN (${ph(ids.length)})`).get(...ids);
  out.grades_pending = pg.n; out.oldest_pending_days = pg.oldest ? Math.floor((Date.now() - pg.oldest) / 864e5) : null;

  // question + topic difficulty, using exactly the attempts counted above
  const q = new Map();
  for (let i = 0; i < chosen.length; i += 400) {
    const chunk = chosen.slice(i, i + 400).map(a => a.id);
    for (const g of await db.prepare(`SELECT g.eq_id, SUM(g.marks) got, COUNT(*) n FROM grades g WHERE g.attempt_id IN (${ph(chunk.length)}) GROUP BY g.eq_id`).all(...chunk)) { const c = q.get(g.eq_id) || { got: 0, n: 0 }; c.got += g.got; c.n += g.n; q.set(g.eq_id, c); }
  }
  const eqs = await db.prepare(`SELECT id,exam_id,pos,stem,topic,marks FROM exam_questions WHERE exam_id IN (${ph(ids.length)})`).all(...ids), qs = [], topics = new Map();
  for (const x of eqs) {
    const c = q.get(x.id); if (!c || c.n < MIN_N || !(x.marks > 0)) continue; const pc = c.got / (c.n * x.marks) * 100;
    qs.push({ exam_id: x.exam_id, exam: byId.get(x.exam_id).title, n: x.pos + 1, stem: String(x.stem).replace(/\s+/g, ' ').slice(0, 90), topic: x.topic || '', percent: r1(pc), responses: c.n });
    const key = (x.topic || '').trim().toLowerCase() || '(no topic)', t = topics.get(key) || { topic: x.topic || '(no topic)', got: 0, max: 0, n: 0, qn: 0 }; t.got += c.got; t.max += c.n * x.marks; t.n += c.n; t.qn++; topics.set(key, t);
  }
  out.hardest_questions = qs.sort((a, b) => a.percent - b.percent).slice(0, 10);
  out.topics = [...topics.values()].map(t => ({ topic: t.topic, percent: r1(t.got / t.max * 100), questions: t.qn, responses: t.n })).sort((a, b) => a.percent - b.percent);
  const when = f.from || f.to ? ` Submissions ${f.from ? 'from ' + new Date(f.from).toISOString().slice(0, 10) : ''}${f.to ? ' to ' + new Date(f.to).toISOString().slice(0, 10) : ''}.` : '';
  out.population = `${out.n} student result${out.n === 1 ? '' : 's'} (each student's highest graded attempt per exam) from ${exams.length} exam${exams.length === 1 ? '' : 's'}${truncated ? ` (most recent ${CAP})` : ''}.${out.attempts_pending ? ` ${out.attempts_pending} submitted attempt${out.attempts_pending === 1 ? ' is' : 's are'} still awaiting grading and ${out.attempts_pending === 1 ? 'is' : 'are'} not included in any score.` : ''}${when} Pass rate uses each exam's own pass mark.`;
  return out;
}
module.exports = { readFilters, facets, report, MIN_N };
