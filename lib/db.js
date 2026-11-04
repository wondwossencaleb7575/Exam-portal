'use strict';
// PostgreSQL access (Supabase). The application server is the ONLY database client: browsers never connect to Supabase.
//
// The call style of the old SQLite layer is kept on purpose so every query reads as before, now with `await`:
//     await db.prepare('SELECT ... WHERE id=?').get(id)      -> first row or undefined
//     await db.prepare('SELECT ...').all(a, b)                -> array of rows
//     await db.prepare('UPDATE ...').run(x)                   -> { changes, lastInsertRowid }  (add RETURNING id to an INSERT to get the id)
//     await tx(async () => { ...every db call in here shares ONE transaction... })
// "?" placeholders (and the numbered form ?1) are turned into $1, $2... Values are always sent as parameters, never pasted into SQL.
const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool } = require('pg');
const { log } = require('./log');
const { sslFor, stripSsl } = require('./pgconfig');

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set. Put the Supabase connection string (session pooler, role eagle_app) in .env or in your host's environment settings. See docs/SUPABASE.md.");
}
const { ssl, mode: sslMode } = sslFor(url);
if (sslMode === 'no-verify') log('warn', 'database TLS certificate is NOT being verified (DATABASE_SSL=no-verify); use verify with DATABASE_CA when possible');

const num = (name, def, lo, hi) => { const v = Number(process.env[name]); return process.env[name] && Number.isInteger(v) && v >= lo && v <= hi ? v : def; };
const STATEMENT_MS = num('DB_STATEMENT_TIMEOUT_MS', 20000, 1000, 600000);
const pool = new Pool({ connectionString: stripSsl(url), ssl, max: num('DB_POOL_MAX', 10, 1, 100), idleTimeoutMillis: 30000, connectionTimeoutMillis: num('DB_CONNECT_TIMEOUT_MS', 10000, 1000, 60000), application_name: 'eagle-exam-portal' });
// Per-connection settings, applied (and awaited) once when a physical connection is first used. The role-level search_path from the migration is
// the primary mechanism; this makes it hold for any role. (Startup parameters are avoided because connection poolers may reject them.)
const INIT = `SET search_path TO eagle, pg_temp; SET statement_timeout = ${STATEMENT_MS}; SET idle_in_transaction_session_timeout = 60000`;
async function acquire() {
  const c = await pool.connect();
  if (!c._eagleReady) { try { await c.query(INIT); c._eagleReady = true; } catch (e) { c.release(true); throw e; } }
  return c;
}
pool.on('error', e => log('error', 'idle database connection error', { err: e.message })); // never crash the process because an idle connection dropped

const { convert } = require('./sqlparams');

const als = new AsyncLocalStorage();
async function query(sql, args) {
  const text = convert(sql), params = args.map(a => a === undefined ? null : a);
  const store = als.getStore();
  try {
    if (store) return await store.client.query(text, params);
    const c = await acquire(); let broken = false;
    try { return await c.query(text, params); } catch (e) { broken = !e.code; throw e; } finally { c.release(broken); } // no SQLSTATE code = a connection-level failure: discard that connection
  } catch (e) { e.sqlSnippet = text.slice(0, 120); throw e; } // never log or return parameters
}
const prepare = sql => ({
  get: async (...a) => (await query(sql, a)).rows[0],
  all: async (...a) => (await query(sql, a)).rows,
  run: async (...a) => { const r = await query(sql, a); return { changes: r.rowCount ?? 0, lastInsertRowid: r.rows?.[0]?.id }; }
});
// Several statements at once (maintenance / DDL only: no parameters).
const exec = async sql => {
  const s = als.getStore(); if (s) return s.client.query(sql);
  const c = await acquire(); try { return await c.query(sql); } finally { c.release(); }
};

let spN = 0;
// One transaction. Every db call made inside `fn` (even deep in helper functions) uses it, because the connection travels with the async context.
// Calling tx() inside a transaction creates a SAVEPOINT: if the inner function throws, only its own changes are undone.
async function tx(fn) {
  const outer = als.getStore();
  if (outer) {
    const sp = 'sp_' + (++spN); await outer.client.query('SAVEPOINT ' + sp);
    try { const r = await fn(); await outer.client.query('RELEASE SAVEPOINT ' + sp); return r; }
    catch (e) { try { await outer.client.query('ROLLBACK TO SAVEPOINT ' + sp); } catch {} throw e; }
  }
  const client = await acquire(); let broken = false;
  try {
    await client.query('BEGIN');
    const r = await als.run({ client }, fn);
    await client.query('COMMIT'); return r;
  } catch (e) { try { await client.query('ROLLBACK'); } catch { broken = true; } throw e; }
  finally { client.release(broken); }
}
// Run fn so that a failure inside it (for example a unique-constraint error you intend to catch) cannot abort the surrounding
// transaction: inside a transaction it runs under a SAVEPOINT, outside one it simply runs.
const guarded = fn => als.getStore() ? tx(fn) : fn();
// Map constraint violations to friendly messages by constraint NAME, never by matching message text.
const uniqueViolation = (e, constraint) => e?.code === '23505' && (!constraint || e.constraint === constraint);
const ping = async () => { await pool.query('SELECT 1'); return true; };
const close = () => pool.end();
// Fail fast and clearly at start-up if the database is unreachable or the migrations have not been applied.
async function check() {
  const m = (await pool.query("SELECT to_regclass('eagle.schema_migrations') t")).rows[0].t;
  if (!m) throw new Error('The database has no "eagle" schema yet. Apply the migrations first: npm run migrate (see docs/SUPABASE.md).');
  return { migrations: (await pool.query('SELECT COUNT(*)::int n FROM eagle.schema_migrations')).rows[0].n };
}
const db = { prepare, exec };
module.exports = { db, tx, guarded, pool, ping, close, check, uniqueViolation, convert };
