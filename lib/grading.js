const crypto = require('crypto');
const { db, tx } = require('./db');
const r2 = x => Math.round(x * 100) / 100;

function parseNum(v) {
  let s = String(v ?? '').trim().replace(/\s+/g, '');
  if (!s) return null;
  if (!s.includes('.') && (s.match(/,/g) || []).length === 1) s = s.replace(',', '.');
  let m = s.match(/^([-+]?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (m) { const d = Number(m[2]); return d ? Number(m[1]) / d : null; }
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) { const n = Number(s); return Number.isFinite(n) ? n : null; }
  return null;
}
// Every numeric reading of what the student typed. Normally exactly one. A comma is genuinely ambiguous: "1,000" is one (decimal comma,
// the European style) or one thousand (thousands separator). Guessing silently would mark a correct answer wrong, so the caller gets BOTH readings.
function numericReadings(v) {
  const s = String(v ?? '').trim().replace(/\s+/g, ''), out = [], main = parseNum(v);
  if (main != null) out.push(main);
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) { const alt = Number(s.replace(/,/g, '')); if (Number.isFinite(alt) && !out.includes(alt)) out.push(alt); }
  return out;
}
const norm = (s, cs) => { s = String(s).trim().replace(/\s+/g, ' ').replace(/[.]+$/, ''); return cs ? s : s.toLowerCase(); };

// Official marking. Runs only on the server. Returns { marks, status } where status is 'auto' or 'pending' (needs teacher).
function gradeAnswer(q, value) {
  const empty = value == null || value === '' || (Array.isArray(value) && !value.length);
  if (empty) return { marks: 0, status: 'auto' };
  switch (q.type) {
    case 'mcq': {
      const sel = new Set(Array.isArray(value) ? value : [value]), cor = new Set(q.key.correct);
      const hit = [...sel].filter(x => cor.has(x)).length, wrong = sel.size - hit;
      if (!q.settings.multi || q.settings.scoring !== 'partial') return { marks: hit === cor.size && wrong === 0 ? q.marks : 0, status: 'auto' };
      return { marks: r2(Math.max(0, (hit - wrong) / cor.size) * q.marks), status: 'auto' };
    }
    case 'tf': return { marks: value === q.key.correct ? q.marks : 0, status: 'auto' };
    case 'short': {
      const cs = q.settings.caseSensitive, v = norm(value, cs);
      if (q.key.accepted.some(a => norm(a, cs) === v)) return { marks: q.marks, status: 'auto' };
      return { marks: 0, status: q.settings.review === false ? 'auto' : 'pending' };
    }
    case 'numeric': {
      const readings = numericReadings(value); if (!readings.length) return { marks: 0, status: 'pending' }; // unreadable: a teacher decides
      const k = q.key; let exp = k.value;
      if (k.decimals != null) exp = Number(exp.toFixed(k.decimals));
      const allowed = k.tolType === 'rel' ? Math.abs(exp) * k.tol / 100 : k.tol;
      const hit = readings.map(x => Math.abs(x - exp) <= allowed + 1e-12);
      // One clear reading: marked automatically. Two readings (see numericReadings): if neither is right the answer is wrong either way;
      // if one is right the machine cannot know what the student meant, so it is left for the teacher instead of guessing.
      if (readings.length === 1) return { marks: hit[0] ? q.marks : 0, status: 'auto' };
      return hit.some(Boolean) ? { marks: 0, status: 'pending' } : { marks: 0, status: 'auto' };
    }
    default: return { marks: 0, status: 'pending' }; // written
  }
}
function validateValue(q, v) {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return null;
  const ids = q.options.map(o => o.id);
  if (q.type === 'mcq') {
    if (q.settings.multi) { if (!Array.isArray(v) || v.length > ids.length || !v.every(x => ids.includes(x))) return undefined; return [...new Set(v)]; }
    return typeof v === 'string' && ids.includes(v) ? v : undefined;
  }
  if (q.type === 'tf') return v === 'true' || v === 'false' ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const max = q.type === 'written' ? 20000 : q.type === 'short' ? 500 : 40;
  return v.length <= max ? v : undefined;
}
const parseEq = r => ({ ...r, options: JSON.parse(r.options), key: JSON.parse(r.key), settings: JSON.parse(r.settings) });
const loadEqs = async examId => (await db.prepare('SELECT * FROM exam_questions WHERE exam_id=? ORDER BY pos').all(examId)).map(parseEq);

async function recompute(attemptId) {
  const t = await db.prepare(`SELECT COALESCE(SUM(g.marks),0) s, COUNT(*) FILTER (WHERE g.status='pending') p FROM grades g WHERE g.attempt_id=?`).get(attemptId);
  const tot = (await db.prepare(`SELECT COALESCE(SUM(q.marks),0) t FROM exam_questions q JOIN attempts a ON a.exam_id=q.exam_id WHERE a.id=?`).get(attemptId)).t;
  await db.prepare('UPDATE attempts SET score=?,total=?,grading_status=? WHERE id=?').run(r2(t.s), r2(tot), t.p > 0 ? 'pending' : 'graded', attemptId);
}
// Idempotent: only the call that flips in_progress -> submitted does the work.
async function submitAttempt(attemptId, status = 'submitted') {
  return await tx(async () => {
    // FOR UPDATE: a second simultaneous submit (double click, two tabs, the deadline sweeper) waits here, then sees the attempt already finished.
    const a = await db.prepare('SELECT * FROM attempts WHERE id=? FOR UPDATE').get(attemptId);
    if (!a || a.status !== 'in_progress') return { changed: false, attempt: a };
    const receipt = crypto.randomBytes(4).toString('hex').toUpperCase(), now = Date.now();
    await db.prepare("UPDATE attempts SET status=?,submitted_at=?,receipt=? WHERE id=? AND status='in_progress'").run(status, now, receipt, a.id);
    const ans = new Map((await db.prepare('SELECT eq_id,value FROM answers WHERE attempt_id=?').all(a.id)).map(r => [r.eq_id, r.value == null ? null : JSON.parse(r.value)]));
    // Marks are computed here, on the server, from the stored answers and the answer key: never from anything the browser sent.
    const ids = [], marks = [], sts = [];
    for (const q of await loadEqs(a.exam_id)) { const g = gradeAnswer(q, ans.get(q.id)); ids.push(q.id); marks.push(g.marks); sts.push(g.status); }
    if (ids.length) await db.prepare('INSERT INTO grades(attempt_id,eq_id,marks,status) SELECT ?::bigint, u.eq, u.m, u.s FROM unnest(?::bigint[], ?::double precision[], ?::text[]) AS u(eq, m, s)').run(a.id, ids, marks, sts); // one statement, not one per question
    await recompute(a.id);
    return { changed: true, attempt: await db.prepare('SELECT * FROM attempts WHERE id=?').get(a.id) };
  });
}
// Finalise attempts whose deadline (+ grace) has passed using the last answers the server accepted.
async function sweepExpired() {
  const rows = await db.prepare(`SELECT a.id FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.status='in_progress' AND a.deadline + e.grace_s*1000 < ?`).all(Date.now());
  const { audit } = require('./audit');
  for (const r of rows) { const x = await submitAttempt(r.id, 'auto_submitted'); if (x.changed) await audit(null, 'attempt.auto_submit', 'attempt', r.id, { reason: 'deadline passed' }); }
  return rows.length;
}
module.exports = { gradeAnswer, validateValue, parseNum, numericReadings, loadEqs, parseEq, recompute, submitAttempt, sweepExpired, r2 };
