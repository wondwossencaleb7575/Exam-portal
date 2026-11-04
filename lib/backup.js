'use strict';
// Database safety tools.
//   check()            application-level consistency checks, run from System > "Check database" (read-only, safe while exams are running)
//   exportTo(file)     portable, checksummed logical export (gzip, one JSON object per line) of every durable table, taken from ONE consistent
//                      snapshot. This is an independent copy you can keep OFF the platform; Supabase's own backups are separate (docs/RECOVERY.md).
//   verifyFile(file)   re-reads an export and checks every row count and SHA-256 against its manifest
//   restoreFrom(file)  loads an export into an EMPTY, migrated database (used by `npm run restore-test` and for real recoveries)
// Sessions and pending e-mail codes are deliberately NOT exported: they are short-lived secrets and everyone simply signs in again after a restore.
const fs = require('fs'), zlib = require('zlib'), crypto = require('crypto'), readline = require('readline');
const { Client } = require('pg');
const { sslFor, stripSsl } = require('./pgconfig');

// Parents first, so every foreign key is satisfied while loading.
const TABLES = [
  { name: 'subjects', pk: ['id'], identity: true }, { name: 'users', pk: ['id'], identity: true }, { name: 'classes', pk: ['id'], identity: true },
  { name: 'class_members', pk: ['class_id', 'user_id'] }, { name: 'images', pk: ['id'], identity: true, bytea: ['data'] }, { name: 'questions', pk: ['id'], identity: true },
  { name: 'exams', pk: ['id'], identity: true }, { name: 'exam_classes', pk: ['exam_id', 'class_id'] }, { name: 'exam_students', pk: ['exam_id', 'student_id'] },
  { name: 'exam_questions', pk: ['id'], identity: true }, { name: 'accommodations', pk: ['exam_id', 'student_id'] }, { name: 'attempts', pk: ['id'], identity: true },
  { name: 'answers', pk: ['attempt_id', 'eq_id'] }, { name: 'grades', pk: ['attempt_id', 'eq_id'] }, { name: 'grade_history', pk: ['id'], identity: true },
  { name: 'attempt_events', pk: ['id'], identity: true }, { name: 'audit', pk: ['id'], identity: true }, { name: 'school_settings', pk: ['id'], single: true }
];
const BATCH = 1000;
const hex = b => '\\x' + Buffer.from(b).toString('hex'); // bytea in its text form, which jsonb_populate_recordset reads back

// ---------- 1. consistency check (uses the application's own connection pool) ----------
async function check(db) {
  const n = async (sql, ...a) => (await db.prepare(sql).get(...a)).n, issues = [];
  const rules = [
    ['Graded attempts that still have ungraded answers', "SELECT COUNT(*) n FROM attempts a WHERE a.grading_status='graded' AND EXISTS(SELECT 1 FROM grades g WHERE g.attempt_id=a.id AND g.status='pending')"],
    ['Submitted attempts with no grade rows', "SELECT COUNT(*) n FROM attempts a WHERE a.status<>'in_progress' AND NOT EXISTS(SELECT 1 FROM grades g WHERE g.attempt_id=a.id)"],
    ['Submitted attempts whose stored score differs from the sum of their marks', "SELECT COUNT(*) n FROM attempts a WHERE a.status<>'in_progress' AND a.score IS NOT NULL AND abs(a.score-(SELECT COALESCE(SUM(g.marks),0) FROM grades g WHERE g.attempt_id=a.id))>0.01"],
    ['Attempts with a score higher than their total', 'SELECT COUNT(*) n FROM attempts WHERE score IS NOT NULL AND total IS NOT NULL AND score>total+0.01'],
    ['Released attempts that were never finalized', 'SELECT COUNT(*) n FROM attempts WHERE released_at IS NOT NULL AND finalized_at IS NULL'],
    ['Attempts still "in progress" more than a day after their deadline', "SELECT COUNT(*) n FROM attempts WHERE status='in_progress' AND deadline < ?"],
    ['Published exams with no questions', "SELECT COUNT(*) n FROM exams e WHERE e.status IN ('published','closed') AND NOT EXISTS(SELECT 1 FROM exam_questions q WHERE q.exam_id=e.id)"],
    ['Answers that belong to a question of a different exam', 'SELECT COUNT(*) n FROM answers a JOIN attempts t ON t.id=a.attempt_id JOIN exam_questions q ON q.id=a.eq_id WHERE q.exam_id<>t.exam_id'],
    ['Active administrator accounts (must be at least 1)', "SELECT CASE WHEN COUNT(*)>=1 THEN 0 ELSE 1 END n FROM users WHERE role='admin' AND status='active'"]
  ];
  for (const [label, sql] of rules) { const c = await n(sql, ...(sql.includes('deadline < ?') ? [Date.now() - 864e5] : [])); if (c) issues.push({ check: label, count: c }); }
  const c = async t => n(`SELECT COUNT(*) n FROM ${t}`);
  return { ok: !issues.length, integrity: issues.length ? `${issues.length} problem${issues.length === 1 ? '' : 's'} found` : 'ok', issues, checks_run: rules.length, users: await c('users'), exams: await c('exams'), attempts: await c('attempts'), answers: await c('answers'), audit: await c('audit') };
}

// ---------- 2. logical export ----------
const connect = async (url) => { const c = new Client({ connectionString: stripSsl(url), ssl: sslFor(url).ssl, application_name: 'eagle-backup' }); await c.connect(); await c.query('SET search_path TO eagle, pg_temp'); return c; };
async function exportTo(file, { url = process.env.DATABASE_URL } = {}) {
  const c = await connect(url), out = fs.createWriteStream(file, { mode: 0o600 }), gz = zlib.createGzip(); gz.pipe(out);
  const write = line => new Promise((res, rej) => gz.write(line + '\n', e => e ? rej(e) : res()));
  const manifest = {};
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); // every table is read from the same moment
    const migrations = (await c.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r => r.version);
    await write(JSON.stringify({ eagle_backup: 1, created: new Date().toISOString(), migrations }));
    for (const t of TABLES) {
      const h = crypto.createHash('sha256'); let rows = 0, last = null;
      const order = t.pk.join(','), cols = (await c.query('SELECT column_name FROM information_schema.columns WHERE table_schema=\'eagle\' AND table_name=$1', [t.name])).rows.map(r => r.column_name);
      for (;;) { // keyset-free paging by primary key order, in batches, so memory stays flat
        const r = await c.query(`SELECT * FROM ${t.name} ORDER BY ${order} LIMIT ${BATCH} OFFSET ${rows}`);
        if (!r.rows.length) break;
        for (const row of r.rows) {
          for (const b of t.bytea || []) if (row[b] != null) row[b] = hex(row[b]);
          const line = JSON.stringify({ t: t.name, r: Object.fromEntries(cols.map(k => [k, row[k]])) }); h.update(line + '\n'); await write(line); rows++;
        }
        if (r.rows.length < BATCH) break;
      }
      manifest[t.name] = { rows, sha256: h.digest('hex') };
    }
    await c.query('COMMIT');
    await write(JSON.stringify({ manifest }));
  } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; }
  finally { await c.end(); await new Promise(res => gz.end(res)); await new Promise(res => out.once('close', res)); }
  return { file, tables: manifest };
}

// ---------- 3. read / verify ----------
async function* lines(file) { for await (const l of readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity })) if (l) yield l; }
async function verifyFile(file) {
  const seen = {}, hashes = {}; let header = null, manifest = null;
  for await (const l of lines(file)) {
    const o = JSON.parse(l);
    if (o.eagle_backup) header = o; else if (o.manifest) manifest = o.manifest;
    else { (hashes[o.t] ||= crypto.createHash('sha256')).update(l + '\n'); seen[o.t] = (seen[o.t] || 0) + 1; }
  }
  const problems = [];
  if (!header) problems.push('missing header'); if (!manifest) problems.push('missing manifest (the file is incomplete)');
  for (const t of TABLES) {
    const m = manifest?.[t.name]; if (!m) { if (manifest) problems.push(`${t.name}: not in manifest`); continue; }
    if ((seen[t.name] || 0) !== m.rows) problems.push(`${t.name}: ${seen[t.name] || 0} rows read, ${m.rows} expected`);
    else if ((hashes[t.name]?.digest('hex') ?? crypto.createHash('sha256').digest('hex')) !== m.sha256) problems.push(`${t.name}: checksum mismatch`);
  }
  return { ok: !problems.length, problems, created: header?.created, tables: Object.fromEntries(TABLES.map(t => [t.name, seen[t.name] || 0])) };
}

// Bulk-insert JSON rows into one table (column names must match; bytea values are '\\x...' hex strings). Shared by restore and the SQLite import.
const loadRows = (c, table, rows) => c.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(null::eagle.${table}, $1::jsonb)`, [JSON.stringify(rows)]);
const resetSequences = async c => { for (const t of TABLES.filter(x => x.identity)) await c.query(`SELECT setval(pg_get_serial_sequence('eagle.${t.name}','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM ${t.name}),1), (SELECT COUNT(*) FROM ${t.name})>0)`); };

// ---------- 4. restore into an EMPTY migrated database (needs a privileged URL) ----------
async function restoreFrom(file, { url }) {
  const v = await verifyFile(file); if (!v.ok) throw new Error('Refusing to restore a damaged export: ' + v.problems.join('; '));
  const c = await connect(url);
  try {
    await c.query('BEGIN');
    if ((await c.query('SELECT COUNT(*)::int n FROM users')).rows[0].n) throw new Error('The target database already has accounts. Restore only into an empty, freshly migrated database.');
    await c.query('DELETE FROM school_settings'); await c.query('DELETE FROM subjects'); // the migrations seed a default settings row and subject; the export carries the real ones (the target has no accounts, so nothing refers to them)
    const buf = {}; const flush = async t => { const rows = buf[t]; if (!rows?.length) return; buf[t] = []; await loadRows(c, t, rows); };
    for await (const l of lines(file)) {
      const o = JSON.parse(l); if (!o.t) continue;
      (buf[o.t] ||= []).push(o.r); if (buf[o.t].length >= BATCH) await flush(o.t);
      // a table is complete when the next table starts; flushing in file order keeps foreign keys satisfied
      for (const k of Object.keys(buf)) if (k !== o.t) await flush(k);
    }
    for (const k of Object.keys(buf)) await flush(k);
    await resetSequences(c);
    await c.query('COMMIT');
  } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; }
  finally { await c.end(); }
  return v;
}
module.exports = { TABLES, check, exportTo, verifyFile, restoreFrom, loadRows, resetSequences, connect };
