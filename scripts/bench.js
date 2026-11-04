#!/usr/bin/env node
'use strict';
// Honest performance measurements on a SCRATCH PostgreSQL database. Run: TEST_DATABASE_URL=... npm run bench -- [students=20000]
// (npm run bench creates and removes its own throw-away database on that server, so it never touches your real data.)
// Prints the environment and the raw numbers; nothing here is an estimate. Never touches your real database.
const os = require('os'), path = require('path'), fs = require('fs');
const N = Number(process.argv[2]) || 20000, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-bench-'));
Object.assign(process.env, { OTP_LOGIN_MODE: 'off', ADMIN_EMAIL: 'admin@b.local', ADMIN_PASSWORD: 'Admin-Pass-12345', LOG_LEVEL: 'silent' });
const { start } = require('../server'), { db } = require('../lib/db'), A = require('../lib/auth');
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
(async () => {
  const srv = start(0), base = `http://localhost:${srv.address().port}`; for (let i = 0; i < 100 && !await db.prepare('SELECT 1 FROM users').get(); i++) await new Promise(r => setTimeout(r, 50));
  let cookie = ''; const call = async (m, u, b) => { const t = process.hrtime.bigint(), r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'eagle', cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const body = await r.text(); return { status: r.status, ms: Number(process.hrtime.bigint() - t) / 1e6, body }; };
  await call('POST', '/api/auth/login', { email: 'admin@b.local', password: 'Admin-Pass-12345' });
  // seed N students in classes of 40 with one shared (valid) password hash, set-based so seeding stays fast over a network: seeding speed is not what is being measured
  const hash = await A.hashPw('x'), now = Date.now();
  const first = ['Abebe', 'Kebede', 'Tigist', 'Meron', 'Dawit', 'Hana', 'Yonas', 'Selam', 'Bethel', 'Samuel'], last = ['Tadesse', 'Bekele', 'Alemu', 'Girma', 'Haile', 'Mengistu', 'Wolde', 'Assefa'];
  for (let from = 0; from < N; from += 2000) {
    const idx = Array.from({ length: Math.min(2000, N - from) }, (_, k) => from + k);
    await db.prepare("INSERT INTO users(email,name,role,student_number,pw_hash,must_change,created) SELECT u.e,u.n,'student',u.s,?,1,? FROM unnest(?::text[],?::text[],?::text[]) AS u(e,n,s)")
      .run(hash, now, idx.map(i => `s${i}@bench.local`), idx.map(i => `${first[i % 10]} ${last[(i / 10 | 0) % 8]} ${i}`), idx.map(i => `B${String(i).padStart(6, '0')}`));
  }
  const nCls = Math.ceil(N / 40);
  await db.prepare("INSERT INTO classes(name,grade,academic_year,created) SELECT 'Class ' || g, (9 + g % 4)::text, '2026/27', ? FROM generate_series(0, ?::int) AS g").run(now, nCls - 1);
  await db.prepare("INSERT INTO class_members(class_id,user_id,role) SELECT c.id, u.id, 'student' FROM (SELECT id, (row_number() OVER (ORDER BY id) - 1) / 40 AS k FROM users WHERE email LIKE '%@bench.local') u JOIN (SELECT id, row_number() OVER (ORDER BY id) - 1 AS k FROM classes WHERE name LIKE 'Class %') c ON c.k = u.k").run();
  if (process.env.MIGRATION_DATABASE_URL) { const { Client } = require('pg'), c = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL }); await c.connect(); await c.query('ANALYZE'); await c.end(); } // fresh statistics, as autovacuum would have produced
  const t = await call('POST', '/api/admin/users', { email: 'tb@b.local', name: 'Bench Teacher', role: 'teacher' }), tp = JSON.parse(t.body).temp_password;
  const tcookie = cookie; cookie = ''; await call('POST', '/api/auth/login', { email: 'tb@b.local', password: tp }); await call('POST', '/api/auth/change-password', { current: tp, next: 'Teacher-Pass-1234' });
  const tc = cookie; await db.prepare("INSERT INTO class_members(class_id,user_id,role) SELECT id,(SELECT id FROM users WHERE email='tb@b.local'),'teacher' FROM classes WHERE id<=60").run(); // the teacher teaches 60 classes = 2,400 students
  const time = async (label, n, fn) => { const ms = []; for (let i = 0; i < n; i++) { const r = await fn(i); if (r.status !== 200) throw new Error(label + ' failed ' + r.status + ' ' + r.body.slice(0, 120)); ms.push(r.ms); } return { label, n, p50: q(ms, .5), p95: q(ms, .95), max: Math.max(...ms) }; };
  const rows = []; cookie = tcookie;
  rows.push(await time('admin: list students, page 1 of ' + N, 30, () => call('GET', '/api/students?size=25')));
  rows.push(await time('admin: search by name ("Tigist Alemu")', 30, () => call('GET', '/api/students?q=Tigist%20Alemu&size=25')));
  rows.push(await time('admin: search by student number prefix', 30, () => call('GET', '/api/students?q=B01999&size=25')));
  rows.push(await time('admin: filter by class + sort by number', 30, i => call('GET', `/api/students?class_id=${1 + i}&sort=student_number&size=25`)));
  cookie = tc;
  rows.push(await time('teacher (2,400 students in scope): search by name', 30, () => call('GET', '/api/students?q=Meron&size=25')));
  rows.push(await time('teacher: list page 1', 30, () => call('GET', '/api/students?size=25')));
  console.log(`\nEnvironment: Node ${process.version}, ${os.cpus()[0].model} x${os.cpus().length}, ${(os.totalmem() / 2 ** 30).toFixed(1)} GB RAM, ${os.platform()} ${os.arch()}; database: ${(await db.prepare('SHOW server_version').get()).server_version} on ${new URL(process.env.DATABASE_URL).hostname}; ${N} students, ${Math.ceil(N / 40)} classes, 1 client, sequential requests, warm cache.`);
  console.log('\n| Operation | runs | p50 ms | p95 ms | max ms |\n|---|---|---|---|---|'); for (const r of rows) console.log(`| ${r.label} | ${r.n} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.max.toFixed(1)} |`);
  // streaming export of every student: time, size, and memory growth while streaming
  cookie = tcookie; const rss0 = process.memoryUsage().rss, t0 = Date.now(); const res = await fetch(base + '/api/students/export.csv', { headers: { cookie } }); let bytes = 0, peak = rss0; for await (const c of res.body) { bytes += c.length; peak = Math.max(peak, process.memoryUsage().rss); }
  console.log(`\nExport of ${N} students (streamed, gzip on the wire): ${((Date.now() - t0) / 1000).toFixed(2)} s, ${(bytes / 1e6).toFixed(2)} MB transferred, process RSS grew by ${((peak - rss0) / 2 ** 20).toFixed(0)} MB while streaming (client and server share this process).`);
  // import: preview is cheap; commit is dominated by password hashing (scrypt per new account, by design)
  const M = 100, csv = 'student_number,full_name,email,class_name\n' + Array.from({ length: M }, (_, i) => `I${i},Import Kid ${i},imp${i}@bench.local,Class 0`).join('\n');
  const pv = await call('POST', '/api/students/import/preview', { csv }); const t1 = Date.now(); const cm = await call('POST', '/api/students/import/commit', { csv });
  console.log(`Import of ${M} new students: preview ${pv.ms.toFixed(0)} ms; commit ${((Date.now() - t1) / 1000).toFixed(1)} s (${((Date.now() - t1) / M).toFixed(0)} ms per new account, almost all of it password hashing); status ${cm.status}.`);
  console.log(`Extrapolated (linear): ~${Math.round((Date.now() - t1) / M * 1000 / 1000)} s for 1000 new accounts. Re-importing existing students (no new hashing) is far faster.`);
  srv.closeAllConnections(); srv.close(); await require('../lib/db').close(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0);
})().catch(e => { console.error('bench failed:', e.message); process.exit(1); });
