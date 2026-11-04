// npm run restore-test <file>: proves that a backup can actually be restored. It builds a brand-new throw-away database, loads the export into it,
// runs the application's consistency checks against the copy, compares every row count with the export's manifest, and (optionally) confirms the
// administrator can sign in with the password you supply. Needs a PRIVILEGED URL for a DISPOSABLE server, never your live Supabase project:
//   RESTORE_ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres   (a local or docker Postgres is ideal)
//   RESTORE_ADMIN_EMAIL / RESTORE_ADMIN_PASSWORD   optional: verify the sign-in works on the restored copy
const crypto = require('crypto');
const { Client } = require('pg');
const { migrate } = require('../lib/migrate'), B = require('../lib/backup'), { convert } = require('../lib/sqlparams');
const { sslFor, stripSsl } = require('../lib/pgconfig');
const { isLocalUrl, hostOf } = require('../lib/pgconfig');
const guardTarget = u => { if (u && (/(^|\.)supabase\.(co|com|net)$/i.test(hostOf(u)) || (!isLocalUrl(u) && !process.env.RESTORE_ALLOW_REMOTE))) { console.error('Refusing to run: RESTORE_ADMIN_DATABASE_URL must be a local or Docker PostgreSQL, never your live Supabase project (host "' + hostOf(u) + '"). A disposable remote server can be allowed with RESTORE_ALLOW_REMOTE=1.'); process.exit(2); } };
const fail = m => { console.error('RESTORE TEST FAILED: ' + m); process.exitCode = 1; };
(async () => {
  const file = process.argv[2], admin = process.env.RESTORE_ADMIN_DATABASE_URL;
  guardTarget(admin);
  if (!file || !admin) { console.error('usage: RESTORE_ADMIN_DATABASE_URL=... node scripts/restore-test.js <file.ndjson.gz>'); process.exit(2); }
  const v = await B.verifyFile(file).catch(e => ({ ok: false, problems: [e.message] }));
  if (!v.ok) return fail('the backup file is damaged or incomplete: ' + v.problems.join('; '));
  console.log('backup file verified (checksums match)');
  const name = 'eagle_restore_' + crypto.randomBytes(4).toString('hex'), mk = u => new Client({ connectionString: stripSsl(u), ssl: sslFor(u).ssl });
  const withDb = n => { const x = new URL(admin); x.pathname = '/' + n; return x.toString(); };
  const a = mk(admin); await a.connect(); await a.query(`CREATE DATABASE ${name}`);
  try {
    const url = withDb(name); await migrate({ url }); await B.restoreFrom(file, { url });
    const c = mk(url); await c.connect(); await c.query('SET search_path TO eagle, pg_temp');
    try {
      const q = { prepare: sql => ({ get: async (...p) => (await c.query(convert(sql), p)).rows[0] }) };
      for (const [t, n] of Object.entries(v.tables)) { const got = (await c.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n; if (got !== n) throw new Error(`${t}: restored ${got} rows, backup holds ${n}`); }
      console.log('row counts match the backup: ' + Object.entries(v.tables).map(([t, n]) => `${t}=${n}`).join(' '));
      const chk = await B.check(q); console.log(`integrity checks: ${chk.integrity} (${chk.checks_run} checks)`); if (!chk.ok) throw new Error('consistency problems: ' + chk.issues.map(i => `${i.check} (${i.count})`).join('; '));
      const email = process.env.RESTORE_ADMIN_EMAIL, pw = process.env.RESTORE_ADMIN_PASSWORD;
      if (email && pw) {
        process.env.DATABASE_URL = url; const A = require('../lib/auth'); const u = (await c.query('SELECT pw_hash,role,status FROM users WHERE email=$1', [email.toLowerCase()])).rows[0];
        if (!u || u.role !== 'admin' || u.status !== 'active') throw new Error('that administrator account is not in the backup');
        if (!await A.verifyPw(pw, u.pw_hash)) throw new Error('the administrator password is not valid for the restored copy');
        console.log('signed in as administrator ' + email + ' on the restored copy'); await require('../lib/db').close();
      } else console.log('Sign-in check skipped (set RESTORE_ADMIN_EMAIL and RESTORE_ADMIN_PASSWORD to include it).');
      console.log('RESTORE TEST PASSED');
    } finally { await c.end(); }
  } catch (e) { fail(e.message); }
  finally { await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end(); }
})().catch(e => fail(e.message));
