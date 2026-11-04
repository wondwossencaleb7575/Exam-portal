'use strict';
// Applies supabase/migrations/*.sql, in file-name order, each inside ONE transaction, exactly once.
// Every migration file registers itself in eagle.schema_migrations (its last statement), so this runner and `supabase db push` leave the
// same trace and either can be used. Use ONE of them per database. Needs a privileged role (Supabase "postgres"): never the runtime role.
const fs = require('fs'), path = require('path');
const { Client } = require('pg');
const { sslFor, stripSsl } = require('./pgconfig');
const DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const versionOf = f => f.split('_')[0];

async function migrate({ url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL, log = () => {}, dir = DIR } = {}) {
  if (!url) throw new Error('Set MIGRATION_DATABASE_URL (a privileged role such as Supabase "postgres"; see docs/SUPABASE.md).');
  const files = fs.readdirSync(dir).filter(f => /^\d{14}_.+\.sql$/.test(f)).sort();
  const c = new Client({ connectionString: stripSsl(url), ssl: sslFor(url).ssl, application_name: 'eagle-migrate' });
  await c.connect();
  const applied = [];
  try {
    await c.query('SELECT pg_advisory_lock(727274)'); // two people running the migration at once would wait for each other
    const have = (await c.query("SELECT to_regclass('eagle.schema_migrations') t")).rows[0].t
      ? new Set((await c.query('SELECT version FROM eagle.schema_migrations')).rows.map(r => r.version)) : new Set();
    for (const f of files) {
      if (have.has(versionOf(f))) continue;
      log(`applying ${f}`);
      try { await c.query('BEGIN'); await c.query(fs.readFileSync(path.join(dir, f), 'utf8')); await c.query('COMMIT'); }
      catch (e) { try { await c.query('ROLLBACK'); } catch {} throw new Error(`Migration ${f} failed and was rolled back: ${e.message}`); }
      applied.push(f);
    }
  } finally { try { await c.query('SELECT pg_advisory_unlock(727274)'); } catch {} await c.end(); }
  return { applied, total: files.length };
}
module.exports = { migrate, DIR };
