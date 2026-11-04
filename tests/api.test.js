const test = require('node:test'), assert = require('node:assert/strict');
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-'));
Object.assign(process.env, { ADMIN_EMAIL: 'admin@t.local', ADMIN_PASSWORD: 'Admin-Pass-12345', OTP_LOGIN_MODE: 'off' }); // these suites test exams, grading and enrollment; tests/otp.test.js covers email verification
const { start } = require('../server');
const { db } = require('../lib/db');
const { gradeAnswer, parseNum } = require('../lib/grading');
const adminQuery = require('./helpers/admin-db');
let base; const srv = start(0); base = `http://localhost:${srv.address().port}`;
test.after(async () => { srv.closeAllConnections(); srv.close(); await require('../lib/db').close(); });

function client() {
  let cookie = '';
  const call = async (method, url, body, hdr = {}) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'eagle', ...(cookie ? { cookie } : {}), ...hdr }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || ''; const data = ct.includes('json') ? await r.json() : await r.text();
    return { status: r.status, data, headers: r.headers };
  };
  return { get: async u => await call('GET', u), post: async (u, b) => await call('POST', u, b || {}), put: async (u, b) => await call('PUT', u, b), patch: async (u, b) => await call('PATCH', u, b), del: async u => await call('DELETE', u), raw: call };
}
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.data)); return r.data; };
const S = {}; // shared state across ordered tests

test('anonymous users and CSRF', async () => {
  const c = client();
  assert.equal((await c.get('/api/exams')).status, 401);
  assert.equal((await c.get('/api/student/exams')).status, 401);
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403); // missing custom header
  assert.equal((await c.post('/api/auth/login', { email: 'x@y.zz', password: 'nope' })).status, 401);
});

test('accounts: admin creates teacher, temp password must be changed', async () => {
  const a = S.admin = client(); ok(await a.post('/api/auth/login', { email: 'admin@t.local', password: 'Admin-Pass-12345' }));
  const t = ok(await a.post('/api/admin/users', { email: 'teach@t.local', name: 'Tea Cher', role: 'teacher' }));
  const c = S.teacher = client(); ok(await c.post('/api/auth/login', { email: 'teach@t.local', password: t.temp_password }));
  const blocked = await c.get('/api/exams'); assert.equal(blocked.status, 403); assert.equal(blocked.data.code, 'must_change');
  assert.equal((await c.post('/api/auth/change-password', { current: t.temp_password, next: 'short' })).status, 400);
  ok(await c.post('/api/auth/change-password', { current: t.temp_password, next: 'Teacher-Pass-1234' }));
  ok(await c.get('/api/exams'));
  assert.equal((await (await db.prepare("SELECT pw_hash FROM users WHERE email='teach@t.local'").get()).pw_hash).startsWith('scrypt$'), true);
});

test('login throttling', async () => {
  const c = client();
  for (let i = 0; i < 8; i++) await c.post('/api/auth/login', { email: 'victim@t.local', password: 'wrong' + i });
  assert.equal((await c.post('/api/auth/login', { email: 'victim@t.local', password: 'wrong' })).status, 429);
});

test('classes and controlled student import; suspension', async () => {
  const t = S.teacher, cl = ok(await t.post('/api/classes', { name: 'Grade 10A', grade: '10', academic_year: '2026/27', subject_id: 1 }));
  S.classId = cl.id;
  const imp = ok(await t.post(`/api/classes/${cl.id}/import`, { text: 'Ann A, ann@t.local, S1\nBob B, bob@t.local\nbadline' }));
  assert.deepEqual(imp.results.map(x => x.status), ['created', 'created', 'error']);
  S.ann = client(); S.bob = client();
  for (const [k, e] of [['ann', 'ann@t.local'], ['bob', 'bob@t.local']]) {
    const tp = imp.results.find(x => x.email === e).temp_password;
    ok(await S[k].post('/api/auth/login', { email: e, password: tp })); ok(await S[k].post('/api/auth/change-password', { current: tp, next: 'Student-Pass-123' }));
  }
  const outsider = ok(await S.admin.post('/api/admin/users', { email: 'out@t.local', name: 'Out Sider', role: 'student' }));
  S.out = client(); ok(await S.out.post('/api/auth/login', { email: 'out@t.local', password: outsider.temp_password })); ok(await S.out.post('/api/auth/change-password', { current: outsider.temp_password, next: 'Student-Pass-123' }));
  // role separation
  assert.equal((await S.ann.get('/api/exams')).status, 403);
  assert.equal((await S.ann.get('/api/admin/users')).status, 403);
  assert.equal((await S.teacher.get('/api/admin/audit')).status, 403);
  // suspension kills the session
  const uid = (await db.prepare("SELECT id FROM users WHERE email='out@t.local'").get()).id;
  ok(await S.admin.patch(`/api/admin/users/${uid}`, { status: 'suspended' })); assert.equal((await S.out.get('/api/student/exams')).status, 401);
});

const QS = () => [
  { type: 'mcq', stem: 'What is $1+1$?', options: [{ text: '1' }, { text: '2' }, { text: '3' }], key: { correct: ['b'] }, settings: {}, marks: 2, topic: 'Arithmetic' },
  { type: 'tf', stem: 'Zero is even.', key: { correct: 'true' }, marks: 1, topic: 'Numbers' },
  { type: 'numeric', stem: 'Compute $\\pi$ to 2 d.p.', key: { value: 3.14, tol: 0.005, tolType: 'abs' }, marks: 2, topic: 'Numbers' },
  { type: 'short', stem: 'Longest side of a right triangle?', key: { accepted: ['hypotenuse'] }, settings: { review: true }, marks: 1, topic: 'Geometry' },
  { type: 'written', stem: 'Prove $a+b$ is even for even $a,b$.', key: { guide: 'secret marking notes' }, marks: 4, topic: 'Proof' }
];
test('exam builder: validation, publish, immutability', async () => {
  const t = S.teacher, { id } = ok(await t.post('/api/exams', { title: 'Quiz 1' })); S.examId = id;
  const meta = { title: 'Quiz 1', minutes: 20, max_attempts: 1, release_mode: 'manual', show_answers: true, shuffle_q: true, shuffle_o: true, subject_id: 1, class_ids: [], declared_total: 99, questions: QS() };
  ok(await t.put(`/api/exams/${id}`, meta));
  let pub = await t.post(`/api/exams/${id}/publish`); assert.equal(pub.status, 400);
  assert.ok(pub.data.issues.some(i => /class/i.test(i))); assert.ok(pub.data.issues.some(i => /Total marks mismatch/.test(i)));
  const bad = await t.put(`/api/exams/${id}`, { ...meta, class_ids: [S.classId], declared_total: 10, questions: [{ ...QS()[0], stem: 'Bad $\\frac{1$' }] });
  ok(bad); pub = await t.post(`/api/exams/${id}/publish`); assert.ok(pub.data.issues.some(i => /invalid math/i.test(i)));
  const xss = await t.put('/api/questions/0', {}); assert.equal(xss.status, 404);
  assert.equal((await t.post('/api/questions', { ...QS()[0], stem: '$\\href{javascript:alert(1)}{x}$' })).status, 400);
  ok(await t.put(`/api/exams/${id}`, { ...meta, class_ids: [S.classId], declared_total: 10 }));
  ok(await t.post(`/api/exams/${id}/publish`));
  assert.equal((await t.put(`/api/exams/${id}`, { ...meta, class_ids: [S.classId] })).status, 409); // locked after publish
  const bank = ok(await t.get('/api/questions')); assert.equal(bank.total, 5); // questions joined the bank on publish
  S.examQs = ok(await t.get(`/api/exams/${id}`)).questions;
});

test('bank edits never rewrite a published exam (snapshots)', async () => {
  const t = S.teacher, q = (await t.get('/api/questions')).data.items.find(x => x.type === 'tf');
  ok(await t.put(`/api/questions/${q.id}`, { ...q, stem: 'CHANGED in bank', key: { correct: 'false' } }));
  const eq = (await t.get(`/api/exams/${S.examId}`)).data.questions.find(x => x.type === 'tf');
  assert.equal(eq.stem, 'Zero is even.'); assert.deepEqual(eq.key, { correct: 'true' });
});

test('student: sees only assigned exams; key never reaches browser', async () => {
  assert.equal((await S.ann.get('/api/student/exams')).data.items.length, 1);
  assert.equal((await S.out.get('/api/student/exams')).status, 401);
  const o2 = client(); const tp = ok(await S.admin.post('/api/admin/users', { email: 'o2@t.local', name: 'O Two', role: 'student' }));
  ok(await o2.post('/api/auth/login', { email: 'o2@t.local', password: tp.temp_password })); ok(await o2.post('/api/auth/change-password', { current: tp.temp_password, next: 'Student-Pass-123' }));
  assert.equal((await o2.get(`/api/student/exams/${S.examId}`)).status, 404); assert.equal((await o2.post(`/api/student/exams/${S.examId}/start`)).status, 404);
  const info = ok(await S.ann.get(`/api/student/exams/${S.examId}`)); assert.equal(JSON.stringify(info).includes('hypotenuse'), false);
  const st = ok(await S.ann.post(`/api/student/exams/${S.examId}/start`)); S.annAttempt = st.attempt.id;
  const s = JSON.stringify(st); for (const leak of ['hypotenuse', 'secret marking notes', '"key"', '"correct"', 'explanation']) assert.equal(s.includes(leak), false, 'leaked ' + leak);
  assert.equal(st.questions.length, 5); S.payload = st;
  const again = ok(await S.ann.post(`/api/student/exams/${S.examId}/start`)); assert.equal(again.attempt.id, S.annAttempt); assert.equal(again.attempt.deadline, st.attempt.deadline); // refresh does not reset timer
  assert.equal((await S.bob.get(`/api/student/attempts/${S.annAttempt}`)).status, 404); // other student's attempt
  assert.equal((await S.bob.put(`/api/student/attempts/${S.annAttempt}/answers`, { items: [] })).status, 404);
});

test('autosave: idempotent, ordered by seq, validated; submit is idempotent and graded on server', async () => {
  const a = S.ann, id = S.annAttempt, byType = Object.fromEntries(S.payload.questions.map(q => [q.type, q]));
  const mcq = byType.mcq, correctOpt = mcq.options.find(o => o.text === '2').id;
  let r = ok(await a.put(`/api/student/attempts/${id}/answers`, { items: [{ qid: mcq.id, value: correctOpt, seq: 5 }, { qid: byType.tf.id, value: 'true', seq: 1 }, { qid: byType.numeric.id, value: '3,14', seq: 1 }, { qid: byType.short.id, value: 'Hypotenuse.', seq: 1 }, { qid: byType.written.id, value: 'Let a=2m, b=2n...', seq: 1, flagged: true }] }));
  assert.equal(r.saved.length, 5);
  ok(await a.put(`/api/student/attempts/${id}/answers`, { items: [{ qid: mcq.id, value: correctOpt, seq: 5 }] })); // retry: same result
  ok(await a.put(`/api/student/attempts/${id}/answers`, { items: [{ qid: mcq.id, value: 'zzz', seq: 6 }] })).rejected.length === 1 || assert.fail('invalid option accepted');
  ok(await a.put(`/api/student/attempts/${id}/answers`, { items: [{ qid: mcq.id, value: mcq.options.find(o => o.text === '1').id, seq: 2 }] })); // stale seq ignored
  const resumed = ok(await a.get(`/api/student/attempts/${id}`)); assert.equal(resumed.answers[mcq.id].value, correctOpt); assert.equal(resumed.answers[byType.written.id].flagged, true);
  const [s1, s2] = await Promise.all([a.post(`/api/student/attempts/${id}/submit`, {}), a.post(`/api/student/attempts/${id}/submit`, {})]);
  assert.equal(s1.status, 200); assert.equal(s2.status, 200); assert.equal(s1.data.receipt, s2.data.receipt);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM grades WHERE attempt_id=?').get(id)).n, 5); // no duplicate grading rows
  assert.equal((await a.put(`/api/student/attempts/${id}/answers`, { items: [] })).status, 409);
  const res = ok(await a.get(`/api/student/attempts/${id}/result`)); assert.equal(res.result.state, 'awaiting'); assert.equal(res.items, undefined); // not released
  assert.equal((await a.post(`/api/student/exams/${S.examId}/start`)).status, 409); // attempt limit
  const row = await db.prepare('SELECT score,grading_status FROM attempts WHERE id=?').get(id); assert.equal(row.grading_status, 'pending'); assert.equal(row.score, 6); // 2+1+2+1 auto-graded; written pending
});

test('teacher grading: pending written, override needs reason, finalize gate, release, student result', async () => {
  const t = S.teacher, id = S.annAttempt, view = ok(await t.get(`/api/attempts/${id}`));
  const w = view.items.find(i => i.q.type === 'written'); assert.equal(w.grade.status, 'pending');
  assert.equal(view.items.find(i => i.q.type === 'short').grade.status, 'auto'); // exact match accepted automatically
  let f = ok(await t.post(`/api/exams/${S.examId}/finalize`, {})); assert.equal(f.finalized, 0); assert.equal(f.blocked.length, 1); // cannot finalize with ungraded work
  assert.equal((await t.put(`/api/attempts/${id}/grade`, { eq_id: w.q.id, marks: 99 })).status, 400);
  ok(await t.put(`/api/attempts/${id}/grade`, { eq_id: w.q.id, marks: 3, feedback: 'Good, missing one step' }));
  const mc = view.items.find(i => i.q.type === 'mcq');
  assert.equal((await t.put(`/api/attempts/${id}/grade`, { eq_id: mc.q.id, marks: 1 })).status, 400); // override without reason
  ok(await t.put(`/api/attempts/${id}/grade`, { eq_id: mc.q.id, marks: 1, reason: 'Partial credit agreed' }));
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM grade_history WHERE attempt_id=?').get(id)).n, 2);
  await assert.rejects(() => db.prepare('UPDATE grade_history SET new_marks=9').run(), /permission denied/); // the application role has no UPDATE privilege on it
  await assert.rejects(() => adminQuery('UPDATE grade_history SET new_marks=9'), /append-only/);          // and even a privileged role is stopped by the trigger
  f = ok(await t.post(`/api/exams/${S.examId}/finalize`, {})); assert.equal(f.finalized, 1);
  let res = ok(await S.ann.get(`/api/student/attempts/${id}/result`)); assert.equal(res.result.state, 'awaiting'); // finalized but not yet released
  ok(await t.post(`/api/exams/${S.examId}/release`, {}));
  res = ok(await S.ann.get(`/api/student/attempts/${id}/result`));
  assert.equal(res.result.state, 'released'); assert.equal(res.result.score, 1 + 1 + 2 + 1 + 3); assert.equal(res.result.total, 10);
  // v2.4 policy change: show_answers is enabled, but the exam is still open for other students, so the key is withheld until it closes (see tests/hardening.test.js for the after-close half).
  assert.equal(res.answers_withheld, 'exam_open'); assert.equal(res.items[0].key, undefined);
  assert.equal((await S.bob.get(`/api/student/attempts/${id}/result`)).status, 404);
});

test('server-enforced deadline, auto-submit, extension with audit', async () => {
  const st = ok(await S.bob.post(`/api/student/exams/${S.examId}/start`)), id = st.attempt.id, q = st.questions.find(x => x.type === 'tf');
  ok(await S.bob.put(`/api/student/attempts/${id}/answers`, { items: [{ qid: q.id, value: 'true', seq: 1 }] }));
  await db.prepare('UPDATE attempts SET deadline=? WHERE id=?').run(Date.now() - 60000, id); // client clock is irrelevant; server says time is up
  const late = await S.bob.put(`/api/student/attempts/${id}/answers`, { items: [{ qid: q.id, value: 'false', seq: 2 }] });
  assert.equal(late.status, 409); assert.equal(late.data.finalized, true);
  const row = await db.prepare('SELECT status,score FROM attempts WHERE id=?').get(id); assert.equal(row.status, 'auto_submitted'); assert.equal(row.score, 1); // only the accepted answer counted
  assert.equal((await S.bob.post(`/api/student/attempts/${id}/submit`, { items: [{ qid: q.id, value: 'false', seq: 3 }] })).data.already, true);
  assert.equal((await S.teacher.post(`/api/attempts/${id}/extend`, { minutes: 10 })).status, 400); // reason required
  const ext = ok(await S.teacher.post(`/api/attempts/${id}/extend`, { minutes: 10, reason: 'Network outage during exam' }));
  assert.ok(ext.deadline > Date.now()); assert.equal((await db.prepare('SELECT status FROM attempts WHERE id=?').get(id)).status, 'in_progress');
  ok(await S.bob.get(`/api/student/attempts/${id}`)); ok(await S.bob.post(`/api/student/attempts/${id}/submit`, {}));
  assert.equal((await db.prepare('SELECT status FROM attempts WHERE id=?').get(id)).status, 'submitted');
});

test('analytics, CSV export (formula-safe), audit trail, backups', async () => {
  const t = S.teacher, an = ok(await t.get(`/api/exams/${S.examId}/analytics`)); assert.equal(an.n, 2); assert.equal(an.excluded_pending, 0); assert.equal(an.mean_percent, 45); assert.equal(an.highest, 80);
  await db.prepare("UPDATE users SET name='=HYPERLINK(\"x\")' WHERE email='ann@t.local'").run();
  const csv = (await t.get(`/api/exams/${S.examId}/export.csv`)).data; assert.ok(csv.includes("'=HYPERLINK")); assert.ok(csv.includes('Percent'));
  const res = ok(await t.get(`/api/exams/${S.examId}/results?q=bob`)); assert.equal(res.rows.length, 1);
  const au = ok(await S.admin.get('/api/admin/audit?size=200')).items.map(x => x.action);
  for (const a of ['exam.publish', 'grade.set', 'results.finalize', 'results.release', 'attempt.extend', 'attempt.auto_submit' , 'user.create', 'results.export']) assert.ok(au.includes(a), 'missing audit ' + a);
  await assert.rejects(() => db.prepare('DELETE FROM audit').run(), /permission denied/);
  await assert.rejects(() => adminQuery('DELETE FROM audit'), /append-only/);
  assert.equal(JSON.stringify(au).includes('pw_hash'), false);
  const b = ok(await S.admin.post('/api/admin/backup')); assert.equal(b.verify.ok, true); assert.ok(b.verify.attempts >= 2);
  assert.equal(ok(await S.admin.get('/api/admin/health')).ok, true);
});

test('grading rules', () => {
  const num = (k, v) => gradeAnswer({ type: 'numeric', marks: 2, key: { tolType: 'abs', tol: 0, decimals: null, ...k }, settings: {} }, v).marks;
  assert.equal(num({ value: 0.5 }, '1/2'), 2); assert.equal(num({ value: 0.5 }, '0,5'), 2); assert.equal(num({ value: 0.5 }, '0.51'), 0);
  assert.equal(num({ value: 100, tol: 1, tolType: 'rel' }, '100.9'), 2); assert.equal(num({ value: 100, tol: 1, tolType: 'rel' }, '102'), 0);
  assert.equal(num({ value: 3.14159, decimals: 2 }, '3.14'), 2); assert.equal(num({ value: 3.14159, decimals: 2 }, '3.1416'), 0);
  assert.equal(gradeAnswer({ type: 'numeric', marks: 1, key: { value: 1, tol: 0, tolType: 'abs' }, settings: {} }, 'abc').status, 'pending');
  const mq = s => ({ type: 'mcq', marks: 4, key: { correct: ['a', 'b'] }, settings: { multi: true, scoring: s } });
  assert.equal(gradeAnswer(mq('all'), ['a']).marks, 0); assert.equal(gradeAnswer(mq('partial'), ['a']).marks, 2); assert.equal(gradeAnswer(mq('partial'), ['a', 'c']).marks, 0); assert.equal(gradeAnswer(mq('all'), ['b', 'a']).marks, 4);
  assert.equal(gradeAnswer({ type: 'mcq', marks: 1, key: { correct: ['a'] }, settings: {} }, null).marks, 0);
  assert.equal(parseNum('1e3'), 1000); assert.equal(parseNum('1/0'), null); assert.equal(parseNum('abc'), null);
});
