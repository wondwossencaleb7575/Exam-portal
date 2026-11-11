'use strict';
// Question-bank CSV import engine (teachers). ONE engine for both steps:
//   plan()  = dry run for the preview: parses, validates and de-duplicates every row, writes NOTHING.
//   run()   = the commit: re-validates everything against the live database inside ONE transaction and inserts the valid rows.
// Every row is checked by the same cleanQuestion() the question editor uses, so an imported question is exactly as valid as a typed one.
const crypto = require('crypto');
const { db, tx } = require('./db');
const CSV = require('./csv');
const { cleanQuestion } = require('./validate');
const { numericReadings } = require('./grading');
const { HttpError } = require('./http');
const { audit } = require('./audit');

const LETTERS = 'abcdefgh';
const OPTION_COLS = [...LETTERS].map(l => 'option_' + l);
const COLUMNS = ['type', 'subject', 'topic', 'difficulty', 'question', ...OPTION_COLS, 'correct_answer', 'marks', 'explanation',
  'multiple_correct', 'scoring', 'accepted_answers', 'case_sensitive', 'review', 'tolerance', 'tolerance_type', 'decimals', 'unit'];
const SPEC = {
  required: ['type', 'question'], optional: COLUMNS.filter(c => c !== 'type' && c !== 'question'),
  aliases: { question_type: 'type', stem: 'question', question_text: 'question', text: 'question', chapter: 'topic', level: 'difficulty',
    answer: 'correct_answer', correct: 'correct_answer', correct_option: 'correct_answer', correct_answers: 'correct_answer', mark: 'marks', points: 'marks',
    multiple: 'multiple_correct', multi: 'multiple_correct', multiple_answers: 'multiple_correct', accepted: 'accepted_answers', tol: 'tolerance', tol_type: 'tolerance_type',
    casesensitive: 'case_sensitive', units: 'unit', decimal_places: 'decimals' },
  maxField: 6000 // the question text may be up to 5000 characters; the generic reader would stop at 500
};
// The HTTP body limit (1 MB of JSON) is the real ceiling; a 500 KB CSV (well over 1,000 typical questions) always fits inside it.
const MAX_BYTES = 500000;
const TYPE_OF = { mcq: 'mcq', multiple_choice: 'mcq', multiplechoice: 'mcq', tf: 'tf', true_false: 'tf', truefalse: 'tf', short: 'short', short_answer: 'short', shortanswer: 'short',
  numeric: 'numeric', numerical: 'numeric', number: 'numeric', written: 'written', essay: 'written', long: 'written' };
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/, BAD_CHAR = /\uFFFD/;
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const low = s => String(s || '').trim().toLowerCase();
const yn = v => { const s = low(v); return ['yes', 'y', 'true', '1'].includes(s) ? true : ['no', 'n', 'false', '0'].includes(s) ? false : s === '' ? null : undefined; };

/* ---------- template ---------- */
const SAMPLE_RE = /^sample\s*[:\-–]/i;
function templateRows(subject) {
  const row = o => COLUMNS.map(c => o[c] ?? '');
  const base = { subject, topic: 'Algebra', difficulty: 'easy', marks: 1 };
  return [
    row({ ...base, type: 'mcq', question: 'SAMPLE: What is $2+3$?', option_a: '4', option_b: '5', option_c: '6', option_d: '7', correct_answer: 'B', explanation: 'Add the two numbers.' }),
    row({ ...base, type: 'mcq', difficulty: 'medium', marks: 2, question: 'SAMPLE: Which of these numbers are prime, and why? (tick all that apply)', option_a: '2', option_b: '4', option_c: '5', option_d: '9',
      correct_answer: 'A|C', multiple_correct: 'yes', scoring: 'partial', explanation: 'A prime has exactly two factors.' }),
    row({ ...base, type: 'tf', topic: 'Geometry', question: 'SAMPLE: The angles of a triangle add up to 180 degrees.', correct_answer: 'true' }),
    row({ ...base, type: 'short', topic: 'Geometry', question: 'SAMPLE: What do we call a polygon with eight sides?', correct_answer: 'octagon', accepted_answers: 'an octagon', case_sensitive: 'no', review: 'yes' }),
    row({ ...base, type: 'numeric', difficulty: 'medium', question: 'SAMPLE: Solve for x: 2x = 7. Give your answer as a decimal.', correct_answer: '3.5', tolerance: '0.01', tolerance_type: 'absolute', marks: 2 }),
    row({ ...base, type: 'written', difficulty: 'hard', marks: 5, question: 'SAMPLE: Explain, in your own words, why the square root of 2 is irrational.',
      correct_answer: 'Marking guide (only you see it): proof by contradiction; assume p/q in lowest terms, show both are even.' })
  ];
}

/* ---------- one row ---------- */
const colOf = msg => /^Option \d/.test(msg) ? 'option_a' : /^Explanation/.test(msg) ? 'explanation' : /^Question|text is empty/.test(msg) ? 'question' : /^Marks/.test(msg) ? 'marks' : /correct|Mark the/i.test(msg) ? 'correct_answer' : '';
async function evaluate(row, ctx) {
  const d = Object.fromEntries(COLUMNS.map(c => [c, row.data[c] ?? ''])), errors = [], notes = [], e = (column, message) => errors.push({ column, message });
  const out = { line: row.line, action: 'fail', errors, notes, type: low(d.type), stem: d.question || '' };
  if (row.parseError) { e('', row.parseError + ' Fix the quotes on this line.'); return out; }
  for (const [k, v] of Object.entries(d)) {
    if (CTRL.test(v)) e(k, 'Contains an invalid control character.');
    if (BAD_CHAR.test(v)) e(k, 'Contains an unreadable character (�). Save the file as "CSV UTF-8 (Comma delimited)" in Excel and upload it again.');
  }
  const type = TYPE_OF[low(d.type).replace(/[\s\-/]+/g, '_')];
  if (!d.type) e('type', 'Question type is required (mcq, tf, short, numeric or written).'); else if (!type) e('type', `Unknown question type "${d.type}". Use mcq, tf, short, numeric or written.`);
  const stem = d.question.replace(/\r\n?/g, '\n');
  if (!stem) e('question', 'Question text is required.'); else if (stem.length > 5000) e('question', 'Question text is too long (maximum 5000 characters).');
  else if (SAMPLE_RE.test(stem)) e('question', 'This is a sample row from the template. Delete it or replace it with your own question.');
  const explanation = d.explanation.replace(/\r\n?/g, '\n'); if (explanation.length > 3000) e('explanation', 'Explanation is too long (maximum 3000 characters).');
  if (d.topic.length > 60) e('topic', 'Topic is too long (maximum 60 characters).');
  let difficulty = low(d.difficulty) || 'medium'; if (!['easy', 'medium', 'hard'].includes(difficulty)) { e('difficulty', `Invalid difficulty "${d.difficulty}". Use easy, medium or hard (or leave blank for medium).`); difficulty = 'medium'; }
  let marks = 1;
  if (d.marks !== '') { if (/^\d+([.,]\d+)?$/.test(d.marks)) marks = Math.round(Number(d.marks.replace(',', '.')) * 100) / 100; else marks = NaN; if (!(marks > 0 && marks <= 100)) { e('marks', `Invalid marks "${d.marks}". Use a number above 0 and up to 100 (or leave blank for 1).`); marks = 1; } }
  let subject = ctx.defaultSubject;
  if (d.subject) { subject = ctx.subjects.find(s => low(s.name) === low(d.subject)); if (!subject) { e('subject', `Unknown subject "${d.subject}". Available: ${ctx.subjects.map(s => s.name).join(', ') || '(none)'}. Ask an administrator to add a subject; imports never create subjects.`); subject = null; } }
  Object.assign(out, { subject: subject?.name || d.subject || '', topic: d.topic, difficulty, marks });
  if (!type) return out;
  const q = { type, stem, marks, topic: d.topic, difficulty, explanation, options: [], key: {}, settings: {} };
  const ca = d.correct_answer, num = (col, v, def) => { if (v === '') return def; if (!/^\d+([.,]\d+)?$/.test(v)) { e(col, `"${v}" is not a valid non-negative number.`); return def; } return Number(v.replace(',', '.')); };
  if (type === 'mcq') {
    const texts = OPTION_COLS.map(c => d[c] || ''), last = texts.reduce((n, t, i) => t ? i : n, -1);
    texts.slice(0, last + 1).forEach((t, i) => { if (!t) e(OPTION_COLS[i], `${OPTION_COLS[i]} is empty but a later option is filled. Fill options in order from option_a.`); else if (t.length > 500) e(OPTION_COLS[i], 'Option text is too long (maximum 500 characters).'); });
    if (last < 1) e('option_b', 'Multiple-choice questions need at least 2 options (option_a and option_b).');
    q.options = texts.slice(0, last + 1).map((text, i) => ({ id: LETTERS[i], text }));
    let ids = [];
    if (!ca) e('correct_answer', 'correct_answer is required (the letter of the correct option, e.g. B; use A|C for several).');
    else {
      const asLetters = /^[A-Ha-h]([\s,;|]+[A-Ha-h])*$/.test(ca) ? ca.split(/[\s,;|]+/) : null, toks = asLetters || ca.split(/[|;]/).map(x => x.trim()).filter(Boolean);
      for (const t of toks) {
        let id = /^[A-Ha-h]$/.test(t) ? t.toLowerCase() : null;
        if (!id) { const hit = q.options.filter(o => norm(o.text) === norm(t)); if (hit.length === 1) id = hit[0].id; else { e('correct_answer', hit.length ? `"${t}" matches more than one option; use the option letter instead.` : `"${t}" is not an option letter (A–H) and does not match any option text.`); continue; } }
        if (!q.options.some(o => o.id === id)) e('correct_answer', `Correct answer ${id.toUpperCase()} refers to option_${id}, which is empty.`); else if (!ids.includes(id)) ids.push(id);
      }
    }
    const explicit = yn(d.multiple_correct); if (explicit === undefined) e('multiple_correct', `"${d.multiple_correct}" is not yes or no.`);
    const multi = explicit ?? ids.length > 1; if (explicit === false && ids.length > 1) e('multiple_correct', 'multiple_correct is "no" but several correct answers are listed.');
    const sc = low(d.scoring) || 'all'; if (!['all', 'partial'].includes(sc)) e('scoring', 'scoring must be "all" or "partial" (or blank).'); else if (d.scoring && !multi) notes.push('scoring is ignored for single-answer questions.');
    q.key = { correct: ids }; q.settings = { multi: !!multi, scoring: sc === 'partial' ? 'partial' : 'all' };
  } else {
    if (OPTION_COLS.some(c => d[c])) notes.push(`Option columns are ignored for ${type === 'tf' ? 'true/false' : type === 'short' ? 'short-answer' : type === 'numeric' ? 'numerical' : 'written'} questions.`);
    if (type === 'tf') {
      const v = low(ca); if (!ca) e('correct_answer', 'correct_answer is required: true or false.'); else if (!['true', 'false', 't', 'f'].includes(v)) e('correct_answer', `"${ca}" is not valid for a true/false question. Use true or false.`);
      q.key = { correct: v === 'true' || v === 't' ? 'true' : v === 'false' || v === 'f' ? 'false' : null };
    } else if (type === 'short') {
      const accepted = [...ca.split('|'), ...d.accepted_answers.split('|')].map(x => x.trim()).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
      if (!accepted.length) e('correct_answer', 'Give at least one accepted answer in correct_answer (separate several with |).'); else if (accepted.length > 10) e('accepted_answers', 'At most 10 accepted answers are allowed.'); else if (accepted.some(x => x.length > 200)) e('accepted_answers', 'An accepted answer is too long (maximum 200 characters).');
      const cs = yn(d.case_sensitive), rv = yn(d.review); if (cs === undefined) e('case_sensitive', `"${d.case_sensitive}" is not yes or no.`); if (rv === undefined) e('review', `"${d.review}" is not yes or no.`);
      q.key = { accepted }; q.settings = { caseSensitive: cs === true, review: rv !== false };
    } else if (type === 'numeric') {
      const reads = ca ? numericReadings(ca) : []; let value = null;
      if (!ca) e('correct_answer', 'correct_answer is required: the correct number.'); else if (!reads.length) e('correct_answer', `"${ca}" is not a valid number.`);
      else if (reads.length > 1) e('correct_answer', `"${ca}" is ambiguous (decimal comma or thousands separator?). Write ${reads[1]} or ${reads[0]} instead.`); else value = reads[0];
      const tol = num('tolerance', d.tolerance, 0), tt = low(d.tolerance_type), rel = ['rel', 'relative', 'percent', '%'].includes(tt);
      if (tt && !rel && !['abs', 'absolute'].includes(tt)) e('tolerance_type', `Unknown tolerance type "${d.tolerance_type}". Use absolute or relative (percent).`);
      let dec = null; if (d.decimals !== '') { dec = /^\d+$/.test(d.decimals) ? Number(d.decimals) : NaN; if (!(dec >= 0 && dec <= 10)) { e('decimals', 'decimals must be a whole number from 0 to 10.'); dec = null; } }
      if (d.unit.length > 20) e('unit', 'Unit is too long (maximum 20 characters).');
      q.key = { value, tol, tolType: rel ? 'rel' : 'abs', decimals: dec }; q.settings = { unit: d.unit };
    } else {
      if (ca.length > 3000) e('correct_answer', 'The marking guide is too long (maximum 3000 characters).');
      q.key = { guide: ca }; if (!ca) notes.push('No marking guide: you will mark this question by hand.');
    }
  }
  if (errors.length) return out;
  let c; try { c = await cleanQuestion(q, { strict: true }); } catch (x) { if (x instanceof HttpError) { e(colOf(x.message), x.message); return out; } throw x; }
  if (!subject) { e('subject', 'The portal has no subjects yet. Ask an administrator to add one.'); return out; }
  Object.assign(out, { c, subject_id: subject.id, stem: c.stem });
  const fp = crypto.createHash('sha256').update(JSON.stringify([c.type, norm(c.stem), c.options.map(o => norm(o.text))])).digest('hex');
  out.fp = fp;
  if (ctx.seen.has(fp)) { out.action = 'duplicate'; notes.push(`Duplicate of line ${ctx.seen.get(fp)} in this file. Not imported.`); return out; }
  if (ctx.existing.has(fp)) { out.action = 'duplicate'; notes.push(`Already in your question bank (question #${ctx.existing.get(fp)}). Not imported.`); return out; }
  ctx.seen.set(fp, row.line); out.action = 'import'; return out;
}

/* ---------- whole file ---------- */
const fingerprintOf = (type, stem, options) => crypto.createHash('sha256').update(JSON.stringify([type, norm(stem), options.map(o => norm(o.text))])).digest('hex');
async function context(userId, rows) {
  const subjects = await db.prepare('SELECT id,name FROM subjects ORDER BY name').all();
  // Candidate duplicates already in THIS teacher's bank (never anyone else's): narrowed by normalised question text in SQL, then compared exactly in JS.
  const stems = [...new Set(rows.map(r => norm(r.data.question.replace(/\r\n?/g, '\n'))).filter(Boolean))], existing = new Map();
  for (let i = 0; i < stems.length; i += 500) {
    const part = stems.slice(i, i + 500);
    for (const x of await db.prepare("SELECT id,type,stem,options FROM questions WHERE owner_id=? AND archived=0 AND lower(regexp_replace(btrim(stem), '\\s+', ' ', 'g')) = ANY(?)").all(userId, part)) {
      let o = []; try { o = JSON.parse(x.options); } catch {}
      const fp = fingerprintOf(x.type, x.stem, o); if (!existing.has(fp)) existing.set(fp, x.id);
    }
  }
  return { subjects, defaultSubject: subjects[0] || null, seen: new Map(), existing };
}
const read = text => CSV.readTable(text, { ...SPEC, maxBytes: MAX_BYTES });
async function evaluateAll(userId, text) {
  const t = read(text), rows = t.rows.filter(r => Object.values(r.data).some(v => v !== '') || r.parseError), ctx = await context(userId, rows), out = [];
  for (const r of rows) out.push(await evaluate(r, ctx));
  return { t, out, emptyIgnored: t.rows.length - rows.length };
}
const digestOf = (text, userId) => crypto.createHash('sha256').update(JSON.stringify({ text, u: userId })).digest('hex');
const tally = (rows, emptyIgnored = 0) => ({ total: rows.length, valid: rows.filter(r => r.action === 'import').length, invalid: rows.filter(r => r.action === 'fail').length, duplicate: rows.filter(r => r.action === 'duplicate').length, empty_ignored: emptyIgnored });
const answerLabel = c => !c ? '' : c.type === 'mcq' ? c.key.correct.map(x => x.toUpperCase()).join(', ') + (c.settings.multi ? ' (several correct)' : '') : c.type === 'tf' ? (c.key.correct === 'true' ? 'True' : 'False')
  : c.type === 'short' ? c.key.accepted.join(' | ') : c.type === 'numeric' ? `${c.key.value}${c.key.tol ? ` ± ${c.key.tol}${c.key.tolType === 'rel' ? '%' : ''}` : ''}${c.settings.unit ? ' ' + c.settings.unit : ''}` : c.key.guide ? 'Marking guide provided' : 'Marked by the teacher';
const brief = r => ({ line: r.line, action: r.action, type: r.c?.type || r.type, subject: r.subject, topic: r.topic, difficulty: r.difficulty, marks: r.marks, stem: String(r.stem || '').slice(0, 300),
  options: (r.c?.options || []).map(o => ({ id: o.id, text: o.text.slice(0, 200) })), answer: answerLabel(r.c), errors: r.errors, notes: r.notes });
const reportCsv = rows => { const bad = rows.filter(r => r.action !== 'import'); return bad.length ? CSV.toCsv(['line', 'result', 'type', 'question', 'problems'], bad.map(r => [r.line, r.action === 'fail' ? 'error' : 'duplicate', r.type, String(r.stem || '').slice(0, 200), [...r.errors.map(x => (x.column ? x.column + ': ' : '') + x.message), ...(r.action === 'duplicate' ? r.notes : [])].join(' ')])) : null; };
// Header + sample rows for the downloadable template.
async function template() { const s = (await db.prepare('SELECT name FROM subjects ORDER BY name LIMIT 1').get())?.name || ''; return CSV.toCsv(COLUMNS, templateRows(s)); }

async function plan(actor, text) {
  const { t, out, emptyIgnored } = await evaluateAll(actor.id, text);
  return { digest: digestOf(text, actor.id), columns: t.columns, ignored_columns: t.ignored, summary: tally(out, emptyIgnored), rows: out.map(brief), report_csv: reportCsv(out) };
}
// Commit. ONE transaction: either every valid row is saved or none is, so a failure can never leave half a file or touch existing questions.
// A per-teacher advisory lock serialises imports, so a double click (or two tabs) cannot both pass the duplicate check: the second one waits,
// then finds the first one's questions already in the bank and imports nothing.
async function run(actor, text, digest) {
  if (!digest || digest !== digestOf(text, actor.id)) throw new HttpError(409, 'The file changed since the preview (or was never previewed). Preview it again before importing.');
  const now = Date.now();
  const { out, emptyIgnored, ids } = await tx(async () => {
    await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get('question-import:' + actor.id);
    const r = await evaluateAll(actor.id, text), ok = r.out.filter(x => x.action === 'import'), ids = new Map();
    for (let i = 0; i < ok.length; i += 100) {
      const part = ok.slice(i, i + 100), J = JSON.stringify;
      const rows = await db.prepare(`INSERT INTO questions(owner_id,subject_id,type,stem,options,key,settings,marks,topic,difficulty,explanation,image_id,created,updated) VALUES ${part.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')} RETURNING id`)
        .all(...part.flatMap(x => [actor.id, x.subject_id, x.c.type, x.c.stem, J(x.c.options), J(x.c.key), J(x.c.settings), x.c.marks, x.c.topic, x.c.difficulty, x.c.explanation, null, now, now]));
      part.forEach((x, k) => ids.set(x.line, rows[k].id)); // RETURNING keeps VALUES order for a single INSERT
    }
    const summary = { ...tally(r.out, r.emptyIgnored), imported: ok.length };
    await audit(actor, 'question.import', 'question', null, { total: summary.total, imported: summary.imported, invalid: summary.invalid, duplicate: summary.duplicate, first_ids: [...ids.values()].slice(0, 20) });
    return { out: r.out, emptyIgnored: r.emptyIgnored, ids };
  });
  const summary = { ...tally(out, emptyIgnored), imported: ids.size };
  return { summary, rows: out.filter(x => x.action !== 'import').map(brief), imported_ids: [...ids.values()].slice(0, 2000), report_csv: reportCsv(out) };
}
module.exports = { plan, run, template, COLUMNS, SPEC, MAX_BYTES };
