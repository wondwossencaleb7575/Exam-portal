const test = require('node:test'), assert = require('node:assert/strict');
const os = require('os'), path = require('path'), fs = require('fs'), cp = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-enr-'));
Object.assign(process.env, { ADMIN_EMAIL: 'admin@t.local', ADMIN_PASSWORD: 'Admin-Pass-12345', OTP_LOGIN_MODE: 'off' }); // these suites test exams, grading and enrollment; tests/otp.test.js covers email verification
const { start } = require('../server');
const { db } = require('../lib/db');
const CSV = require('../lib/csv');
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
  const raw = async u => { const r = await fetch(base + u, { headers: { cookie } }); return Buffer.from(await r.arrayBuffer()); };
  return { raw, get: async u => await call('GET', u), post: async (u, b) => await call('POST', u, b || {}), put: async (u, b) => await call('PUT', u, b), patch: async (u, b) => await call('PATCH', u, b), del: async u => await call('DELETE', u) };
}
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.data).slice(0, 400)); return r.data; };
const S = {}, uid = async e => (await db.prepare('SELECT id FROM users WHERE email=?').get(e))?.id;
const count = async (sql, ...p) => (await db.prepare(sql).get(...p)).n;
async function staffLogin(admin, email, name, role) {
  const t = ok(await admin.post('/api/admin/users', { email, name, role })), c = client();
  ok(await c.post('/api/auth/login', { email, password: t.temp_password })); ok(await c.post('/api/auth/change-password', { current: t.temp_password, next: 'Teacher-Pass-1234' })); return c;
}
async function studentLogin(email, temp) { const c = client(); ok(await c.post('/api/auth/login', { email, password: temp })); ok(await c.post('/api/auth/change-password', { current: temp, next: 'Student-Pass-123' })); return c; }
const tfQ = [{ type: 'tf', stem: 'Zero is even.', key: { correct: 'true' }, marks: 1, topic: 'Numbers' }];
async function mkExam(t, title, class_ids = []) {
  const { id } = ok(await t.post('/api/exams', { title }));
  ok(await t.put(`/api/exams/${id}`, { title, minutes: 20, max_attempts: 1, release_mode: 'manual', show_answers: false, subject_id: 1, class_ids, questions: tfQ })); return id;
}
const HEAD = 'student_number,full_name,email,class_name,grade,academic_year,status\n';

test('setup: teachers, classes, students created through the CSV importer', async () => {
  for (let i = 0; i < 100 && !await uid('admin@t.local'); i++) await new Promise(r => setTimeout(r, 50)); // first-run admin is created asynchronously
  const a = S.admin = client(); ok(await a.post('/api/auth/login', { email: 'admin@t.local', password: 'Admin-Pass-12345' }));
  S.tA = await staffLogin(a, 'ta@t.local', 'Teacher A', 'teacher'); S.tB = await staffLogin(a, 'tb@t.local', 'Teacher B', 'teacher');
  S.cA = ok(await S.tA.post('/api/classes', { name: 'Grade 9A', grade: '9', academic_year: '2026/27', subject_id: 1 })).id;
  S.cB = ok(await S.tB.post('/api/classes', { name: 'Grade 9B', grade: '9', academic_year: '2026/27', subject_id: 1 })).id;
  const csv = HEAD + [
    'S100,"Kebede, Abebe",abebe@t.local,Grade 9A,9,2026/27,', 'S101,"Bekele ""Beki"" Tadesse",beki@t.local,Grade 9A,,,', 'S102,አበበ በቀለ,abebe2@t.local,Grade 9B,,,',
    'S103,Cara Sus,cara@t.local,Grade 9A,,,suspended', 'S104,"Line\nBreak",nl@t.local,,,,', 'S105,No Email,,,,,', 'S100,Dup Number,dupnum@t.local,,,,', 'S106,Ghost,ghost@t.local,No Such Class,,,', 'S107,Wrong Grade,wg@t.local,Grade 9A,11,,'].join('\n');
  assert.equal((await S.tA.post('/api/students/import/preview', { csv })).status, 403); // teachers cannot use the global importer
  const p = ok(await a.post('/api/students/import/preview', { csv }));
  assert.deepEqual(p.summary, { total: 9, create: 4, update: 0, skip: 0, fail: 5 });
  const err = line => p.rows.find(r => r.line === line).errors.map(e => e.column + ': ' + e.message).join(' ');
  assert.match(err(6), /control or line-break/); assert.match(err(8), /email: Email is required/); assert.match(err(9), /Duplicate student number/); assert.match(err(10), /No class named "No Such Class"/); assert.match(err(11), /No class named "Grade 9A" for grade 11/); // the row with an embedded line break spans lines 6-7
  assert.equal(await count('SELECT COUNT(*) n FROM users WHERE email=?', 'abebe@t.local'), 0); // preview saved nothing
  assert.equal((await a.post('/api/students/import/commit', { csv, digest: 'tampered' })).status, 409);
  const r = ok(await a.post('/api/students/import/commit', { csv, digest: p.digest }));
  assert.deepEqual(r.summary, { total: 9, created: 4, updated: 0, skipped: 0, failed: 5 }); assert.equal(r.credentials.length, 4);
  assert.equal(JSON.stringify(r.report_csv).includes(r.credentials[0].temp_password), false); // reports never contain passwords
  assert.match(r.report_csv, /^\ufeffstudent_number,full_name,email,class_name,grade,academic_year,status,line,result,reason/);
  const row = await db.prepare("SELECT role,must_change,pw_hash,status FROM users WHERE email='abebe@t.local'").get(); assert.deepEqual([row.role, row.must_change], ['student', 1]); assert.ok(row.pw_hash.startsWith('scrypt$'));
  assert.equal((await db.prepare("SELECT name FROM users WHERE email='abebe@t.local'").get()).name, 'Kebede, Abebe'); assert.equal((await db.prepare("SELECT name FROM users WHERE email='abebe2@t.local'").get()).name, 'አበበ በቀለ');
  assert.equal((await db.prepare("SELECT status FROM users WHERE email='cara@t.local'").get()).status, 'suspended');
  S.abebe = await studentLogin('abebe@t.local', r.credentials.find(c => c.email === 'abebe@t.local').temp_password);
  S.beki = await studentLogin('beki@t.local', r.credentials.find(c => c.email === 'beki@t.local').temp_password);
  S.abebe2 = await studentLogin('abebe2@t.local', r.credentials.find(c => c.email === 'abebe2@t.local').temp_password);
  S.ids = { abebe: await uid('abebe@t.local'), beki: await uid('beki@t.local'), abebe2: await uid('abebe2@t.local'), cara: await uid('cara@t.local') };
  assert.equal(await count("SELECT COUNT(*) n FROM class_members WHERE class_id=? AND role='student'", S.cA), 3);
});

test('import safety: no duplicate accounts, conflicts reported, silent overwrite refused, admin/teacher emails rejected', async () => {
  const a = S.admin, users = await count('SELECT COUNT(*) n FROM users');
  const again = ok(await a.post('/api/students/import/commit', { csv: HEAD + 'S100,"Kebede, Abebe",ABEBE@t.local,Grade 9A,,,\nS101,"Bekele ""Beki"" Tadesse",beki@t.local,Grade 9A,,,' }));
  assert.deepEqual(again.summary, { total: 2, created: 0, updated: 0, skipped: 2, failed: 0 }); assert.equal(await count('SELECT COUNT(*) n FROM users'), users); assert.equal(again.credentials.length, 0);
  const conf = ok(await a.post('/api/students/import/preview', { csv: HEAD + ['S999,Kebede Abebe,abebe@t.local,,,,', 'S101,Someone Else,new1@t.local,,,,', 'S5,Teach,ta@t.local,,,,', 'S6,Admin,admin@t.local,,,,', 'S7,Twin,twin@t.local,,,,\nS7,Twin Two,twin2@t.local,,,,'].join('\n') }));
  const msg = l => conf.rows.find(r => r.line === l).errors.map(e => e.message).join(' ');
  assert.match(msg(2), /already has student number "S100"/); assert.match(msg(3), /already assigned to another account/); assert.match(msg(4), /a teacher account/); assert.match(msg(5), /an administrator account/);
  assert.equal(conf.rows.find(r => r.line === 6).action, 'create'); assert.match(msg(7), /Duplicate student number/);
  // differing name: left alone by default, applied only with the deliberate update option, never touching identifiers
  const diff = HEAD + 'S100,Abebe Kebede Renamed,abebe@t.local,,,,';
  let p = ok(await a.post('/api/students/import/preview', { csv: diff })); assert.equal(p.rows[0].action, 'skip'); assert.match(p.rows[0].notes.join(' '), /left unchanged/);
  p = ok(await a.post('/api/students/import/preview', { csv: diff, update_existing: true })); assert.equal(p.rows[0].action, 'update'); assert.equal(p.rows[0].changes[0].to, 'Abebe Kebede Renamed');
  assert.equal((await db.prepare("SELECT name FROM users WHERE email='abebe@t.local'").get()).name, 'Kebede, Abebe');
  ok(await a.post('/api/students/import/commit', { csv: diff, update_existing: true })); assert.equal((await db.prepare("SELECT name FROM users WHERE email='abebe@t.local'").get()).name, 'Abebe Kebede Renamed');
  ok(await a.post('/api/students/import/commit', { csv: HEAD + 'S100,"Kebede, Abebe",abebe@t.local,,,,', update_existing: true })); // restore
  // the template example rows can never be imported by accident
  const ex = ok(await a.post('/api/students/import/preview', { csv: (await a.get('/api/students/import/example.csv')).data })); assert.equal(ex.summary.fail, 2); assert.match(ex.rows[0].errors[0].message, /example row/);
  assert.equal((await a.post('/api/students/import/preview', { csv: 'name\nA' })).status, 400); // missing required columns -> clear message
  assert.deepEqual([...(await a.raw('/api/students/import/template.csv')).subarray(0, 3)], [0xEF, 0xBB, 0xBF]); // UTF-8 BOM so Excel opens non-Latin names correctly
  const tpl = await a.get('/api/students/import/template.csv'); assert.equal(tpl.status, 200); assert.equal(tpl.data.trim(), 'student_number,full_name,email,class_name,grade,academic_year,status'); // (fetch().text() drops the BOM; Excel-compat BOM is asserted on raw bytes in the export tests)
});

test('import limits: row count, file size, value length', async () => {
  const a = S.admin; process.env.CSV_MAX_ROWS = '3';
  try { const big = HEAD + [1, 2, 3, 4].map(i => `,N${i},n${i}@t.local,,,,`).join('\n'); const r = await a.post('/api/students/import/preview', { csv: big }); assert.equal(r.status, 400); assert.match(r.data.error, /Too many rows/); assert.equal((await a.post('/api/students/import/commit', { csv: big })).status, 400); } finally { delete process.env.CSV_MAX_ROWS; }
  process.env.CSV_MAX_BYTES = '100';
  try { const r = await a.post('/api/students/import/preview', { csv: HEAD + ',' + 'x'.repeat(200) + ',a@t.local,,,,' }); assert.equal(r.status, 400); assert.match(r.data.error, /too large/); } finally { delete process.env.CSV_MAX_BYTES; }
  const r = ok(await a.post('/api/students/import/preview', { csv: HEAD + `,${'x'.repeat(100)},long@t.local,,,,` })); assert.match(r.rows[0].errors[0].message, /Too long \(maximum 80/);
  assert.equal((await fetch(base + '/api/students/import/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'eagle' }, body: JSON.stringify({ csv: 'x'.repeat(1.2e6) }) })).status, 401 | 0 === 0 ? 413 : 413); // HTTP body ceiling (1 MB)
});

test('student directory: search, filters, sorting, pagination and teacher scoping', async () => {
  const A = S.tA, B = S.tB, names = r => r.items.map(x => x.name);
  let r = ok(await A.get('/api/students?q=abebe')); assert.equal(r.total, 1); assert.equal(r.items[0].email, 'abebe@t.local'); // abebe2 (another teacher's class) is invisible
  assert.equal(ok(await A.get('/api/students?q=S101')).total, 1); assert.equal(ok(await A.get('/api/students?q=beki@')).total, 1); assert.equal(ok(await A.get('/api/students?q=Kebede,')).total, 1);
  assert.equal(ok(await A.get('/api/students?q=%25')).total, 0); // LIKE wildcards are escaped, not interpreted
  assert.equal(ok(await A.get('/api/students?q=S102')).total, 0); assert.equal(ok(await B.get('/api/students?q=S102')).total, 1);
  assert.equal(ok(await A.get(`/api/students?class_id=${S.cB}`)).total, 0); // filtering by a class you do not teach reveals nothing
  assert.equal(ok(await A.get(`/api/students?class_id=${S.cA}&status=active`)).total, 2); assert.equal(ok(await A.get('/api/students?status=suspended')).total, 1);
  assert.equal(ok(await A.get('/api/students?grade=9&academic_year=2026/27')).total, 3);
  assert.deepEqual(names(ok(await A.get('/api/students?sort=student_number&dir=desc'))), ['Cara Sus', 'Bekele "Beki" Tadesse', 'Kebede, Abebe']);
  assert.equal(ok(await A.get('/api/students')).items.every(s => !('last_login' in JSON.parse(JSON.stringify(s))) && !('pw_hash' in s)), true); // no secrets; last_login is admin-only
  assert.equal(ok(await S.admin.get('/api/students')).total, 4); assert.ok('last_login' in ok(await S.admin.get('/api/students')).items[0]);
  // multi-class student shows every class the viewer may see
  const mc = ok(await S.tA.post('/api/classes', { name: 'Math Club', grade: '9', academic_year: '2026/27' })); ok(await S.tA.post(`/api/classes/${mc.id}/members`, { email: 'abebe@t.local' }));
});
test('pagination over many students', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => `P${String(i).padStart(3, '0')},Page Kid ${String(i).padStart(2, '0')},kid${i}@t.local,Grade 9A,,,`).join('\n');
  ok(await S.admin.post('/api/students/import/commit', { csv: HEAD + rows }));
  const p1 = ok(await S.tA.get('/api/students?q=Page Kid&size=10&page=1')), p3 = ok(await S.tA.get('/api/students?q=Page Kid&size=10&page=3'));
  assert.equal(p1.total, 30); assert.equal(p1.items.length, 10); assert.equal(p3.items.length, 10); assert.equal(p3.items[0].name, 'Page Kid 20'); assert.equal(ok(await S.tA.get('/api/students?size=1000')).size, 100); // size is capped
});

test('student detail view is scoped; students cannot use the directory', async () => {
  const d = ok(await S.tA.get(`/api/students/${S.ids.abebe}`)); assert.equal(d.student.email, 'abebe@t.local'); assert.ok(d.student.classes.length >= 1); assert.ok(Array.isArray(d.exams));
  assert.equal((await S.tA.get(`/api/students/${S.ids.abebe2}`)).status, 404); assert.equal((await S.abebe.get('/api/students')).status, 403); assert.equal((await S.abebe.get(`/api/students/${S.ids.beki}`)).status, 403);
  assert.equal((await client().get('/api/students')).status, 401);
});

test('enrollment: picker search, single add, duplicate, concurrent requests, bulk, scope and suspended accounts', async () => {
  const A = S.tA, id = S.examId = await mkExam(A, 'Direct quiz');
  let c = ok(await A.get(`/api/exams/${id}/candidates?q=Kebede`)); assert.equal(c.items.length, 1); assert.equal(c.items[0].enroll.key, 'not_enrolled');
  assert.equal(ok(await A.get(`/api/exams/${id}/candidates?q=cara`)).items[0].enroll.key, 'ineligible');
  const v = ok(await A.post(`/api/exams/${id}/validate`)); assert.ok(v.issues.some(i => /class/i.test(i))); // no audience yet
  let r = ok(await A.post(`/api/exams/${id}/enrollment`, { student_ids: [S.ids.abebe] })); assert.deepEqual(r.summary, { added: 1, already: 0, failed: 0 });
  r = ok(await A.post(`/api/exams/${id}/enrollment`, { student_ids: [S.ids.abebe] })); assert.deepEqual(r.summary, { added: 0, already: 1, failed: 0 }); assert.equal(r.already[0].reason, 'Already enrolled.');
  // two simultaneous identical requests: exactly one row, exactly one "added"
  const dup = await Promise.all([A.post(`/api/exams/${id}/enrollment`, { student_ids: [S.ids.beki] }), A.post(`/api/exams/${id}/enrollment`, { student_ids: [S.ids.beki] })]);
  assert.equal(dup.reduce((n, x) => n + x.data.summary.added, 0), 1); assert.equal(await count('SELECT COUNT(*) n FROM exam_students WHERE exam_id=? AND student_id=?', id, S.ids.beki), 1);
  await assert.rejects(async () => await db.prepare('INSERT INTO exam_students(exam_id,student_id,enrolled_at) VALUES(?,?,?)').run(id, S.ids.beki, 1), /UNIQUE|constraint/i); // the database itself refuses duplicates
  await assert.rejects(async () => await db.prepare('INSERT INTO exam_students(exam_id,student_id,enrolled_at) VALUES(?,?,?)').run(id, await uid('ta@t.local'), 1), /only student accounts/);
  // bulk: new + already + out-of-scope (another teacher's student) + unknown + suspended
  const kid = await uid('kid0@t.local'), kid2 = await uid('kid1@t.local');
  r = ok(await A.post(`/api/exams/${id}/enrollment`, { student_ids: [kid, kid2, S.ids.abebe, S.ids.abebe2, 99999, S.ids.cara] }));
  assert.deepEqual(r.summary, { added: 2, already: 1, failed: 3 }); assert.ok(r.failed.some(f => f.id === S.ids.abebe2 && /not found or not available/.test(f.reason))); assert.ok(r.failed.some(f => /suspended/.test(f.reason)));
  assert.equal(await count('SELECT COUNT(*) n FROM attempts WHERE exam_id=?', id), 0); // enrolling never creates an attempt / timer
  // select-all-matching resolves on the server with the same filters
  r = ok(await A.post(`/api/exams/${id}/enrollment`, { filters: { q: 'Page Kid' } })); assert.equal(r.summary.added, 28); assert.equal(r.summary.failed, 0);
  assert.equal((await A.post(`/api/exams/${id}/enrollment`, { student_ids: [1], class_id: S.cA })).status, 400); assert.equal((await A.post(`/api/exams/${id}/enrollment`, {})).status, 400); assert.equal((await A.post(`/api/exams/${id}/enrollment`, { student_ids: ['x'] })).status, 400);
  c = ok(await A.get(`/api/exams/${id}/candidates?q=Page Kid&hide_enrolled=1`)); assert.equal(c.total, 0);
  const s = ok(await A.get(`/api/exams/${id}/enrollment`)); assert.deepEqual([s.summary.eligible, s.summary.enrolled_direct, s.summary.via_class, s.summary.started, s.summary.not_started], [32, 32, 0, 0, 32]);
  assert.equal(ok(await A.get(`/api/exams/${id}/enrollment?q=beki`)).items[0].source, 'direct');
  assert.deepEqual([s.summary.attempting, s.summary.awaiting_grading], [0, 0]); assert.equal(s.summary.not_enrolled, await count("SELECT COUNT(*) n FROM users u WHERE u.role='student' AND EXISTS(SELECT 1 FROM class_members sm JOIN class_members tm ON tm.class_id=sm.class_id AND tm.role='teacher' AND tm.user_id=? WHERE sm.user_id=u.id AND sm.role='student') AND NOT EXISTS(SELECT 1 FROM exam_students es WHERE es.exam_id=? AND es.student_id=u.id)", await uid('ta@t.local'), id)); // the not-enrolled tile matches an independent count
  const au = ok(await S.admin.get('/api/admin/audit?size=200&action=exam.enroll')).items; assert.ok(au.length >= 3); au.forEach(x => JSON.parse(x.detail));
});

test('enrollment authorisation: other teachers, students and anonymous users are refused', async () => {
  const id = S.examId, B = S.tB;
  for (const [m, u, b] of [['get', `/api/exams/${id}/enrollment`], ['get', `/api/exams/${id}/candidates`], ['post', `/api/exams/${id}/enrollment`, { student_ids: [S.ids.abebe2] }], ['del', `/api/exams/${id}/enrollment/${S.ids.abebe}`], ['get', `/api/exams/${id}/roster.csv`], ['get', `/api/exams/${id}/enrollment/template.csv`], ['post', `/api/exams/${id}/enrollment/import/preview`, { csv: 'email\na@b.cc' }]])
    assert.equal((await B[m](u, b)).status, 404, `${m} ${u}`); // exam owned by someone else: indistinguishable from "does not exist"
  assert.equal(await count('SELECT COUNT(*) n FROM exam_students WHERE student_id=?', S.ids.abebe2), 0);
  for (const [m, u, b] of [['post', `/api/exams/${id}/enrollment`, { student_ids: [S.ids.abebe2] }], ['get', `/api/exams/${id}/enrollment`], ['del', `/api/exams/${id}/enrollment/${S.ids.abebe}`], ['get', `/api/exams/${id}/roster.csv`]])
    assert.equal((await S.abebe2[m](u, b)).status, 403, 'student self-enrol ' + u); // students cannot enroll themselves by calling the API
  assert.equal((await client().post(`/api/exams/${id}/enrollment`, { student_ids: [1] })).status, 401);
  assert.equal((await S.admin.get(`/api/exams/${id}/enrollment`)).status, 403); // administrators do not own exams (existing rule)
  // a teacher cannot import into another teacher's class
  assert.equal((await B.post(`/api/classes/${S.cA}/import-csv/preview`, { csv: 'full_name,email\nX,x@t.local' })).status, 404); assert.equal((await B.get(`/api/classes/${S.cA}/members.csv`)).status, 404);
});

test('direct enrollment grants access (and only that); exam rules still apply; class assignment still works', async () => {
  const A = S.tA, id = S.examId;
  ok(await A.post(`/api/exams/${id}/validate`)); assert.deepEqual(ok(await A.post(`/api/exams/${id}/validate`)).issues, []); // direct enrollment alone satisfies "needs an audience"
  assert.equal((await S.abebe.get(`/api/student/exams/${id}`)).status, 404); // enrolled but draft: not visible yet
  ok(await A.post(`/api/exams/${id}/publish`));
  assert.ok(ok(await S.abebe.get('/api/student/exams')).items.some(e => e.id === id)); ok(await S.abebe.get(`/api/student/exams/${id}`));
  assert.equal(ok(await S.abebe2.get('/api/student/exams')).items.length, 0); // not enrolled, not in an assigned class
  assert.equal((await S.abebe2.get(`/api/student/exams/${id}`)).status, 404); assert.equal((await S.abebe2.post(`/api/student/exams/${id}/start`)).status, 404);
  const st = ok(await S.abebe.post(`/api/student/exams/${id}/start`)); S.attemptId = st.attempt.id;
  assert.equal(await count('SELECT COUNT(*) n FROM attempts WHERE exam_id=?', id), 1);
  // class-based assignment keeps working, alone and next to direct enrollment
  const cid = await mkExam(A, 'Class quiz', [S.cA]); ok(await A.post(`/api/exams/${cid}/publish`)); S.classExam = cid;
  assert.ok(ok(await S.beki.get('/api/student/exams')).items.some(e => e.id === cid)); assert.equal(ok(await S.abebe2.get('/api/student/exams')).items.some(e => e.id === cid), false);
  const sm = ok(await A.get(`/api/exams/${cid}/enrollment`)).summary; assert.deepEqual([sm.eligible, sm.enrolled_direct, sm.via_class], [33, 0, 33]);
  const r = ok(await A.post(`/api/exams/${cid}/enrollment`, { student_ids: [S.ids.beki] })); assert.match(r.already[0].reason, /through an assigned class/);
  assert.equal(ok(await A.get(`/api/exams/${cid}/candidates?q=beki`)).items[0].enroll.label, 'Enrolled (via class)');
  assert.equal(await count('SELECT COUNT(*) n FROM exam_students WHERE exam_id=?', cid), 0);
  // closing window / attempt limits still decide: a student enrolled late cannot start a closed exam
  const late = await mkExam(A, 'Window quiz'); ok(await A.post(`/api/exams/${late}/enrollment`, { student_ids: [S.ids.beki] })); ok(await A.post(`/api/exams/${late}/publish`));
  ok(await A.patch(`/api/exams/${late}/settings`, { closes: Date.now() - 5000, release_mode: 'manual' }));
  const cl = await S.beki.post(`/api/student/exams/${late}/start`); assert.equal(cl.status, 409); assert.match(cl.data.error, /closed/);
  ok(await A.patch(`/api/exams/${late}/settings`, { closes: null, release_mode: 'manual' })); ok(await S.beki.post(`/api/student/exams/${late}/start`)); // within the window it works
});

test('removing enrollment never deletes attempts, answers, grades or history', async () => {
  const A = S.tA, id = S.examId, a = await db.prepare('SELECT * FROM attempts WHERE id=?').get(S.attemptId);
  let x = await A.del(`/api/exams/${id}/enrollment/${S.ids.abebe}`); assert.equal(x.status, 409); assert.match(x.data.error, /attempt/); // in progress
  const q = ok(await S.abebe.get(`/api/student/attempts/${S.attemptId}`)).questions[0];
  ok(await S.abebe.put(`/api/student/attempts/${S.attemptId}/answers`, { items: [{ qid: q.id, value: 'true', seq: 1 }] })); ok(await S.abebe.post(`/api/student/attempts/${S.attemptId}/submit`, {}));
  await db.prepare("INSERT INTO grade_history(attempt_id,eq_id,old_marks,new_marks,by_user,at,reason) VALUES(?,?,0,1,?,?,'t')").run(S.attemptId, q.id, await uid('ta@t.local'), Date.now());
  const snap = async () => ['attempts', 'answers', 'grades', 'grade_history', 'attempt_events'].map(async t => await count(`SELECT COUNT(*) n FROM ${t}`)).join(',') + '|' + JSON.stringify(await db.prepare('SELECT status,score,total,receipt FROM attempts WHERE id=?').get(S.attemptId));
  const before = await snap(); x = await A.del(`/api/exams/${id}/enrollment/${S.ids.abebe}`); assert.equal(x.status, 409); assert.equal(await snap(), before); assert.equal(await count('SELECT COUNT(*) n FROM exam_students WHERE exam_id=? AND student_id=?', id, S.ids.abebe), 1);
  assert.deepEqual(ok(await A.get(`/api/exams/${id}/enrollment?q=abebe@`)).items[0].can_remove, false);
  // a student with no attempt can be removed; losing access takes effect immediately, and nothing else changes
  const kid = await uid('kid0@t.local'); ok(await A.del(`/api/exams/${id}/enrollment/${kid}`)); assert.equal(await snap(), before);
  assert.equal(await count('SELECT COUNT(*) n FROM exam_students WHERE exam_id=? AND student_id=?', id, kid), 0); assert.equal((await A.del(`/api/exams/${id}/enrollment/${kid}`)).status, 404);
  const viaClass = await A.del(`/api/exams/${S.classExam}/enrollment/${S.ids.beki}`); assert.equal(viaClass.status, 404); assert.match(viaClass.data.error, /assigned class/);
  assert.ok(await db.prepare("SELECT 1 FROM audit WHERE action='exam.unenroll'").get());
  const arch = await mkExam(A, 'To archive'); ok(await A.post(`/api/exams/${arch}/archive`)); assert.equal((await A.post(`/api/exams/${arch}/enrollment`, { student_ids: [S.ids.beki] })).status, 409);
});

test('exam roster CSV: import preview/commit only matches existing accounts; export format', async () => {
  const A = S.tA, id = await mkExam(A, 'Roster quiz'), users = await count('SELECT COUNT(*) n FROM users');
  const csv = 'email,student_number\nbeki@t.local,\n,S100\nABEBE@T.LOCAL,S100\nbeki@t.local,\nghost@nowhere.org,\nabebe2@t.local,\n,S100,\n,\nkid5@t.local,P999';
  const p = ok(await A.post(`/api/exams/${id}/enrollment/import/preview`, { csv })); const by = l => p.rows.find(r => r.line === l);
  assert.equal(by(2).action, 'enroll'); assert.equal(by(3).action, 'enroll'); assert.equal(by(4).action, 'skip'); assert.match(by(4).notes[0], /Duplicate/); assert.equal(by(5).action, 'skip');
  assert.match(by(6).errors[0].message, /existing accounts/); assert.match(by(7).errors[0].message, /existing accounts/); // unknown + another teacher's student look identical
  assert.match(by(9).errors[0].message, /email or a student_number/ ); assert.equal(by(10).action, 'fail'); assert.match(by(10).errors[0].message, /does not match the one on file/);
  assert.equal(await count('SELECT COUNT(*) n FROM exam_students WHERE exam_id=?', id), 0); // preview saved nothing
  const r = ok(await A.post(`/api/exams/${id}/enrollment/import/commit`, { csv, digest: p.digest }));
  assert.equal(r.summary.enrolled, 2); assert.equal(await count('SELECT COUNT(*) n FROM exam_students WHERE exam_id=?', id), 2); assert.equal(await count('SELECT COUNT(*) n FROM users'), users); // no accounts created
  assert.match(r.report_csv, /result,reason/); assert.equal((await A.post(`/api/exams/${id}/enrollment/import/commit`, { csv, digest: 'bad' })).status, 409);
  assert.equal((await A.post(`/api/exams/${id}/enrollment/import/preview`, { csv: 'name\nx' })).status, 400); assert.equal((await A.post(`/api/exams/${id}/enrollment/import/preview`, {})).status, 400);
  const roster = await A.get(`/api/exams/${id}/roster.csv`); assert.equal(roster.status, 200); assert.match(roster.headers.get('content-type'), /text\/csv; charset=utf-8/); assert.match(roster.headers.get('content-disposition'), /attachment; filename="roster-exam-\d+\.csv"/);
  const t = CSV.parse(roster.data).records; assert.deepEqual(t[0].cells, ['exam_id', 'exam_title', 'student_id', 'student_number', 'student_name', 'student_email', 'enrollment_source', 'enrolled_at', 'participation_status', 'attempt_count', 'submission_status']);
  assert.equal(t.length, 3); assert.deepEqual(t.slice(1).map(r => r.cells[6]), ['direct', 'direct']); assert.equal(t[1].cells[8], 'not_started'); assert.match(t[1].cells[7], /^\d{4}-\d\d-\d\dT/);
  assert.equal(roster.data.includes('pw_hash'), false); assert.equal(roster.data.includes('scrypt$'), false); assert.equal(roster.data.includes('"key"'), false); // no secrets or answer keys
  assert.deepEqual(CSV.parse((await A.get(`/api/exams/${id}/enrollment/template.csv`)).data).records[0].cells, ['email', 'student_number']);
});

test('class CSV: export, template, membership import without duplicates', async () => {
  const A = S.tA, ex = await A.get('/api/classes/export.csv'); assert.deepEqual(CSV.parse(ex.data).records[0].cells, ['class_id', 'class_name', 'grade', 'academic_year', 'subject', 'student_count', 'teachers', 'archived', 'created_at']);
  assert.ok(!ex.data.includes('Grade 9B')); // only classes the teacher belongs to
  const m = await A.get(`/api/classes/${S.cA}/members.csv`), rows = CSV.parse(m.data).records;
  assert.deepEqual(rows[0].cells, ['class_id', 'class_name', 'grade', 'academic_year', 'student_id', 'student_number', 'full_name', 'email', 'account_status']); assert.equal(rows.length, 1 + 33); assert.ok(m.data.includes('"Kebede, Abebe"') || m.data.includes('Kebede, Abebe'));
  assert.deepEqual(CSV.parse((await A.get('/api/classes/members-template.csv')).data).records[0].cells, ['student_number', 'full_name', 'email']);
  const users = await count('SELECT COUNT(*) n FROM users'), csv = 'student_number,full_name,email\nS100,"Kebede, Abebe",abebe@t.local\nS200,New Kid,newkid@t.local\n,Wrong class row,wc@t.local';
  const p = ok(await A.post(`/api/classes/${S.cA}/import-csv/preview`, { csv })); assert.deepEqual(p.summary, { total: 3, create: 2, update: 0, skip: 1, fail: 0 });
  const bad = ok(await A.post(`/api/classes/${S.cA}/import-csv/preview`, { csv: 'full_name,email,class_name\nZed,zed@t.local,Grade 9B' })); assert.match(bad.rows[0].errors[0].message, /targets "Grade 9A"/);
  const r = ok(await A.post(`/api/classes/${S.cA}/import-csv/commit`, { csv })); assert.equal(r.summary.created, 2); assert.equal(await count('SELECT COUNT(*) n FROM users'), users + 2);
  ok(await A.post(`/api/classes/${S.cA}/import-csv/commit`, { csv })); assert.equal(await count('SELECT COUNT(*) n FROM users'), users + 2); assert.equal(await count("SELECT COUNT(*) n FROM class_members WHERE class_id=? AND user_id=?", S.cA, S.ids.abebe), 1);
  // the legacy paste box now goes through the same engine
  const leg = ok(await A.post(`/api/classes/${S.cA}/import`, { text: '"Smith, Jo", jo@t.local, S300\nbroken' })); assert.deepEqual(leg.results.map(x => x.status), ['created', 'error']); assert.ok(leg.results[0].temp_password);
});

test('student export: scoped, same filters as the list, selection, headers, no secrets, formula-safe', async () => {
  await db.prepare("UPDATE users SET name='=HYPERLINK(\"http://evil\",\"x\")' WHERE email='cara@t.local'").run(); await db.prepare("UPDATE users SET name='+1+1' WHERE email='kid2@t.local'").run(); await db.prepare("UPDATE users SET name='@SUM(A1)' WHERE email='kid3@t.local'").run(); await db.prepare("UPDATE users SET name='-2+3' WHERE email='kid4@t.local'").run();
  const A = S.tA, x = await A.get('/api/students/export.csv'); assert.equal(x.status, 200); assert.match(x.headers.get('content-disposition'), /attachment; filename="students\.csv"/);
  const t = CSV.parse(x.data).records; assert.deepEqual(t[0].cells, ['student_id', 'student_number', 'full_name', 'email', 'account_status', 'class_names', 'grades', 'academic_years', 'created_at']); // teachers get no last_login
  assert.equal(x.data.includes('abebe2@t.local'), false); assert.equal(x.data.includes('pw_hash'), false); assert.equal(x.data.includes('scrypt'), false);
  for (const bad of ["'=HYPERLINK", "'+1+1", "'@SUM(A1)", "'-2+3"]) assert.ok(x.data.includes(bad), 'not neutralised: ' + bad);
  assert.equal(t.slice(1).some(r => /^[=+\-@]/.test(r[2])), false);
  const f = CSV.parse((await A.get('/api/students/export.csv?status=suspended')).data).records; assert.equal(f.length, 2); assert.equal(f[1].cells[4], 'suspended');
  assert.equal(CSV.parse((await A.get(`/api/students/export.csv?ids=${S.ids.abebe},${S.ids.abebe2},${S.ids.beki}`)).data).records.length, 3); // out-of-scope id silently excluded
  assert.equal(CSV.parse((await A.get(`/api/students/export.csv?class_id=${S.cB}`)).data).records.length, 1);
  const ab = CSV.parse((await A.get(`/api/students/export.csv?q=abebe@`)).data).records[1].cells; assert.ok(ab[5].includes('Grade 9A') && ab[5].includes('Math Club') && ab[5].includes('; ')); assert.equal(ab[6], '9; 9'); // multi-class: semicolon-separated, aligned lists
  const adm = CSV.parse((await S.admin.get('/api/students/export.csv')).data).records; assert.equal(adm[0].cells.at(-1), 'last_login'); assert.ok(adm.length > 34);
  for (const c of [S.abebe, client()]) assert.ok([401, 403].includes((await c.get('/api/students/export.csv')).status));
  assert.equal((await S.tA.get('/api/admin/users/export.csv')).status, 403);
  const au = CSV.parse((await S.admin.get('/api/admin/users/export.csv?role=teacher')).data).records; assert.deepEqual(au[0].cells, ['user_id', 'full_name', 'email', 'role', 'student_number', 'account_status', 'created_at', 'last_login']); assert.equal(au.length, 3); assert.equal((await S.admin.get('/api/admin/users/export.csv')).data.includes('scrypt'), false);
});

test('results CSV: owner only, pending work never shown as a final score, real attempts and not-started rows', async () => {
  const A = S.tA, id = S.examId, x = await A.get(`/api/exams/${id}/export.csv`); assert.equal(x.status, 200);
  const t = CSV.parse(x.data).records, h = t[0].cells; assert.deepEqual(h.slice(0, 5), ['Exam ID', 'Exam title', 'Student ID', 'Student number', 'Student name']); assert.ok(h.includes('Percent') && h.includes('Grading') && h.includes('Result released') && h.includes('Extra minutes (accommodation)'));
  const col = n => h.indexOf(n), ab = t.find(r => r.cells[5] === 'abebe@t.local').cells;
  assert.equal(ab[col('Attempt status')], 'submitted'); assert.equal(ab[col('Marks')], '1'); assert.equal(ab[col('Total marks')], '1'); assert.equal(ab[col('Percent')], '100'); assert.equal(ab[col('Grading')], 'graded'); assert.equal(ab[col('Finalized')], 'no'); assert.equal(ab[col('Class')], '(direct enrollment)');
  const nb = t.find(r => r.cells[5] === 'beki@t.local').cells; assert.equal(nb[col('Attempt status')], 'not_started'); assert.equal(nb[col('Marks')], ''); assert.equal(nb[col('Grading')], 'not_started');
  // a pending (unmarked written) attempt: no score is presented
  const wid = (await A.post('/api/exams', { title: 'Written' })).data.id;
  ok(await A.put(`/api/exams/${wid}`, { title: 'Written', minutes: 20, max_attempts: 1, release_mode: 'manual', subject_id: 1, class_ids: [S.cA], questions: [{ type: 'written', stem: 'Explain', key: { guide: 'g' }, marks: 5 }] })); ok(await A.post(`/api/exams/${wid}/publish`));
  const sa = ok(await S.beki.post(`/api/student/exams/${wid}/start`)), wq = ok(await S.beki.get(`/api/student/attempts/${sa.attempt.id}`)).questions[0]; ok(await S.beki.put(`/api/student/attempts/${sa.attempt.id}/answers`, { items: [{ qid: wq.id, value: 'My explanation', seq: 1 }] })); ok(await S.beki.post(`/api/student/attempts/${sa.attempt.id}/submit`, {}));
  const pr = CSV.parse((await A.get(`/api/exams/${wid}/export.csv`)).data).records.find(r => r.cells[5] === 'beki@t.local').cells; assert.equal(pr[col('Grading')], 'pending'); assert.equal(pr[col('Marks')], ''); assert.equal(pr[col('Percent')], ''); assert.equal(pr[col('Finalized')], 'no');
  assert.equal((await S.tB.get(`/api/exams/${id}/export.csv`)).status, 404); assert.equal((await S.abebe.get(`/api/exams/${id}/export.csv`)).status, 403); assert.equal((await client().get(`/api/exams/${id}/export.csv`)).status, 401);
  await db.prepare("UPDATE users SET name='=cmd|x' WHERE email='abebe@t.local'").run(); assert.ok((await A.get(`/api/exams/${id}/export.csv`)).data.includes("'=cmd|x")); await db.prepare("UPDATE users SET name='Kebede, Abebe' WHERE email='abebe@t.local'").run();
});

test('regressions: grading summary roster counts, accommodations for direct students, backups include enrollment', async () => {
  const A = S.tA, id = S.examId, sm = ok(await A.get(`/api/exams/${id}/results`)).summary; assert.equal(sm.roster, 31); assert.equal(sm.submitted, 1);
  const ro = ok(await A.get(`/api/exams/${id}/roster`)); assert.ok(ro.some(s => s.id === S.ids.abebe)); // direct students appear in the accommodation roster
  ok(await A.post(`/api/exams/${id}/accommodations`, { student_id: S.ids.beki, extra_minutes: 5, extra_attempts: 0, note: 'approved' })); assert.equal((await A.post(`/api/exams/${id}/accommodations`, { student_id: S.ids.abebe2, extra_minutes: 5, note: 'nope' })).status, 400);
  const b = ok(await S.admin.post('/api/admin/backup')); assert.equal(b.verify.ok, true, JSON.stringify(b.verify.issues)); assert.ok(b.verify.checks_run >= 8); // the admin "Check database" button
  const Bk = require('../lib/backup'), file = path.join(tmp, 'export.ndjson.gz'); await Bk.exportTo(file); const v = await Bk.verifyFile(file);
  assert.equal(v.ok, true, v.problems.join('; ')); assert.ok(v.tables.exam_students > 20, 'the export includes direct enrollments');
  const dup = ok(await A.post(`/api/exams/${id}/duplicate`)); assert.equal(await count('SELECT COUNT(*) n FROM exam_students WHERE exam_id=?', dup.id), await count('SELECT COUNT(*) n FROM exam_students WHERE exam_id=?', id)); // a copy keeps its audience
});
