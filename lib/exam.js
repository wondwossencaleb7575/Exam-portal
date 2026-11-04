// Shapes exam content for students. The answer key is never included here.
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffle(arr, rand) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function studentQuestions(eqs, exam, seed) {
  const rand = rng(seed);
  let list = eqs;
  if (exam.shuffle_q) { // shuffle inside each section; section order is preserved
    const groups = []; for (const q of eqs) { const g = groups[groups.length - 1]; if (g && g.s === q.section) g.q.push(q); else groups.push({ s: q.section, q: [q] }); }
    list = groups.flatMap(g => shuffle(g.q, rand));
  }
  return list.map(q => ({
    id: q.id, type: q.type, section: q.section, stem: q.stem, marks: q.marks, image_id: q.image_id,
    options: q.type === 'mcq' ? (exam.shuffle_o ? shuffle(q.options, rand) : q.options) : q.type === 'tf' ? q.options : [],
    multi: !!q.settings.multi, unit: q.settings.unit || ''
  }));
}

// When may a student see the correct answers and explanations (only ever AFTER their result was released and the teacher turned on "show answers")?
// Only when sharing them can no longer help anyone who has not finished: the exam is closed or archived (nobody can start it) and nobody still has
// an attempt running. Otherwise a finished student could pass the key to classmates who have not taken the exam yet.
// `phaseNow` is the exam's phase ('scheduled' | 'active' | 'closed' | 'archived' | ...), `anyInProgress` whether any attempt is still running.
function answersVisibility({ showAnswers, phaseNow, anyInProgress }) {
  if (!showAnswers) return { visible: false, reason: null };
  if (!['closed', 'archived'].includes(phaseNow)) return { visible: false, reason: 'exam_open' };
  if (anyInProgress) return { visible: false, reason: 'in_progress' };
  return { visible: true, reason: null };
}
module.exports = { studentQuestions, answersVisibility };
