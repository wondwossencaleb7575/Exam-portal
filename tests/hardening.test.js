// Regression tests for the v2.4 hardening round. Each test names the defect it guards against.
const test = require('node:test'), assert = require('node:assert/strict');
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-hard-'));
Object.assign(process.env, { ADMIN_EMAIL: 'admin@t.local', ADMIN_PASSWORD: 'Admin-Pass-12345', OTP_LOGIN_MODE: 'off' });
const { start } = require('../server');
const { db } = require('../lib/db');
const A = require('../lib/auth');
const { gradeAnswer, numericReadings, loadEqs } = require('../lib/grading');
const { saveAnswers } = require('../lib/answers');
const { answersVisibility } = require('../lib/exam');
const srv = start(0), base = `http://localhost:${srv.address().port}`;
test.after(async () => { srv.closeAllConnections(); srv.close(); await require('../lib/db').close(); });

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'eagle', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const type = r.headers.get('content-type') || '', data = type.includes('json') ? await r.json() : await r.text();
    return { status: r.status, data };
  };
  return { get: async u => await call('GET', u), post: async (u, b) => await call('POST', u, b || {}), put: async (u, b) => await call('PUT', u, b) };
}
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.data).slice(0, 500)); return r.data; };
const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await new Promise(r => setTimeout(r, 25)); } assert.fail('timed out waiting'); };

// ---------------------------------------------------------------------------------------------------------------------
// Numeric answers: a comma must never silently turn 1,000 into 1
// ---------------------------------------------------------------------------------------------------------------------
const NUM = (value, extra = {}) => ({ type: 'numeric', marks: 2, key: { value, tol: 0, tolType: 'abs', decimals: null, ...extra }, settings: {} });
test('numeric: an ambiguous comma is never silently mis-read', () => {
  assert.deepEqual(numericReadings('1,000'), [1, 1000]); // both readings are reported, not one guessed
  assert.deepEqual(numericReadings('1,234,567'), [1234567]); // only one sensible reading
  assert.deepEqual(numericReadings('1,234.5'), [1234.5]);
  assert.deepEqual(numericReadings('3,14'), [3.14]); // decimal comma, unambiguous (two digits)
  assert.deepEqual(numericReadings('abc'), []);
  // either reading would be right -> the machine does not guess: it goes to the teacher with no marks yet
  assert.deepEqual(gradeAnswer(NUM(1000), '1,000'), { marks: 0, status: 'pending' });
  assert.deepEqual(gradeAnswer(NUM(1), '1,000'), { marks: 0, status: 'pending' });
  // neither reading is right -> wrong either way, marked automatically
  assert.deepEqual(gradeAnswer(NUM(5), '1,000'), { marks: 0, status: 'auto' });
  // unambiguous inputs still mark automatically, as before
  assert.deepEqual(gradeAnswer(NUM(1234567), '1,234,567'), { marks: 2, status: 'auto' });
  assert.deepEqual(gradeAnswer(NUM(3.14), '3,14'), { marks: 2, status: 'auto' });
  assert.deepEqual(gradeAnswer(NUM(3.14), '3.14'), { marks: 2, status: 'auto' });
  assert.deepEqual(gradeAnswer(NUM(0.5), '1/2'), { marks: 2, status: 'auto' });
  assert.deepEqual(gradeAnswer(NUM(100, { tol: 5, tolType: 'rel' }), '104'), { marks: 2, status: 'auto' });
  assert.deepEqual(gradeAnswer(NUM(100, { tol: 5, tolType: 'rel' }), '106'), { marks: 0, status: 'auto' });
  assert.deepEqual(gradeAnswer(NUM(7), 'abc'), { marks: 0, status: 'pending' });
});

// ---------------------------------------------------------------------------------------------------------------------
// Autosave: the server tells the browser what it really holds (real SQLite, no web server involved)
// ---------------------------------------------------------------------------------------------------------------------
async function seedAttempt() {
  const now = Date.now(), n = (await db.prepare('SELECT COUNT(*) n FROM users').get()).n;
  const uid = (await db.prepare("INSERT INTO users(email,name,role,pw_hash,created) VALUES(?,?,'student','x',?) RETURNING id").run(`s${n}@t.local`, 'S', now)).lastInsertRowid;
  const tid = (await db.prepare("INSERT INTO users(email,name,role,pw_hash,created) VALUES(?,?,'teacher','x',?) RETURNING id").run(`t${n}@t.local`, 'T', now)).lastInsertRowid;
  const eid = (await db.prepare('INSERT INTO exams(owner_id,title,created,updated) VALUES(?,?,?,?) RETURNING id').run(tid, 'E', now, now)).lastInsertRowid;
  const ins = db.prepare("INSERT INTO exam_questions(exam_id,pos,type,stem,options,key,settings,marks) VALUES(?,?,?,?,?,?,?,1) RETURNING id");
  const q1 = (await ins.run(eid, 0, 'short', 'Name a prime.', '[]', '{"accepted":["2"]}', '{}')).lastInsertRowid, q2 = (await ins.run(eid, 1, 'tf', 'True?', '[]', '{"correct":"true"}', '{}')).lastInsertRowid;
  const aid = (await db.prepare("INSERT INTO attempts(exam_id,student_id,attempt_no,started,deadline,seed) VALUES(?,?,1,?,?,1) RETURNING id").run(eid, uid, now, now + 6e5)).lastInsertRowid;
  return { aid, q1, q2, eqs: await loadEqs(eid) };
}
const row = async (aid, q) => await db.prepare('SELECT value,seq,flagged FROM answers WHERE attempt_id=? AND eq_id=?').get(aid, q);

test('autosave: first save, newer save, exact retry', async () => {
  const { aid, q1, eqs } = await seedAttempt();
  let r = await saveAnswers(aid, eqs, [{ qid: q1, value: 'two', seq: 1 }]); assert.deepEqual(r, { saved: [{ qid: q1, seq: 1 }], stale: [], rejected: [] });
  r = await saveAnswers(aid, eqs, [{ qid: q1, value: 'two', seq: 1 }]); assert.deepEqual(r.saved, [{ qid: q1, seq: 1 }]); assert.deepEqual(r.stale, []); // lost response, same retry: still "saved"
  r = await saveAnswers(aid, eqs, [{ qid: q1, value: 'three', seq: 2 }]); assert.equal(r.saved.length, 1); assert.equal(JSON.parse((await row(aid, q1)).value), 'three');
});
test('autosave: an older seq (late retry) is reported stale with the server copy and never overwrites', async () => {
  const { aid, q1, eqs } = await seedAttempt();
  await saveAnswers(aid, eqs, [{ qid: q1, value: 'newest', seq: 5 }]);
  const r = await saveAnswers(aid, eqs, [{ qid: q1, value: 'old', seq: 3 }]);
  assert.deepEqual(r.saved, []); assert.deepEqual(r.stale, [{ qid: q1, seq: 5, value: 'newest', flagged: false }]);
  assert.equal(JSON.parse((await row(aid, q1)).value), 'newest');
});
test('autosave: two tabs writing the SAME seq with different content - the first stays, the second is told the truth', async () => {
  const { aid, q1, eqs } = await seedAttempt();
  assert.equal((await saveAnswers(aid, eqs, [{ qid: q1, value: 'from tab A', seq: 4 }])).saved.length, 1);
  const r = await saveAnswers(aid, eqs, [{ qid: q1, value: 'from tab B', seq: 4 }]);
  assert.deepEqual(r.saved, []); assert.equal(r.stale[0].value, 'from tab A'); assert.equal(r.stale[0].seq, 4);
  assert.equal(JSON.parse((await row(aid, q1)).value), 'from tab A'); // previously this silently overwrote and tab B showed "saved"
});
test('autosave: a flag-only change saves; clearing an answer saves; invalid input is rejected without touching stored data', async () => {
  const { aid, q1, q2, eqs } = await seedAttempt();
  await saveAnswers(aid, eqs, [{ qid: q1, value: 'x', seq: 1, flagged: false }]);
  assert.equal((await saveAnswers(aid, eqs, [{ qid: q1, value: 'x', seq: 2, flagged: true }])).saved.length, 1); assert.equal((await row(aid, q1)).flagged, 1);
  assert.equal((await saveAnswers(aid, eqs, [{ qid: q1, value: '', seq: 3, flagged: true }])).saved.length, 1); assert.equal((await row(aid, q1)).value, null);
  const r = await saveAnswers(aid, eqs, [{ qid: q2, value: 'maybe', seq: 1 }, { qid: 999999, value: 'true', seq: 1 }, { qid: q1, value: 'y', seq: -1 }]);
  assert.equal(r.rejected.length, 3); assert.deepEqual(r.saved, []); assert.equal(await row(aid, q2), undefined);
  assert.deepEqual(await saveAnswers(aid, eqs, 'not an array'), { saved: [], stale: [], rejected: [] });
});

// ---------------------------------------------------------------------------------------------------------------------
// Answer key: not handed out while the exam is still open for other students
// ---------------------------------------------------------------------------------------------------------------------
test('answersVisibility: only when the exam is closed/archived and nobody is still writing it', () => {
  const v = (showAnswers, phaseNow, anyInProgress) => answersVisibility({ showAnswers, phaseNow, anyInProgress });
  assert.deepEqual(v(false, 'closed', false), { visible: false, reason: null }); // teacher never enabled it
  assert.deepEqual(v(true, 'active', false), { visible: false, reason: 'exam_open' });
  assert.deepEqual(v(true, 'scheduled', false), { visible: false, reason: 'exam_open' });
  assert.deepEqual(v(true, 'draft', false), { visible: false, reason: 'exam_open' });
  assert.deepEqual(v(true, 'closed', true), { visible: false, reason: 'in_progress' });
  assert.deepEqual(v(true, 'closed', false), { visible: true, reason: null });
  assert.deepEqual(v(true, 'archived', false), { visible: true, reason: null });
});

// ---------------------------------------------------------------------------------------------------------------------
// Expired sessions are removed
// ---------------------------------------------------------------------------------------------------------------------
test('sweepSessions deletes only expired sessions', async () => {
  const uid = (await db.prepare("INSERT INTO users(email,name,role,pw_hash,created) VALUES('sw@t.local','S','student','x',?) RETURNING id").run(Date.now())).lastInsertRowid, now = Date.now();
  const ins = db.prepare('INSERT INTO sessions VALUES(?,?,?,?)');
  await ins.run('old1', uid, now - 9e6, now - 1000); await ins.run('old2', uid, now - 9e6, now - 5); await ins.run('live', uid, now, now + 3600e3);
  assert.equal(await A.sweepSessions(now), 2);
  assert.deepEqual((await db.prepare("SELECT token_hash h FROM sessions WHERE user_id=?").all(uid)).map(x => x.h), ['live']);
});

// ---------------------------------------------------------------------------------------------------------------------
// Through the real server code
// ---------------------------------------------------------------------------------------------------------------------
const S = {};
async function adminClient() { await waitFor(async () => await db.prepare("SELECT 1 FROM users WHERE email='admin@t.local'").get()); const c = client(); ok(await c.post('/api/auth/login', { email: 'admin@t.local', password: 'Admin-Pass-12345' })); return c; }
async function newStaff(admin, email, role) { const t = ok(await admin.post('/api/admin/users', { email, name: email.split('@')[0], role })), c = client(); ok(await c.post('/api/auth/login', { email, password: t.temp_password })); ok(await c.post('/api/auth/change-password', { current: t.temp_password, next: 'Teacher-Pass-1234' })); return c; }

test('login: a classroom of honest typos behind ONE address is not locked out, but one account still is', async () => {
  const admin = await adminClient(); S.admin = admin;
  for (let i = 0; i < 40; i++) assert.equal((await client().post('/api/auth/login', { email: `typo${i}@t.local`, password: 'wrong-password-1' })).status, 401, `failure #${i + 1} must not trigger an address lockout`); // used to lock at 30
  assert.equal((await client().post('/api/auth/login', { email: 'admin@t.local', password: 'Admin-Pass-12345' })).status, 200, 'a correct login still works after 40 failures from the same address');
  const t = ok(await admin.post('/api/admin/users', { email: 'victim@t.local', name: 'Victim', role: 'teacher' })), c = client();
  for (let i = 0; i < 8; i++) assert.equal((await c.post('/api/auth/login', { email: 'victim@t.local', password: 'nope-' + i })).status, 401);
  assert.equal((await c.post('/api/auth/login', { email: 'victim@t.local', password: t.temp_password })).status, 429, 'per-account lockout is unchanged');
});
test('login: the address limit is configurable and read at request time', async () => {
  process.env.LOGIN_MAX_FAILS_PER_IP = '10';
  try { assert.equal((await client().post('/api/auth/login', { email: 'admin@t.local', password: 'Admin-Pass-12345' })).status, 429, 'already more than 10 failures from this address'); }
  finally { delete process.env.LOGIN_MAX_FAILS_PER_IP; }
  assert.equal((await client().post('/api/auth/login', { email: 'admin@t.local', password: 'Admin-Pass-12345' })).status, 200);
  process.env.LOGIN_MAX_FAILS_PER_IP = 'banana'; // an invalid value falls back to the safe default instead of disabling the limit
  try { assert.equal((await client().post('/api/auth/login', { email: 'admin@t.local', password: 'Admin-Pass-12345' })).status, 200); } finally { delete process.env.LOGIN_MAX_FAILS_PER_IP; }
});

const TF = n => Array.from({ length: n }, (_, i) => ({ type: 'tf', stem: `Statement ${i + 1} is true.`, key: { correct: 'true' }, marks: 1, topic: 'Logic', explanation: 'SECRET-EXPLANATION-XYZ' }));
test('results: correct answers are withheld while the exam is open, and appear once it is closed', async () => {
  const admin = S.admin, t = await newStaff(admin, 'teach@t.local', 'teacher');
  const { id: cid } = ok(await t.post('/api/classes', { name: 'Class A', grade: '10', academic_year: '2026' }));
  const imp = ok(await t.post(`/api/classes/${cid}/import-csv/commit`, { csv: 'student_number,full_name,email\nK1,Abebe Kebede,abebe@t.local\nK2,Beki Tadesse,beki@t.local' }));
  const stu = {}; for (const c of imp.credentials) { const cl = client(); ok(await cl.post('/api/auth/login', { email: c.email, password: c.temp_password })); ok(await cl.post('/api/auth/change-password', { current: c.temp_password, next: 'Student-Pass-123' })); stu[c.email] = cl; }
  const { id } = ok(await t.post('/api/exams', { title: 'Key quiz' }));
  ok(await t.put(`/api/exams/${id}`, { title: 'Key quiz', minutes: 20, max_attempts: 1, release_mode: 'manual', show_answers: true, subject_id: 1, class_ids: [cid], questions: TF(2) }));
  ok(await t.post(`/api/exams/${id}/publish`));
  const a = stu['abebe@t.local'], st = ok(await a.post(`/api/student/exams/${id}/start`)), aid = st.attempt.id;
  ok(await a.put(`/api/student/attempts/${aid}/answers`, { items: st.questions.map((q, i) => ({ qid: q.id, value: 'true', seq: i + 1 })) })); ok(await a.post(`/api/student/attempts/${aid}/submit`, {}));
  // Beki has NOT taken the exam yet: this is exactly who must not be able to get the key from Abebe.
  ok(await t.post(`/api/exams/${id}/finalize`, {})); ok(await t.post(`/api/exams/${id}/release`, {}));
  let r = ok(await a.get(`/api/student/attempts/${aid}/result`));
  assert.equal(r.result.state, 'released'); assert.equal(r.result.score, 2); // the score itself is released as before
  assert.equal(r.answers_withheld, 'exam_open');
  assert.ok(r.items.every(i => i.key === undefined && i.explanation === undefined), 'no key or explanation while the exam is open');
  assert.ok(!JSON.stringify(r).includes('SECRET-EXPLANATION-XYZ'));
  ok(await t.post(`/api/exams/${id}/close`));
  r = ok(await a.get(`/api/student/attempts/${aid}/result`));
  assert.equal(r.answers_withheld, null); assert.ok(r.items.every(i => i.key && i.explanation === 'SECRET-EXPLANATION-XYZ'), 'key and explanation appear after the exam is closed');
  S.teacher = t; S.stu = stu; S.cid = cid;
});

test('autosave through the API: a conflicting save is reported as stale, never as saved', async () => {
  const t = S.teacher, b = S.stu['beki@t.local'];
  const { id } = ok(await t.post('/api/exams', { title: 'Conflict quiz' }));
  ok(await t.put(`/api/exams/${id}`, { title: 'Conflict quiz', minutes: 20, max_attempts: 1, release_mode: 'manual', show_answers: false, subject_id: 1, class_ids: [S.cid], questions: TF(1) }));
  ok(await t.post(`/api/exams/${id}/publish`));
  const st = ok(await b.post(`/api/student/exams/${id}/start`)), aid = st.attempt.id, q = st.questions[0].id, put = items => b.put(`/api/student/attempts/${aid}/answers`, { items });
  let r = ok(await put([{ qid: q, value: 'true', seq: 2 }])); assert.deepEqual(r.saved, [{ qid: q, seq: 2 }]); assert.deepEqual(r.stale, []);
  r = ok(await put([{ qid: q, value: 'false', seq: 2 }])); assert.deepEqual(r.saved, []); assert.equal(r.stale.length, 1); assert.equal(r.stale[0].value, 'true'); // other tab, same seq
  r = ok(await put([{ qid: q, value: 'false', seq: 1 }])); assert.equal(r.stale[0].seq, 2); // late retry
  r = ok(await put([{ qid: q, value: 'false', seq: 3 }])); assert.deepEqual(r.saved, [{ qid: q, seq: 3 }]);
  r = ok(await put([{ qid: q, value: 'false', seq: 3 }])); assert.deepEqual(r.saved, [{ qid: q, seq: 3 }]); // exact retry stays "saved"
  const sub = ok(await b.post(`/api/student/attempts/${aid}/submit`, {})); assert.ok(sub.receipt);
  assert.equal((await db.prepare('SELECT marks FROM grades WHERE attempt_id=?').get(aid)).marks, 0); // graded from what the server held ('false'), not from a stale copy
});
