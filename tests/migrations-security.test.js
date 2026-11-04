'use strict';
// Database-level tests: migrations, Row Level Security, privileges and constraints. No HTTP server involved.
// "as(role, ...)" impersonates a Supabase API role exactly the way PostgREST does (SET ROLE), so these show what an anon/authenticated/service key could reach.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { Client } = require('pg');
const { migrate, DIR } = require('../lib/migrate');
const adminQuery = require('./helpers/admin-db');
const { db } = require('../lib/db'); // connects as the least-privilege application role "eagle_app"
test.after(async () => { await require('../lib/db').close(); });

const ADMIN = () => process.env.TEST_ADMIN_DATABASE_URL, API_ROLES = ['anon', 'authenticated', 'service_role'];
async function session(fn) { const c = new Client({ connectionString: ADMIN() }); await c.connect(); try { await c.query('BEGIN'); await fn(c); } finally { try { await c.query('ROLLBACK'); } catch {} await c.end(); } } // always rolled back
const as = (role, sql, params = []) => { let out; return session(async c => { await c.query(`SET LOCAL ROLE ${role}`); out = await c.query(sql, params); }).then(() => out); };
async function expectFail(c, sql, re, params = []) { await c.query('SAVEPOINT s'); try { await c.query(sql, params); } catch (e) { await c.query('ROLLBACK TO SAVEPOINT s'); assert.match(e.message, re, sql); return; } assert.fail('should have been rejected: ' + sql); }
const tables = async () => (await adminQuery("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='eagle' AND c.relkind='r' ORDER BY 1")).rows.map(r => r.relname);

test('migrations: every file is registered once, and running the migrator again changes nothing', async () => {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).map(f => f.split('_')[0]).sort();
  const have = (await adminQuery('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r => r.version);
  assert.deepEqual(have, files);
  assert.deepEqual((await migrate({ url: ADMIN() })).applied, []);
});

test('schema: everything lives in "eagle"; nothing was created in "public" (which the Data API exposes by default)', async () => {
  assert.equal((await adminQuery("SELECT COUNT(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0);
  assert.ok((await tables()).length >= 22);
});

test('Lock 3: Row Level Security is enabled on every table, and the only policies name the application role', async () => {
  const off = (await adminQuery("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='eagle' AND c.relkind='r' AND NOT c.relrowsecurity")).rows;
  assert.deepEqual(off, [], 'tables without RLS (every new table needs "enable row level security" in its migration)');
  const pol = (await adminQuery("SELECT tablename, roles::text r FROM pg_policies WHERE schemaname='eagle'")).rows;
  assert.equal(pol.length, (await tables()).length, 'one policy per table'); assert.ok(pol.every(p => p.r === '{eagle_app}'), JSON.stringify(pol.filter(p => p.r !== '{eagle_app}')));
});

test('Locks 1-2: anon, authenticated and service_role hold no privilege on any table, and are refused when they try', async () => {
  for (const role of API_ROLES) {
    assert.equal((await adminQuery("SELECT has_schema_privilege($1,'eagle','USAGE') u", [role])).rows[0].u, false, role + ' must not even see the schema');
    for (const t of await tables()) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) assert.equal((await adminQuery('SELECT has_table_privilege($1,$2,$3) p', [role, 'eagle.' + t, priv])).rows[0].p, false, `${role} ${priv} ${t}`);
    }
    for (const sql of ['SELECT * FROM eagle.users', 'SELECT * FROM eagle.exam_questions', 'SELECT key FROM eagle.questions', 'SELECT * FROM eagle.attempts', 'SELECT * FROM eagle.answers', 'SELECT * FROM eagle.grades', 'SELECT pw_hash FROM eagle.users', 'SELECT * FROM eagle.otp_challenges', 'SELECT * FROM eagle.sessions',
      "INSERT INTO eagle.users(email,name,role,pw_hash,created) VALUES('x@x.xx','x','admin','x',1)", "UPDATE eagle.users SET role='admin'", 'DELETE FROM eagle.audit', 'SELECT * FROM eagle.schema_migrations'])
      await assert.rejects(() => as(role, sql), /permission denied/, `${role}: ${sql}`);
  }
});

test('Lock 3 on its own: even if someone grants an API role access by mistake, RLS still returns zero rows and rejects writes', async () => {
  await session(async c => {
    await c.query("INSERT INTO eagle.users(email,name,role,pw_hash,created) VALUES('rls@t.local','R','student','x',1)");
    // Open BOTH the schema and the tables (locks 1 and 2 deliberately defeated) so that only RLS is left standing:
    await c.query('GRANT USAGE ON SCHEMA eagle TO anon, authenticated'); await c.query('GRANT SELECT, INSERT, UPDATE, DELETE ON eagle.users, eagle.exam_questions, eagle.attempts TO anon, authenticated');
    assert.equal((await c.query('SELECT COUNT(*)::int n FROM eagle.users')).rows[0].n, 1, 'the privileged role sees the row');
    for (const role of ['anon', 'authenticated']) {
      await c.query('SAVEPOINT s'); await c.query(`SET LOCAL ROLE ${role}`);
      assert.equal((await c.query('SELECT COUNT(*)::int n FROM eagle.users')).rows[0].n, 0, role + ' must see zero rows');
      assert.equal((await c.query("UPDATE eagle.users SET name='pwn'")).rowCount, 0, role + ' must not be able to update');
      await assert.rejects(() => c.query("INSERT INTO eagle.users(email,name,role,pw_hash,created) VALUES('evil@t.local','E','admin','x',1)"), /row-level security/i);
      await c.query('ROLLBACK TO SAVEPOINT s');
    }
  });
});

test('Lock 4: the application role can do the application\'s work and nothing more', async () => {
  const r = (await adminQuery("SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname='eagle_app'")).rows[0];
  assert.deepEqual(r, { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false });
  assert.equal(String((await db.prepare('SELECT current_user u').get()).u), 'eagle_app');
  for (const [sql, re] of [['CREATE TABLE eagle.sneaky(id int)', /permission denied/], ['ALTER TABLE eagle.users DISABLE ROW LEVEL SECURITY', /must be owner/], ['DROP TABLE eagle.audit', /must be owner/], ['TRUNCATE eagle.users', /permission denied/], ['TRUNCATE eagle.audit', /permission denied/],
    ['DELETE FROM users', /permission denied/], ['DELETE FROM attempts', /permission denied/], ['DELETE FROM answers', /permission denied/], ['DELETE FROM audit', /permission denied/], ['UPDATE audit SET action=\'x\'', /permission denied/], ['UPDATE grade_history SET new_marks=1', /permission denied/],
    ['DROP POLICY eagle_app_only ON eagle.users', /must be owner/], ['CREATE ROLE evil', /permission denied/], ['ALTER ROLE eagle_app SUPERUSER', /permission denied/]])
    await assert.rejects(() => db.exec(sql), re, sql);
  await db.exec('GRANT SELECT ON eagle.users TO anon'); // PostgreSQL turns a non-owner GRANT into a warning and a no-op; what matters is that nothing was granted
  assert.equal((await adminQuery("SELECT has_table_privilege('anon','eagle.users','select') p")).rows[0].p, false);
  assert.ok(await db.prepare('SELECT 1 FROM users LIMIT 1').all() !== undefined);                                   // it can read...
  await db.prepare("INSERT INTO audit(ts,action) VALUES(?,'test.privileges')").run(Date.now());                    // ...and append to the audit trail
});

test('future tables are locked down by default: nobody but the owner can use a table a later migration forgets to grant', async () => {
  await session(async c => {
    await c.query('CREATE TABLE eagle.zz_future(id int)');
    for (const role of [...API_ROLES, 'eagle_app']) for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal((await c.query('SELECT has_table_privilege($1,$2,$3) p', [role, 'eagle.zz_future', priv])).rows[0].p, false, `${role} ${priv}`);
  });
});

test('validation constraints reject bad data at the database, whatever the application sends', async () => {
  await session(async c => {
    const U = (e, n, role = 'student') => c.query("INSERT INTO eagle.users(email,name,role,student_number,pw_hash,created) VALUES($1,'N',$3,$2,'h',1) RETURNING id", [e, n, role]).then(r => r.rows[0].id);
    const teacher = await U('t@t.local', null, 'teacher'), s1 = await U('s1@t.local', 'ABC-1'), s2 = await U('s2@t.local', 'ABC-2');
    await expectFail(c, "INSERT INTO eagle.users(email,name,role,pw_hash,created) VALUES('Upper@T.local','N','student','h',1)", /users_email_is_lowercase/);
    await expectFail(c, "INSERT INTO eagle.users(email,name,role,pw_hash,created) VALUES('s1@t.local','N','student','h',1)", /users_email_key/);
    await expectFail(c, "INSERT INTO eagle.users(email,name,role,student_number,pw_hash,created) VALUES('s3@t.local','N','student','abc-1','h',1)", /users_student_number_key/); // ignoring case
    await expectFail(c, "INSERT INTO eagle.users(email,name,role,pw_hash,created) VALUES('r@t.local','N','superuser','h',1)", /check constraint/);
    await expectFail(c, 'UPDATE eagle.users SET otp_exempt=1 WHERE id=$1', /users_otp_exempt_students_only/, [teacher]);
    await expectFail(c, "INSERT INTO eagle.subjects(name) VALUES('mathematics')", /subjects_name_key/);
    const E = (cols, vals) => c.query(`INSERT INTO eagle.exams(owner_id,title,created,updated,${cols}) VALUES($1,'E',1,1,${vals}) RETURNING id`, [teacher]);
    for (const [cols, vals] of [['minutes', '0'], ['minutes', '601'], ['max_attempts', '6'], ['grace_s', '301'], ['pass_mark', '101'], ['declared_total', '0'], ['status', "'weird'"], ['release_mode', "'whenever'"], ['opens,closes', '1000,1000'], ['opens,closes', '2000,1000']])
      await expectFail(c, `INSERT INTO eagle.exams(owner_id,title,created,updated,${cols}) VALUES($1,'E',1,1,${vals})`, /check constraint/, [teacher]);
    const exam = (await E('status', "'published'")).rows[0].id;
    const q = (await c.query("INSERT INTO eagle.exam_questions(exam_id,pos,type,stem) VALUES($1,0,'mcq','Q') RETURNING id", [exam])).rows[0].id;
    await expectFail(c, "INSERT INTO eagle.exam_questions(exam_id,pos,type,stem) VALUES($1,1,'essay','Q')", /check constraint/, [exam]);
    await expectFail(c, "INSERT INTO eagle.exam_questions(exam_id,pos,type,stem,marks) VALUES($1,1,'mcq','Q',-1)", /check constraint/, [exam]);
    const att = (await c.query("INSERT INTO eagle.attempts(exam_id,student_id,attempt_no,started,deadline,seed) VALUES($1,$2,1,1,2,1) RETURNING id", [exam, s1])).rows[0].id;
    await expectFail(c, 'INSERT INTO eagle.attempts(exam_id,student_id,attempt_no,started,deadline,seed) VALUES($1,$2,2,1,2,1)', /one_active_attempt/, [exam, s1]);       // a second RUNNING attempt
    await c.query("UPDATE eagle.attempts SET status='submitted' WHERE id=$1", [att]);
    await expectFail(c, 'INSERT INTO eagle.attempts(exam_id,student_id,attempt_no,started,deadline,seed) VALUES($1,$2,1,1,2,1)', /attempts_attempt_key/, [exam, s1]);      // the same attempt number twice
    await expectFail(c, "UPDATE eagle.attempts SET status='cheating' WHERE id=$1", /check constraint/, [att]);
    await expectFail(c, "INSERT INTO eagle.answers(attempt_id,eq_id,updated) VALUES(999999,$1,1)", /foreign key/, [q]);                                                      // an answer needs a real attempt
    await expectFail(c, "INSERT INTO eagle.grades(attempt_id,eq_id,marks,status) VALUES($1,$2,-1,'auto')", /check constraint/, [att, q]);
    await expectFail(c, "INSERT INTO eagle.grades(attempt_id,eq_id,marks,status) VALUES($1,$2,1,'bogus')", /check constraint/, [att, q]);
    await expectFail(c, 'INSERT INTO eagle.exam_students(exam_id,student_id,enrolled_at) VALUES($1,$2,1)', /only student accounts/, [exam, teacher]);                       // a teacher cannot be an examinee
    await expectFail(c, "INSERT INTO eagle.school_settings(id) VALUES(2)", /check constraint/);                                                                             // exactly one settings row
    await expectFail(c, "INSERT INTO eagle.otp_challenges(token_hash,user_id,purpose,email,code_hash,code_expires,challenge_expires,last_sent,created) VALUES('t',$1,'anything','e','h',1,1,1,1)", /check constraint/, [s1]);
    await c.query("INSERT INTO eagle.grades(attempt_id,eq_id,marks,status) VALUES($1,$2,1,'auto')", [att, q]); // a valid row still goes in
    assert.ok(s2);
  });
});
