# Coverage of the master specification, part by part

Legend: **Done + tested** = implemented and covered by automated tests · **Done, UI checked headlessly** = implemented; the screen was exercised in a simulated browser (jsdom), **not** in a real browser or on a phone · **Partial** = some of the part · **Not done** = not implemented. Nothing is marked Done without evidence.

| Part | Topic | Status | Detail |
|---|---|---|---|
| 1 | Principles | n/a | Guided every decision below; no code. |
| 2 | Audit | Done | `docs/AUDIT_REPORT.md`. Existing tests were run first (12/12). |
| 3 | Design system | **Partial** | Existing navy/blue tokens, buttons, inputs, tables, dialogs, toasts, pager, empty/error states are reused everywhere; added visible focus, high-contrast and forced-colours rules, reduced motion, print stylesheet, text-size control (A−/A+). **Not done:** a full visual redesign; sortable columns exist only on the Students page; layouts were not tested on real tablets/phones. |
| 4 | Roles and permissions | **Done + tested** | 401/403/404 checked for students, other teachers, administrators and anonymous callers on every new endpoint (insecure direct object references return 404, indistinguishable from "not found"). |
| 5 | Central student database | **Done + tested** (UI headless) | List, search (name, email, student number), filters (class, grade, year, status), sort, pagination, detail, class memberships, exam participation, create, **edit** (name, email, number), suspend/reactivate, CSV import/export, unique numbers enforced by the database. *Deliberately omitted:* searching by internal id (it is not a school-facing identifier). |
| 6 | One-click enrollment | **Done + tested** (UI headless) | Picker with search/filters, per-row Add, bulk, "select all N matching", whole class, roster export/import, duplicate/concurrency safety, safe removal, audit. Counters: enrolled, not enrolled, not started, attempting, submitted, awaiting grading. |
| 7 | Exam creation | **Partial** | Have: title, instructions, subject, duration, open/close (in school time zone), marks check, attempts, question/option shuffle, release mode, accommodations/extra time, publish checklist, preview, **new:** academic year, term, grade, pass mark, late-grace seconds. **Not done:** drawing random questions from a pool; an enforced "teacher must preview" gate; separate stored states (scheduled/in-progress are derived from times, not stored). |
| 8 | Question bank | **Partial** | Have: topic, difficulty, five types (multiple choice, multiple select with all-or-partial credit, true/false, short, numeric with tolerance, written), KaTeX mathematics, images, explanations, archive, version number, published papers are snapshots. **Not done:** chapter/curriculum fields, rubrics, a visual maths editor, version-history browsing. |
| 9 | Student exam experience | **Server side done + tested**; screen **not browser-tested** | Server timer, sequence-guarded autosave, resume, idempotent submit, receipts, grace period tested. The screen already had countdown, navigation, flags, save status, local answer preservation and retry; these were not re-tested with real network drops. |
| 10 | Integrity | **Done** | Server-side rules only. **No** tab-switch monitoring, webcam, or biometrics, by design. |
| 11 | Grading and results | **Partial** | Auto + manual grading, partial credit, finalize, controlled release, append-only grade history with reasons, **pass/fail, letter grades, final-vs-provisional** (tested). **Not done:** rubrics, a dedicated moderation workflow beyond re-marking with a reason. |
| 12 | Analytics | **Done + tested** (UI headless) | Teacher dashboard: counts, enrollments, submission rate, mean, median, distribution (accessible chart + table), pass rate, letters, per-exam table, hardest questions, topics, pending workload; filters: subject, grade, class, year, term, exam, date range; population stated on screen. **Not done:** an administrator school-wide overview (administrators keep their existing rule of no access to marks). |
| 13 | CSV import/export | **Done + tested** | See `docs/CSV_FORMATS.md`. |
| 14 | Ethiopian requirements | **Partial** | Done: school time zone (default Africa/Addis_Ababa), Ethiopian calendar **display** via the platform's ICU (tested against known dates), Amharic month names, configurable terms, grade levels, pass mark and grading scale, UTF-8/Amharic names and CSV, browser-print reports. **Not done:** translating the interface into Amharic (only dates are localised); *entering* dates in the Ethiopian calendar; the Ethiopian 12-hour clock; logo upload (name and colour only). |
| 15 | Low bandwidth | **Partial** | gzip (measured), pagination, cacheable static assets, no large images, save-status indicators. No offline exam mode (deliberately: unsafe without conflict handling). Not measured on real slow links. |
| 16 | Security | **Done + tested**, with caveats | Cookies, CSRF, headers, CSP, throttling, parameterised SQL, escaping, authorisation, answer-key secrecy, no leakage in errors/logs, append-only audit, dependency audit = 0 vulnerabilities. **Not done:** external penetration test, administrator second factor, e-mail password reset. |
| 17 | Database/migrations | **Done + tested** | Sequential migrations, tested on a populated v001 database, automatic pre-upgrade snapshot, unique-number triggers that tolerate legacy duplicates. |
| 18 | Hosting/backups | **Partial** | Documented, health check, structured logs, graceful shutdown, `restore-test` (restores, checks integrity, boots the app, signs in). **Not done:** tested on a real HTTPS host; automatic error-monitoring service (logs only). |
| 19 | Automated tests | **Done** | 57 tests, all passing, four consecutive runs stable. Regression areas listed in the spec (auth, classes, bank, exam creation/publication, grading/results, backup/recovery) are covered by the original 12 plus the new suites. |
| 20 | Performance/concurrency | **Done, measured** | `docs/PERFORMANCE.md`. No browser load test. |
| 21 | Future phases (AI tools, multi-school, integrations) | **Not done** | Intentionally deferred, as the specification says. |
| 22 | Roadmap | Phases 1–2 done; 3–4 partial; 5 not started. |
| 23–25 | Workflow, definition of done, deliverables | Done | This file, the audit, the README and the final report. |

## What must still happen before real examinations depend on this
1. A supervised pilot with real devices, real network conditions and your real class size.
2. A native Amharic speaker should review any future translation; none was attempted.
3. Run the manual checklist (`docs/TEST_CHECKLIST.md`) in real browsers on phone, tablet and school PCs, including a deliberate network drop during an exam.
4. Host behind HTTPS with the Supabase database in the same region as the server, confirm your Supabase backup entitlement, keep an independent `npm run backup` copy off the platform, and run `npm run restore-test` each term.
