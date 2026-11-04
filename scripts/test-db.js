// Test-database helper (used by tests/helpers/setup-db.js and `npm run test:db`). Needs a throw-away PostgreSQL server:
//   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres      (a role that may CREATE DATABASE and CREATE ROLE)
// `create` makes a fresh, fully migrated database and prints JSON {name, admin, app}; `drop <name>` removes it. It never touches any other database.
const { Client } = require('pg');
const crypto = require('crypto');
const { migrate } = require('../lib/migrate');
const { sslFor, stripSsl } = require('../lib/pgconfig');
const ADMIN = process.env.TEST_DATABASE_URL;
if (!ADMIN) { console.error('Set TEST_DATABASE_URL to a throw-away PostgreSQL server (see docs/SUPABASE.md, "Running the tests").'); process.exit(2); }
const { isLocalUrl, hostOf } = require('../lib/pgconfig');
// SAFETY: this script creates databases and sets a KNOWN password on the cluster-wide role eagle_app. It must never be pointed at a real project.
if (/(^|\.)supabase\.(co|com|net)$/i.test(hostOf(ADMIN)) || (!isLocalUrl(ADMIN) && !process.env.TEST_DATABASE_ALLOW_REMOTE)) {
  console.error('Refusing to run: TEST_DATABASE_URL is not a local throw-away PostgreSQL server (host "' + hostOf(ADMIN) + '"). Use a local or Docker server, see docs/SUPABASE.md. (A remote CI database that is truly disposable can be allowed with TEST_DATABASE_ALLOW_REMOTE=1; a Supabase host is never allowed.)');
  process.exit(2);
}
const APP_PW = 'eagle_test_pw_' + 'only';
const withDb = (u, name) => { const x = new URL(u); x.pathname = '/' + name; return x.toString(); };
const conn = u => new Client({ connectionString: stripSsl(u), ssl: sslFor(u).ssl });

async function create() {
  const name = 'eagle_t_' + crypto.randomBytes(5).toString('hex'), c = conn(ADMIN); await c.connect();
  try {
    await c.query('SELECT pg_advisory_lock(424242)'); // roles are cluster-wide: set them up one process at a time
    // Supabase pre-creates these roles and the "extensions" schema; a plain local server does not.
    for (const r of ['anon', 'authenticated']) await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN CREATE ROLE ${r} NOLOGIN; END IF; END $$`);
    await c.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$");
    await c.query(`CREATE DATABASE ${name}`);
    const adminUrl = withDb(ADMIN, name);
    await migrate({ url: adminUrl });
    await c.query(`ALTER ROLE eagle_app WITH LOGIN PASSWORD '${APP_PW}'`);
    const u = new URL(adminUrl); u.username = 'eagle_app'; u.password = APP_PW;
    return { name, admin: adminUrl, app: u.toString() };
  } finally { try { await c.query('SELECT pg_advisory_unlock(424242)'); } catch {} await c.end(); }
}
async function drop(name) {
  if (!/^eagle_t_[0-9a-f]{10}$/.test(name)) throw new Error('refusing to drop a database that is not a test database');
  const c = conn(ADMIN); await c.connect();
  try { await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await c.end(); }
}
(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'create') console.log(JSON.stringify(await create()));
  else if (cmd === 'drop') await drop(arg);
  else { console.error('usage: node scripts/test-db.js create | drop <name>'); process.exit(2); }
})().catch(e => { console.error(e.message); process.exit(1); });
