'use strict';
// Races and failures that only exist because PostgreSQL (unlike the old single-writer SQLite file) serves many requests at the same moment.
const test = require('node:test'), assert = require('node:assert/strict');
const os = require('os'), path = require('path'), fs = require('fs'), cp = require('child_process');
const adminQuery = require('./helpers/admin-db');
Object.assign(process.env, { ADMIN_EMAIL: 'admin@t.local', ADMIN_PASSWORD: 'Admin-Pass-12345', OTP_LOGIN_MODE: 'off' });
const { start } = require('../server');
const { db } = require('../lib/db');
const srv = start(0), base = `http://localhost:${srv.address().port}`;
test.after(async () => { srv.closeAllConnections(); srv.close(); await require('../lib/db').close(); });

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'eagle', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || ''; return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
  };
  return { get: u => call('GET', u), post: (u, b) => call('POST', u, b || {}), put: (u, b) => call('PUT', u, b), call };
}
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.data)); return r.data; };
const S = {};
const QS = () => [
  { type: 'mcq', stem: 'What is $1+1$?', options: [{ text: '1' }, { text: '2' }, { text: '3' }], key: { correct: ['b'] }, settings: {}, marks: 2, topic: 'A' },
  { type: 'tf', stem: 'Zero is even.', key: { correct: 'true' }, marks: 1, topic: 'N' },
  { type: 'numeric', stem: 'Compute $\\pi$ to 2 d.p.', key: { value: 3.14, tol: 0.005, tolType: 'abs' }, marks: 2, topic: 'N' }
];
async function signedInStudent(email) { // admin creates the account; the student signs in and sets a real password
  const t = ok(await S.admin.post('/api/admin/users', { email, name: 'Stu ' + email.split('@')[0], role: 'student' })), c = client();
  ok(await c.post('/api/auth/login', { email, password: t.temp_password })); ok(await c.post('/api/auth/change-password', { current: t.temp_password, next: 'Student-Pass-123' })); return c;
}
const attemptCount = async (examId, email) => (await db.prepare('SELECT COUNT(*) n FROM attempts a JOIN users u ON u.id=a.student_id WHERE a.exam_id=? AND u.email=?').get(examId, email)).n;

test('setup: teacher, class, students, a published exam', async () => {
  const a = S.admin = client(); ok(await a.post('/api/auth/login', { email: 'admin@t.local', password: 'Admin-Pass-12345' }));
  const t = ok(await a.post('/api/admin/users', { email: 'teach@t.local', name: 'Tea Cher', role: 'teacher' })), tc = S.teacher = client();
  ok(await tc.post('/api/auth/login', { email: 'teach@t.local', password: t.temp_password })); ok(await tc.post('/api/auth/change-password', { current: t.temp_password, next: 'Teacher-Pass-123' }));
  const cl = ok(await tc.post('/api/classes', { name: 'Race Class', grade: '10', academic_year: '2026/27', subject_id: 1 }));
  S.stu = {}; for (const n of ['r1', 'r2', 'r3']) { S.stu[n] = await signedInStudent(`${n}@t.local`); ok(await tc.post(`/api/classes/${cl.id}/members`, { email: `${n}@t.local` })); }
  const { id } = ok(await tc.post('/api/exams', { title: 'Race exam' })); S.examId = id;
  ok(await tc.put(`/api/exams/${id}`, { title: 'Race exam', minutes: 30, max_attempts: 5, release_mode: 'manual', show_answers: false, shuffle_q: false, shuffle_o: false, subject_id: 1, class_ids: [cl.id], declared_total: 5, questions: QS() }));
  ok(await tc.post(`/api/exams/${id}/publish`));
});

test('starting: twelve simultaneous start requests (double click, two tabs, retries) create exactly one attempt', async () => {
  const rs = await Promise.all(Array.from({ length: 12 }, () => S.stu.r1.post(`/api/student/exams/${S.examId}/start`)));
  assert.ok(rs.every(r => r.status === 200), JSON.stringify(rs.map(r => r.status)));
  assert.equal(new Set(rs.map(r => r.data.attempt.id)).size, 1, 'everyone is handed the same attempt');
  assert.equal(await attemptCount(S.examId, 'r1@t.local'), 1);
  S.r1 = rs[0].data;
});

test('submitting: ten simultaneous submits grade the attempt exactly once', async () => {
  const q = S.r1.questions, mcq = q.find(x => x.type === 'mcq'), id = S.r1.attempt.id;
  ok(await S.stu.r1.put(`/api/student/attempts/${id}/answers`, { items: [{ qid: mcq.id, value: mcq.options.find(o => o.text === '2').id, seq: 1 }] }));
  const rs = await Promise.all(Array.from({ length: 10 }, () => S.stu.r1.post(`/api/student/attempts/${id}/submit`, {})));
  assert.ok(rs.every(r => r.status === 200), JSON.stringify(rs.map(r => [r.status, r.data.error])));
  assert.equal(rs.filter(r => !r.data.already).length, 1, 'exactly one request did the work; the rest were told it was already submitted: ');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM grades WHERE attempt_id=?').get(id)).n, 3, 'one grade row per question, not duplicated');
  assert.equal(new Set(rs.map(r => r.data.receipt)).size, 1, 'every caller is given the same receipt');
  assert.equal((await db.prepare('SELECT score FROM attempts WHERE id=?').get(id)).score, 2);
});

test('a save racing a submit is never silently lost: it is either graded or refused', async () => {
  const c = S.stu.r2; let both = { saved: 0, refused: 0 };
  for (let round = 0; round < 5; round++) {
    const st = ok(await c.post(`/api/student/exams/${S.examId}/start`)), id = st.attempt.id, mcq = st.questions.find(x => x.type === 'mcq'), right = mcq.options.find(o => o.text === '2').id;
    const [put, sub] = await Promise.all([c.put(`/api/student/attempts/${id}/answers`, { items: [{ qid: mcq.id, value: right, seq: 1 }] }), c.post(`/api/student/attempts/${id}/submit`, {})]);
    assert.equal(sub.status, 200, JSON.stringify(sub.data));
    const row = await db.prepare('SELECT value FROM answers WHERE attempt_id=? AND eq_id=?').get(id, mcq.id.eq_id || mcq.id), g = await db.prepare("SELECT g.marks FROM grades g JOIN exam_questions q ON q.id=g.eq_id WHERE g.attempt_id=? AND q.type='mcq'").get(id);
    if (put.status === 200) { both.saved++; assert.ok(row, 'a save that was acknowledged must be stored'); assert.equal(g.marks, 2, 'and it must have been graded'); }
    else { both.refused++; assert.equal(put.status, 409, JSON.stringify(put.data)); assert.equal(put.data.finalized, true); assert.equal(row, undefined, 'a refused save must not leave a row behind'); assert.equal(g.marks, 0); }
  }
  assert.equal(both.saved + both.refused, 5);
});

test('a database connection dropping mid-session is survived: the next request works', async () => {
  const before = ok(await S.teacher.get('/api/auth/me')); assert.ok(before.user);
  await adminQuery("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND usename='eagle_app'"); // the network "dropped" every connection
  await new Promise(r => setTimeout(r, 300));
  const after = await S.teacher.get('/api/auth/me'); assert.equal(after.status, 200, JSON.stringify(after.data)); assert.ok(after.data.user);
  assert.equal((await S.stu.r3.get('/api/student/exams')).status, 200);
});

test('malformed numbers in a query string are a clean 4xx or an empty result, never a 500', async () => {
  for (const u of ['/api/bank?subject_id=abc', '/api/bank?page=-4&size=zz', '/api/exams?subject_id=x', '/api/exams?class_id=1.5', '/api/students?class_id=abc', '/api/students?class_id=99999999999999999999', `/api/exams/${S.examId}/results?page=abc`, '/api/exams/abc', '/api/classes/1e9/members']) {
    const r = await S.teacher.get(u); assert.ok(r.status < 500, `${u} -> ${r.status} ${JSON.stringify(r.data).slice(0, 100)}`);
    assert.equal(typeof r.data === 'string' && /error|select|from|\$1/i.test(r.data), false, 'no SQL text in responses');
  }
});

test('when the database is unreachable the server stays up and answers 503 with a plain message', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = cp.spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port), DATABASE_URL: 'postgres://eagle_app:x@127.0.0.1:1/none', DATABASE_SSL: 'off', LOG_LEVEL: 'silent', DB_CONNECT_TIMEOUT_MS: '1000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let r; for (let i = 0; i < 40 && !r; i++) { try { r = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { 'X-Requested-With': 'eagle' } }); } catch { await new Promise(x => setTimeout(x, 150)); } }
    assert.ok(r, 'the server must still be listening'); assert.equal(r.status, 503); const body = await r.json(); assert.match(body.error, /unavailable|starting/i);
    assert.equal(/127\.0\.0\.1|postgres|ECONN|eagle_app/.test(JSON.stringify(body)), false, 'no connection details in the response');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 503);
  } finally { child.kill('SIGTERM'); }
});

test('a database that has not been migrated is never served: 503, and the log says exactly what to do', async () => {
  const { Client } = require('pg'), name = 'eagle_t_' + require('crypto').randomBytes(5).toString('hex'), port = 20000 + Math.floor(Math.random() * 20000);
  const a = new Client({ connectionString: process.env.TEST_ADMIN_DATABASE_URL }); await a.connect(); await a.query(`CREATE DATABASE ${name}`);
  const u = new URL(process.env.DATABASE_URL); u.pathname = '/' + name; // the application role, pointed at an EMPTY database
  const child = cp.spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: (() => { const e = { ...process.env, PORT: String(port), DATABASE_URL: u.toString(), LOG_LEVEL: 'info' }; delete e.NODE_TEST_CONTEXT; return e; })(), stdio: ['ignore', 'pipe', 'pipe'] }); // the logger is silent under the test runner; this child must log like a real server
  let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  try {
    let r; for (let i = 0; i < 40 && !r; i++) { try { r = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { 'X-Requested-With': 'eagle' } }); } catch { await new Promise(x => setTimeout(x, 150)); } }
    assert.ok(r, 'the server must still be listening'); assert.equal(r.status, 503);
    assert.equal(/eagle|schema|relation|migrat/i.test(JSON.stringify(await r.json())), false, 'the browser gets no internals');
    await new Promise(x => setTimeout(x, 300)); assert.match(out, /no \\"eagle\\" schema yet/); assert.match(out, /npm run migrate/); // the operator's log says what to do
  } finally { child.kill('SIGTERM'); await new Promise(x => setTimeout(x, 200)); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end(); }
});
