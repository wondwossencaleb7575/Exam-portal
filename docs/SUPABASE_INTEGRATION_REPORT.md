# Supabase integration report (v2.4 → v3.0.0)

What was found, what was decided and why, what changed, how it is secured, and **what was actually tested**. Operator instructions are in [`SUPABASE.md`](SUPABASE.md).

## 1. Summary

The portal was a **Node/Express server with a SQLite file**, a custom account system (scrypt passwords, database-backed sessions, emailed one-time codes), server-side grading, and a browser that only ever talked to its own server. There was **no Supabase code, no GitHub Pages deployment and no browser-side database access** anywhere.

Decision: **Supabase is the database; the Express server stays the only database client.** The browser still never touches Supabase. All 270-odd database calls were ported to asynchronous PostgreSQL; the user interface was not redesigned (one card on the System page changed because file backups no longer exist). Section 2 explains why this is better than the alternative (browser → Supabase client + RLS), because it determines everything else.

**Not done and not claimed:** nothing was run against a live Supabase project (no credentials were available, and none were invented). Everything was tested on a real PostgreSQL 16 server with Supabase's role layout reproduced. Section 9 lists exactly what remains unverified.

## 2. The architecture decision

| | A. Server-side database access (chosen) | B. Browser talks to Supabase (anon key + RLS) |
|---|---|---|
| Answer keys, grading | Stay on the server, as now | Would have to move into database functions/Edge Functions and column-level rules |
| Accounts / OTP / throttling | Kept (mature, tested: 60 OTP tests) | Replace with Supabase Auth: every user resets their password (the custom scrypt hashes are not something I would expect Supabase Auth to import), OTP/rate-limit logic rewritten |
| Front end | Unchanged | Rewritten (every fetch to `/api`), CSP `connect-src 'self'` widened |
| Where permissions are enforced | One place (server) plus four database locks | Only RLS: one mistaken policy exposes data directly to the internet |
| Risk to a working exam system | Low (same behaviour, verified by the original test suite) | High (rewrite of the security boundary) |

The master prompt itself says to use server-side privileged logic "where the existing deployment architecture supports a secure server runtime", and to "not redesign the website unnecessarily". It does here. If you actually want option B, it is a different project, not a variation of this one.

Consequence for **RLS**: the request in the prompt to write per-user policies using `auth.uid()` does not apply, because application users are not Supabase Auth users and never hold a database credential. Writing such policies would be dead code that *looks* secure. What RLS does here is a different, real job: section 6.

## 3. Audit of the existing application

**Strong (kept, and covered by the original tests, all ported and passing):** every route is behind `requireAuth({roles})` with the role re-read from the database per request; teachers reach only their own exams/classes (ownership checked in SQL, not in the browser); a student's attempt is found only by `student_id = session user`; answer keys are never sent to a student before their result is released (and withheld while the exam is still open for others); marks are computed on the server from stored answers; sessions are stored only as SHA-256 hashes in `HttpOnly`, `SameSite=Strict` cookies; CSRF header and origin checks; scrypt with timing-equalised failures; CSP with `connect-src 'self'`; JSON logs without bodies/queries; append-only audit log. Email codes are random, keyed-hash stored, single use, expiring, with per-code, per-account and per-address limits that live in the database.

**Findings (all verified by reading the code or by a test):**

| # | Finding | Status |
|---|---|---|
| 1 | Roles can be set only by an administrator at account creation (or first-run bootstrap); no code path updates `users.role` afterwards. The whole admin router is gated on the database role. | Confirmed; now also covered by a database CHECK for `otp_exempt` (students only) |
| 2 | Login throttle, general rate limiter and the decoy store for code-only sign-in are **in server memory**, so they are per process | Documented; `render.yaml` keeps one instance. Not changed |
| 3 | `OTP_SECRET` is optional; without it every restart (and every extra instance) cannot verify earlier codes | Documented as required for multi-instance |
| 4 | A teacher can add **any existing student account** to a class by email, which then gives that teacher visibility of that student | Pre-existing, by design ("add existing student"); **left unchanged**, noted for your policy review |
| 5 | The SQLite file backup feature cannot exist for a remote database | Replaced (section 8) rather than silently dropped |
| 6 | SQLite's one-writer-at-a-time behaviour had been providing correctness for free in several places | **Eleven concurrency hazards** found while porting and fixed (section 7) |

## 4. Database schema

`supabase/migrations/` (versioned, reproducible, no dashboard-only changes):

* `20261024100000_eagle_core_schema.sql`: 22 tables in private schema `eagle`: users, sessions, subjects, classes, class_members, images, questions, exams, exam_classes, exam_students, exam_questions (exam-specific *snapshots*), accommodations, attempts, answers, grades, grade_history, attempt_events, audit, school_settings, otp_challenges, otp_events, schema_migrations.
* `20261024100100_eagle_security.sql`: role, privileges, RLS, and a self-check that aborts the migration if the result is not what section 6 states.

Choices: `bigint` identity ids (explicit ids can be loaded, so existing ids/links/receipts survive); timestamps stay **epoch milliseconds** in `bigint` and flags stay `smallint 0/1` with CHECKs (the API and all time logic are unchanged); e-mail is stored lower-case with a CHECK and a unique constraint; student numbers are unique ignoring case; JSON-bearing columns stay text validated by the application (a `jsonb` migration would change every `JSON.parse`). Constraints enforce: valid enums for status/type/role/difficulty/release mode, `minutes 1–600`, `max_attempts 1–5`, `grace 0–300`, `pass_mark 0–100`, `closes > opens`, `marks ≥ 0`, one **running** attempt per student per exam (partial unique index), unique attempt numbers, one settings row, only student accounts can be enrolled in an exam (trigger), append-only `audit` and `grade_history` (triggers, including TRUNCATE). Foreign-key columns are indexed.

An exam contains many questions (`exam_questions`, copied at publish so later bank edits never change a published exam); a student may have several attempts up to the exam's limit; every answer and grade row is tied to its attempt and exam question by foreign key, and a test proves an answer cannot reference another exam's question.

## 5. Authentication and role model

Unchanged in behaviour, now stored in PostgreSQL: roles `admin`, `teacher`, `student`; passwords scrypt-hashed (no plaintext anywhere); sessions are random 256-bit tokens, only their hash stored, 12-hour expiry, deleted on logout and by a periodic sweep; cookie `HttpOnly; SameSite=Strict; Secure` in production; staff sign in with password **plus** an emailed code; students may use a code only (configurable); administrators can never use code-only unless explicitly named. **Supabase Auth was deliberately not adopted** (section 2). The OTP implementation was reviewed and **retained**: its design is sound, and the port found and fixed three PostgreSQL-specific weaknesses in it (section 7, items 7–9).

## 6. Row Level Security and privileges

| Lock | What | Proven by |
|---|---|---|
| 1 | Schema `eagle` is not in the Data API's exposed schemas | Documented check (dashboard) — **not verifiable offline** |
| 2 | `anon`, `authenticated`, `service_role`, `PUBLIC`: no privilege on schema, tables, sequences, functions; also revoked for tables created later | `tests/migrations-security.test.js`: every role × every table × 7 privileges via `has_table_privilege`, plus actual `SET ROLE` attempts to read `users`, `exam_questions`, `questions.key`, `attempts`, `answers`, `grades`, `pw_hash`, `sessions`, `otp_challenges`, write, and delete |
| 3 | RLS **enabled on all 22 tables**; the only policy on each is `FOR ALL TO eagle_app` | Same file: no table without RLS (also catches future migrations that forget it); every policy's role list is exactly `{eagle_app}`; with locks 1–2 **deliberately defeated** (grants added by hand) `anon`/`authenticated` still see 0 rows and cannot insert/update |
| 4 | `eagle_app`: not superuser, no BYPASSRLS/CREATEROLE/CREATEDB; per-table minimal DML; **no** DELETE on users/attempts/answers/audit, **no** UPDATE/DELETE on audit and grade_history, no TRUNCATE, no DDL, cannot alter RLS or policies, cannot grant | Same file, 14 forbidden statements (plus a `GRANT` that must be a no-op) executed as `eagle_app`; the whole application suite runs as this role, so any missing grant would fail a test |

The `using (true)` policies are scoped to `eagle_app` only and are not "unrestricted access to make the app work": the server is the trusted component. **What this model does *not* give you:** if the portal's own code had an authorization bug, RLS would not catch it (it cannot know which student is asking). That protection is the server's per-request checks and the tests in `api.test.js`/`hardening.test.js` (a student cannot read another student's attempt or an unassigned exam, keys never reach the browser, teachers cannot touch other teachers' exams, etc.).

## 7. Reliability and race conditions found by the port

PostgreSQL serves requests concurrently, unlike the single-writer SQLite file. Each of these was a **silent** problem after a mechanical conversion; each now has a fix and, where marked ✔, a test that fails if the fix is removed:

1. Submit twice at once (double click, two tabs, the deadline sweeper): row lock on the attempt; one grading, one receipt ✔
2. Autosave racing submit: shared lock + status check in one transaction; a save is either graded or refused with 409, never lost ✔
3. Two tabs saving the same answer: the loser is told `stale` with the server's copy, judged by the affected-row count ✔ (existing test)
4. Start exam ×12 simultaneously: one attempt for all ✔; the catch is limited to the unique-violation (a DB outage is no longer disguised as "try again")
5. Publish while saving a draft: exam row locked, status re-checked
6. Manual grading and time extension read their "before" values inside a row-locked transaction
7. **OTP: N parallel wrong guesses** were counted as one (all read attempts = 0): row lock + relative increments ✔ (mutation-tested)
8. **OTP timing**: the real and decoy sign-in paths now differ by several database round trips, which could reveal which addresses have accounts: minimum response time ✔ (mutation-tested)
9. **OTP background mail** must not be awaited (same reason): regression test ✔ (mutation-tested; the code converter silently re-added the `await` once, which is how this was found)
10. A class-import filter `array.filter(async …)` would have passed **every** class for the "is this teacher allowed" check (Promises are truthy): rewritten as a loop; a map of async callbacks in the teacher's attempt view and an un-awaited `forEach` inside a transaction were fixed likewise
11. Unique-violation handling by constraint **name** (not message text), savepoints so a caught violation cannot abort an enclosing transaction ✔

Other behaviour: database failures become `503` (connection errors, timeouts, deadlocks, pooler limits) or `400` (malformed numbers, out-of-range values) or `409` (duplicates/foreign keys) with plain messages and **no SQL, host, role or password** ✔; the server keeps running with the database down and recovers on its own ✔; the pool survives all connections being killed ✔; requests wait for start-up checks and answer `503` if the schema is missing.

## 8. Backups

Supabase keeps its own backups (check what your plan includes). The in-process "snapshot to server disk" scheduler could not be kept honestly, so: **System → Check database now** runs nine consistency checks (graded attempts with ungraded answers, score ≠ sum of marks, answers pointing at another exam's question, no active administrator, …); `npm run backup` writes a gzip file of every durable table from one consistent snapshot with per-table SHA-256; `npm run verify-backup` re-checks it; `npm run restore-test` loads it into a brand-new database, compares every row count, runs the consistency checks and (optionally) proves the administrator password still works. Tests cover a damaged file, a tampered value and a wrong password failing loudly ✔. See [`RECOVERY.md`](RECOVERY.md).

## 9. Tests: what was actually run

Environment: PostgreSQL 16.15 (local), Node 22.22, `eagle_app` as the application role, Supabase's `anon`/`authenticated`/`service_role` roles reproduced. Every test file gets its own freshly migrated database.

| Suite | Tests | Result |
|---|---|---|
| `api.test.js` (accounts, classes, exams, snapshots, student flow, autosave, grading, deadlines, analytics, CSV) | 12 | pass |
| `hardening.test.js` | 11 | pass |
| `enrollment.test.js` | 15 | pass |
| `platform.test.js` (incl. error-leak, append-only, backup/restore) | 15 | pass |
| `otp.test.js` (60, of which 3 new) | 60 | pass |
| `csv`, `static`, `tz` | 14 | pass |
| `migrations-security.test.js` (new) | 8 | pass |
| `concurrency.test.js` (new) | 8 | pass |
| `db-layer.test.js` (new) | 4 | pass |
| `sqlite-import.test.js` (new) | 4 | pass |
| **Total `npm test`** | **151** | **151 pass, 0 fail, ~50 s** |
| `npm run test:e2e` (real Chromium, student exam player) | 11 | 11 pass, ~37 s |

Baseline before the port: 128 passing tests. The original SQLite-upgrade tests (3) and the SQLite file-backup assertions were replaced, not deleted without a substitute. Three guards were **mutation-tested** (the fix removed → the specific test fails): the OTP row lock, the response-time floor and the un-awaited background mail. `scripts/bench.js` also ran (3,000 students, loopback database) to prove the ported script works; its numbers are not evidence about Supabase.

**Not run / not verified (be aware):**

* **Any connection to a live Supabase project**, including the pooler, TLS certificate verification (`DATABASE_CA` may be needed), `supabase db push`, the dashboard click-paths in `SUPABASE.md`, and the Data API "not exposed" check (lock 1).
* Behaviour under Supabase network latency and plan limits (connection caps, pausing).
* The `render.yaml` deployment and the published site's environment configuration.
* Load: no multi-hundred-student simultaneous exam was simulated.
* Browsers other than Chromium.

## 10. Remaining manual steps

1. Create the project, run the migrations, set the `eagle_app` password, build `DATABASE_URL` (`SUPABASE.md` steps 1–4).
2. Confirm the Data API does not expose `eagle` (step 5).
3. If you have live data: `--dry-run` then the real SQLite import (step 6); keep the old file.
4. Set the secrets on the host; keep one instance; run a supervised pilot exam.
5. Decide on finding 4 (teachers adding any existing student by email) and on multi-instance if you ever need it.
6. Schedule `npm run backup` somewhere that is **not** the web server, and rehearse `npm run restore-test` once per term.

## 11. Files

**New:** `supabase/migrations/*.sql`, `lib/{db,pgconfig,sqlparams,migrate,backup}.js`, `scripts/{migrate,migrate-from-sqlite,test-db,backup,verify-backup,restore-test}.js`, `tests/{migrations-security,concurrency,db-layer,sqlite-import}.test.js`, `tests/helpers/*`, `docs/SUPABASE*.md`, `legacy/sqlite/migrations/` (the old migrations, kept for reference and for the import test).
**Changed:** every `lib/*.js` and `routes/*.js` that touches data (async + PostgreSQL dialect), `server.js` (start-up gate, error mapping, no SQLite/backup scheduler), `public/admin.js` (System page card text and button), the tests, `package.json`, `.env.example`, `render.yaml`, `.gitignore`, `README.md`, `docs/{DEPLOYMENT,RECOVERY,…}.md`.
