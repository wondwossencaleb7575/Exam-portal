'use strict';
// One place that decides pass/fail and letter grades, so results, exports and student views can never disagree.
// The school settings (s / scale) are always passed in by the caller, who has loaded them once: no hidden database read here.
const passMarkFor = (exam, s) => exam?.pass_mark != null ? Number(exam.pass_mark) : s.default_pass_mark;
const percent = (score, total) => total > 0 && score != null ? Math.round(score / total * 10000) / 100 : null; // null = not calculable (zero total or no score)
// 'pass' | 'fail' | null. null means "cannot say yet": ungraded, unfinished, or zero-mark paper. Never guessed.
function passFail(score, total, passMark, graded = true) { const p = percent(score, total); return graded && p != null ? (p >= passMark ? 'pass' : 'fail') : null; }
function letterFor(pct, scale) { if (pct == null || !scale.length) return null; for (const g of [...scale].sort((a, b) => b.min - a.min)) if (pct >= g.min) return g.label; return null; }
module.exports = { passMarkFor, percent, passFail, letterFor };
