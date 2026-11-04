'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { db, tx, guarded, convert, uniqueViolation } = require('../lib/db');
test.after(async () => { await require('../lib/db').close(); });

test('placeholders: ? and ?N are numbered like SQLite, and quoted text is left alone', () => {
  assert.equal(convert('SELECT ? , ?'), 'SELECT $1 , $2');
  assert.equal(convert('SELECT ?1, ?1, ?2'), 'SELECT $1, $1, $2');
  assert.equal(convert('SELECT ?1, ?'), 'SELECT $1, $2');            // a bare ? follows the highest number used so far
  assert.equal(convert('SELECT ?2, ?'), 'SELECT $2, $3');
  assert.equal(convert("SELECT '?', \"a?b\", ? -- why?\n, ?"), "SELECT '?', \"a?b\", $1 -- why?\n, $2");
  assert.equal(convert("SELECT 'it''s ?', ?"), "SELECT 'it''s ?', $1");
});

test('typed results: bigint and numeric come back as numbers, undefined binds as NULL', async () => {
  const r = await db.prepare('SELECT 9007199254740 AS big, COUNT(*) AS n, AVG(x)::numeric AS a FROM (VALUES (1),(2)) t(x)').get();
  assert.equal(typeof r.big, 'number'); assert.equal(typeof r.n, 'number'); assert.equal(r.a, 1.5);
  assert.equal((await db.prepare('SELECT ?::text IS NULL AS isnull').get(undefined)).isnull, true);
});

test('transactions: all-or-nothing, shared by nested helper calls, and savepoints isolate a caught error', async () => {
  const name = 'tx-' + Date.now();
  await assert.rejects(() => tx(async () => { await db.prepare('INSERT INTO subjects(name) VALUES(?)').run(name); throw new Error('boom'); }), /boom/);
  assert.equal(await db.prepare('SELECT 1 FROM subjects WHERE name=?').get(name), undefined, 'rolled back');
  const helper = () => db.prepare('INSERT INTO subjects(name) VALUES(?)').run(name + '-b'); // no tx argument: it joins the transaction through the async context
  await tx(async () => { await helper(); });
  assert.ok(await db.prepare('SELECT 1 FROM subjects WHERE name=?').get(name + '-b'), 'committed');
  // a unique violation that the caller catches must not poison the rest of the transaction
  await tx(async () => {
    await db.prepare('INSERT INTO subjects(name) VALUES(?)').run(name + '-c');
    try { await guarded(() => db.prepare('INSERT INTO subjects(name) VALUES(?)').run(name + '-C')); assert.fail('should be a duplicate (case-insensitive)'); }
    catch (e) { assert.ok(uniqueViolation(e, 'subjects_name_key'), e.message); }
    await db.prepare('INSERT INTO subjects(name) VALUES(?)').run(name + '-d'); // still works
  });
  assert.ok(await db.prepare('SELECT 1 FROM subjects WHERE name=?').get(name + '-d'));
});

test('concurrent transactions do not see each other until commit', async () => {
  const name = 'iso-' + Date.now(); let release; const gate = new Promise(r => release = r);
  const writer = tx(async () => { await db.prepare('INSERT INTO subjects(name) VALUES(?)').run(name); await gate; });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(await db.prepare('SELECT 1 FROM subjects WHERE name=?').get(name), undefined, 'uncommitted rows are invisible');
  release(); await writer;
  assert.ok(await db.prepare('SELECT 1 FROM subjects WHERE name=?').get(name));
});
