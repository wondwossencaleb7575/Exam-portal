'use strict';
// Saving a student's answers. Kept apart from the route so the rules can be tested against a real database without a web server.
//
// Every change a student makes carries a per-question sequence number (`seq`) that only goes up. The server decides, per item:
//   saved    - the server now holds exactly this value and seq (a first save, a newer change, or an exact retry of one it already holds)
//   stale    - the server holds something NEWER or DIFFERENT for that question (another tab or window saved it first, or an old retry
//              arrived late). The server's current copy is returned so the browser can show the truth instead of claiming "saved".
//   rejected - not a valid answer for that question (unknown question, impossible option, too long)
// A client may only say "saved" for items in `saved`.
const { db, tx } = require('./db');
const { validateValue } = require('./grading');

const MAX_ITEMS = 200;

// Runs in one short transaction that holds a SHARE lock on the attempt row. submitAttempt() takes the same row FOR UPDATE, so a save and a
// submit can never interleave: either the save commits first (and is graded) or the attempt is already closed and the save is refused.
async function saveAnswers(attemptId, eqs, items, now = Date.now()) {
  return await tx(async () => {
    const att = await db.prepare('SELECT status FROM attempts WHERE id=? FOR SHARE').get(attemptId);
    if (!att || att.status !== 'in_progress') return { closed: true, saved: [], stale: [], rejected: [] };
    return await saveLocked(attemptId, eqs, items, now);
  });
}
async function saveLocked(attemptId, eqs, items, now) {
  const byId = eqs instanceof Map ? eqs : new Map(eqs.map(q => [q.id, q]));
  const get = db.prepare('SELECT value,seq,flagged FROM answers WHERE attempt_id=? AND eq_id=?');
  const up = db.prepare(`INSERT INTO answers(attempt_id,eq_id,value,seq,flagged,updated) VALUES(?,?,?,?,?,?)
    ON CONFLICT(attempt_id,eq_id) DO UPDATE SET value=excluded.value,seq=excluded.seq,flagged=excluded.flagged,updated=excluded.updated WHERE excluded.seq>answers.seq`);
  const saved = [], stale = [], rejected = [];
  for (const it of (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS)) {
    const q = byId.get(Number(it?.qid)), seq = Math.floor(Number(it?.seq));
    if (!q || !(seq >= 0)) { rejected.push({ qid: it?.qid, reason: 'unknown question' }); continue; }
    const v = validateValue(q, it.value); if (v === undefined) { rejected.push({ qid: q.id, reason: 'invalid answer' }); continue; }
    const enc = v === null ? null : JSON.stringify(v), flagged = it.flagged ? 1 : 0, cur = await get.get(attemptId, q.id);
    if (cur && (seq < cur.seq || (seq === cur.seq && (cur.value !== enc || cur.flagged !== flagged)))) {
      stale.push({ qid: q.id, seq: cur.seq, value: cur.value == null ? null : JSON.parse(cur.value), flagged: !!cur.flagged });
      continue;
    }
    if (!cur || seq > cur.seq) {
      // The upsert only takes effect if our seq is still the newest. Two tabs can race between the read above and this write, so the
      // affected-row count (not the earlier read) decides whether we may say "saved"; otherwise report the server's real copy as stale.
      const w = await up.run(attemptId, q.id, enc, seq, flagged, now);
      if (!w.changes) { const now2 = await get.get(attemptId, q.id); stale.push({ qid: q.id, seq: now2?.seq ?? 0, value: now2?.value == null ? null : JSON.parse(now2.value), flagged: !!now2?.flagged }); continue; }
    } // an exact retry (same seq, same content) needs no write
    saved.push({ qid: q.id, seq });
  }
  return { saved, stale, rejected };
}
module.exports = { saveAnswers, MAX_ITEMS };
