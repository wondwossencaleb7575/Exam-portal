# Audit of the existing system (v2.3 → v2.4)

> **Historical document.** Written for the SQLite version (v2.x). Where it mentions the database file, WAL, `DB_FILE` or file backups, read `docs/SUPABASE_INTEGRATION_REPORT.md` for the v3 position. Its findings about authorization, grading and answer keys still describe the code, which was ported without changing those rules.

Method: read the source, traced workflows from the screen through the route to the database, ran the existing tests, then fixed what the evidence supported
and wrote tests that fail without each fix. File and function names are given; there are no line numbers because the code was edited during this work.

## 1. What was and was not inspected

| Inspected line by line | Read only partly, or checked by search | Not read |
|---|---|---|
| `server.js`; `lib/` auth, http, db, users, audit, policy, otp, grading, exam, validate, csv, students, backup, log, settings; `routes/` auth, student, exams, results, admin, classes, students, images, bank; migrations 001-003; `public/student.js`, `public/core.js`, `public/index.html` | `lib/enroll.js` (opening section), `lib/mailer.js` (opening), migration 004; all of `public/*.js` were scanned with a script for unescaped interpolations of user-controlled fields, and every flagged spot was read in context | `public/teacher.js`, `admin.js`, `analytics.js`, `students.js`, `otp.js` and `style.css` beyond the lines above; `lib/analytics.js`, `studentImport.js`, `enrollImport.js`, `emailTemplates.js`; `scripts/` (other than the backup code in `lib/`); migration 005 |

Findings below apply to what was inspected. Absence of a finding in the "not read" column is **not** evidence that the code is sound.

## 2. Architecture (as found)

Node 22 + Express 4 single process, built-in `node:sqlite` (WAL), no build step; vanilla-JS single-page front end served from `public/`. Three roles (student, teacher,
admin). Sessions are random tokens stored hashed, in an `HttpOnly` cookie, with a custom-header CSRF check. Exam content is **snapshotted** into `exam_questions` at
publish time; attempts, answers, grades, grade history and the audit log are separate tables, with append-only triggers on the audit and grade-history tables.
Authorization is enforced in route handlers (ownership and class membership checks) and one shared scoping function for student lists and exports. The database has no row-level
security (SQLite), so the server is the only enforcement point. One school per deployment: there is no tenant column anywhere.

## 3. What is strong and was left alone

* Server-authoritative deadlines; refresh/reconnect resume the same attempt; one running attempt per student enforced by a partial unique index; submit is idempotent.
* Answer keys are never sent to the student during an exam; grading is recomputed on the server from the snapshot.
* Email sign-in codes: CSPRNG, keyed hash at rest, single use consumed in the same transaction as session creation, attempt and rate counters stored in the database, decoy challenges against account enumeration.
* Grade overrides require a reason and are recorded in append-only history and the audit log; finalize is blocked while anything is pending.
* CSV exports neutralise spreadsheet formulas; student directory queries and exports share one scope function.
* No unescaped user data found in the front end's HTML templates (script-assisted scan plus manual reading of every flagged site).

## 4. Findings

**No P0 (data exposure, broken authorization, lost submissions, compromised accounts) was found in the inspected code.** That is a statement about what was read, not a security guarantee.

| ID | Pri | Finding (where) | Status |
|---|---|---|---|
| F1 | P1 | **Two tabs could silently overwrite each other while both showed "Saved".** `saveItems` in `routes/student.js` accepted an equal sequence number with different content and reported every item as saved, even ones it had ignored. | **Fixed**: `lib/answers.js` returns `saved` / `stale` / `rejected`; the exam screen adopts the server's copy and says so. |
| F2 | P1 | **One student could lock a whole school out of signing in.** `routes/auth.js` blocked an address after 30 wrong passwords in 10 minutes; a school behind one public address reaches that with ordinary typing of temporary passwords at exam start. | **Fixed**: address limit is `LOGIN_MAX_FAILS_PER_IP` (default 150); per-account limit (8) kept. The email-code limits (`OTP_MAX_*_PER_IP`) have the same shared-address trade-off and are only documented (`docs/EMAIL_OTP.md`). |
| F3 | P1 | **A finished student could receive the answer key while the exam was still open to others.** `routes/student.js` result endpoint released key and explanations as soon as the teacher released that result. | **Fixed**: `answersVisibility` in `lib/exam.js`; shown only after the exam is closed and no attempt is running. *Behaviour change* (see section 6). |
| F4 | P1 | **`1,000` typed for a numeric answer was read as 1.** `parseNum` treats a single comma as a decimal comma, so a correct "1,000" was marked wrong with no review. | **Fixed**: ambiguous commas are routed to the teacher (`numericReadings`, `docs/GRADING_RULES.md`). |
| F5 | P2 | An expired or revoked sign-in during an exam sent the student to the login page with no explanation. | **Fixed** (`public/core.js`); typed answers are kept on the device and resume after sign-in (browser-tested). |
| F6 | P2 | Every save failure showed the same "Not saved yet". Offline, server fault and rate-limit need different messages. | **Fixed** (`public/student.js`); indicator also shows the time of the last confirmed save. |
| F7 | P2 | If the automatic time-up submit got a persistent 4xx, the clock retried every 500 ms. | **Fixed**: 5 s back-off and an explanatory message. |
| F8 | P2 | Expired rows in `sessions` were never deleted. | **Fixed**: `sweepSessions` every 10 minutes. |
| F9 | P2 | Unsent answers stayed in the browser's `localStorage` on shared computers if an exam ended while offline. | **Mitigated**: removed when the server confirms the submission and after 7 days otherwise. They contain only the student's own typed answers, not questions or keys. Still readable by anyone with developer tools on that device until then. |
| F10 | P2 | The save indicator used a green "ok" style for "Saving…". | Left as is (cosmetic). |
| O1 | P2 | Question edits keep a `version` counter but **no history** of earlier versions. Exam snapshots protect running exams, but a teacher cannot see or restore an older wording. | Open |
| O2 | P2 | Each exam has one owner. No co-grading, moderation or second-marker workflow. | Open |
| O3 | P2 | Any teacher who is a member of a class can remove **any** member, including a co-teacher, using the member route in `routes/classes.js`, which checks "is a member" and not "is a teacher of this class", and ignores the archived flag. It is audited. | Open |
| O4 | P2 | A teacher can add any existing student account to their class by email, which widens what that teacher can see. Probably acceptable in one school; it needs a decision before a second school shares the deployment. | Open |
| O5 | P2 | Administrator second factor is an email code, so the mailbox is the second factor. No authenticator-app or hardware-key option. | Open |
| O6 | P2 | The attempt deadline is *start + duration*; it is **not capped by the exam's closing time**. A student starting one minute before close gets the full time. This may be intended; confirm the policy with teachers. | Open (policy) |
| O7 | P2 | Backup failures are logged to the console only; nothing alerts anyone. Backups are on the same disk as the database unless copied off. | Open (`docs/RECOVERY.md`) |
| O8 | P3 | Login and rate-limit counters are in memory: they reset on restart and do not work across several processes. Fine for one instance. | Open |
| O9 | P3 | The generic request limiter in `server.js` is keyed by the `sid` cookie value *before* the session is validated, so a client that sends a different random cookie each time gets a fresh bucket. Login, code and password endpoints have their own limits, so this weakens only the generic limit. | Open |
| O10 | P3 | `package-lock.json` still says version 2.1.0 (was already out of date). | Open |

## 5. Not verified in this work

* Behaviour on **real Express** and a real deployment (see `docs/RELEASE_STATUS.md`).
* Performance and load: no measurements were taken in this work; the figures in `docs/PERFORMANCE.md` are the previous author's and were not re-run.
* Screen-reader behaviour, Firefox, Safari, Edge, real Android devices, 200 % zoom. Only Chrome 131 (desktop and a 360 × 640 emulated phone) was driven.
* Dependency vulnerability scan (`npm audit`): no network access.
* Restore drill on separate hardware (the in-repo restore test passed, see the test report).
* Teacher, admin and analytics screens (not read).
* Ethiopian-calendar display and configurable grade structures: not examined.
