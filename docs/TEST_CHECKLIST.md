# Quality checklist

**Automated (`npm test`, 12 files and 151 tests, run against a throw-away PostgreSQL; plus `npm run test:e2e`):** sign-in/out, forced password change, throttling, role separation, suspended accounts, CSRF header, exam validation and locking, bank edits not changing published exams, answer-key never sent to students, autosave idempotency and ordering, duplicate/concurrent submit, server-enforced deadline and auto-submit, extension with reason, grading rules (numeric tolerance, partial credit), mark history, finalize gate, release gate, CSV formula safety, audit append-only, backup + verification.

**Manual before a real exam (tick each):**
- [ ] Sign in on a phone, a tablet and a laptop; one full exam on each.
- [ ] Refresh mid-exam: timer unchanged, answers still there.
- [ ] Turn Wi-Fi off mid-exam: warning appears, answers return after reconnecting.
- [ ] Open the same exam in two tabs, answer the same question in both: the second tab must say the answer was changed in another tab and show the saved one.
- [ ] Mid-exam, have an admin reset that student's password (this ends their sign-in): the student must see a plain explanation, sign in again, and find their answers.
- [ ] Release a result with "show correct answers" while the exam is still open: the student must NOT see answers; close the exam: they now do.
- [ ] 40 students sign in within one minute from the school network with temporary passwords: nobody is locked out.
- [ ] Keyboard-only run through an exam; screen-reader pass (NVDA/VoiceOver) of login, exam and result screens.
- [ ] Student cannot open `#/t` pages or `/api/exams`; student A cannot open student B's attempt.
- [ ] Restore a backup on a spare machine and sign in.
- [ ] Load test with the real number of students.
- [ ] Teacher completes the whole workflow and approves it.

## Student management, enrollment and CSV (manual run-through)
- [ ] Sign in as a teacher, open an exam → *Students & Exam Enrollment* shows six counters and an empty-state message.
- [ ] *+ Add Existing Students*: search by name, by student number and by email; filter by class; press **Add** on one student (row flips to *Enrolled*, roster behind the dialog updates).
- [ ] Tick several rows → *Add Selected Students*; tick the page checkbox → *Select all N matching* → add; try again and confirm nothing is duplicated.
- [ ] A student who belongs to another teacher's class never appears in the picker.
- [ ] *Add a class* enrolls the whole class; students already covered are skipped.
- [ ] Publish an exam that has only direct enrollments; sign in as an enrolled student (sees and starts it) and as a non-enrolled student (does not see it, cannot open it by URL).
- [ ] After a student starts or submits, *Remove* is unavailable/refused; their attempt and grade are untouched.
- [ ] Enrolled late into a closed exam → cannot start it. Archived exam → enrollment buttons are disabled.
- [ ] Students page (teacher and admin): search, filters, sort, pagination, details; suspended accounts are marked.
- [ ] Admin → *Import Students (CSV)*: download template, upload a file with a quoted comma, a quote and a non-Latin name, an invalid email, a duplicate student number and an unknown class. Preview marks exactly those rows; confirm; summary, one-time passwords and failure report appear; re-upload → everything is *skipped* (no duplicates).
- [ ] *Update existing students* off → name differences are left unchanged; on → applied, student numbers never overwritten.
- [ ] Exports open correctly in Excel (names intact): students (filtered and selected), classes, class roster, exam roster, results. A student whose name is `=1+1` shows as text, not a formula.
- [ ] Results CSV: an ungraded written answer shows *pending* with blank marks; students with no attempt show *not_started*.
- [ ] Exam roster CSV import: unknown email and another teacher's student are rejected; no accounts are created.
- [ ] Another teacher / a student / a signed-out browser cannot download these files or call the enrollment API (404/403/401).
- [ ] `npm run backup` then `npm run verify-backup` still succeed.

## Settings, pass marks, analytics, operations (manual run-through)
- [ ] Administrator → *Settings*: change the time zone, press Save, open an exam: Opens/Closes show the school zone; set a time, reload, confirm the same time comes back. Do this from a computer set to a *different* time zone.
- [ ] Switch the calendar to Ethiopian and the language to Amharic: dates show Ethiopian months; switch back.
- [ ] Add a grading scale (must include 0%), save, release an exam's results, and check a student sees the right pass/fail and letter.
- [ ] Exam editor: set pass mark, term, academic year, grade, late grace; publish; after releasing results try to change the pass mark (it must be refused).
- [ ] An exam with a written question: before you mark it, the results table shows *provisional*, no pass/fail; after marking it shows the percent and Pass/Fail.
- [ ] Analytics: apply each filter; confirm the grey population note changes; confirm a class you do not teach is not offered.
- [ ] Administrator → *Students* → a student → *Edit*: change the student number to one already in use (refused with a clear message); suspend then reactivate.
- [ ] On a real phone/tablet and a school PC: take a short exam, switch the network off for 30 s in the middle, switch it back, confirm answers are saved and the receipt appears. Use A+ and keyboard-only navigation.
- [ ] `npm run restore-test` prints `RESTORE TEST PASSED`; `GET /api/health` returns ok; stop the service with the service manager and confirm no half-finished request is lost.
- [ ] After an upgrade, `eagle.db.before-….bak` exists beside the database.

## Email sign-in codes (manual run-through with a REAL mailbox; details in `docs/EMAIL_OTP.md`, section 6)
- [ ] `npm run email:check -- your-test-address` prints *SMTP login OK* and *ACCEPTED*, and the message really arrives (check spam).
- [ ] Teacher sign-in: code screen shows a masked address; the email has the school name, the code, the expiry and the *never share* warning; the correct code opens the teacher dashboard, admin opens the admin pages.
- [ ] Wrong code → clear message and attempts left; 5 wrong codes cancel the code; the right digits entered afterwards are refused until a new code is requested.
- [ ] *Resend* is disabled during the 60 s cooldown, then works; the previous code no longer works; the 4th resend is refused.
- [ ] A code older than 5 minutes shows *expired*; resend fixes it. Reload on the code screen keeps it; *Use a different account* returns to sign-in and a direct visit to `#/verify` goes to sign-in.
- [ ] Phone: the six digits can be typed or pasted (`123 456` works), the layout fits, the countdown is readable, screen reader announces errors.
- [ ] Wrong `GMAIL_APP_PASSWORD` → sign-in shows a calm delivery error, no one is signed in, nothing secret appears in the browser or the log. Restore it.
- [ ] Student signs in with password only (default mode). With `OTP_LOGIN_MODE=all`, a student needs a code unless marked *Allow password only*.
- [ ] *System → Email verification*: *Check connection* and *Send a test email* work.
- [ ] Login page → *No password? Use an email code*: a student (not on a temporary password) receives a code and lands on *My exams*; an unknown address shows the same code screen and nothing arrives; a teacher address behaves like an unknown one (unless `OTP_CODE_LOGIN_ROLES` includes teachers).

## Supabase checks (once per environment, before the first real exam)
- [ ] `GET /api/health` shows the expected `migrations` count; *System → Check database now* reports no problems.
- [ ] Dashboard → Data API: schema `eagle` is **not** in *Exposed schemas* (or the Data API is disabled); the `curl` check in `docs/SUPABASE.md` step 5 returns no data.
- [ ] The two SQL checks in step 5 say `true` for every table and `false | false` for `anon` / `authenticated`.
- [ ] `DATABASE_URL` is set only on the server (not in a repository, a GitHub variable, or any browser-visible setting); `MIGRATION_DATABASE_URL` is **not** on the server.
- [ ] You know what your Supabase plan's backups include; `npm run backup` + `npm run restore-test` have succeeded once on a local Postgres.
- [ ] Only **one** server instance is running; the portal and the database are in the same region.
- [ ] Pilot exam with dummy students on the real hosting setup: start, answer, refresh in the middle, submit, see results.
