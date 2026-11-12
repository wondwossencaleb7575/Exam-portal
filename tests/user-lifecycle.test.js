// User lifecycle: deactivate / restore / permanently delete. Real server, real PostgreSQL, real HTTP. Run with the rest of the suite: npm test
const test = require('node:test'), assert = require('node:assert/strict');
Object.assign(process.env, { ADMIN_EMAIL: 'admin@t.local', ADMIN_PASSWORD: 'Admin-Pass-12345', OTP_LOGIN_MODE: 'off' });
const { start } = require('../server');
const { db } = require('../lib/db');
const adminQuery = require('./helpers/admin-db');
const srv = start(0), base = `http://localhost:${srv.address().port}`;
test.after(async () => { srv.closeAllConnections(); srv.close(); await require('../lib/db').close(); });

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'eagle', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
    return { status: r.status, data };
  };
  return { get: u => call('GET', u), post: (u, b) => call('POST', u, b || {}), patch: (u, b) => call('PATCH', u, b), del: (u, b) => call('DELETE', u, b || {}), cookie: () => cookie, setCookie: c => { cookie = c; } };
}
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.data).slice(0, 400)); return r.data; };
const PW = 'Person-Pass-1234', now = Date.now();
const A = {}; let SUBJECT;
async function mk(role, name) {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}@school.test`, c = client();
  const t = ok(await A.admin.post('/api/admin/users', { email, name, role, ...(role === 'student' ? { student_number: 'N-' + name.replace(/\W/g, '') } : {}) }));
  ok(await c.post('/api/auth/login', { email, password: t.temp_password })); ok(await c.post('/api/auth/change-password', { current: t.temp_password, next: PW }));
  return { id: t.id, email, name, role, c };
}
const login = (u, pw = PW) => client().post('/api/auth/login', { email: u.email, password: pw });
const rows = async (sql, params = []) => (await adminQuery(sql, params)).rows;
const one = async (sql, params = []) => (await rows(sql, params))[0];
const audit = async (action, id) => rows('SELECT * FROM audit WHERE action=$1 AND resource_id=$2 ORDER BY id', [action, id]);
// A fingerprint of everything that must NOT change when an unrelated account is handled.
const snapshot = async exceptId => JSON.stringify(await Promise.all([
  rows('SELECT id,email,name,role,status,student_number,pw_hash FROM users WHERE id<>$1 ORDER BY id', [exceptId]), rows('SELECT * FROM exams ORDER BY id'), rows('SELECT * FROM attempts ORDER BY id'),
  rows('SELECT * FROM grades ORDER BY attempt_id,eq_id'), rows('SELECT * FROM answers ORDER BY attempt_id,eq_id'), rows('SELECT * FROM classes ORDER BY id'), rows('SELECT * FROM class_members WHERE user_id<>$1 ORDER BY class_id,user_id', [exceptId]),
  rows('SELECT * FROM questions WHERE owner_id<>$1 ORDER BY id', [exceptId]), rows('SELECT * FROM exam_students WHERE student_id<>$1 ORDER BY exam_id,student_id', [exceptId])]));
const ins = async (sql, params) => (await rows(sql + ' RETURNING id', params))[0].id;
async function exam(owner, title, status = 'closed', closes = now - 86400e3) { return ins('INSERT INTO exams(owner_id,subject_id,title,status,closes,created,updated) VALUES($1,$2,$3,$4,$5,$6,$6)', [owner, SUBJECT, title, status, closes, now]); }
async function attempt(examId, studentId, status = 'submitted', score = 7) {
  const id = await ins('INSERT INTO attempts(exam_id,student_id,attempt_no,started,deadline,status,submitted_at,seed,score,total,grading_status) VALUES($1,$2,1,$3,$4,$5,$6,1,$7,10,$8)', [examId, studentId, now - 7200e3, now - 3600e3, status, status === 'in_progress' ? null : now - 3700e3, score, status === 'in_progress' ? null : 'graded']);
  const eq = await ins("INSERT INTO exam_questions(exam_id,pos,type,stem,marks) VALUES($1,1,'tf','Is it?',10)", [examId]);
  await rows("INSERT INTO answers(attempt_id,eq_id,value,updated) VALUES($1,$2,'true',$3)", [id, eq, now]); await rows("INSERT INTO grades(attempt_id,eq_id,marks,status) VALUES($1,$2,$3,'auto')", [id, eq, score]);
  return id;
}
const S = {};

test('setup: administrators, teachers, students, classes, exams and results', async () => {
  const a = A.admin = client(); ok(await a.post('/api/auth/login', { email: 'admin@t.local', password: 'Admin-Pass-12345' })); A.id = (await one("SELECT id FROM users WHERE email='admin@t.local'")).id;
  SUBJECT = (await one('SELECT id FROM subjects ORDER BY name LIMIT 1')).id;
  S.admin2 = await mk('admin', 'Second Admin'); S.admin3 = await mk('admin', 'Third Admin');
  S.t1 = await mk('teacher', 'Teacher One'); S.t2 = await mk('teacher', 'Teacher Two');
  S.s1 = await mk('student', 'Student Alpha'); S.s2 = await mk('student', 'Student Beta'); S.s3 = await mk('student', 'Student Gamma'); S.s4 = await mk('student', 'Student Delta');
  const cls = S.cls = await ins('INSERT INTO classes(name,grade,subject_id,created_by,created) VALUES($1,$2,$3,$4,$5)', ['Grade 9A', '9', SUBJECT, S.t1.id, now]);
  for (const [u, r] of [[S.t1, 'teacher'], [S.s1, 'student'], [S.s2, 'student'], [S.s3, 'student']]) await rows('INSERT INTO class_members(class_id,user_id,role) VALUES($1,$2,$3)', [cls, u.id, r]);
  S.e1 = await exam(S.t1.id, 'Algebra test'); S.e2 = await exam(S.t2.id, 'Geometry test');
  S.a1 = await attempt(S.e1, S.s1.id, 'submitted', 8); S.a2 = await attempt(S.e1, S.s2.id, 'submitted', 6); S.a3 = await attempt(S.e2, S.s1.id, 'submitted', 9);
  await rows('INSERT INTO exam_students(exam_id,student_id,enrolled_by,enrolled_at) VALUES($1,$2,$3,$4)', [S.e1, S.s1.id, S.t1.id, now]);
  const e3 = S.e3 = await exam(S.t2.id, 'Not yet taken', 'closed'); await rows('INSERT INTO exam_students(exam_id,student_id,enrolled_by,enrolled_at) VALUES($1,$2,$3,$4)', [e3, S.s1.id, S.t2.id, now]);
  await rows("INSERT INTO accommodations(exam_id,student_id,extra_minutes,note) VALUES($1,$2,15,'private note about the student')", [S.e1, S.s1.id]);
  S.qs = [await ins("INSERT INTO questions(owner_id,subject_id,type,stem,created,updated) VALUES($1,$2,'tf','T1 question one',$3,$3)", [S.t1.id, SUBJECT, now]), await ins("INSERT INTO questions(owner_id,subject_id,type,stem,created,updated) VALUES($1,$2,'tf','T2 question',$3,$3)", [S.t2.id, SUBJECT, now])];
});

const ROUTES = id => [['POST', `/api/admin/users/${id}/deactivate`, {}], ['POST', `/api/admin/users/${id}/restore`, {}], ['DELETE', `/api/admin/users/${id}`, { confirm: 'DELETE' }]];
test('security: anonymous, student and teacher callers are refused on every lifecycle endpoint, and nothing changes', async () => {
  const before = await snapshot(0);
  for (const [who, want] of [[client(), 401], [S.s1.c, 403], [S.t1.c, 403]])
    for (const [m, url, body] of ROUTES(S.s2.id)) { const r = await (m === 'DELETE' ? who.del(url, body) : who.post(url, body)); assert.equal(r.status, want, `${m} ${url}`); }
  assert.equal(await snapshot(0), before); assert.equal((await one('SELECT status FROM users WHERE id=$1', [S.s2.id])).status, 'active');
});

test('input validation: bad ids, missing/wrong DELETE confirmation, over-long reason, unknown accounts', async () => {
  for (const id of ['abc', '0', '-5', '1.5', '99999999', '9007199254740993']) for (const [m, url, body] of ROUTES(id)) { const r = await (m === 'DELETE' ? A.admin.del(url, body) : A.admin.post(url, body)); assert.equal(r.status, 404, `${m} ${url} -> ${r.status}`); }
  const before = await snapshot(0);
  for (const body of [{}, { confirm: 'delete' }, { confirm: ' DELETE' }, { confirm: true }, { confirm: 'DELETE ', reason: 'x'.repeat(301) }]) assert.equal((await A.admin.del(`/api/admin/users/${S.s4.id}`, body)).status, 400, JSON.stringify(body).slice(0, 40));
  assert.equal((await A.admin.post(`/api/admin/users/${S.s4.id}/deactivate`, { reason: 'x'.repeat(301) })).status, 400);
  assert.equal(await snapshot(0), before); assert.equal((await one('SELECT status FROM users WHERE id=$1', [S.s4.id])).status, 'active');
});

test('self protection: an administrator cannot deactivate or delete their own account', async () => {
  for (const [m, url, body] of [ROUTES(A.id)[0], ROUTES(A.id)[2]]) { const r = await (m === 'DELETE' ? A.admin.del(url, body) : A.admin.post(url, body)); assert.equal(r.status, 409); assert.match(r.data.error, /your own account/); }
  assert.equal((await one('SELECT status FROM users WHERE id=$1', [A.id])).status, 'active'); ok(await A.admin.get('/api/admin/users'));
});

for (const key of ['s3', 't2', 'admin3']) test(`deactivate and restore a ${{ s3: 'student', t2: 'teacher', admin3: 'administrator' }[key]}: blocked everywhere, then back with the same account and all history`, async () => {
  const u = S[key], before = await snapshot(u.id), users = (await one('SELECT COUNT(*)::int n FROM users')).n;
  ok(await u.c.get(u.role === 'student' ? '/api/student/exams' : u.role === 'teacher' ? '/api/questions' : '/api/admin/users'));          // works while active
  const r = ok(await A.admin.post(`/api/admin/users/${u.id}/deactivate`, { reason: 'left the school' })); assert.equal(r.status, 'suspended');
  assert.equal((await login(u)).status, 403);                                                                                                   // cannot sign in
  assert.equal((await u.c.get(u.role === 'student' ? '/api/student/exams' : u.role === 'teacher' ? '/api/questions' : '/api/admin/users')).status, 401); // old session is dead
  assert.equal((await one('SELECT COUNT(*)::int n FROM sessions WHERE user_id=$1', [u.id])).n, 0);
  if (u.role === 'student') assert.equal((await u.c.post(`/api/student/exams/${S.e1}/start`)).status, 401);                                    // cannot start exams
  assert.equal(await snapshot(u.id), before); assert.equal((await one('SELECT COUNT(*)::int n FROM users')).n, users);                          // nothing else changed, nothing deleted
  const l = (await audit('USER_DEACTIVATED', u.id)).at(-1); assert.equal(l.actor_id, A.id); assert.equal(JSON.parse(l.detail).result, 'success'); assert.equal(JSON.parse(l.detail).reason, 'left the school');
  assert.ok(!/@|password|token/i.test(l.detail)); assert.equal((await A.admin.post(`/api/admin/users/${u.id}/deactivate`)).status, 409); // twice -> already deactivated
  const shown = ok(await A.admin.get(`/api/admin/users?q=${encodeURIComponent(u.email)}`)).items[0]; assert.equal(shown.status, 'suspended'); assert.equal(shown.id, u.id);
  // restore
  assert.equal(ok(await A.admin.post(`/api/admin/users/${u.id}/restore`, { reason: 'back' })).status, 'active'); assert.equal((await A.admin.post(`/api/admin/users/${u.id}/restore`)).status, 409);
  ok(await login(u)); assert.equal((await one('SELECT id FROM users WHERE email=$1', [u.email])).id, u.id); assert.equal((await one('SELECT COUNT(*)::int n FROM users')).n, users); // same account, no duplicate
  assert.equal(await snapshot(u.id), before); assert.equal((await audit('USER_RESTORED', u.id)).filter(x => JSON.parse(x.detail).result === 'success').length, 1);
  const fresh = client(); ok(await fresh.post('/api/auth/login', { email: u.email, password: PW })); u.c = fresh;
});

test('permanent delete of a STUDENT: personal data gone, results kept, everyone else untouched', async () => {
  const u = S.s1, before = await snapshot(u.id), enc = ok(await A.admin.get(`/api/admin/users?q=${encodeURIComponent(u.email)}`)).items[0];
  assert.equal(enc.id, u.id);
  const r = ok(await A.admin.del(`/api/admin/users/${u.id}`, { confirm: 'DELETE', reason: 'GDPR request' })); assert.equal(r.deleted, true); assert.equal(r.retained.exam_attempts, 2);
  const row = await one('SELECT * FROM users WHERE id=$1', [u.id]);
  assert.deepEqual([row.status, row.name, row.student_number, row.last_login, row.email_verified_at, row.must_change, row.otp_exempt], ['deleted', 'Deleted user', null, null, null, 0, 0]);
  assert.equal(row.email, `deleted-${u.id}@deleted.invalid`); assert.ok(!row.pw_hash.startsWith('scrypt'));
  assert.equal((await one('SELECT COUNT(*)::int n FROM users WHERE name ILIKE $1 OR email ILIKE $2 OR student_number ILIKE $3', ['%Alpha%', '%student.alpha%', '%StudentAlpha%'])).n, 0);
  assert.equal((await login(u)).status, 401); assert.equal((await login(u, 'anything-else-123')).status, 401);                                  // can no longer authenticate
  assert.equal((await u.c.get('/api/student/exams')).status, 401); assert.equal((await one('SELECT COUNT(*)::int n FROM sessions WHERE user_id=$1', [u.id])).n, 0);
  // academic record intact and still pointing at the same (anonymised) id
  assert.deepEqual((await rows('SELECT id,score,total,status FROM attempts WHERE student_id=$1 ORDER BY id', [u.id])).map(x => [x.id, x.score]), [[S.a1, 8], [S.a3, 9]]);
  assert.equal((await one('SELECT COUNT(*)::int n FROM grades WHERE attempt_id IN ($1,$2)', [S.a1, S.a3])).n, 2); assert.equal((await one('SELECT COUNT(*)::int n FROM answers WHERE attempt_id IN ($1,$2)', [S.a1, S.a3])).n, 2);
  assert.equal((await one('SELECT COUNT(*)::int n FROM class_members WHERE user_id=$1', [u.id])).n, 0);                                          // roster link removed
  assert.equal((await one('SELECT COUNT(*)::int n FROM exam_students WHERE student_id=$1', [u.id])).n, 1);                                       // enrolment WITH an attempt kept, the never-used one removed
  assert.equal((await one('SELECT note FROM accommodations WHERE student_id=$1', [u.id])).note, '');
  assert.equal(await snapshot(u.id), before);                                                                                                       // other users, exams, classes, results: byte-for-byte unchanged
  // results page still lists the work, under the anonymised name
  const res = ok(await S.t1.c.get(`/api/exams/${S.e1}/results`)); assert.ok(JSON.stringify(res).includes('Deleted user')); assert.ok(!JSON.stringify(res).includes('Student Alpha'));
  // gone from every list
  assert.ok(!ok(await A.admin.get('/api/admin/users?size=100')).items.some(x => x.id === u.id)); assert.equal(ok(await A.admin.get('/api/admin/users?status=suspended')).items.some(x => x.id === u.id), false);
  assert.ok(!(await A.admin.get('/api/admin/users/export.csv')).data.includes(`deleted-${u.id}`)); assert.ok(!JSON.stringify(ok(await A.admin.get('/api/students?size=200'))).includes(`"id":${u.id},`));
  // audit: kept, minimal
  const l = (await audit('USER_PERMANENTLY_DELETED', u.id))[0]; assert.equal(l.actor_id, A.id); assert.ok(!/student\.alpha|Student Alpha|N-StudentAlpha|scrypt/i.test(JSON.stringify(l))); assert.equal(JSON.parse(l.detail).role, 'student');
  assert.equal((await A.admin.del(`/api/admin/users/${u.id}`, { confirm: 'DELETE' })).status, 404);                                                 // repeated request
  for (const [m, url, body] of [ROUTES(u.id)[0], ROUTES(u.id)[1]]) assert.equal((await A.admin.post(url, body)).status, 404);                      // a deleted account cannot be revived
  assert.equal((await A.admin.patch(`/api/admin/users/${u.id}`, { status: 'active' })).status, 404); assert.equal((await A.admin.post(`/api/admin/users/${u.id}/reset-password`)).status, 404);
  await assert.rejects(adminQuery("UPDATE users SET status='active' WHERE id=$1", [u.id]), /deleted account cannot be changed/);                    // ...not even with direct database access
  // the freed e-mail can be used again, by a NEW account; the old results stay with the old id
  const again = await mk('student', 'Student Alpha'); assert.notEqual(again.id, u.id); assert.equal((await one('SELECT COUNT(*)::int n FROM attempts WHERE student_id=$1', [again.id])).n, 0);
});

test('permanent delete is refused while something live depends on the account, and changes nothing', async () => {
  const live = await exam(S.t1.id, 'Open exam', 'published', now + 86400e3), ip = await attempt(S.e2, S.s4.id, 'in_progress'), before = await snapshot(0);
  let r = await A.admin.del(`/api/admin/users/${S.t1.id}`, { confirm: 'DELETE' }); assert.equal(r.status, 409); assert.match(r.data.error, /still open or scheduled/);
  r = await A.admin.del(`/api/admin/users/${S.s4.id}`, { confirm: 'DELETE' }); assert.equal(r.status, 409); assert.match(r.data.error, /in progress/);
  r = await A.admin.del(`/api/admin/users/${S.t2.id}`, { confirm: 'DELETE' }); assert.equal(r.status, 409); assert.match(r.data.error, /student attempt/);
  assert.equal(await snapshot(0), before); assert.ok((await audit('USER_PERMANENTLY_DELETED', S.t1.id)).some(x => JSON.parse(x.detail).result === 'refused'));  // the refusal itself is on record
  await rows("UPDATE exams SET status='closed' WHERE id=$1", [live]); await rows("UPDATE attempts SET status='submitted',submitted_at=$2 WHERE id=$1", [ip, now]); // once nothing is live...
  S.liveExam = live;
});

test('permanent delete of a TEACHER: content is kept and archived under the anonymised owner, never handed to anyone', async () => {
  const u = S.t1, draft = await exam(u.id, 'Draft by T1', 'draft', null), before = await snapshot(u.id), others = JSON.stringify(await rows('SELECT * FROM questions WHERE owner_id<>$1 ORDER BY id', [u.id]));
  const r = ok(await A.admin.del(`/api/admin/users/${u.id}`, { confirm: 'DELETE' })); assert.equal(r.retained.questions_owned, 1); assert.equal(r.removed.questions_archived, 1); assert.equal(r.removed.draft_exams_archived, 1);
  assert.equal((await one('SELECT status FROM users WHERE id=$1', [u.id])).status, 'deleted');
  const qq = await one('SELECT owner_id,archived,stem FROM questions WHERE id=$1', [S.qs[0]]); assert.deepEqual([qq.owner_id, qq.archived, qq.stem], [u.id, 1, 'T1 question one']);   // same owner id (no transfer), archived, text kept
  assert.equal((await one('SELECT owner_id,status FROM exams WHERE id=$1', [draft])).status, 'archived'); assert.equal((await one('SELECT owner_id FROM exams WHERE id=$1', [S.e1])).owner_id, u.id);
  assert.equal((await one('SELECT COUNT(*)::int n FROM attempts WHERE exam_id=$1', [S.e1])).n, 2); assert.equal((await one('SELECT created_by FROM classes WHERE id=$1', [S.cls])).created_by, u.id);
  assert.equal((await one('SELECT COUNT(*)::int n FROM class_members WHERE user_id=$1', [u.id])).n, 0); assert.equal((await one("SELECT COUNT(*)::int n FROM class_members WHERE class_id=$1 AND role='student'", [S.cls])).n, 2 /* s2 + s3 */);
  assert.equal(JSON.stringify(await rows('SELECT * FROM questions WHERE owner_id<>$1 ORDER BY id', [u.id])), others);                                          // nobody else's questions touched
  assert.equal((await login(u)).status, 401); assert.equal((await u.c.get('/api/questions')).status, 401);
  assert.ok(!JSON.stringify(await audit('USER_PERMANENTLY_DELETED', u.id)).includes('teacher.one'));
  assert.ok(before);
});

test('an administrator and an already-deactivated account can be permanently deleted too', async () => {
  const before = await snapshot(S.admin3.id); ok(await A.admin.post(`/api/admin/users/${S.admin3.id}/deactivate`)); ok(await A.admin.del(`/api/admin/users/${S.admin3.id}`, { confirm: 'DELETE' }));
  assert.equal((await one('SELECT status,role FROM users WHERE id=$1', [S.admin3.id])).status, 'deleted'); assert.equal(await snapshot(S.admin3.id), before); assert.equal((await login(S.admin3)).status, 401);
  ok(await A.admin.del(`/api/admin/users/${S.admin2.id}`, { confirm: 'DELETE' })); assert.equal((await one("SELECT COUNT(*)::int n FROM users WHERE role='admin' AND status='active'")).n, 1);
});

test('the LAST active administrator can never be removed: by the API, the old PATCH route, or even direct SQL', async () => {
  assert.equal((await one("SELECT COUNT(*)::int n FROM users WHERE role='admin' AND status='active'")).n, 1);
  const extra = await mk('admin', 'Temp Admin'); // a second administrator, only to be able to ask the question through the API
  ok(await extra.c.post(`/api/admin/users/${A.id}/deactivate`)); assert.equal((await A.admin.get('/api/admin/users')).status, 401);                  // A is now deactivated; extra is the only active admin
  assert.equal((await extra.c.post(`/api/admin/users/${extra.id}/deactivate`)).status, 409);                                                         // self
  await assert.rejects(adminQuery("UPDATE users SET status='suspended' WHERE id=$1", [extra.id]), /last active administrator/);                       // database guard
  await assert.rejects(adminQuery("UPDATE users SET role='teacher' WHERE id=$1", [extra.id]), /last active administrator/);
  await assert.rejects(db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(extra.id), /last active administrator/);                      // and for the application's own database role
  assert.equal((await extra.c.patch(`/api/admin/users/${A.id}`, { status: 'active' })).status, 200);                                                 // restore A through the OLD route still works
  A.admin = client(); ok(await A.admin.post('/api/auth/login', { email: 'admin@t.local', password: 'Admin-Pass-12345' }));
  assert.equal((await A.admin.patch(`/api/admin/users/${extra.id}`, { status: 'suspended' })).status, 200); assert.equal((await A.admin.patch(`/api/admin/users/${extra.id}`, { status: 'active' })).status, 200);
  S.extra = extra;
});

test('two administrators removing each other at the same moment: exactly one succeeds and an administrator always remains', async () => {
  const x = S.extra, y = A; y.c = A.admin; await rows("UPDATE users SET status='active' WHERE id=$1", [x.id]);
  const res = await Promise.all([x.c.post(`/api/admin/users/${y.id}/deactivate`), y.c.post(`/api/admin/users/${x.id}/deactivate`)]);
  const codes = res.map(r => r.status).sort(); assert.equal(codes[0], 200); assert.ok([401, 409].includes(codes[1]), codes.join()); assert.equal((await one("SELECT COUNT(*)::int n FROM users WHERE role='admin' AND status='active'")).n, 1);
  await rows("UPDATE users SET status='active' WHERE id=$1", [A.id]); A.admin = client(); ok(await A.admin.post('/api/auth/login', { email: 'admin@t.local', password: 'Admin-Pass-12345' }));
});

test('repeated and simultaneous requests are safe', async () => {
  const v = await mk('student', 'Student Twin'), res = await Promise.all([1, 2, 3, 4].map(() => A.admin.del(`/api/admin/users/${v.id}`, { confirm: 'DELETE' })));
  assert.deepEqual(res.map(r => r.status).sort(), [200, 404, 404, 404]); assert.equal((await audit('USER_PERMANENTLY_DELETED', v.id)).filter(x => JSON.parse(x.detail).result === 'success').length, 1);
  const w = await mk('student', 'Student Echo'), r2 = await Promise.all([1, 2, 3].map(() => A.admin.post(`/api/admin/users/${w.id}/deactivate`))); assert.deepEqual(r2.map(r => r.status).sort(), [200, 409, 409]);
});

test('a failure half-way through a permanent deletion rolls EVERYTHING back', async () => {
  const v = await mk('teacher', 'Teacher Fault'); await ins("INSERT INTO questions(owner_id,subject_id,type,stem,created,updated) VALUES($1,$2,'tf','fault q',$3,$3)", [v.id, SUBJECT, now]);
  await adminQuery("CREATE OR REPLACE FUNCTION eagle.ul_boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$ LANGUAGE plpgsql"); await adminQuery('CREATE TRIGGER ul_boom BEFORE UPDATE ON eagle.questions FOR EACH ROW EXECUTE FUNCTION eagle.ul_boom()');
  const before = await snapshot(0), user = await one('SELECT * FROM users WHERE id=$1', [v.id]);
  const r = await A.admin.del(`/api/admin/users/${v.id}`, { confirm: 'DELETE' }); assert.ok(r.status >= 500, 'reported as an error'); assert.ok(!/simulated|postgres|trigger/i.test(JSON.stringify(r.data)), 'no internals leak');
  assert.deepEqual(await one('SELECT * FROM users WHERE id=$1', [v.id]), user); assert.equal(await snapshot(0), before); assert.equal((await audit('USER_PERMANENTLY_DELETED', v.id)).filter(x => JSON.parse(x.detail).result === 'success').length, 0);
  await adminQuery('DROP TRIGGER ul_boom ON eagle.questions'); ok(await login(v));                                                                   // untouched, can still sign in
  ok(await A.admin.del(`/api/admin/users/${v.id}`, { confirm: 'DELETE' }));                                                                          // and the same request now succeeds
});

test('user list: search, role and status filters; unrelated features still work (reset password, new account, old status route)', async () => {
  const all = ok(await A.admin.get('/api/admin/users?size=100')); assert.ok(all.items.every(u => u.status !== 'deleted'));
  const only = ok(await A.admin.get('/api/admin/users?role=teacher&size=100')).items; assert.ok(only.length && only.every(u => u.role === 'teacher'));
  ok(await A.admin.post(`/api/admin/users/${S.s2.id}/deactivate`)); assert.ok(ok(await A.admin.get('/api/admin/users?status=suspended&size=100')).items.every(u => u.status === 'suspended'));
  assert.ok(ok(await A.admin.get('/api/admin/users?status=active&size=100')).items.every(u => u.status === 'active')); assert.equal(ok(await A.admin.get('/api/admin/users?q=Student+Beta')).total, 1);
  ok(await A.admin.patch(`/api/admin/users/${S.s2.id}`, { status: 'active' })); ok(await login(S.s2));
  const t = ok(await A.admin.post(`/api/admin/users/${S.s2.id}/reset-password`)); assert.ok(t.temp_password);
  const csv = await A.admin.get('/api/admin/users/export.csv'); assert.equal(csv.status, 200); assert.ok(!csv.data.includes('@deleted.invalid'));
});

test('the migration is idempotent in effect: it accepts exactly the three statuses and re-running the migrator changes nothing', async () => {
  await assert.rejects(adminQuery("UPDATE users SET status='bogus' WHERE id=$1", [S.s3.id]), /users_status_check/);
  const { migrate } = require('../lib/migrate'); assert.deepEqual((await migrate({ url: process.env.TEST_ADMIN_DATABASE_URL })).applied, []);
  assert.ok((await one("SELECT 1 x FROM schema_migrations WHERE version='20261111000000'")));
});
