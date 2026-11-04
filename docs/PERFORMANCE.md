# Performance measurements

> **Historical (v2.4, SQLite).** The figures below were measured against a SQLite file on the same machine and **do not describe v3 on Supabase**: every query is now a network round trip, so latency depends on the distance between your server and your Supabase region and on your plan. `npm run bench -- 20000` (with `TEST_DATABASE_URL`) now runs the same measurements on a throw-away PostgreSQL database; it was run once during the port (3,000 students, loopback database) only to prove it works, and those numbers are not evidence about Supabase. Measure your real setup before a large exam.

Produced by `node scripts/bench.js 20000` (v2.4) on a **scratch database** (nothing estimated). Re-run it on your own server: the numbers below describe the test machine only, not your school hardware.

**Environment:** Node v22.22.2, 1 virtual CPU (Intel Xeon @ 2.10 GHz), 3.9 GB RAM, Linux x64, database on local disk, 20,000 students in 500 classes, one client, sequential requests, warm cache.

| Operation | runs | p50 ms | p95 ms | max ms |
|---|---|---|---|---|
| Admin: list students, page 1 of 20,000 | 30 | 5.8 | 13.4 | 29.3 |
| Admin: search by name ("Tigist Alemu") | 30 | 43.7 | 47.2 | 47.9 |
| Admin: search by student-number fragment | 30 | 48.6 | 64.9 | 67.5 |
| Admin: filter by class + sort by number | 30 | 10.2 | 17.7 | 18.3 |
| Teacher (2,400 students in scope): search by name | 30 | 34.9 | 43.5 | 49.6 |
| Teacher: list page 1 | 30 | 21.8 | 27.5 | 31.4 |

* **Export of 20,000 students** (streamed, gzip): 0.43 s, 2.10 MB on the wire; memory grew by 13 MB while streaming (client and server share the process in this test).
* **Import of 100 new students:** preview 22 ms; commit 3.8 s = 38 ms per new account, almost all password hashing (scrypt, deliberately slow). About 40 s per 1,000 new accounts here; re-importing existing students needs no hashing and is much faster.
* **Concurrency (automated tests):** 18 students starting, answering and submitting simultaneously → every attempt graded exactly once with the correct score; 12 simultaneous submits of one attempt → one receipt, no duplicate grades; 30 out-of-order autosaves → the last sequence wins; two simultaneous enrollments of one student → one row.
* **Compression:** `core.js` 13,396 → 4,965 bytes over the wire (63 % smaller).

**Not measured:** a browser load test with hundreds of real students, slow or lossy network behaviour, or memory/CPU on a typical school PC. Before a large simultaneous exam, run a supervised pilot with your real class size (autosave is roughly one small request per student every second or two while typing).
