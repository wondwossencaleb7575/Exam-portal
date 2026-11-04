# Release status, v3.0.0 (Supabase)

Everything here is limited to what was observed. Where something was not run, it says so. Full evidence: `docs/SUPABASE_INTEGRATION_REPORT.md`.

**Observed (PostgreSQL 16.15 locally, application connecting as the limited `eagle_app` role, Supabase's API roles reproduced):**
* `npm test`: **151 passed, 0 failed** (~50 s). `npm run test:e2e` (real Chromium, student exam player): **11 passed, 0 failed**.
* All 128 tests that existed before the port were carried over (the ones tied to SQLite internals were replaced by PostgreSQL equivalents, not dropped).
* New: database security (RLS on all 22 tables, no privileges for `anon`/`authenticated`/`service_role`, least-privilege server role, 14 forbidden statements refused, constraints), concurrency (double start, double submit, save racing submit, parallel wrong codes, dropped connections, unreachable and un-migrated databases), SQLite → PostgreSQL data import, backup / verify / restore (including a damaged file, a tampered value and a wrong password failing loudly).
* Three safeguards were mutation-tested (remove the fix → its test fails).

**Not observed (do these before relying on it):**
* Any connection to a **live Supabase project**: pooler login with the `eagle_app.<ref>` user, TLS verification against Supabase's certificate, `supabase db push`, the dashboard click-paths in `docs/SUPABASE.md`, and the check that the Data API does not expose schema `eagle`.
* Behaviour under real Supabase latency and plan limits; a multi-hundred-student simultaneous exam; the Render deployment.
* Browsers other than Chromium.

**Decisions you may want to revisit:** the server remains the only database client (Supabase Auth and browser-side RLS were deliberately not adopted; reasons in the report); one server instance; teachers can add any existing student account to a class by email (unchanged from v2).

---

*The v2.4 status follows, for history.*

## v2.4.0 status (historical)


Everything here is limited to what was observed. Where something was not run, it says so.

## 1. Summary

The existing portal was already well engineered: server-enforced deadlines, snapshotted exams, protected answer keys, an OTP sign-in flow with real brute-force protection, and a
117-test suite. This round did **not** rebuild anything. A source audit (`docs/AUDIT_v2.4.md`) found no P0 defect in the code that was read, and four P1 defects, all of
which are now fixed and covered by tests that fail when the fix is removed:

1. Autosave could show "Saved" for an answer another tab had overwritten.
2. One student could lock a whole school behind one address out of signing in.
3. A finished student could receive the answer key while classmates had not yet taken the exam.
4. A numeric answer such as `1,000` was silently read as 1.

Plus exam-screen honesty (named failure states, a plain explanation when a sign-in expires mid-exam, last-saved time), a retry back-off, session clean-up and tighter
handling of unsent answers on shared computers. A real-browser test suite for the student exam player was added.

## 2. Feature matrix (against the brief's main areas)

"Verified" means observed passing in this environment's test runs (see section 5 for the Express caveat).

| Area | Status |
|---|---|
| Server-authoritative deadlines, refresh/reconnect resume, no extra time by reloading or a forged clock | Already implemented; **re-verified in a real browser** |
| Autosave with visible saving / saved / not-saved states, retry, out-of-order protection | Already implemented; **improved and verified** (stale/conflict reporting, named causes, last-saved time) |
| Local recovery of unsent answers after refresh or outage | Already implemented; **verified**; cleanup improved |
| Expired session mid-exam | **Newly implemented and verified** (explanation, answers kept, resume) |
| Duplicate / repeated submission | Already implemented; **verified** (same receipt returned, one attempt) |
| Exam workspace: navigator, flag, review screen, confirm, receipt | Already implemented; **verified** in browser |
| Question types: single, multi-select (all-or-nothing or partial), true/false, short, numeric with tolerance, written; maths; images | Already implemented; numeric ambiguity **fixed and verified**; rules now written down (`docs/GRADING_RULES.md`) |
| Keyboard use of the exam screen, visible focus, 24 px targets on a 360 px phone, no sideways scroll | **Verified** by browser tests (Chrome only). Screen-reader behaviour **not tested** |
| Teacher: question bank, exam builder, drafts, duplication, shuffling, assignment, grading with overrides and history, release | Already implemented; **not re-read this round** apart from the answer-key wording |
| Question version history | **Not implemented** (O1) |
| Multiple graders / moderation | **Not implemented** (O2) |
| Student CSV import/export with validation and duplicate handling | Already implemented; covered by the existing 16 enrollment tests, **not re-read** |
| Analytics | Present; **not reviewed** |
| Admin: users, roles, audit log, health, settings, accommodations | Already implemented; routes read, UI **not reviewed** |
| Authentication: email codes, throttling, sessions, admin protection | Already implemented and **verified** by the existing 57 OTP tests; address limit **changed** (F2) |
| Authorization: ownership/class scoping on every route read | Already implemented; **no flaw found** in routes read; O3 and O4 open |
| Audit trail (append-only) | Already implemented; **verified** by existing tests |
| Backups, verification, restore test | Already implemented; the in-repo restore test **passed**; **not drilled on separate hardware**; no failure alerting (O7) |
| Performance / load for a real exam day | **Not measured** in this work |
| Multi-school isolation | **Not implemented** by design: one school per deployment. Do not host two schools on one deployment |
| Admin authenticator-app / hardware-key MFA | **Not implemented** (O5) |
| Amharic interface | **Excluded** as instructed |

## 3. Files changed

| File | Change |
|---|---|
| `lib/answers.js` *(new)* | Autosave rules: saved / stale / rejected, per-question sequence, idempotent retry |
| `routes/student.js` | Uses `lib/answers.js`; applies the answer-key rule to the result endpoint (adds `answers_withheld`) |
| `lib/exam.js` | `answersVisibility()` |
| `lib/grading.js` | `numericReadings()`; numeric grading routes ambiguous commas to a teacher |
| `routes/auth.js` | Wrong-password limits configurable (`LOGIN_MAX_FAILS_PER_IP` default 150, `LOGIN_MAX_FAILS_PER_ACCOUNT` default 8) |
| `lib/auth.js`, `server.js` | `sweepSessions()` run every 10 minutes |
| `public/student.js` | Stale-answer adoption, named failure states, last-saved time, time-up back-off, local-buffer cleanup, option-group label, withheld-answers notice |
| `public/core.js` | Plain notice when sign-in ends during an exam |
| `public/teacher.js` | "Show correct answers" wording now states the close-of-exam condition |
| `tests/hardening.test.js` *(new, 11 tests)* | Regression tests for the fixes above |
| `tests/api.test.js` | **One assertion changed on purpose** (see below) |
| `tests/e2e/exam-player.e2e.js` *(new)* | 11 real-browser scenarios; needs Playwright, which is a developer tool and is deliberately **not** added to `package.json` dependencies |
| `package.json` | New `test:e2e` script; version 2.4.0 |
| `docs/AUDIT_v2.4.md`, `docs/GRADING_RULES.md`, `docs/RELEASE_STATUS.md` *(new)*, `README.md`, `.env.example` | Documentation |

The one changed existing assertion (`tests/api.test.js`, teacher-grading test) used to require that the answer key is delivered after release while the exam is still open. That is the behaviour F3 removes, so it now asserts the key is
withheld with reason `exam_open`; the "visible after close" half is in `tests/hardening.test.js`. No other existing test was edited, weakened or skipped.

## 4. Security report

Fixed: F2 (lockout of a shared address), F3 (answer-key release), plus F8/F9 hygiene. Checked and found sound in the code read: password storage, session handling and CSRF, OTP design, per-route ownership checks, snapshot integrity, answer-key secrecy during exams, CSV formula neutralisation, HTML escaping in the front-end templates (script scan plus manual reading of flagged sites).

Remaining risks, in rough order: O5 (email as admin second factor), O3/O4 (class membership rules), O7 (no backup-failure alert, backups on the same disk), O8/O9 (in-memory counters, forgeable generic limiter key), no dependency scan was possible, teacher/admin front-end code not reviewed, and the application has not had an independent penetration test. **This is not a statement that the application is secure.**
Privacy and legal compliance were not assessed; see `docs/PRIVACY_RETENTION.md` and get local advice before using real student data.

## 5. Test report

**Important limitation.** The sandbox had no network access, so Express, `compression` and `nodemailer` could not be installed. To run the existing tests at all, a small Express-compatible stand-in
(routing, JSON body parsing, static files, response helpers, gzip) was written **outside the project, in a separate directory, and is not delivered**. Every result below was
produced against that stand-in, not real Express. It is credible evidence (the unmodified code passed all 117 original tests under it, including cookie, CSRF, throttling and restore tests) but it is **not** a substitute for running `npm test` yourself.
Also used: KaTeX 0.16.45 (the project asks for ^0.19) and Chrome 131 for the browser tests.

| What | Command | Observed result |
|---|---|---|
| Original suite, **unmodified code** | `npm test` | 117 tests, 117 passed |
| Original suites that need no Express (csv, tz, static, otp-migration), no stand-in | `node --test tests/csv.test.js tests/tz.test.js tests/static.test.js tests/otp-migration.test.js` | 17 / 17 passed |
| Full suite, **final code** | `npm test` | **128 tests, 128 passed**, 0 failed/skipped |
| Browser tests, final code | `npm run test:e2e` | **11 scenarios, 11 passed**; run 3 times in a row, stable |
| Mutation check | each fix temporarily reverted in a scratch copy | the matching test failed every time (IP limit, key release, tie-overwrite, numeric parse, 401 notice, stale adoption) |

Browser scenarios: full happy path with review, flagging, confirmation and receipt; network loss and recovery; refresh with unsent typing; HTTP 503 handling; expired session and resume; two tabs;
reload and forged clock; deadline expiry with repeated-submit idempotence; keyboard-only answering and visible focus; 360 px phone layout and target size; answer-key withholding.

Not run: real-Express run, `npm audit`, load or timing tests, `npm run bench`, a restore drill on another machine, Firefox/Safari/Edge, a screen reader, a physical Android device, zoom testing.
A caution on the browser tests: they use an emulated offline mode and deliberately forced server errors, which are good evidence about the code but are not a substitute for a trial on a bad school network.

## 6. Database and migration report

No schema change and no new migration. Existing data is untouched. Behaviour changes to communicate to teachers: (a) "show correct answers" takes effect only after the exam has closed for everyone;
(b) a numeric answer with an ambiguous comma may appear in the "needs grading" queue. Back up before upgrading as usual (`npm run backup`).

## 7. Deployment guide

The stack, `render.yaml` and `docs/DEPLOYMENT.md` are unchanged apart from two optional variables.

```
npm ci                                  # install (needs network)
npm test                                # run against a scratch database; never your live one
npm start                               # node --env-file-if-exists=.env server.js
npm run backup && npm run verify-backup # create and integrity-check a backup
npm run restore-test                    # restore into a scratch copy and check it
```

New optional variables: `LOGIN_MAX_FAILS_PER_IP` (default 150) and `LOGIN_MAX_FAILS_PER_ACCOUNT` (default 8); see `.env.example`.
Health: `GET /api/health` (no secrets); admin detail under System in the admin screen. Restore procedure: `docs/RECOVERY.md`.
Browser tests (developer machine only): `npm install --no-save playwright && npx playwright install chromium && npm run test:e2e`.

## 8. Remaining priorities

**Before any real examination:**
1. Run `npm ci && npm test && npm run test:e2e` on your own machine with real Express and report anything that fails.
2. Run a timed rehearsal with the real number of students on the real network and devices (use `npm run bench` and a manual dress rehearsal); record the results.
3. Do a restore drill on a second machine; copy backups off the server; add a failure alert (O7).
4. Decide the deadline policy (O6) and tell teachers about the two behaviour changes in section 6.
5. Set `ADMIN_*` credentials, email, `TRUST_PROXY` and the disk path as in `docs/DEPLOYMENT.md`; confirm `OTP_MAX_REQUESTS_PER_IP_HOUR` is high enough for your largest login burst.
6. Have someone not on the team run the manual checklist in `docs/TEST_CHECKLIST.md`, including a screen reader.

**Next:** question version history (O1); co-grading and moderation (O2); tighten class-member removal (O3); authenticator-app MFA for admins (O5); review the teacher, admin and analytics screens that were not read; tenant isolation only when a second school is real.

## 9. Release recommendation

**Suitable for a supervised pilot only after the section 8 "before any real examination" items are done; until then, suitable for controlled internal testing.**
Reasons: the examination core is sound and its failure behaviour is now tested in a real browser; but verification here ran on a stand-in for Express, no load or restore drill was done,
the teacher and admin interfaces were not reviewed, and no one has yet tried it on a real school network. Use it for low-stakes assessments first, with a teacher present and a paper fallback.

## 10. Handover

The modified project is in `exam-portal-v14-hardening.zip` (no `node_modules`, no database). Run `npm ci && npm test`, then `npm start`; read `README.md` ("What changed in v2.4") first.
