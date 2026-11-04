const test = require('node:test'), assert = require('node:assert/strict');
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-plat-'));
Object.assign(process.env, { ADMIN_EMAIL: 'admin@t.local', ADMIN_PASSWORD: 'Admin-Pass-12345', OTP_LOGIN_MODE: 'off' }); // these suites test exams, grading and enrollment; tests/otp.test.js covers email verification
const { start } = require('../server');
const { db } = require('../lib/db');
const adminQuery = require('./helpers/admin-db');
const P = require('../lib/policy');
const CSV = require('../lib/csv');
const srv = start(0), base = `http://localhost:${srv.address().port}`;
test.after(async () => { srv.closeAllConnections(); srv.close(); await require('../lib/db').close(); });

function client() {
  let cookie = '';
  const call = async (method, url, body, extra = {}) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'eagle', ...(cookie ? { cookie } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const type = r.headers.get('content-type') || '', data = type.includes('json') ? await r.json() : await r.text();
    return { status: r.status, data, headers: r.headers, setCookie: sc };
  };
  return { get: async u => await call('GET', u), post: async (u, b, h) => await call('POST', u, b || {}, h), put: async (u, b) => await call('PUT', u, b), patch: async (u, b) => await call('PATCH', u, b), del: async u => await call('DELETE', u) };
}
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.data).slice(0, 500)); return r.data; };
const S = {}, count = async (sql, ...p) => (await db.prepare(sql).get(...p)).n, uid = async e => (await db.prepare('SELECT id FROM users WHERE email=?').get(e))?.id;
async function staff(admin, email, name, role) { const t = ok(await admin.post('/api/admin/users', { email, name, role })), c = client(); ok(await c.post('/api/auth/login', { email, password: t.temp_password })); ok(await c.post('/api/auth/change-password', { current: t.temp_password, next: 'Teacher-Pass-1234' })); return c; }
async function studentsInto(teacher, classId, list) { // [{email,name,number}] -> {email: client}
  const csv = 'student_number,full_name,email\n' + list.map(s => `${s.number},${s.name},${s.email}`).join('\n'), r = ok(await teacher.post(`/api/classes/${classId}/import-csv/commit`, { csv })), out = {};
  for (const c of r.credentials) { const cl = client(); ok(await cl.post('/api/auth/login', { email: c.email, password: c.temp_password })); ok(await cl.post('/api/auth/change-password', { current: c.temp_password, next: 'Student-Pass-123' })); out[c.email] = cl; } return out;
}
const TF = n => Array.from({ length: n }, (_, i) => ({ type: 'tf', stem: `Statement ${i + 1} is true.`, key: { correct: 'true' }, marks: 1, topic: i < 2 ? 'Logic' : 'Algebra', explanation: 'SECRET-EXPLANATION-XYZ' }));
const WRITTEN = { type: 'written', stem: 'Explain.', key: { guide: 'SECRET-GUIDE-ABC' }, marks: 5, topic: 'Essays' };
async function mkExam(t, title, class_ids, questions, extra = {}) {
  const { id } = ok(await t.post('/api/exams', { title }));
  ok(await t.put(`/api/exams/${id}`, { title, minutes: 20, max_attempts: 1, release_mode: 'manual', show_answers: false, subject_id: 1, class_ids, questions, ...extra })); return id;
}
const publish = async (t, id) => ok(await t.post(`/api/exams/${id}/publish`));
async function take(student, examId, correct) { // start, answer the first `correct` questions rightly, submit; returns attempt id
  const st = ok(await student.post(`/api/student/exams/${examId}/start`)), aid = st.attempt.id, qs = st.questions;
  if (correct) ok(await student.put(`/api/student/attempts/${aid}/answers`, { items: qs.slice(0, correct).map((q, i) => ({ qid: q.id, value: 'true', seq: i + 1 })) }));
  ok(await student.post(`/api/student/attempts/${aid}/submit`, {})); return aid;
}

test('setup: two teachers, a class of six students, and the exams used below', async () => {
  for (let i = 0; i < 100 && !await uid('admin@t.local'); i++) await new Promise(r => setTimeout(r, 50));
  const a = S.admin = client(); ok(await a.post('/api/auth/login', { email: 'admin@t.local', password: 'Admin-Pass-12345' }));
  S.tA = await staff(a, 'ta@t.local', 'Teacher A', 'teacher'); S.tB = await staff(a, 'tb@t.local', 'Teacher B', 'teacher');
  S.cls = ok(await S.tA.post('/api/classes', { name: 'Grade 9A', grade: '9', academic_year: '2026/27', subject_id: 1 })).id; S.clsB = ok(await S.tB.post('/api/classes', { name: 'Other', grade: '9' })).id;
  S.st = await studentsInto(S.tA, S.cls, [1, 2, 3, 4, 5, 6].map(i => ({ email: `s${i}@t.local`, name: `Student ${i}`, number: `N${i}` })));
  assert.equal(Object.keys(S.st).length, 6);
});

test('school settings: anyone signed in can read, only administrators change, every field is validated and audited', async () => {
  const d = ok(await S.tA.get('/api/settings')); assert.deepEqual([d.timezone, d.locale, d.calendar, d.default_pass_mark], ['Africa/Addis_Ababa', 'en', 'gregory', 50]);
  assert.equal((await S.tA.put('/api/admin/settings', { school_name: 'Hack' })).status, 403); assert.equal((await S.st['s1@t.local'].put('/api/admin/settings', {})).status, 403); assert.equal((await client().put('/api/admin/settings', {})).status, 401);
  const bad = async b => { const r = await S.admin.put('/api/admin/settings', b); assert.equal(r.status, 400, JSON.stringify(b)); return r.data.error; };
  assert.match(await bad({ timezone: 'Mars/Olympus' }), /time zone/); assert.match(await bad({ default_pass_mark: 120 }), /0 and 100/); assert.match(await bad({ calendar: 'julian' }), /Calendar/); assert.match(await bad({ locale: 'fr' }), /Language/);
  assert.match(await bad({ brand_color: 'red' }), /colour/); assert.match(await bad({ terms: [] }), /1 to 8/); assert.match(await bad({ terms: ['A', 'a'] }), /different/); assert.match(await bad({ school_name: '' }), /School name/);
  assert.match(await bad({ grading_scale: [{ min: 50, label: 'P' }] }), /start at 0/); assert.match(await bad({ grading_scale: [{ min: 0, label: 'F' }, { min: 0, label: 'G' }] }), /same minimum/); assert.match(await bad({ grading_scale: [{ min: 0, label: '' }] }), /label/);
  const saved = ok(await S.admin.put('/api/admin/settings', { school_name: 'Eagle Secondary School', terms: ['Semester 1', 'Semester 2'], calendar: 'ethiopic', locale: 'am', default_pass_mark: 50 }));
  assert.deepEqual([saved.school_name, saved.calendar, saved.locale], ['Eagle Secondary School', 'ethiopic', 'am']);
  const me = ok(await S.tA.get('/api/auth/me')); assert.equal(me.settings.school_name, 'Eagle Secondary School'); assert.equal(me.user.email, 'ta@t.local'); assert.ok(ok(await client().get('/api/auth/me')).settings); // branding is available before sign-in
  const au = await db.prepare("SELECT detail FROM audit WHERE action='settings.update' ORDER BY id DESC").get(); const j = JSON.parse(au.detail); assert.equal(j.before.calendar, 'gregory'); assert.equal(j.after.calendar, 'ethiopic');
  ok(await S.admin.put('/api/admin/settings', { calendar: 'gregory', locale: 'en' }));
});

test('policy: pass/fail, percent and letter grades are consistent and never guess', () => {
  assert.equal(P.percent(7, 10), 70); assert.equal(P.percent(0, 0), null); assert.equal(P.percent(null, 10), null); assert.equal(P.percent(1, 3), 33.33);
  assert.equal(P.passFail(5, 10, 50), 'pass'); assert.equal(P.passFail(4.99, 10, 50), 'fail'); assert.equal(P.passFail(0, 0, 50), null); assert.equal(P.passFail(9, 10, 50, false), null); // zero-mark and ungraded papers have no result
  const scale = [{ min: 0, label: 'F' }, { min: 90, label: 'A' }, { min: 50, label: 'D' }]; assert.equal(P.letterFor(100, scale), 'A'); assert.equal(P.letterFor(89.99, scale), 'D'); assert.equal(P.letterFor(0, scale), 'F'); assert.equal(P.letterFor(null, scale), null); assert.equal(P.letterFor(80, []), null);
  assert.equal(P.passMarkFor({ pass_mark: 65 }, { default_pass_mark: 50 }), 65); assert.equal(P.passMarkFor({ pass_mark: null }, { default_pass_mark: 50 }), 50); assert.equal(P.passMarkFor({ pass_mark: 0 }, { default_pass_mark: 50 }), 0);
});

test('student identity: numbers are unique (database-enforced), edits are validated and audited, only administrators edit', async () => {
  const a = S.admin, id = await uid('s1@t.local');
  let r = await a.post('/api/admin/users', { email: 'dup@t.local', name: 'Dup', role: 'student', student_number: 'n1' }); assert.equal(r.status, 409); assert.match(r.data.error, /student number already belongs/); // case-insensitive
  assert.equal(await count("SELECT COUNT(*) n FROM users WHERE email='dup@t.local'"), 0);
  r = await a.patch(`/api/admin/users/${await uid('s2@t.local')}`, { student_number: 'N1' }); assert.equal(r.status, 409);
  await assert.rejects(async () => await db.prepare("UPDATE users SET student_number='N3' WHERE email='s1@t.local'").run(), /users_student_number_key/); // even a direct SQL write is refused (unique index)
  r = await a.patch(`/api/admin/users/${id}`, { name: 'Student One Renamed', email: 'S1.New@T.local', student_number: 'X-100' }); ok(r);
  const row = await db.prepare('SELECT name,email,student_number FROM users WHERE id=?').get(id); assert.deepEqual([row.name, row.email, row.student_number], ['Student One Renamed', 's1.new@t.local', 'X-100']);
  const au = JSON.parse((await db.prepare("SELECT detail FROM audit WHERE action='user.update' AND resource_id=? ORDER BY id DESC").get(id)).detail).changes; assert.deepEqual(au.name, ['Student 1', 'Student One Renamed']); assert.deepEqual(au.student_number, ['N1', 'X-100']); assert.deepEqual(au.email, ['s1@t.local', 's1.new@t.local']);
  assert.equal((await a.patch(`/api/admin/users/${id}`, { email: 'ta@t.local' })).status, 409); assert.equal((await a.patch(`/api/admin/users/${id}`, { email: 'not-an-email' })).status, 400);
  assert.equal((await a.patch(`/api/admin/users/${id}`, { student_number: 'bad;drop' })).status, 400); assert.equal((await a.patch(`/api/admin/users/${await uid('ta@t.local')}`, { student_number: 'T1' })).status, 400); // teachers have no student number
  assert.equal((await S.tA.patch(`/api/admin/users/${id}`, { name: 'x' })).status, 403); assert.equal((await S.st['s2@t.local'].patch(`/api/admin/users/${id}`, { name: 'x' })).status, 403);
  ok(await a.patch(`/api/admin/users/${id}`, { email: 's1@t.local', student_number: 'N1', name: 'Student 1' })); // restore for later tests
  ok(await a.patch(`/api/admin/users/${id}`, { student_number: '' })); assert.equal((await db.prepare('SELECT student_number FROM users WHERE id=?').get(id)).student_number, null); ok(await a.patch(`/api/admin/users/${id}`, { student_number: 'N1' }));
});

test('exam metadata: pass mark, year, term, grade, grace; validated; copied on duplicate', async () => {
  const t = S.tA, id = await mkExam(t, 'Meta quiz', [S.cls], TF(2), { pass_mark: 65, academic_year: '2026/27', term: 'Semester 2', grade: '9', grace_s: 30 });
  const e = ok(await t.get(`/api/exams/${id}`)).exam; assert.deepEqual([e.pass_mark, e.academic_year, e.term, e.grade, e.grace_s], [65, '2026/27', 'Semester 2', '9', 30]);
  const put = b => t.put(`/api/exams/${id}`, { title: 'Meta quiz', minutes: 20, max_attempts: 1, release_mode: 'manual', subject_id: 1, class_ids: [S.cls], questions: TF(2), ...b });
  assert.equal((await put({ term: 'Imaginary term' })).status, 400); assert.equal((await put({ pass_mark: 101 })).status, 400); assert.equal((await put({ pass_mark: -1 })).status, 400); assert.equal((await put({ grace_s: 301 })).status, 400);
  ok(await put({ pass_mark: '' })); assert.equal(ok(await t.get(`/api/exams/${id}`)).exam.pass_mark, null); // blank = school default
  ok(await put({ pass_mark: 65, term: 'Semester 2', grace_s: 30, academic_year: '2026/27', grade: '9' }));
  const dup = ok(await t.post(`/api/exams/${id}/duplicate`)); const c = ok(await t.get(`/api/exams/${dup.id}`)).exam; assert.deepEqual([c.pass_mark, c.term, c.grade, c.grace_s], [65, 'Semester 2', '9', 30]);
  assert.equal((await S.tB.put(`/api/exams/${id}`, { title: 'x' })).status, 404);
});

test('exam integrity: server timer, grace period, resume, out-of-order saves, idempotent submit', async () => {
  const t = S.tA, s = S.st['s3@t.local'], id = await mkExam(t, 'Timer quiz', [S.cls], [WRITTEN, ...TF(1)], { grade: '10' }); await publish(t, id);
  const st = ok(await s.post(`/api/student/exams/${id}/start`)), aid = st.attempt.id, [w] = st.questions; assert.ok(st.attempt.serverNow > 0 && st.attempt.deadline > st.attempt.serverNow);
  assert.equal(ok(await s.post(`/api/student/exams/${id}/start`)).attempt.id, aid); assert.equal(await count('SELECT COUNT(*) n FROM attempts WHERE exam_id=?', id), 1); // reopening resumes, never restarts the clock
  // out-of-order and duplicate saves: the highest sequence number wins, stale retries are ignored
  ok(await s.put(`/api/student/attempts/${aid}/answers`, { items: [{ qid: w.id, value: 'version five', seq: 5 }] })); ok(await s.put(`/api/student/attempts/${aid}/answers`, { items: [{ qid: w.id, value: 'stale three', seq: 3 }] })); ok(await s.put(`/api/student/attempts/${aid}/answers`, { items: [{ qid: w.id, value: 'version five', seq: 5 }] }));
  const back = ok(await s.get(`/api/student/attempts/${aid}`)); assert.equal(JSON.stringify(back).includes('version five'), true); assert.equal(JSON.stringify(back).includes('stale three'), false); assert.equal(back.attempt.deadline, st.attempt.deadline); // recovery returns saved work, same deadline
  assert.equal(await count('SELECT COUNT(*) n FROM answers WHERE attempt_id=?', aid), 1);
  // a client cannot extend its own time or save for an unknown question
  const r = ok(await s.put(`/api/student/attempts/${aid}/answers`, { deadline: Date.now() + 9e9, items: [{ qid: 999999, value: 'x', seq: 1 }] })); assert.equal(r.rejected.length, 1); assert.equal((await db.prepare('SELECT deadline FROM attempts WHERE id=?').get(aid)).deadline, st.attempt.deadline);
  // within the 15 s grace window a late save is still accepted; beyond it the attempt is closed by the server with the saved answers kept
  await db.prepare('UPDATE attempts SET deadline=? WHERE id=?').run(Date.now() - 5000, aid); ok(await s.put(`/api/student/attempts/${aid}/answers`, { items: [{ qid: w.id, value: 'last second', seq: 6 }] }));
  await db.prepare('UPDATE attempts SET deadline=? WHERE id=?').run(Date.now() - 20000, aid);
  const late = await s.put(`/api/student/attempts/${aid}/answers`, { items: [{ qid: w.id, value: 'too late', seq: 7 }] }); assert.equal(late.status, 409); assert.equal(late.data.finalized, true);
  const row = await db.prepare('SELECT status,submitted_at,receipt FROM attempts WHERE id=?').get(aid); assert.equal(row.status, 'auto_submitted'); assert.ok(row.receipt);
  assert.equal(JSON.parse((await db.prepare('SELECT value FROM answers WHERE attempt_id=? AND eq_id=?').get(aid, w.id)).value), 'last second'); // nothing lost, nothing added after the deadline
  const again = ok(await s.post(`/api/student/attempts/${aid}/submit`, {})); assert.equal(again.already, true); assert.equal(again.receipt, row.receipt); // submit after auto-submit is a safe no-op
  assert.equal((await s.post(`/api/student/exams/${id}/start`)).status, 409); // attempt limit reached: no second attempt
});

test('exam integrity: simultaneous duplicate submits and an autosave storm leave one consistent record', async () => {
  const t = S.tA, s = S.st['s4@t.local'], id = await mkExam(t, 'Storm quiz', [S.cls], [WRITTEN, ...TF(2)], { grade: '10' }); await publish(t, id);
  const st = ok(await s.post(`/api/student/exams/${id}/start`)), aid = st.attempt.id, w = st.questions[0];
  const seqs = Array.from({ length: 30 }, (_, i) => i + 1).sort(() => Math.random() - .5); // delivered in random order
  const storm = await Promise.all(seqs.map(q => s.put(`/api/student/attempts/${aid}/answers`, { items: [{ qid: w.id, value: `v${q}`, seq: q }] }))); assert.ok(storm.every(r => r.status === 200));
  assert.equal(JSON.parse((await db.prepare('SELECT value FROM answers WHERE attempt_id=? AND eq_id=?').get(aid, w.id)).value), 'v30'); assert.equal(await count('SELECT COUNT(*) n FROM answers WHERE attempt_id=?', aid), 1);
  const subs = await Promise.all(Array.from({ length: 12 }, () => s.post(`/api/student/attempts/${aid}/submit`, {}))); assert.ok(subs.every(r => r.status === 200)); assert.equal(new Set(subs.map(r => r.data.receipt)).size, 1);
  assert.equal(subs.filter(r => !r.data.already).length >= 1, true); assert.equal(await count('SELECT COUNT(*) n FROM grades WHERE attempt_id=?', aid), 3); // one grade row per question, never duplicated
  assert.equal(await count("SELECT COUNT(*) n FROM audit WHERE action='attempt.auto_submit' AND resource_id=?", aid), 0);
});

test('many students submitting at the same moment: every attempt is graded exactly once', async () => {
  const t = S.tA, n = 18, list = Array.from({ length: n }, (_, i) => ({ email: `c${i}@t.local`, name: `Crowd ${i}`, number: `C${i}` })), cc = ok(await t.post('/api/classes', { name: 'Crowd', grade: '10' })).id, crowd = await studentsInto(t, cc, list), id = await mkExam(t, 'Crowd quiz', [cc], TF(4), { grade: '10' }); await publish(t, id);
  const t0 = Date.now(); const aids = await Promise.all(Object.values(crowd).map(async (c, i) => await take(c, id, i % 5))); const ms = Date.now() - t0;
  assert.equal(new Set(aids).size, n); assert.equal(await count("SELECT COUNT(*) n FROM attempts WHERE exam_id=? AND status='submitted'", id), n); assert.equal(await count('SELECT COUNT(*) n FROM grades g JOIN attempts a ON a.id=g.attempt_id WHERE a.exam_id=?', id), n * 4);
  assert.equal(await count("SELECT COUNT(*) n FROM attempts WHERE exam_id=? AND grading_status='graded'", id), n); assert.equal(await count('SELECT COUNT(DISTINCT receipt) n FROM attempts WHERE exam_id=?', id), n);
  const rows = await db.prepare('SELECT u.email,a.score FROM attempts a JOIN users u ON u.id=a.student_id WHERE a.exam_id=?').all(id); for (const r of rows) assert.equal(r.score, Number(r.email.match(/c(\d+)@/)[1]) % 5, r.email); // every score is the right one
  assert.ok(ms < 20000, `took ${ms} ms`);
});

test('answer keys never reach students: not in the exam page, the attempt, the result, or other students\' attempts', async () => {
  const t = S.tA, id = await mkExam(t, 'Key quiz', [S.cls], [WRITTEN, ...TF(1)], { grade: '10', show_answers: false }); await publish(t, id);
  const s = S.st['s5@t.local'], other = S.st['s6@t.local'], info = ok(await s.get(`/api/student/exams/${id}`)), st = ok(await s.post(`/api/student/exams/${id}/start`)), aid = st.attempt.id;
  const scan = (label, o) => { const j = JSON.stringify(o); assert.equal(/SECRET-(EXPLANATION|GUIDE)/.test(j), false, label); assert.equal(/"key"\s*:|"correct"\s*:|"guide"\s*:/.test(j), false, label + ' has a key field'); };
  scan('exam info', info); scan('start', st); scan('attempt', ok(await s.get(`/api/student/attempts/${aid}`)));
  ok(await s.post(`/api/student/attempts/${aid}/submit`, {})); scan('result before release', ok(await s.get(`/api/student/attempts/${aid}/result`)));
  assert.equal((await other.get(`/api/student/attempts/${aid}`)).status, 404); assert.equal((await other.put(`/api/student/attempts/${aid}/answers`, { items: [] })).status, 404); assert.equal((await other.post(`/api/student/attempts/${aid}/submit`, {})).status, 404); assert.equal((await other.get(`/api/student/attempts/${aid}/result`)).status, 404);
  for (const u of [`/api/exams/${id}`, `/api/exams/${id}/results`, `/api/exams/${id}/export.csv`, `/api/exams/${id}/analytics`, '/api/analytics', '/api/questions']) assert.equal((await s.get(u)).status, 403, u); // teacher endpoints are closed to students
  assert.equal((await s.put(`/api/exams/${id}`, { title: 'x' })).status, 403);
  assert.equal((await t.put(`/api/exams/${id}`, { title: 'x', minutes: 5, max_attempts: 1, release_mode: 'manual', questions: TF(1), class_ids: [S.cls] })).status, 409); // a published paper cannot be edited under students' feet
});

test('grade changes are authorised, reasoned and audited; history keeps every decision', async () => {
  const t = S.tA, id = await mkExam(t, 'Essay quiz', [S.cls], [WRITTEN], { grade: '9' }); await publish(t, id); S.essay = id;
  const s = S.st['s1@t.local'], st = ok(await s.post(`/api/student/exams/${id}/start`)); ok(await s.put(`/api/student/attempts/${st.attempt.id}/answers`, { items: [{ qid: st.questions[0].id, value: 'My essay', seq: 1 }] })); ok(await s.post(`/api/student/attempts/${st.attempt.id}/submit`, {}));
  const aid = st.attempt.id, eq = (await db.prepare('SELECT eq_id FROM grades WHERE attempt_id=?').get(aid)).eq_id, g = b => t.put(`/api/attempts/${aid}/grade`, { eq_id: eq, ...b });
  assert.equal((await db.prepare('SELECT grading_status FROM attempts WHERE id=?').get(aid)).grading_status, 'pending');
  const list = ok(await t.get(`/api/exams/${id}/results`)).rows[0]; assert.equal(list.percent, null); assert.equal(list.result, null); assert.equal(typeof list.provisional_percent, 'number'); // an ungraded paper is never shown as a final score
  assert.equal((await S.tB.put(`/api/attempts/${aid}/grade`, { eq_id: eq, marks: 5 })).status, 404); assert.equal((await s.put(`/api/attempts/${aid}/grade`, { eq_id: eq, marks: 5 })).status, 403); assert.equal((await client().put(`/api/attempts/${aid}/grade`, {})).status, 401);
  assert.equal((await g({ marks: 6 })).status, 400); assert.equal((await g({ marks: -1 })).status, 400); assert.equal((await g({ marks: 'abc' })).status, 400);
  ok(await g({ marks: 3 })); assert.equal((await db.prepare('SELECT grading_status FROM attempts WHERE id=?').get(aid)).grading_status, 'graded');
  const noReason = await g({ marks: 4 }); assert.equal(noReason.status, 400); assert.match(noReason.data.error, /reason/); ok(await g({ marks: 4, reason: 'Regraded after moderation' })); assert.equal((await db.prepare('SELECT score FROM attempts WHERE id=?').get(aid)).score, 4);
  const h = await db.prepare('SELECT old_marks,new_marks,old_status,reason,by_user FROM grade_history WHERE attempt_id=? ORDER BY id').all(aid); assert.equal(h.length, 2); assert.deepEqual([h[0].old_marks, h[0].new_marks, h[0].old_status], [0, 3, 'pending']); assert.deepEqual([h[1].old_marks, h[1].new_marks, h[1].reason], [3, 4, 'Regraded after moderation']); assert.equal(h[1].by_user, await uid('ta@t.local'));
  const au = (await db.prepare("SELECT detail FROM audit WHERE action='grade.set' AND resource_id=? ORDER BY id").all(aid)).map(r => JSON.parse(r.detail)); assert.equal(au.length, 2); assert.equal(au[1].from, 3); assert.equal(au[1].to, 4);
  assert.equal(ok(await t.get(`/api/exams/${id}/results`)).rows[0].percent, 80); // graded now: 4 of 5
});

test('Quiz A: scores, best-attempt rule, pass mark, results CSV, student result, grade letters, pass-mark lock', async () => {
  const t = S.tA, id = S.quizA = await mkExam(t, 'Quiz A', [S.cls], TF(4), { grade: '9', term: 'Semester 1', academic_year: '2026/27', max_attempts: 2 }); await publish(t, id);
  const sc = { 's1@t.local': 4, 's2@t.local': 3, 's3@t.local': 2, 's4@t.local': 1, 's6@t.local': 4 }; S.aid = {};
  for (const [e, k] of Object.entries(sc)) S.aid[e] = await take(S.st[e], id, k);
  await take(S.st['s5@t.local'], id, 0); S.aid['s5@t.local'] = await take(S.st['s5@t.local'], id, 4); // first attempt 0%, second 100%: the best counts
  const rows = ok(await t.get(`/api/exams/${id}/results?size=50`)); assert.equal(rows.total, 7); assert.ok(rows.rows.every(r => r.percent != null && r.provisional_percent == null && (r.result === 'pass' || r.result === 'fail')));
  assert.deepEqual(rows.rows.filter(r => r.result === 'fail').map(r => r.percent).sort((a, b) => a - b), [0, 25]); assert.equal(rows.exam.pass_mark, 50);
  ok(await S.tA.post(`/api/exams/${id}/finalize`)); ok(await S.tA.post(`/api/exams/${id}/release`));
  const csv = await t.get(`/api/exams/${id}/export.csv`), t2 = CSV.parse(csv.data).records, h = t2[0].cells; assert.deepEqual(h.slice(-3), ['Pass mark (%)', 'Result', 'Letter grade']);
  const find = e => t2.find(r => r.cells[5] === e).cells; assert.deepEqual([find('s4@t.local')[h.indexOf('Result')], find('s4@t.local')[h.indexOf('Percent')], find('s1@t.local')[h.indexOf('Result')]], ['fail', '25', 'pass']);
  const lock = await t.patch(`/api/exams/${id}/settings`, { pass_mark: 60, release_mode: 'manual' }); assert.equal(lock.status, 409); assert.match(lock.data.error, /locked/); // results are released: the pass mark can no longer move under students
  // student view (released): pass/fail from the exam's pass mark, letter grade from the school scale
  ok(await S.admin.put('/api/admin/settings', { grading_scale: [{ min: 0, label: 'F' }, { min: 50, label: 'C' }, { min: 80, label: 'A' }] }));
  const r1 = ok(await S.st['s1@t.local'].get(`/api/student/attempts/${S.aid['s1@t.local']}/result`)).result, r4 = ok(await S.st['s4@t.local'].get(`/api/student/attempts/${S.aid['s4@t.local']}/result`)).result;
  assert.deepEqual([r1.state, r1.result, r1.letter, r1.pass_mark, r1.percent], ['released', 'pass', 'A', 50, 100]); assert.deepEqual([r4.result, r4.letter, r4.percent], ['fail', 'F', 25]);
  assert.equal(await count("SELECT COUNT(*) n FROM audit WHERE action='exam.settings'"), 0); // the refused change left no trace of a change
});

test('analytics: exact figures for a controlled dataset, graded-only, best attempt, aggregates only, authorised', async () => {
  const t = S.tA, W = S.essay; // add a pending essay attempt in grade 9 to prove pending work is excluded and reported
  const s2 = S.st['s2@t.local'], st = ok(await s2.post(`/api/student/exams/${W}/start`)); ok(await s2.put(`/api/student/attempts/${st.attempt.id}/answers`, { items: [{ qid: st.questions[0].id, value: 'x', seq: 1 }] })); ok(await s2.post(`/api/student/attempts/${st.attempt.id}/submit`, {}));
  // enrollment panel counters on the same exam: s1 graded, s2 awaiting grading, s3 mid-exam
  ok(await S.st['s3@t.local'].post(`/api/student/exams/${W}/start`));
  const en = ok(await t.get(`/api/exams/${W}/enrollment`)).summary; assert.deepEqual([en.eligible, en.submitted, en.awaiting_grading, en.attempting, en.not_started], [6, 2, 1, 1, 3]);
  const a = ok(await t.get('/api/analytics?grade=9'));
  // Quiz A: 100,75,50,25,100 (best of 0 and 100),100  +  essay exam: s1 graded 80 (s2's essay is still pending and excluded)
  // 7 results -> mean 75.7, median 80; pass mark 50 -> 6 of 7 pass (only the 25 fails)
  assert.deepEqual([a.n, a.mean, a.median, a.min, a.max, a.pass_n, a.pass_rate], [7, 75.7, 80, 25, 100, 6, 85.7]);
  assert.deepEqual(a.distribution, [0, 0, 1, 0, 0, 1, 0, 1, 1, 3]); assert.equal(a.exams_in_scope, 2); assert.equal(a.enrollments, 12); assert.equal(a.students_submitted, 8); assert.equal(a.submission_rate, 66.7); // 6 students on Quiz A + 2 on the essay, out of 6 + 6 entitled
  assert.equal(a.attempts_pending, 1); assert.equal(a.grades_pending, 1); assert.match(a.population, /still awaiting grading/); assert.match(a.population, /highest graded attempt/);
  // hardest question first: Q4 was answered correctly by 3 of 6
  assert.deepEqual([a.hardest_questions[0].n, a.hardest_questions[0].percent, a.hardest_questions[0].responses], [4, 50, 6]); assert.deepEqual(a.topics.map(x => [x.topic, x.percent]), [['Algebra', 58.3], ['Logic', 91.7]]);
  assert.deepEqual(a.letters.map(l => [l.label, l.count]), [['A', 4], ['C', 2], ['F', 1]]); // school scale (A 80+, C 50+, F 0+) applied to the same seven results
  // only aggregates leave the server
  const j = JSON.stringify(a); for (const s of ['Student 1', 's1@t.local', 'N1', 'student_id', 'ta@t.local']) assert.equal(j.includes(s), false, s);
  // filters narrow the population correctly, and an empty result is reported honestly
  assert.equal(ok(await t.get(`/api/analytics?exam_id=${S.quizA}`)).n, 6); assert.equal(ok(await t.get('/api/analytics?term=Semester 1')).exams_in_scope, 1); assert.equal(ok(await t.get('/api/analytics?academic_year=2026/27&grade=10')).n, 0);
  assert.equal(ok(await t.get(`/api/analytics?class_id=${S.cls}&grade=9`)).n, 7); const none = ok(await t.get(`/api/analytics?from=${Date.now() + 864e5}`)); assert.equal(none.n, 0); assert.equal(none.mean, null); assert.equal(none.pass_rate, null);
  assert.equal(ok(await t.get('/api/analytics?grade=zzz')).population, 'No published or closed exams match these filters.');
  // pass rate follows each exam's own pass mark (the lock only applies once results are released, so use a fresh exam)
  const fresh = await mkExam(t, 'Strict quiz', [S.cls], TF(2), { grade: '11', pass_mark: 100 }); await publish(t, fresh); await take(S.st['s1@t.local'], fresh, 2); await take(S.st['s2@t.local'], fresh, 1);
  const strict = ok(await t.get('/api/analytics?grade=11')); assert.deepEqual([strict.n, strict.pass_n, strict.pass_rate, strict.mean], [2, 1, 50, 75]);
  // authorisation
  assert.equal((await S.tB.get(`/api/analytics?class_id=${S.cls}`)).status, 404); assert.equal(ok(await S.tB.get('/api/analytics?grade=9')).n, 0); // another teacher sees none of this
  assert.equal((await S.st['s1@t.local'].get('/api/analytics')).status, 403); assert.equal((await client().get('/api/analytics')).status, 401); assert.equal((await S.admin.get('/api/analytics')).status, 403);
});

test('web security hygiene: cookies, CSRF, headers, compression, brute force, and no internal details in errors', async () => {
  const c = client(), login = await c.post('/api/auth/login', { email: 'ta@t.local', password: 'Teacher-Pass-1234' }); assert.match(login.setCookie, /HttpOnly/); assert.match(login.setCookie, /SameSite=Strict/); assert.match(login.setCookie, /Path=\//);
  assert.equal(JSON.stringify(login.data).includes('pw_hash'), false); assert.equal(JSON.stringify(ok(await c.get('/api/auth/me'))).includes('scrypt'), false);
  const raw = (u, o = {}) => fetch(base + u, o), noHdr = await raw('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(noHdr.status, 403); // CSRF: custom header required
  assert.equal((await raw('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'eagle', Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  const page = await raw('/'), csp = page.headers.get('content-security-policy'); assert.match(csp, /script-src 'self'(;|$)/); assert.equal(/script-src[^;]*unsafe/.test(csp), false); assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff'); assert.equal(page.headers.get('x-frame-options'), 'DENY'); assert.equal(page.headers.get('x-powered-by'), null); assert.ok(page.headers.get('x-request-id'));
  assert.equal((await raw('/core.js', { headers: { 'Accept-Encoding': 'gzip' } })).headers.get('content-encoding'), 'gzip');
  const health = await (await raw('/api/health')).json(); assert.deepEqual(Object.keys(health).sort(), ['migrations', 'ok', 'version']); // reveals nothing about data
  // errors never leak SQL, paths or stack traces
  const probes = [await raw('/api/exams/abc'), await raw('/api/nope'), await raw('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'eagle' }, body: '{bad json' }), await c.get("/api/students?q=' OR 1=1; DROP TABLE users;--"), await raw('/api/students')];
  for (const r of probes) { const body = typeof r.status === 'number' && r.json ? JSON.stringify(await r.json()) : JSON.stringify(r.data); assert.equal(/SQLITE|node_modules|\.js:\d|at Object|stack|sqlite|\/home\/|relation "|column "|syntax error at or near|violates|constraint|ERROR:|\$1/i.test(body), false, body.slice(0, 200)); }
  assert.ok(await count('SELECT COUNT(*) n FROM users') > 5); // the injection attempt changed nothing
  const orig = db.prepare.bind(db); db.prepare = () => { throw Object.assign(new Error('password authentication failed for user "eagle_app" connecting to postgres://eagle_app:hunter2@db.abcdefgh.supabase.co:5432/postgres secret-path'), { code: '28P01' }); };
  let boom; try { boom = await raw('/api/students', { headers: { cookie: 'sid=x' } }); } finally { db.prepare = orig; }
  const bj = await boom.json(); assert.equal(boom.status, 500); assert.equal(/hunter2|supabase|eagle_app|postgres|secret-path|28P01/i.test(JSON.stringify(bj)), false, 'no host, role, password or error code reaches the browser'); assert.match(bj.error, /Something went wrong/); assert.match(bj.error_id, /^[a-f0-9]{16}$/); assert.equal(bj.error_id, boom.headers.get('x-request-id')); // support can find the log line
  let last; for (let i = 0; i < 9; i++) last = await client().post('/api/auth/login', { email: 'brute@t.local', password: 'wrong-password-' + i }); assert.equal(last.status, 429); // brute force is throttled per account
});

test('backup and restore: an export is verified by checksum, restores into a brand-new database, and damage or a wrong password fail loudly', () => {
  const cp = require('child_process'), cwd = path.join(__dirname, '..'), env = { ...process.env, LOG_LEVEL: 'silent', RESTORE_ADMIN_DATABASE_URL: process.env.TEST_ADMIN_DATABASE_URL };
  const run = (script, args, extra = {}) => cp.spawnSync(process.execPath, ['scripts/' + script, ...args], { cwd, encoding: 'utf8', env: { ...env, ...extra } });
  const file = path.join(tmp, 'backup.ndjson.gz'), made = run('backup.js', [file]); assert.equal(made.status, 0, made.stderr); assert.match(made.stdout, /Backup written and verified/);
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'owner-only permissions');
  assert.equal(run('verify-backup.js', [file]).status, 0);
  const ok = run('restore-test.js', [file], { RESTORE_ADMIN_EMAIL: 'admin@t.local', RESTORE_ADMIN_PASSWORD: 'Admin-Pass-12345' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr); assert.match(ok.stdout, /RESTORE TEST PASSED/); assert.match(ok.stdout, /integrity checks: ok/); assert.match(ok.stdout, /signed in as administrator/);
  // negative cases: a wrong password and a damaged backup must FAIL loudly, never pass
  const wrong = run('restore-test.js', [file], { RESTORE_ADMIN_EMAIL: 'admin@t.local', RESTORE_ADMIN_PASSWORD: 'definitely-wrong' }); assert.notEqual(wrong.status, 0); assert.match(wrong.stderr, /RESTORE TEST FAILED.*not valid/);
  const bad = path.join(tmp, 'damaged.ndjson.gz'); fs.writeFileSync(bad, fs.readFileSync(file).subarray(0, 600)); const dmg = run('restore-test.js', [bad]); assert.notEqual(dmg.status, 0); assert.match(dmg.stderr, /RESTORE TEST FAILED/);
  const tampered = path.join(tmp, 'tampered.ndjson.gz'), zlib = require('zlib'); // flip one value inside an otherwise valid file: the checksum must catch it
  fs.writeFileSync(tampered, zlib.gzipSync(zlib.gunzipSync(fs.readFileSync(file)).toString().replace('"role":"student"', '"role":"admin"'))); const tmp2 = run('verify-backup.js', [tampered]); assert.notEqual(tmp2.status, 0); assert.match(tmp2.stderr, /checksum mismatch/);
  const noAdmin = run('restore-test.js', [file]); assert.equal(noAdmin.status, 0); assert.match(noAdmin.stdout, /Sign-in check skipped/); // without explicit credentials the step is skipped, not failed
});

test('the audit log and grade history are append-only at the database level, not just by convention', async () => {
  assert.ok(await count('SELECT COUNT(*) n FROM audit') > 10 && await count('SELECT COUNT(*) n FROM grade_history') >= 2);
  for (const sql of ["UPDATE audit SET action='tampered'", 'DELETE FROM audit', "UPDATE grade_history SET new_marks=99", 'DELETE FROM grade_history']) {
    await assert.rejects(() => db.prepare(sql).run(), /permission denied/, sql);        // lock 1: the application role has no such privilege
    await assert.rejects(() => adminQuery(sql), /append-only/, sql);                      // lock 2: a trigger stops even a privileged role
  }
  await assert.rejects(() => adminQuery('TRUNCATE audit'), /append-only/);
  assert.ok(await count("SELECT COUNT(*) n FROM audit WHERE action='tampered'") === 0);
});
