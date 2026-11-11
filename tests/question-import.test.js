// CSV question import (Question bank). Real server, real PostgreSQL, real HTTP. Run with the rest of the suite: npm test
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('vm'), fs = require('fs'), path = require('path');
Object.assign(process.env, { ADMIN_EMAIL: 'admin@t.local', ADMIN_PASSWORD: 'Admin-Pass-12345', OTP_LOGIN_MODE: 'off' });
const { start } = require('../server');
const { db } = require('../lib/db');
const CSV = require('../lib/csv');
const adminQuery = require('./helpers/admin-db');
const srv = start(0), base = `http://localhost:${srv.address().port}`;
test.after(async () => { srv.closeAllConnections(); srv.close(); await require('../lib/db').close(); });

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'eagle', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
    return { status: r.status, data, headers: r.headers };
  };
  return { get: u => call('GET', u), post: (u, b) => call('POST', u, b || {}), put: (u, b) => call('PUT', u, b), del: u => call('DELETE', u) };
}
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.data).slice(0, 500)); return r.data; };
const S = {};
const H = 'type,subject,topic,difficulty,question,option_a,option_b,option_c,option_d,option_e,option_f,option_g,option_h,correct_answer,marks,explanation,multiple_correct,scoring,accepted_answers,case_sensitive,review,tolerance,tolerance_type,decimals,unit';
const row = o => { const cols = H.split(','); return cols.map(c => { const v = String(o[c] ?? ''); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); };
const file = (...rows) => [H, ...rows.map(r => typeof r === 'string' ? r : row(r))].join('\r\n') + '\r\n';
const preview = (c, csv) => c.post('/api/questions/import/preview', { csv });
const commit = async (c, csv) => { const p = ok(await preview(c, csv)); return c.post('/api/questions/import/commit', { csv, digest: p.digest }); };
const count = async owner => (await db.prepare('SELECT COUNT(*) n FROM questions WHERE owner_id=?').get(owner)).n * 1;
const uid = async email => (await db.prepare('SELECT id FROM users WHERE email=?').get(email)).id;
const lineErr = (p, line) => p.rows.find(r => r.line === line);

test('setup: two teachers, a student', async () => {
  const a = S.admin = client(); ok(await a.post('/api/auth/login', { email: 'admin@t.local', password: 'Admin-Pass-12345' }));
  for (const [k, email] of [['A', 'ta@t.local'], ['B', 'tb@t.local']]) {
    const t = ok(await a.post('/api/admin/users', { email, name: 'Teacher ' + k, role: 'teacher' })), c = S['t' + k] = client();
    ok(await c.post('/api/auth/login', { email, password: t.temp_password })); ok(await c.post('/api/auth/change-password', { current: t.temp_password, next: 'Teacher-Pass-1234' }));
    S['id' + k] = await uid(email);
  }
  const st = ok(await a.post('/api/admin/users', { email: 'stu@t.local', name: 'Stu Dent', role: 'student', student_number: 'S-1' })), c = S.stu = client();
  ok(await c.post('/api/auth/login', { email: 'stu@t.local', password: st.temp_password })); ok(await c.post('/api/auth/change-password', { current: st.temp_password, next: 'Student-Pass-1234' }));
  S.subject = (await db.prepare('SELECT name FROM subjects ORDER BY name LIMIT 1').get()).name;
});

test('unauthenticated, student and admin callers are refused on every import route', async () => {
  const anon = client();
  for (const c of [anon, S.stu, S.admin]) {
    const want = c === anon ? 401 : 403;
    assert.equal((await c.get('/api/questions/import/template.csv')).status, want);
    assert.equal((await c.post('/api/questions/import/preview', { csv: 'type,question\nmcq,x' })).status, want);
    assert.equal((await c.post('/api/questions/import/commit', { csv: 'type,question\nmcq,x', digest: 'x' })).status, want);
  }
  assert.equal(await count(S.idA), 0);
});

test('template: downloadable, has every column and all five types, and its sample rows cannot be imported by accident', async () => {
  const r = await S.tA.get('/api/questions/import/template.csv');
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/csv/); assert.match(r.headers.get('content-disposition'), /questions-template\.csv/);
  const QI = require('../lib/questionImport'), t = CSV.readTable(r.data, { required: ['type', 'question'], optional: QI.COLUMNS.filter(c => c !== 'type' && c !== 'question') });
  assert.deepEqual(t.columns, QI.COLUMNS); assert.deepEqual(t.columns, H.split(','));
  assert.deepEqual(t.columns.slice(0, 5), ['type', 'subject', 'topic', 'difficulty', 'question']); assert.ok(t.columns.includes('option_h') && t.columns.includes('tolerance_type'));
  assert.deepEqual([...new Set(t.rows.map(x => x.data.type))].sort(), ['mcq', 'numeric', 'short', 'tf', 'written']);
  const p = ok(await preview(S.tA, r.data)); assert.equal(p.summary.valid, 0); assert.equal(p.summary.invalid, t.rows.length);
  assert.ok(p.rows.every(x => x.errors.some(e => /sample row/i.test(e.message))));
  const c = await S.tA.post('/api/questions/import/commit', { csv: r.data, digest: p.digest }); assert.equal(ok(c).summary.imported, 0); assert.equal(await count(S.idA), 0);
});

const GOOD = () => file(
  { type: 'mcq', subject: S.subject, topic: 'Algebra', difficulty: 'easy', question: 'What is $2+3$?', option_a: '4', option_b: '5', option_c: '6', option_d: '7', correct_answer: 'B', marks: 1, explanation: 'Add.' },
  { type: 'mcq', topic: 'Primes', difficulty: 'Medium', question: 'Pick the primes', option_a: '2', option_b: '4', option_c: '5', option_d: '9', option_e: '11', correct_answer: 'A|C|E', marks: '2,5', scoring: 'partial' },
  { type: 'tf', topic: 'Geometry', question: 'Triangle angles sum to 180.', correct_answer: 'TRUE', marks: 1 },
  { type: 'short', question: 'An eight-sided polygon?', correct_answer: 'octagon', accepted_answers: 'an octagon|8-gon', case_sensitive: 'no', marks: 1 },
  { type: 'numeric', question: 'Solve 2x = 7', correct_answer: '3.5', tolerance: '0.01', tolerance_type: 'absolute', decimals: 2, unit: 'm', marks: 2 },
  { type: 'written', difficulty: 'hard', question: 'Why is $\\sqrt2$ irrational?', correct_answer: 'Contradiction proof.', marks: 5 },
  { type: 'written', question: 'Discuss.', marks: 3 });

test('preview saves NOTHING; commit saves every valid question of all five types with the teacher as owner', async () => {
  const csv = GOOD(), before = await count(S.idA);
  const p = ok(await preview(S.tA, csv));
  assert.deepEqual([p.summary.total, p.summary.valid, p.summary.invalid, p.summary.duplicate], [7, 7, 0, 0]); assert.equal(await count(S.idA), before);
  assert.equal(p.rows[1].answer, 'A, C, E (several correct)'); assert.equal(p.rows[4].answer, '3.5 ± 0.01 m'); assert.equal(p.rows[6].answer, 'Marked by the teacher');
  const r = ok(await S.tA.post('/api/questions/import/commit', { csv, digest: p.digest }));
  assert.equal(r.summary.imported, 7); assert.equal(await count(S.idA), before + 7); assert.equal(await count(S.idB), 0);
  const rows = await db.prepare('SELECT * FROM questions WHERE owner_id=? ORDER BY id').all(S.idA), J = x => JSON.parse(x);
  assert.deepEqual(rows.map(x => x.type), ['mcq', 'mcq', 'tf', 'short', 'numeric', 'written', 'written']);
  assert.deepEqual(J(rows[0].key), { correct: ['b'] }); assert.equal(rows[0].subject_id, (await db.prepare('SELECT id FROM subjects WHERE name=?').get(S.subject)).id);
  assert.deepEqual(J(rows[1].key), { correct: ['a', 'c', 'e'] }); assert.equal(J(rows[1].settings).multi, true); assert.equal(J(rows[1].settings).scoring, 'partial'); assert.equal(J(rows[1].options).length, 5); assert.equal(rows[1].marks, 2.5); assert.equal(rows[1].difficulty, 'medium');
  assert.deepEqual(J(rows[2].key), { correct: 'true' });
  assert.deepEqual(J(rows[3].key).accepted, ['octagon', 'an octagon', '8-gon']); assert.equal(J(rows[3].settings).caseSensitive, false);
  assert.equal(J(rows[4].key).value, 3.5); assert.equal(J(rows[4].key).tol, 0.01); assert.equal(J(rows[4].settings).unit, 'm');
  assert.equal(J(rows[5].key).guide, 'Contradiction proof.'); assert.equal(rows[5].difficulty, 'hard'); assert.ok(rows.every(x => x.archived === 0 && x.owner_id === S.idA));
  const audit = await db.prepare("SELECT detail FROM audit WHERE action='question.import' ORDER BY id DESC LIMIT 1").get(); assert.ok(audit); assert.equal(JSON.parse(audit.detail).imported, 7);
});

test('imported questions appear in the Question bank and can be added to an exam like any other', async () => {
  const list = ok(await S.tA.get('/api/questions?size=50')); assert.equal(list.total, 7); assert.ok(list.items.some(q => q.stem === 'What is $2+3$?' && q.type === 'mcq'));
  assert.equal(ok(await S.tB.get('/api/questions?size=50')).total, 0); // teacher B sees none of A's questions
  const q = ok(await S.tA.get('/api/questions/' + list.items.find(x => x.type === 'mcq').id));
  const ex = ok(await S.tA.post('/api/exams', { title: 'From import' })), sid = (await db.prepare('SELECT id FROM subjects LIMIT 1').get()).id;
  const body = { title: 'From import', minutes: 10, max_attempts: 1, release_mode: 'manual', show_answers: true, shuffle_q: false, shuffle_o: false, subject_id: sid, class_ids: [], declared_total: 1,
    questions: [{ type: q.type, stem: q.stem, options: q.options, key: q.key, settings: q.settings, marks: q.marks, topic: q.topic, source_qid: q.id }] };
  ok(await S.tA.put('/api/exams/' + ex.id, body)); const e = ok(await S.tA.get('/api/exams/' + ex.id)); assert.equal(e.questions.length, 1); assert.equal(e.questions[0].stem, q.stem);
  ok(await S.tA.post('/api/questions/' + q.id + '/duplicate')); // existing question features still work on imported rows
});

test('manual question creation still works unchanged', async () => {
  const sid = (await db.prepare('SELECT id FROM subjects LIMIT 1').get()).id, before = await count(S.idA);
  ok(await S.tA.post('/api/questions', { type: 'tf', stem: 'Manual question', key: { correct: 'false' }, marks: 1, subject_id: sid }));
  assert.equal(await count(S.idA), before + 1);
});

test('every validation problem names the CSV line and the column', async () => {
  const csv = file(
    { type: 'mcq', question: 'Fine?', option_a: 'x', option_b: 'y', correct_answer: 'A' },                       // line 2: valid
    { type: 'mcq', question: '', option_a: 'x', option_b: 'y', correct_answer: 'A' },                            // 3: no question text
    { type: 'essay2', question: 'Bad type', correct_answer: 'x' },                                              // 4: unknown type
    { type: 'mcq', question: 'Only one option', option_a: 'x', correct_answer: 'A' },                            // 5
    { type: 'mcq', question: 'Gap', option_a: 'x', option_b: 'y', option_d: 'z', correct_answer: 'A' },          // 6: gap in options
    { type: 'mcq', question: 'Wrong letter', option_a: 'x', option_b: 'y', correct_answer: 'D' },               // 7
    { type: 'mcq', question: 'No answer', option_a: 'x', option_b: 'y' },                                        // 8
    { type: 'mcq', question: 'Text answer', option_a: 'Paris', option_b: 'Rome', correct_answer: 'rome' },       // 9: valid (matches text)
    { type: 'mcq', question: 'Text miss', option_a: 'Paris', option_b: 'Rome', correct_answer: 'Berlin' },      // 10
    { type: 'mcq', question: 'Multi no', option_a: 'x', option_b: 'y', correct_answer: 'A|B', multiple_correct: 'no' }, // 11
    { type: 'tf', question: 'TF bad', correct_answer: 'maybe' },                                                // 12
    { type: 'tf', question: 'TF none' },                                                                         // 13
    { type: 'numeric', question: 'Num bad', correct_answer: 'abc' },                                            // 14
    { type: 'numeric', question: 'Num ambiguous', correct_answer: '1,000' },                                    // 15
    { type: 'numeric', question: 'Num tol', correct_answer: '5', tolerance: '-1' },                              // 16
    { type: 'numeric', question: 'Num tol type', correct_answer: '5', tolerance_type: 'wobbly' },                // 17
    { type: 'short', question: 'Short none' },                                                                   // 18
    { type: 'short', question: 'Short flag', correct_answer: 'a', case_sensitive: 'perhaps' },                   // 19
    { type: 'tf', question: 'Marks bad', correct_answer: 'true', marks: 'abc' },                                 // 20
    { type: 'tf', question: 'Marks zero', correct_answer: 'true', marks: '0' },                                  // 21
    { type: 'tf', question: 'Marks big', correct_answer: 'true', marks: '101' },                                 // 22
    { type: 'tf', question: 'Diff bad', correct_answer: 'true', difficulty: 'impossible' },                      // 23
    { type: 'tf', question: 'Subject bad', correct_answer: 'true', subject: 'Underwater Basket Weaving' },       // 24
    { type: 'tf', question: 'Math bad $\\frac{1}{$', correct_answer: 'true' },                                  // 25: invalid KaTeX
    { type: 'tf', question: 'Control\u0001char', correct_answer: 'true' },                                       // 26
    { type: 'tf', question: 'Bad \uFFFD char', correct_answer: 'true' },                                         // 27
    { type: 'tf', question: 'x'.repeat(5001), correct_answer: 'true' },                                          // 28
    { type: 'numeric', question: 'Unit long', correct_answer: '1', unit: 'u'.repeat(21) });                      // 29
  const p = ok(await preview(S.tA, csv)); assert.equal(p.summary.valid, 2);
  const want = { 3: 'question', 4: 'type', 5: 'option_b', 6: 'option_c', 7: 'correct_answer', 8: 'correct_answer', 10: 'correct_answer', 11: 'multiple_correct', 12: 'correct_answer', 13: 'correct_answer', 14: 'correct_answer', 15: 'correct_answer',
    16: 'tolerance', 17: 'tolerance_type', 18: 'correct_answer', 19: 'case_sensitive', 20: 'marks', 21: 'marks', 22: 'marks', 23: 'difficulty', 24: 'subject', 26: '', 27: '', 28: 'question', 29: 'unit' };
  for (const [line, col] of Object.entries(want)) { const r = lineErr(p, +line); assert.equal(r.action, 'fail', 'line ' + line); assert.ok(r.errors.length && r.errors[0].message, 'line ' + line); if (col) assert.ok(r.errors.some(e => e.column === col), `line ${line} should flag ${col}: ${JSON.stringify(r.errors)}`); }
  assert.equal(lineErr(p, 25).action, 'fail'); assert.match(lineErr(p, 25).errors[0].message, /math/i);
  assert.match(lineErr(p, 15).errors[0].message, /ambiguous/); assert.match(lineErr(p, 6).errors[0].message, /option_c is empty/);
  assert.equal(lineErr(p, 2).action, 'import'); assert.equal(lineErr(p, 9).action, 'import'); assert.equal(lineErr(p, 9).answer, 'B');
  assert.ok(p.report_csv.includes('line,result')); const before = await count(S.idA);
  const c = ok(await S.tA.post('/api/questions/import/commit', { csv, digest: p.digest }));  // valid rows still import; invalid ones are reported, never dropped silently
  assert.equal(c.summary.imported, 2); assert.equal(c.rows.length, 26); assert.equal(await count(S.idA), before + 2);
});

test('a minimal file (only the columns it needs) works: absent optional columns are simply blank', async () => {
  const csv = 'type,question,option_a,option_b,correct_answer\nmcq,Minimal file question?,yes,no,A\ntf,Minimal tf,true\n'; // second row is short: missing cells are blank
  const p = ok(await preview(S.tA, csv)); assert.equal(p.summary.valid, 1); assert.equal(p.summary.invalid, 1); assert.equal(p.rows[0].subject, S.subject); assert.equal(p.rows[0].marks, 1); assert.equal(p.rows[0].difficulty, 'medium');
  assert.ok(p.rows[1].errors.some(e => e.column === 'correct_answer'));
  assert.equal(ok(await commit(S.tA, 'type,question\nwritten,Minimal written question\n')).summary.imported, 1);
});

test('hostile / malformed files give a clear error and change nothing', async () => {
  const before = await count(S.idA), bad = async (csv, re) => { const r = await preview(S.tA, csv); assert.equal(r.status, 400, JSON.stringify(r.data)); assert.match(r.data.error, re); };
  await bad('', /empty/i); await bad('type,subject\nmcq,Math', /question/i); await bad('a,b\n1,2', /type/i);
  assert.equal((await S.tA.post('/api/questions/import/preview', {})).status, 400); assert.equal((await S.tA.post('/api/questions/import/preview', { csv: 123 })).status, 400);
  await bad('type,question\n' + 'tf,' + 'y'.repeat(7000) + ',true', /longer|too long|characters/i);
  const q = ok(await preview(S.tA, 'type,question,correct_answer\ntf,Good row,true\n"mcq,"broken quote,x\n')); assert.equal(q.summary.valid, 1); assert.equal(q.rows[1].action, 'fail'); assert.equal(q.rows[1].errors.length, 1); assert.match(q.rows[1].errors[0].message, /quote/i); // a broken line is reported, the good line survives
  assert.equal(await count(S.idA), before);
  // SQL-looking text is stored as text, never executed
  const evil = file({ type: 'tf', question: "Robert'); DROP TABLE questions;-- ", correct_answer: 'true' }); ok(await commit(S.tA, evil));
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM questions WHERE stem LIKE 'Robert%'").get()).n * 1, 1);
});

test('Excel quirks: BOM, CRLF, commas, quotes, multi-line text, Unicode, semicolon delimiter, long questions, blank rows', async () => {
  const long = 'Long problem. ' + 'word '.repeat(700), stem1 = 'Find x, y: if "2x + y = 5", then\nline two,\r\nline three — é ² ≤ ° አማርኛ';
  const csv = '\uFEFF' + file({ type: 'tf', question: stem1, correct_answer: 'true' }, ',,,,,,,,,,,,,,,,,,,,', { type: 'short', question: long, correct_answer: 'ok' }, { type: 'short', question: 'trailing blank row follows', correct_answer: 'a', accepted_answers: 'b, c' }) + '\r\n\r\n';
  const p = ok(await preview(S.tA, csv)); assert.equal(p.summary.valid, 3); assert.equal(p.summary.empty_ignored, 1);
  ok(await S.tA.post('/api/questions/import/commit', { csv, digest: p.digest }));
  const got = (await db.prepare("SELECT stem,type,key FROM questions WHERE owner_id=? AND stem LIKE 'Find x%'").get(S.idA));
  assert.equal(got.stem, stem1.replace(/\r\n/g, '\n')); assert.equal((await db.prepare("SELECT stem FROM questions WHERE stem LIKE 'Long problem%'").get()).stem.length, long.trim().length);
  assert.deepEqual(JSON.parse((await db.prepare("SELECT key FROM questions WHERE stem LIKE 'trailing%'").get()).key).accepted, ['a', 'b, c']);
  const semi = 'type;question;option_a;option_b;correct_answer;marks\r\nmcq;Pick one, please;yes;no;A;1,5\r\n'; const q = ok(await preview(S.tA, semi)); assert.equal(q.summary.valid, 1); assert.equal(q.rows[0].marks, 1.5);
  // the shared reader keeps its 500-character cell limit for the student importers
  assert.throws(() => CSV.readTable('a,b\n' + 'x'.repeat(501) + ',1', { required: ['a'] }), /longer|too long|characters/i);
});

test('duplicates: inside the file and against the bank are skipped and explained; a different answer set is not a duplicate', async () => {
  const q = { type: 'mcq', question: 'Capital of France?', option_a: 'Paris', option_b: 'Rome', correct_answer: 'A' };
  const csv = file(q, { ...q, question: '  capital of  FRANCE?  ' }, { ...q, option_b: 'Berlin' });
  const p = ok(await preview(S.tA, csv)); assert.deepEqual(p.rows.map(r => r.action), ['import', 'duplicate', 'import']); assert.match(p.rows[1].notes[0], /line 2/);
  const r = ok(await S.tA.post('/api/questions/import/commit', { csv, digest: p.digest })); assert.equal(r.summary.imported, 2); assert.equal(r.summary.duplicate, 1);
  const again = ok(await commit(S.tA, csv)); assert.equal(again.summary.imported, 0); assert.equal(again.summary.duplicate, 3); assert.match(again.rows[0].notes[0], /already in your question bank/i);
  const other = ok(await commit(S.tB, csv)); assert.equal(other.summary.imported, 2); // B's bank is separate, so A's questions never block B
});

test('double click / two tabs: simultaneous commits import the file once', async () => {
  const csv = file(...Array.from({ length: 30 }, (_, i) => ({ type: 'tf', question: 'Concurrent question number ' + i, correct_answer: 'true' }))), before = await count(S.idA);
  const p = ok(await preview(S.tA, csv)), res = await Promise.all([1, 2, 3, 4].map(() => S.tA.post('/api/questions/import/commit', { csv, digest: p.digest })));
  const imported = res.map(r => ok(r).summary.imported).sort((a, b) => a - b); assert.deepEqual(imported, [0, 0, 0, 30]); assert.equal(await count(S.idA), before + 30);
});

test('commit needs the digest of a preview of the SAME file by the SAME teacher', async () => {
  const csv = file({ type: 'tf', question: 'Digest test', correct_answer: 'true' }), p = ok(await preview(S.tA, csv)), before = await count(S.idA);
  for (const body of [{ csv }, { csv, digest: 'nope' }, { csv: csv + '\r\n', digest: p.digest }]) assert.equal((await S.tA.post('/api/questions/import/commit', body)).status, 409);
  assert.equal((await S.tB.post('/api/questions/import/commit', { csv, digest: p.digest })).status, 409); // a stolen digest is useless to another teacher
  assert.equal(await count(S.idA), before); assert.equal(await count(S.idB), 2);
  // an owner/subject smuggled into the request is ignored: rows always belong to the authenticated teacher
  const r = await S.tB.post('/api/questions/import/commit', { csv, digest: ok(await preview(S.tB, csv)).digest, owner_id: S.idA }); ok(r);
  assert.equal(await count(S.idA), before); assert.equal(await count(S.idB), 3);
});

test('size limits: 1,000 rows import, 1,001 and >500 KB are refused', async () => {
  const mk = n => file(...Array.from({ length: n }, (_, i) => ({ type: 'tf', question: `Bulk question ${i} of ${n}`, correct_answer: i % 2 ? 'true' : 'false' })));
  const before = await count(S.idB), t0 = Date.now(), r = ok(await commit(S.tB, mk(1000))); assert.equal(r.summary.imported, 1000); assert.equal(await count(S.idB), before + 1000);
  console.log('    1,000-row preview+commit took', Date.now() - t0, 'ms');
  const big = await preview(S.tB, mk(1001)); assert.equal(big.status, 400); assert.match(big.data.error, /too many|rows/i);
  const huge = await preview(S.tB, mk(10) + 'tf,' + 'z '.repeat(260000) + ',true'); assert.equal(huge.status, 400); assert.match(huge.data.error, /too large|longer/i);
});

test('a failure part-way through rolls EVERYTHING back (no half imports, existing questions untouched)', async () => {
  const cat = (await adminQuery("SELECT 1 FROM information_schema.tables WHERE table_schema='eagle' AND table_name='questions'")).rowCount; assert.equal(cat, 1);
  await adminQuery("CREATE OR REPLACE FUNCTION eagle.qi_boom() RETURNS trigger AS $$ BEGIN IF NEW.stem = 'BOOM' THEN RAISE EXCEPTION 'simulated failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql");
  await adminQuery('CREATE TRIGGER qi_boom BEFORE INSERT ON eagle.questions FOR EACH ROW EXECUTE FUNCTION eagle.qi_boom()');
  const before = await count(S.idA), snap = JSON.stringify(await db.prepare('SELECT * FROM questions WHERE owner_id=? ORDER BY id').all(S.idA));
  const csv = file(...[...Array.from({ length: 150 }, (_, i) => ({ type: 'tf', question: 'Rollback ' + i, correct_answer: 'true' })), { type: 'tf', question: 'BOOM', correct_answer: 'true' }]);
  const r = await commit(S.tA, csv); assert.ok(r.status >= 400, 'the failing import must be reported as an error');
  assert.equal(await count(S.idA), before); assert.equal(JSON.stringify(await db.prepare('SELECT * FROM questions WHERE owner_id=? ORDER BY id').all(S.idA)), snap);
  await adminQuery('DROP TRIGGER qi_boom ON eagle.questions'); // and the very same file imports fine once the fault is gone
  assert.equal(ok(await commit(S.tA, csv)).summary.imported, 151);
});

test('the browser file reader (public/questionImport.js) decodes UTF-8 and Excel Windows-1252 files, and rejects .xlsx and oversize files', async () => {
  const ctx = { TextDecoder, Uint8Array, Promise, Error, Math, FileReader: class { readAsArrayBuffer(f) { setTimeout(() => { this.result = f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength); this.onload(); }); } } };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/questionImport.js'), 'utf8') + '\n;globalThis.qiReadFile = qiReadFile;', ctx);
  const F = bytes => ({ size: bytes.length, bytes: Buffer.from(bytes) });
  const utf = await ctx.qiReadFile(F(Buffer.from('type,question\ntf,Angle 90° × 2 ≤ é አ'))); assert.equal(utf.note, ''); assert.ok(utf.text.includes('90° × 2 ≤ é አ'));
  const ansi = await ctx.qiReadFile(F(Buffer.from([...Buffer.from('type,question\ntf,Angle 90'), 0xB0, ...Buffer.from(' x '), 0xD7, ...Buffer.from(' caf'), 0xE9]))); assert.match(ansi.note, /Windows-1252/); assert.ok(ansi.text.endsWith('Angle 90° x × café'));
  await assert.rejects(ctx.qiReadFile(F([0x50, 0x4B, 3, 4, 0, 0])), /xlsx/i); await assert.rejects(ctx.qiReadFile({ size: 600000 }), /too large/i); await assert.rejects(ctx.qiReadFile({ size: 0 }), /empty/i);
});
