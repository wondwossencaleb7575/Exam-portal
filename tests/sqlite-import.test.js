'use strict';
// The one-time SQLite -> PostgreSQL data migration (scripts/migrate-from-sqlite.js), against a database built with the REAL legacy migrations.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { Client } = require('pg');
const ROOT = path.join(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-import-')), made = [];
const mkTarget = () => { const t = JSON.parse(cp.execFileSync(process.execPath, ['scripts/test-db.js', 'create'], { cwd: ROOT, encoding: 'utf8' })); made.push(t.name); return t; };
test.after(() => { for (const n of made) { try { cp.execFileSync(process.execPath, ['scripts/test-db.js', 'drop', n], { cwd: ROOT, stdio: 'ignore' }); } catch {} } });
const q = async (url, sql, p = []) => { const c = new Client({ connectionString: url }); await c.connect(); try { await c.query('SET search_path TO eagle'); return (await c.query(sql, p)).rows; } finally { await c.end(); } };
const run = (file, target, extra = []) => cp.spawnSync(process.execPath, ['scripts/migrate-from-sqlite.js', '--sqlite', file, ...extra], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MIGRATION_DATABASE_URL: target.admin } });

function legacyDb(file, { skipLast = false, duplicateStudentNo = false } = {}) {
  const d = new DatabaseSync(file), dir = path.join(ROOT, 'legacy', 'sqlite', 'migrations'), files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  d.exec('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied INTEGER NOT NULL)');
  for (const f of skipLast ? files.slice(0, -1) : files) { d.exec(fs.readFileSync(path.join(dir, f), 'utf8')); d.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(f, 1); }
  const T = 1_760_000_000_000, hash = 'scrypt$16384$8$1$c2FsdA$aGFzaA';
  const I = (sql, ...a) => d.prepare(sql).run(...a);
  I("INSERT INTO users(id,email,name,role,student_number,pw_hash,status,must_change,created,otp_exempt) VALUES(1,'Admin@Old.Local','Old Admin','admin',NULL,?,'active',0,?,0),(2,'teach@old.local','Old Teacher','teacher',NULL,?,'active',0,?,0),(3,'stu3@old.local','Student Three','student','S-3',?,'active',0,?,1),(4,'stu4@old.local','Student Four','student','S-4',?,'active',0,?,0)", hash, T, hash, T, hash, T, hash, T);
  if (duplicateStudentNo) { for (const t of d.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='users'").all()) d.exec(`DROP TRIGGER ${t.name}`); I("INSERT INTO users(id,email,name,role,student_number,pw_hash,created) VALUES(9,'dup@old.local','Dup','student','s-3',?,?)", hash, T); }
  I("INSERT INTO subjects(id,name) VALUES(7,'Physics')");
  I("INSERT INTO classes(id,name,grade,academic_year,subject_id,created_by,created) VALUES(1,'Grade 10A','10','2026/27',1,2,?)", T);
  I("INSERT INTO class_members(class_id,user_id,role) VALUES(1,2,'teacher'),(1,3,'student')");
  I("INSERT INTO images(id,owner_id,mime,data,created) VALUES(1,2,'image/png',?,?)", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 128, 7]), T);
  I("INSERT INTO questions(id,owner_id,subject_id,type,stem,options,key,marks,topic,difficulty,image_id,created,updated) VALUES(1,2,1,'tf','Zero is even.','[]','{\"correct\":\"true\"}',1,'N','easy',1,?,?)", T, T);
  I("INSERT INTO exams(id,owner_id,subject_id,title,minutes,status,max_attempts,created,updated,published_at,pass_mark) VALUES(1,2,1,'Old exam',30,'published',2,?,?,?,60)", T, T, T);
  I("INSERT INTO exam_questions(id,exam_id,pos,type,stem,options,key,settings,marks,image_id,source_qid) VALUES(1,1,0,'tf','Zero is even.','[]','{\"correct\":\"true\"}','{}',1,1,1),(2,1,1,'numeric','Pi?','[]','{\"value\":3.14,\"tol\":0.01,\"tolType\":\"abs\"}','{}',2.5,NULL,NULL)");
  I('INSERT INTO exam_classes(exam_id,class_id) VALUES(1,1)'); I('INSERT INTO exam_students(exam_id,student_id,enrolled_by,enrolled_at) VALUES(1,4,2,?)', T);
  I("INSERT INTO attempts(id,exam_id,student_id,attempt_no,started,deadline,status,submitted_at,receipt,seed,score,total,grading_status,finalized_at,finalized_by,released_at) VALUES(1,1,3,1,?,?,'submitted',?,'ABCD1234',42,3.5,3.5,'graded',?,2,?)", T, T + 1800000, T + 600000, T + 700000, T + 800000);
  I("INSERT INTO answers(attempt_id,eq_id,value,seq,flagged,updated) VALUES(1,1,'\"true\"',2,0,?),(1,2,'\"3.14\"',3,1,?)", T, T);
  I("INSERT INTO grades(attempt_id,eq_id,marks,status,feedback,graded_by,graded_at) VALUES(1,1,1,'auto','',NULL,NULL),(1,2,2.5,'graded','nice',2,?)", T);
  I("INSERT INTO grade_history(attempt_id,eq_id,old_marks,new_marks,old_status,by_user,at,reason) VALUES(1,2,0,2.5,'pending',2,?,'marked')", T);
  I("INSERT INTO attempt_events(attempt_id,ts,kind) VALUES(1,?,'blur')", T);
  I("INSERT INTO audit(ts,actor_id,actor_email,action,resource,resource_id,detail) VALUES(?,2,'teach@old.local','exam.publish','exam',1,'{}')", T);
  I("UPDATE school_settings SET school_name='Old School', timezone='Africa/Addis_Ababa' WHERE id=1");
  I("INSERT INTO sessions(token_hash,user_id,created,expires) VALUES('tok',1,?,?)", T, T + 3600000);
  d.close(); return file;
}

test('dry run: reports what it would copy and writes nothing', async () => {
  const file = legacyDb(path.join(tmp, 'a.db')), t = mkTarget(), r = run(file, t, ['--dry-run']);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /DRY RUN/); assert.match(r.stdout, /users\s+4/); assert.match(r.stdout, /e-mail lower-cased/);
  assert.equal((await q(t.admin, 'SELECT COUNT(*)::int n FROM users'))[0].n, 0, 'nothing was written');
  assert.equal((await q(t.admin, 'SELECT COUNT(*)::int n FROM exams'))[0].n, 0);
});

test('a real run copies everything faithfully: ids, hashes, answers, grades, audit trail, images and settings', async () => {
  const file = legacyDb(path.join(tmp, 'b.db')), t = mkTarget(), r = run(file, t);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /MIGRATION COMPLETE/);
  const u = await q(t.admin, 'SELECT id,email,pw_hash,student_number,otp_exempt FROM users ORDER BY id');
  assert.deepEqual(u.map(x => [Number(x.id), x.email]), [[1, 'admin@old.local'], [2, 'teach@old.local'], [3, 'stu3@old.local'], [4, 'stu4@old.local']]); // ids kept, e-mail lower-cased
  assert.ok(u.every(x => x.pw_hash === 'scrypt$16384$8$1$c2FsdA$aGFzaA'), 'password hashes are copied byte for byte (nobody has to reset a password)');
  assert.equal(Number(u[2].otp_exempt), 1);
  const counts = Object.fromEntries((await q(t.admin, "SELECT 'exams' t, COUNT(*)::int n FROM exams UNION ALL SELECT 'exam_questions', COUNT(*)::int FROM exam_questions UNION ALL SELECT 'attempts', COUNT(*)::int FROM attempts UNION ALL SELECT 'answers', COUNT(*)::int FROM answers UNION ALL SELECT 'grades', COUNT(*)::int FROM grades UNION ALL SELECT 'grade_history', COUNT(*)::int FROM grade_history UNION ALL SELECT 'audit', COUNT(*)::int FROM audit UNION ALL SELECT 'exam_students', COUNT(*)::int FROM exam_students UNION ALL SELECT 'sessions', COUNT(*)::int FROM sessions")).map(x => [x.t, Number(x.n)]));
  assert.deepEqual(counts, { exams: 1, exam_questions: 2, attempts: 1, answers: 2, grades: 2, grade_history: 1, audit: 1, exam_students: 1, sessions: 0 }); // sessions are deliberately not copied
  const a = (await q(t.admin, 'SELECT * FROM attempts'))[0]; assert.equal(a.receipt, 'ABCD1234'); assert.equal(a.score, 3.5); assert.equal(Number(a.started), 1_760_000_000_000);
  assert.equal((await q(t.admin, 'SELECT marks FROM exam_questions WHERE id=2'))[0].marks, 2.5);
  assert.equal((await q(t.admin, 'SELECT encode(data,\'hex\') h FROM images WHERE id=1'))[0].h, '89504e470' + '0ff8007', 'binary image bytes are identical');
  assert.equal((await q(t.admin, 'SELECT school_name FROM school_settings'))[0].school_name, 'Old School');
  assert.deepEqual((await q(t.admin, 'SELECT name FROM subjects ORDER BY id')).map(x => x.name), ['Mathematics', 'Physics']);
  // sequences continue after the highest copied id, so the first NEW record cannot collide with an old one
  assert.equal(Number((await q(t.admin, "INSERT INTO users(email,name,role,pw_hash,created) VALUES('new@t.local','N','student','h',1) RETURNING id"))[0].id), 5);
  assert.equal(Number((await q(t.admin, "INSERT INTO exams(owner_id,title,created,updated) VALUES(2,'New',1,1) RETURNING id"))[0].id), 2);
  // and the copy is a working database for the application's own checks
  const chk = await require('../lib/backup').check({ prepare: sql => ({ get: async (...p) => (await q(t.admin, require('../lib/sqlparams').convert(sql), p))[0] }) });
  assert.equal(chk.ok, true, JSON.stringify(chk.issues));
  const again = run(file, t); assert.notEqual(again.status, 0); assert.match(again.stderr, /already has accounts/); // running it twice is refused, not doubled
});

test('data the new rules would reject is explained precisely, and nothing is written', async () => {
  const file = legacyDb(path.join(tmp, 'c.db'), { duplicateStudentNo: true }), t = mkTarget(), r = run(file, t);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /student number "s-3" is used by accounts 3 and 9/); assert.match(r.stderr, /Nothing was written/);
  assert.equal((await q(t.admin, 'SELECT COUNT(*)::int n FROM users'))[0].n, 0);
});

test('an old database that has not been fully upgraded is refused with instructions', async () => {
  const file = legacyDb(path.join(tmp, 'd.db'), { skipLast: true }), t = mkTarget(), r = run(file, t);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /005_code_login\.sql/); assert.match(r.stderr, /older version/);
  assert.equal((await q(t.admin, 'SELECT COUNT(*)::int n FROM users'))[0].n, 0);
  const missing = run(path.join(tmp, 'nope.db'), t); assert.notEqual(missing.status, 0); assert.match(missing.stderr, /cannot find/);
});
