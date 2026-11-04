# Audit report (v2.1)

> **Historical document.** Written for the SQLite version (v2.x). Where it mentions the database file, WAL, `DB_FILE` or file backups, read `docs/SUPABASE_INTEGRATION_REPORT.md` for the v3 position. Its findings about authorization, grading and answer keys still describe the code, which was ported without changing those rules.

Method: every file was read; every claim below was checked by running code or a test (`npm test`, 57 automated tests), not inferred from reading.

## Architecture as found
Node.js ≥ 22.13, Express 4, the built-in `node:sqlite` (WAL, foreign keys, plain-SQL migrations), vanilla JavaScript front end (no build step), KaTeX for mathematics. One process, one SQLite file. Roles: administrator, teacher, student. Authentication by server-side sessions in an HttpOnly, SameSite=Strict cookie; CSRF defence by required custom header + origin check; per-IP and per-account login throttling; scrypt password hashing; CSP without `unsafe-inline` scripts.

## What was already strong (and is now covered by tests)
* **Exam integrity is server-side.** Deadline = server start time + duration (+ approved extra minutes); a client cannot extend it. A 15 s grace window is configurable per exam. Expired attempts are closed by the server with the saved answers kept.
* **Safe autosave.** Each save carries a sequence number; stale or duplicate requests are ignored (tested with 30 saves delivered in random order).
* **Idempotent submit.** Twelve simultaneous submits produce one receipt and one set of grades. A partial unique index allows only one in-progress attempt per student per exam.
* **Published papers are snapshots** (`exam_questions` copies the content), so editing the question bank cannot change a published exam.
* **The audit log and grade history are append-only inside the database** (triggers), not only in application code.
* Answer keys are never sent to students (tested across exam page, attempt, result, and other students' attempts).

## Defects found and fixed in this round
| # | Finding | Impact | Fix |
|---|---|---|---|
| 1 | Exam opening/closing times were displayed **and entered in the browser's time zone** | A laptop with the wrong zone silently shifted an exam window | School time zone setting; all display and entry use it (`public/tz.js`, unit-tested incl. daylight-saving zones) |
| 2 | Teacher results table showed a **partial score as a percent** next to a "pending" badge | Could be read as a final mark | `percent`, pass/fail and letter exist only when grading is complete; partial values are labelled *provisional* |
| 3 | Inline `onclick="print()"` in the class-import credentials (pre-existing) | The CSP blocks inline handlers, so the Print button never worked | Delegated listener; a test now fails if any inline handler is added |
| 4 | No response compression | Slow on school links | gzip (`core.js` 13,396 → 4,965 bytes measured) |
| 5 | No graceful shutdown | A restart could cut a student's save or submit | `SIGTERM`/`SIGINT`: stop accepting, finish in-flight requests, checkpoint the WAL |
| 6 | Plain-text logs, no request ids | Hard to trace a problem | JSON logs with a request id (also returned in 500 responses); **never logs query strings, bodies or headers** |
| 7 | No indexes for name / student-number search; student numbers not unique | Slow search; duplicate identities possible | Indexes + database triggers that reject duplicate numbers (triggers, so an existing database holding duplicates can still upgrade) |
| 8 | Admin name edits unaudited; email and student number not editable | Weak accountability | One `PATCH` with validation, uniqueness, and before/after audit entries |
| 9 | Exam `grace_s` existed but could not be set; no pass mark, term, year, grade | No pass/fail at all | Fields added, validated, copied on duplicate |
| 10 | Backups were verified but **never restored** | A backup is not proof until restored | `npm run restore-test` (boots the real app on a copy and signs in); automatic **pre-upgrade snapshot** before any migration on a populated database |
| 11 | CSV streaming added a new `drain`/`close` listener per chunk (introduced in v10) | Listener leak on large exports (Node warned during the 20,000-row benchmark) | One persistent listener pair |
| 12 | `compression` (added this round) had a **high-severity** advisory; KaTeX had a prototype-pollution advisory | Vulnerable dependencies | Upgraded: `compression` 1.8.2, `katex` 0.19.0. `npm audit --omit=dev`: **0 vulnerabilities** |

## Residual risks (not fixed)
* Single SQLite process: fine for a school, not for several schools sharing one server.
* Name/number search is a substring scan (`LIKE '%x%'`): ~45 ms at 20,000 students on the test machine; adequate, but not instant at 100,000+.
* Creating many accounts is slow by design (scrypt): about 38 ms per new account on the test machine (≈ 40 s per 1,000).
* `style-src` still allows inline styles (existing); script injection remains blocked.
* No second factor for administrator accounts; password resets are administrator-initiated only (no e-mail reset flow).
* Nothing here has been tested on real school hardware, over a real HTTPS host, in a real browser on a phone, or against a professional penetration test.
