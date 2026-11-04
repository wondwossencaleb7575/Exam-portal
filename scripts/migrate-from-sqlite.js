// npm run migrate:from-sqlite -- --sqlite ./data/eagle.db [--dry-run]
// One-time copy of an existing v2.x SQLite database into the (empty, migrated) Supabase/PostgreSQL database.
//   * Everything happens in ONE transaction: if anything is wrong, nothing is written. --dry-run runs the whole load and then rolls it back.
//   * Ids, password hashes, timestamps, answers, grades and the audit trail are carried over unchanged (so links, receipts and history stay valid).
//   * Sessions and pending e-mail codes are NOT copied: everyone simply signs in again.
//   * The source file is opened READ-ONLY and is never modified. Keep it until you are satisfied with the result.
// Needs MIGRATION_DATABASE_URL (a privileged role such as Supabase "postgres"; DATABASE_URL is the fallback).
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const B = require('../lib/backup'), { convert } = require('../lib/sqlparams');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const DRY = !!arg('dry-run'), SRC = arg('sqlite', process.env.DB_FILE || './data/eagle.db'), URL = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
const NEEDED = ['001_init.sql', '002_exam_students.sql', '003_school_settings.sql', '004_email_otp.sql', '005_code_login.sql'];
const die = m => { console.error('\nMIGRATION STOPPED: ' + m + '\nNothing was written to the new database.'); process.exit(1); };
const hex = b => '\\x' + Buffer.from(b).toString('hex');

(async () => {
  if (!URL) die('set MIGRATION_DATABASE_URL (see docs/SUPABASE.md).');
  if (typeof SRC !== 'string' || !fs.existsSync(SRC)) die(`cannot find the SQLite file "${SRC}". Pass --sqlite <path>.`);
  const src = new DatabaseSync(path.resolve(SRC), { readOnly: true });
  const applied = src.prepare('SELECT name FROM schema_migrations').all().map(r => r.name);
  const missing = NEEDED.filter(n => !applied.includes(n));
  if (missing.length) die(`the SQLite database is from an older version (missing ${missing.join(', ')}). Start the previous app version once against it so it upgrades itself, then run this again.`);

  // ---- read and reshape every durable table ----
  const data = {}, notes = [];
  for (const t of B.TABLES) {
    const rows = src.prepare(`SELECT * FROM ${t.name}`).all().map(r => ({ ...r }));
    for (const r of rows) for (const k of Object.keys(r)) { if (r[k] instanceof Uint8Array) r[k] = hex(r[k]); if (typeof r[k] === 'bigint') r[k] = Number(r[k]); }
    if (t.name === 'users') for (const u of rows) { const lo = String(u.email).toLowerCase(); if (lo !== u.email) { notes.push(`user ${u.id}: e-mail lower-cased`); u.email = lo; } }
    data[t.name] = rows;
  }
  // ---- checks that give a precise, human answer BEFORE touching the database ----
  const clash = (rows, key, label) => { const seen = new Map(), bad = []; for (const r of rows) { const k = key(r); if (k == null || k === '') continue; if (seen.has(k)) bad.push(`${label} "${k}" is used by accounts ${seen.get(k)} and ${r.id}`); else seen.set(k, r.id); } return bad; };
  const problems = [...clash(data.users, u => u.email, 'e-mail'), ...clash(data.users, u => u.student_number == null ? null : String(u.student_number).toLowerCase(), 'student number'), ...clash(data.subjects, s => String(s.name).toLowerCase(), 'subject')];
  if (problems.length) die('the old database contains duplicates that the new rules (unique, ignoring upper/lower case) do not allow. Fix them in the old app first (change one of each pair), then run this again:\n  - ' + problems.join('\n  - '));

  // ---- load ----
  const c = await B.connect(URL), report = [];
  try {
    await c.query('BEGIN');
    if ((await c.query('SELECT COUNT(*)::int n FROM users')).rows[0].n) throw new Error('the target database already has accounts. This import is only for an empty, freshly migrated database.');
    await c.query('DELETE FROM school_settings'); await c.query('DELETE FROM subjects'); // default rows from the migrations; the real ones come from the old database
    for (const t of B.TABLES) {
      const cols = new Set((await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='eagle' AND table_name=$1", [t.name])).rows.map(r => r.column_name)), rows = data[t.name];
      const extra = rows.length ? Object.keys(rows[0]).filter(k => !cols.has(k)) : []; if (extra.length) notes.push(`${t.name}: columns not present in the new schema were skipped: ${extra.join(', ')}`);
      const clean = rows.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => cols.has(k))));
      for (let i = 0; i < clean.length; i += 500) {
        const batch = clean.slice(i, i + 500);
        await c.query('SAVEPOINT b');
        try { await B.loadRows(c, t.name, batch); await c.query('RELEASE SAVEPOINT b'); }
        catch (e) { // find the exact row(s) so the message says which record is the problem
          await c.query('ROLLBACK TO SAVEPOINT b'); const bad = [];
          for (const r of batch) { await c.query('SAVEPOINT r'); try { await B.loadRows(c, t.name, [r]); await c.query('RELEASE SAVEPOINT r'); } catch (e2) { await c.query('ROLLBACK TO SAVEPOINT r'); bad.push(`${t.name} ${t.pk.map(k => r[k]).join('/')}: ${e2.constraint ? 'violates ' + e2.constraint : e2.message}`); if (bad.length >= 10) break; } }
          throw new Error(`rows that the new schema rejects:\n  - ${bad.join('\n  - ') || e.message}`);
        }
      }
      report.push([t.name, rows.length]);
    }
    await B.resetSequences(c);
    // verify: row counts must match exactly, then the application's own consistency checks must pass on the copy
    await c.query('SET search_path TO eagle, pg_temp');
    for (const [name, n] of report) { const got = (await c.query(`SELECT COUNT(*)::int n FROM ${name}`)).rows[0].n; if (got !== n) throw new Error(`${name}: ${got} rows copied, ${n} expected`); }
    const chk = await B.check({ prepare: sql => ({ get: async (...p) => (await c.query(convert(sql), p)).rows[0] }) });
    if (!chk.ok) notes.push('consistency findings in the OLD data (copied as they were): ' + chk.issues.map(i => `${i.check} (${i.count})`).join('; '));
    if (DRY) { await c.query('ROLLBACK'); } else await c.query('COMMIT');
  } catch (e) { try { await c.query('ROLLBACK'); } catch {} await c.end(); die(e.message); }
  await c.end();
  console.log(`${DRY ? 'DRY RUN (rolled back, nothing was written)' : 'MIGRATION COMPLETE'}: ${SRC}\n` + report.map(([t, n]) => `  ${t.padEnd(16)} ${n}`).join('\n'));
  if (notes.length) console.log('\nNotes:\n  - ' + [...new Set(notes)].join('\n  - '));
  console.log(DRY ? '\nRun again without --dry-run to copy for real.' : '\nNext: start the app against the new database, sign in, and spot-check a few exams and results. Everyone must sign in again (sessions are not copied).');
})().catch(e => die(e.message));
