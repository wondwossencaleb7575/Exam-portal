# Eagle Labs Exam Portal (v3, Supabase)

Secure online examination platform for mathematics: teacher and student accounts, classes, question bank with LaTeX, timed server-enforced exams, autosave, automatic and manual grading, results, analytics, audit log and backups.

**Stack:** Node.js 22.13+, Express, KaTeX, **PostgreSQL on Supabase**. No build step. The browser talks only to this server; the server is the only database client (no Supabase key ever reaches a browser).

```bash
cp .env.example .env     # set DATABASE_URL (secret), ADMIN_EMAIL, ADMIN_PASSWORD ... see docs/SUPABASE.md
npm install
npm run migrate          # once per database: creates the schema (needs MIGRATION_DATABASE_URL, see docs/SUPABASE.md)
npm start                # http://localhost:3000
npm run seed             # optional DUMMY pilot data (teacher@demo.local / student1@demo.local, password Demo-Pass-2026)
npm test                 # 151 automated tests; needs a THROW-AWAY PostgreSQL via TEST_DATABASE_URL (docs/SUPABASE.md); mock email: nothing is sent
npm run test:e2e         # real-browser exam-player tests (developer tool: needs Playwright, see tests/e2e/exam-player.e2e.js)
```

If you omit `ADMIN_PASSWORD` on first start, a one-time administrator password is printed in the console.

**New here? Start with [`docs/SUPABASE.md`](docs/SUPABASE.md).** Upgrading a v2 (SQLite) installation: *Moving an existing portal's data in*, same page. What was found, decided, changed and tested: [`docs/SUPABASE_INTEGRATION_REPORT.md`](docs/SUPABASE_INTEGRATION_REPORT.md).

## Roles
* **Administrator**: creates teachers/accounts, imports students from CSV, browses the central student directory, suspends users, resets passwords, assigns teachers to classes, reads the audit log, manages backups. Cannot edit marks.
* **Teacher**: classes, imports students, question bank, exams, **enrolls existing students in an exam in one click**, grading, results, CSV exports, accommodations.
* **Student**: sees assigned exams, takes them, sees only their own released results.

## Layout
`server.js` bootstrap, start-up gate, security headers, CSRF, rate limiting, sweeper · `routes/` API modules · `lib/` auth, validation, grading, database layer, backup tools · `supabase/migrations/` versioned SQL (schema, RLS, privileges) · `legacy/sqlite/` the v2 migrations, kept for reference · `public/` front end (`core.js`, `student.js`, `teacher.js`, `admin.js`) · `tests/` · `docs/`.

## Docs
`docs/SUPABASE.md` · `docs/SUPABASE_INTEGRATION_REPORT.md` · `docs/TEACHER_GUIDE.md` · `docs/DEPLOYMENT.md` · `docs/RECOVERY.md` · `docs/PRIVACY_RETENTION.md` · `docs/TEST_CHECKLIST.md` · `docs/CSV_FORMATS.md` · `docs/AUDIT_REPORT.md` · `docs/SPEC_COVERAGE.md` · `docs/PERFORMANCE.md`

## What changed in v3.0.0: Supabase (PostgreSQL) replaces SQLite

* **Data now lives in Supabase PostgreSQL**, in a private schema that the Supabase Data API does not serve. Four independent database locks (not exposed · no privileges for `anon`/`authenticated`/`service_role` · Row Level Security on every table · a least-privilege server role) protect it, in addition to the server's own permission checks, which are unchanged. Details and the tests that prove them: `docs/SUPABASE_INTEGRATION_REPORT.md`.
* **No user-visible redesign.** Accounts, passwords (hashes are copied byte for byte), emailed codes, exams, grading and results behave as before. One System-page card changed: file backups no longer exist, so it now says *Check database now* (nine consistency checks) and explains Supabase's backups plus `npm run backup`.
* **Concurrency hardening.** PostgreSQL serves many requests at once, so eleven places that SQLite's one-writer rule used to make safe now have explicit locks and tests (double submit, save racing submit, simultaneous exam start, parallel wrong-code guesses, …).
* **Databases failing is survivable**: connection loss, pauses and timeouts become `503` with a plain message, the server keeps running and recovers, and no SQL, host or password is ever shown to a browser.
* **Moving over:** `npm run migrate:from-sqlite -- --sqlite ./data/eagle.db --dry-run`, then without `--dry-run`. All-or-nothing, ids and hashes preserved.
* **Removed:** `DB_FILE`, `BACKUP_EVERY_HOURS`, `BACKUP_KEEP`, the Render disk, the in-server snapshot scheduler.

## What changed in v2.4: exam-day hardening

Evidence-based fixes from a source audit (details and honest test status: `docs/AUDIT_v2.4.md`, `docs/RELEASE_STATUS.md`):

* **Autosave tells the truth across tabs.** If another tab or window already saved a newer answer, the server now reports it as *stale* with its own copy and the exam screen shows that copy with a notice, instead of showing "saved" for an answer the server does not hold (`lib/answers.js`).
* **Clear failure states in the exam.** "No connection", "server problem" and "server busy" are named separately; an expired sign-in mid-exam explains itself, keeps the typed answers and resumes after signing in; the save indicator shows the time of the last confirmed save.
* **Answer keys are held back while the exam is still open** to other students, even after a student's result is released with "show answers" on.
* **Numeric answers like `1,000` are no longer silently read as `1`.** Ambiguous commas go to the teacher instead of being guessed (`docs/GRADING_RULES.md`).
* **A class cannot lock itself out.** The per-network-address wrong-password limit is now `LOGIN_MAX_FAILS_PER_IP` (default 150, was a fixed 30); the per-account limit is unchanged at 8 and is now `LOGIN_MAX_FAILS_PER_ACCOUNT`.
* Expired sign-in sessions are deleted periodically; unsent answers kept on a device are removed once the exam is submitted and after one week otherwise.

No database migration is needed. One behaviour change to tell teachers: "show correct answers" now takes effect once the exam has closed for everyone.

## What changed in v2.2: email sign-in codes (OTP) through Gmail
* After the password, **administrators and teachers must enter a 6-digit code emailed to them** (set `OTP_LOGIN_MODE=all` to include students; students without a mailbox can be marked *Allow password only*). Codes are random, expire in 5 minutes, are single-use, stored only as keyed hashes, and limited by attempts, resend cooldown and per-account / per-address rate limits. No session exists until the code is verified.
* **Sign in with an email code only:** students (configurable with `OTP_CODE_LOGIN_ROLES`) can also sign in with just their email and a 6-digit code, without revealing which addresses have accounts. See `docs/EMAIL_OTP.md`, section 1b.
* Setup (Gmail App Password, Render, safe rollout, manual end-to-end test, troubleshooting): **`docs/EMAIL_OTP.md`**. Variables: `.env.example`. `npm run email:check -- you@example.com` tests the real Gmail connection. *System → Email verification* does the same from the browser.
* Migration `004_email_otp.sql` only adds columns/tables (automatic pre-upgrade snapshot as before). Existing tests ran unchanged except that they set `OTP_LOGIN_MODE=off`; new suite: `tests/otp.test.js`.
* **Hosting note:** Gmail SMTP requires a *paid* Render instance (free services block SMTP). Since v3 no disk is needed.
* **Upgrading?** Deploy with `OTP_LOGIN_MODE=off` first, give every admin/teacher a real email address, configure Gmail, then switch it on (`docs/EMAIL_OTP.md`, section 3).

## What changed in v2.1
* **School settings** (administrator → *Settings*): school name, **time zone** (all exam times are shown and typed in it, never the computer's), language and **Ethiopian or Gregorian calendar display**, default pass mark, optional letter-grade scale, terms, brand colour.
* **Exams** now carry academic year, term, grade, **pass mark** and late-grace seconds; results show **pass/fail and letters only when grading is complete**; partial marks are labelled *provisional*.
* **Analytics** (teacher → *Analytics*): real figures across your exams with filters; the page states exactly what is counted.
* **Students**: administrators can edit a student (name, email, student number; duplicates refused by the database) and suspend/reactivate.
* **Operations**: gzip, graceful shutdown, JSON logs with request ids, `/api/health`, automatic pre-upgrade snapshot, `npm run restore-test`, `node scripts/bench.js`.
* Honest status of every part of the specification: `docs/SPEC_COVERAGE.md`. Findings and fixes: `docs/AUDIT_REPORT.md`. Measurements: `docs/PERFORMANCE.md`.

Commands: `npm install` · `npm start` · `npm run migrate` · `npm test` (scratch databases only) · `npm run backup` · `npm run verify-backup` · `npm run restore-test` · `npm run bench -- [students]`.

## Student management, enrollment and CSV (v9)
* **Students** page (admin: every student; teacher: students in their own classes): search by name, email or student number; filter by class, grade, academic year, status; sort; paginate; student detail; CSV export; admin CSV import.
* **Exam page → Students & Exam Enrollment**: *+ Add Existing Students* (search, filter, per-row **Add**, bulk, “select all N matching”), *Add a class*, roster search/filter, safe removal, roster CSV export and import. Access to an exam is now *direct enrollment OR assigned class*.
* Full formats, limits and rules: `docs/CSV_FORMATS.md`.

### Applying updates to an existing installation
See `docs/DEPLOYMENT.md`, *Upgrading*, and for the v2 → v3 move `docs/SUPABASE.md` step 6. (The `001`–`005` SQLite migrations that older releases applied at start-up are in `legacy/sqlite/migrations/`; the v3 schema is `supabase/migrations/`.)

## Upgrading from v8
v2 uses a new database (`data/eagle.db`) and accounts instead of exam codes; old `exam.db` data is not migrated.
