const katex = require('katex');
const { db } = require('./db');
const { fail } = require('./http');

const TYPES = ['mcq', 'tf', 'short', 'numeric', 'written'];
const BLOCK = /\\(href|url|html[A-Za-z]*|includegraphics|def|gdef|edef|xdef|let|newcommand|renewcommand|providecommand|input|include|write|read|catcode|csname|expandafter|immediate|openin|openout)(?![A-Za-z])/;

// Math is only ever rendered by KaTeX (never evaluated). We still validate on save so broken or unsafe notation is caught early.
function checkMath(text, label) {
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g; let m;
  while ((m = re.exec(String(text || '')))) {
    const src = m[1] ?? m[2];
    if (BLOCK.test(src)) fail(`${label}: that LaTeX command is not allowed.`);
    try { katex.renderToString(src, { throwOnError: true, displayMode: !!m[1], trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 50 }); }
    catch (e) { fail(`${label}: invalid math "${src.slice(0, 40)}" (${String(e.message).replace(/^KaTeX parse error: /, '').slice(0, 80)}).`); }
  }
}

// strict=false is used for saving unfinished drafts; strict=true for the bank and for publishing.
async function cleanQuestion(q, { strict = true, ownerId = null } = {}) {
  q = q && typeof q === 'object' ? q : {};
  const need = (c, m) => { if (strict && !c) fail(m); };
  const s = (v, max) => String(v ?? '').trim().slice(0, max);
  const type = TYPES.includes(q.type) ? q.type : fail('Unknown question type.');
  const stem = s(q.stem, 5000); need(stem, 'The question text is empty.'); if (strict) checkMath(stem, 'Question');
  const explanation = s(q.explanation, 3000); if (strict && explanation) checkMath(explanation, 'Explanation');
  let marks = Math.round(Number(q.marks) * 100) / 100;
  if (!(marks > 0 && marks <= 100)) { need(false, 'Marks must be between 0 and 100.'); marks = 1; }
  const difficulty = ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium';
  const topic = s(q.topic, 60);
  let image_id = q.image_id ? Number(q.image_id) : null;
  if (image_id && (!Number.isSafeInteger(image_id) || (ownerId && !await db.prepare('SELECT 1 FROM images WHERE id=? AND owner_id=?').get(image_id, ownerId)))) fail('Image not found.');
  const rk = q.key && typeof q.key === 'object' ? q.key : {}, rs = q.settings && typeof q.settings === 'object' ? q.settings : {};
  let options = [], key = {}, settings = {};
  if (type === 'mcq') {
    const used = new Set(), letters = 'abcdefgh';
    options = (Array.isArray(q.options) ? q.options.slice(0, 8) : []).map(o => {
      let id = o && /^[a-h]$/.test(o.id) && !used.has(o.id) ? o.id : null;
      used.add(id); return { id, text: s(o && typeof o === 'object' ? o.text : o, 500) };
    });
    options.forEach(o => { if (!o.id) { o.id = [...letters].find(l => !used.has(l)); used.add(o.id); } });
    need(options.length >= 2, 'Multiple-choice questions need at least 2 options.');
    need(options.every(o => o.text), 'Every answer option needs text.');
    if (strict) options.forEach((o, i) => checkMath(o.text, `Option ${i + 1}`));
    const ids = options.map(o => o.id), multi = !!rs.multi;
    const correct = [...new Set((Array.isArray(rk.correct) ? rk.correct : [rk.correct]).filter(x => ids.includes(x)))];
    need(correct.length >= 1, 'Mark the correct answer.');
    need(multi || correct.length <= 1, 'A single-answer question can only have one correct option.');
    key = { correct }; settings = { multi, scoring: rs.scoring === 'partial' ? 'partial' : 'all' };
  } else if (type === 'tf') {
    options = [{ id: 'true', text: 'True' }, { id: 'false', text: 'False' }];
    const c = rk.correct === true || rk.correct === 'true' ? 'true' : (rk.correct === false || rk.correct === 'false' ? 'false' : null);
    need(c, 'Choose whether the statement is True or False.'); key = { correct: c };
  } else if (type === 'short') {
    const accepted = (Array.isArray(rk.accepted) ? rk.accepted : String(rk.accepted || '').split('\n')).map(x => s(x, 200)).filter(Boolean).slice(0, 10);
    need(accepted.length, 'Add at least one accepted answer.');
    key = { accepted }; settings = { caseSensitive: !!rs.caseSensitive, review: rs.review !== false };
  } else if (type === 'numeric') {
    const value = Number(rk.value), has = rk.value !== '' && rk.value != null && Number.isFinite(value);
    need(has, 'Enter the correct numerical value.');
    const tol = Math.max(0, Number(rk.tol) || 0), dec = rk.decimals === '' || rk.decimals == null ? null : Math.min(10, Math.max(0, Math.floor(Number(rk.decimals)) || 0));
    key = { value: has ? value : null, tol, tolType: rk.tolType === 'rel' ? 'rel' : 'abs', decimals: dec };
    settings = { unit: s(rs.unit, 20) };
  } else { key = { guide: s(rk.guide, 3000) }; }
  return { type, stem, options, key, settings, marks, topic, difficulty, explanation, image_id };
}

// Checks a stored exam before it can be published.
async function examIssues(exam, eqs, classCount) {
  const out = [], now = Date.now();
  if (!exam.title.trim()) out.push('The exam needs a title.');
  if (!(exam.minutes >= 1 && exam.minutes <= 600)) out.push('Duration must be between 1 and 600 minutes.');
  if (!eqs.length) out.push('The exam has no questions.');
  if (!classCount) out.push('Assign the exam to at least one class or enroll at least one student.');
  if (exam.opens && exam.closes && exam.closes <= exam.opens) out.push('The closing time must be after the opening time.');
  if (exam.closes && exam.closes <= now) out.push('The closing time is already in the past.');
  if (!(exam.max_attempts >= 1 && exam.max_attempts <= 5)) out.push('Attempts must be between 1 and 5.');
  for (let i = 0; i < eqs.length; i++) { try { await cleanQuestion(eqs[i], { strict: true }); } catch (err) { out.push(`Question ${i + 1}: ${err.message}`); } }
  const total = Math.round(eqs.reduce((t, e) => t + e.marks, 0) * 100) / 100;
  if (exam.declared_total != null && Math.abs(exam.declared_total - total) > 0.001) out.push(`Total marks mismatch: you expected ${exam.declared_total} but the questions add up to ${total}.`);
  return out;
}
module.exports = { cleanQuestion, examIssues, checkMath, TYPES };
