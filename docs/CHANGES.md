# CHANGES: User lifecycle (deactivate / restore / permanently delete)

Adds three account actions to **Admin → Users**, an optional status filter, and a database safety net. Nothing is rebuilt, no data is touched by the update itself, and no secret or environment variable changes. **Read `DEPLOYMENT.md` first (backup, then migration, then deploy).**

## 0. Technical assessment (what I found before changing anything)
| Topic | Finding |
|---|---|
| User table | One table, `eagle.users`: `id`, `email`, `name`, `role` (`admin`/`teacher`/`student`), `status` (`active`/`suspended`), `pw_hash`, `student_number`, `created`, `last_login`, OTP fields. |
| Roles | **There is no separate "Super Admin".** `admin` is the only administrator tier, and every admin route is already `requireAuth({ roles: ['admin'] })`. I therefore treat `admin` as the Super Admin and did **not** invent a new tier (see "Decisions" below). |
| Sessions | `eagle.sessions` (hashed token, `ON DELETE CASCADE`). Every protected route and login already require `status = 'active'`, so a non-active account is refused by the server. There are no refresh tokens: sessions and e-mail codes (`otp_challenges`) are the only credentials. |
| Rows that point at a user | `attempts.student_id` / `finalized_by`, `grades.graded_by`, `exams.owner_id`, `questions.owner_id`, `images.owner_id`, `classes.created_by`, `exam_students`, `accommodations`, `class_members` (cascade), `sessions`/`otp_*` (cascade), `grade_history.by_user` and `audit.actor_id` (plain numbers). Most are `NOT NULL` with **no cascade**. |
| Database privileges | The application role has **no `DELETE` on `users`** (deliberate hardening) and **no `UPDATE`/`DELETE` on `audit` and `grade_history`** (append-only triggers). |
| Existing feature | `PATCH /api/admin/users/:id {status}` already "suspends" and "reactivates" (sessions cleared, audited). |

**Consequence:** a literal SQL `DELETE` of a user is impossible, and would be wrong: it would orphan or destroy attempts, grades and exams. "Permanent deletion" is therefore implemented as **in-place anonymisation** (a tombstone), which is irreversible for the person and safe for the records.

## 1. Behaviour
**Deactivate** (reversible). `status` becomes `suspended` (shown as **Deactivated**): sessions and e-mail codes are removed, login and every API route refuse the account, and **nothing else changes** (classes, exams, attempts, grades, content all stay). Optional reason, audited as `USER_DEACTIVATED`.

**Restore.** Same row, same id, back to `active`; password, history, classes and exams are exactly as they were. Audited as `USER_RESTORED`. Only a deactivated account can be restored.

**Permanently delete** (irreversible, typed `DELETE`, also enforced by the server). In **one transaction**:
* the account row is anonymised in place: name → `Deleted user`, e-mail → `deleted-<id>@deleted.invalid`, student number, password, last login, verification data removed, `status = 'deleted'`;
* removed: sessions, e-mail codes/events, class and roster links, exam enrolments that never produced an attempt, free-text accommodation notes;
* **kept** (pointing at the anonymised id): attempts, answers, grades, grade history, exams, questions, classes, images. Results stay accurate; reports show "Deleted user";
* a deleted teacher's questions are **archived**, draft exams are archived, everything else stays under the anonymised owner. **Ownership is never transferred to another teacher.**
* refused with a clear message (nothing changes) while the account has an exam attempt **in progress**, or owns a **published exam that is still open or scheduled**, or owns exams with attempts in progress.
* a deleted account is final: the database refuses any later change, it never authenticates, and it disappears from the Users list, the Students directory and the user export. The e-mail address and student number become free for a *new* account.
* audited as `USER_PERMANENTLY_DELETED` with **no name, e-mail or number**, only role, optional reason and counts of what was kept/removed.

**Protections (server-side, and the last two also in the database):** only `admin` (router guard); no self-deactivate/delete; the **last active administrator can never be deactivated, deleted or demoted** (database trigger under a lock, so two admins removing each other at the same instant cannot both succeed); ids validated; a repeated or simultaneous request is safe (one wins, the rest get 404/409); an administrator deactivated while a request was waiting can no longer act; refused attempts are written to the audit log (`result: "refused"`); errors never expose database details.

## 2. Files
**Modified (3)**
| File | Change |
|---|---|
| `routes/admin.js` | Requires the new engine; `POST /users/:id/deactivate`, `POST /users/:id/restore`, `DELETE /users/:id`; `GET /users` gets a `status` filter and hides deleted accounts; export hides deleted accounts; the old `PATCH` and `reset-password` refuse deleted accounts, and `PATCH` reports the last-administrator rule as 409. |
| `lib/students.js` | One condition so deleted accounts never appear in the Students directory. |
| `public/admin.js` | The Users page only: ID and Registered columns, status filter, empty state, **Deactivate** (amber) / **Restore** (green) / **Delete permanently** (red) with confirmation dialogs, typed `DELETE`, no double submission. The old Suspend/Reactivate button is replaced by Deactivate/Restore (same effect). Reset password, OTP toggle, new account, pagination unchanged. |

**New (5)**
| File | Purpose |
|---|---|
| `lib/userLifecycle.js` | The three operations: one transaction each, advisory lock, audit in the same transaction. |
| `supabase/migrations/20261111000000_user_lifecycle.sql` | **Additive** (section 3). |
| `tests/user-lifecycle.test.js` | 17 tests (HTTP + real PostgreSQL). |
| `CHANGES.md` (this file, previous notes kept below), `DEPLOYMENT.md` | Documentation. |

## 3. Database change (migration `20261111000000_user_lifecycle.sql`)
1. Replaces the `users.status` CHECK with a wider one that also allows `'deleted'` (every existing row still satisfies it).
2. Adds one trigger on `users`: forbids removing the last active administrator, and forbids any change to a `deleted` row.

It adds **no table and no column** and changes **no row**. Tested on a populated database built from your two existing migrations: every existing table was byte-identical (hash and row count) before and after, 22 tables and 184 columns before and after; running it twice changes nothing. The currently deployed version of the app keeps working with it applied (it only writes `active`/`suspended`).

## 4. Dependencies / environment variables
None added, none changed. `package.json` is untouched.

## 5. Decisions you may want to change
1. **"Super Admin" = the existing `admin` role.** Admins can already create other admins and reset anyone's password, so lifecycle actions do not add a privilege. If you want a stricter tier (only some admins may delete), that needs a new column and a choice of who is "super": tell me and I will add it.
2. **Deactivated = the existing `suspended` value**, to avoid a second meaning for the same thing.
3. **Anonymise, never `DELETE`**, for the reasons in section 0.
4. **Blocking rules** for permanent delete (in-progress attempts, open published exams) are deliberately conservative.

## 6. Known limitations (please read)
* **Old audit entries keep the e-mail they were written with.** The audit log is append-only by design (trigger plus no privilege), so rows written *before* a deletion (for example a teacher's `exam.publish` entries, or an admin's earlier password-reset entry that mentions an address) still contain that address. New entries written by this feature contain none. Removing old ones would mean weakening the append-only protection; I did not do that. If you must meet a legal erasure rule, tell me and I will propose a narrowly-scoped redaction function for you to approve.
* Names inside historical reports become "Deleted user" (that is the intent); a student-number-based export for a deleted student shows a blank number.
* A deleted teacher's classes stay (created-by shows "Deleted user") with their students, but with no teacher attached; assign another teacher with your normal class tools.
* The "last administrator" check in the application is defensive; the database trigger is what actually guarantees it.
* Not tested here: your real Supabase project, Vercel or any hosted environment, real e-mail delivery, the optional Playwright suite (`npm run test:e2e`).

## 7. Tested (run here, PostgreSQL 16)
* Full suite **184 / 184** (151 existing + 16 question-import + 17 new). In one of four full runs, four timing-sensitive tests in `hardening`/`api` failed under heavy parallel load; they pass alone and in both reruns, and the code they cover was not touched.
* New tests cover: deactivate/restore of a student, teacher and administrator (login blocked, old sessions dead, exams cannot be started, records byte-identical, same id, no duplicate); permanent deletion of a student (personal data gone, results kept, class/enrolment handling, unrelated records unchanged, audit minimal, repeat = 404, cannot be revived even by SQL), a teacher (content archived, not transferred) and an administrator; refusal while live work exists; student/teacher/anonymous access (401/403); self-protection; last administrator (API, old route, direct SQL, simultaneous removal); invalid ids and confirmations; simultaneous requests; a **forced failure half-way through a deletion rolls everything back**; list filters; email reuse; old PATCH and reset-password still work.
* **Upgrade simulation** on a populated old-schema database (above).
* **Real browser** (Chromium, desktop and 375 px phone): 20 checks, no console errors: filters, empty state, both dialogs, typed-`DELETE` gating, a double click sends one request.

---
# (Previous update, kept for reference)

# CHANGES: CSV Question Import (Question bank)

Adds **Import Questions (CSV)** to the teacher Question bank: template download → upload → preview with per-row errors → explicit confirmation → import. Teachers only, own bank only. Nothing else in the portal changes.

## 1. Modified files (4 + docs)
| File | What changed |
|---|---|
| `routes/bank.js` | +2 `require`s and 3 routes, placed **above** `GET /:id`: `GET /api/questions/import/template.csv`, `POST /api/questions/import/preview`, `POST /api/questions/import/commit`. They inherit the router's existing `requireAuth({ roles: ['teacher'] })`. No existing route touched. |
| `lib/csv.js` | `parse()`/`readTable()` accept two **optional** options, `maxField` and `maxBytes`. Defaults are unchanged (500-character cells, `CSV_MAX_BYTES`), so the student/class/enrollment importers behave exactly as before. Needed because question text can exceed 500 characters. |
| `public/teacher.js` | Question bank header gets an *Import Questions (CSV)* button (`data-qimp`) and one `else if` in the existing click handler that opens the dialog and reloads the list afterwards. Manual "+ New question" unchanged. |
| `public/index.html` | One `<script src="/questionImport.js">` tag after `students.js`. |
| `docs/CSV_FORMATS.md` | New "Question import" section (columns, rules, limits). |

## 2. New files
| File | Purpose |
|---|---|
| `lib/questionImport.js` | The engine: template, row validation (reuses `cleanQuestion`), duplicate detection, `plan()` (preview, writes nothing) and `run()` (one transaction, batched inserts, per-teacher advisory lock, audit entry). |
| `public/questionImport.js` | The import dialog (template, upload, preview, confirm, summary, problem-report download). Reads the file as bytes (UTF-8, falling back to Windows-1252 for Excel's plain CSV). |
| `tests/question-import.test.js` | 16 tests (HTTP + real PostgreSQL; includes the browser file-reader logic). |
| `CHANGES.md` | This file. |

## 3. Dependencies
None added or removed (the project's own RFC 4180 reader in `lib/csv.js` is reused). `package.json` / `package-lock.json` untouched.

## 4. Database migrations
**None.** Questions go into the existing `questions` table through the same columns the editor uses.

## 5. Environment variables
None new. Existing `CSV_MAX_ROWS` (default 1000) applies. Question files are additionally capped at 500 KB (about 1,000 typical questions) so the JSON request always fits under the server's 1 MB body limit.

## 6. Applying the update
1. Back up / commit your current project (e.g. `git commit -am "before question import"`).
2. Extract this ZIP **into your project root** (the folder containing `package.json`), allowing it to overwrite the 5 modified files.
3. `npm test` (needs your throw-away PostgreSQL, see `docs/SUPABASE.md`), then `npm start`, sign in as a teacher → **Question bank → Import Questions (CSV)**.
4. Local try-out: download the template, delete the `SAMPLE:` rows (or edit them), upload, check the preview, confirm.

## 7. Deploying
This project is a **long-running Node/Express server** (`npm start`, one process, `render.yaml`, in-memory rate limiting and timers, see `docs/DEPLOYMENT.md`). It contains **no Vercel configuration** and is not designed for Vercel's serverless functions, so I did not (and could not) test a Vercel deployment.
* **Render / any Node host, as you deploy today:** commit the updated files and push (or redeploy). No migration, no new variables, no new packages.
* **If you have your own Vercel adaptation:** this update is only plain files; redeploy the same way you do now. Keep in mind Vercel's request-body limit (4.5 MB) is above the portal's 1 MB limit, so question files up to 500 KB work.

## 8. Behaviour notes and limitations
* Unknown `subject` names are rejected (imports never create subjects; subjects are managed by administrators). A blank subject uses the default subject, like manual creation.
* Duplicates (same type + question text + options, inside the file or already in your non-archived bank) are skipped and listed, not imported.
* Images, exam sections and per-question files cannot be imported; add images in the question editor afterwards.
* Plain Excel "CSV (Comma delimited)" is read as Windows-1252 and flagged; Amharic or other non-Latin text must be saved as **CSV UTF-8**. `.xlsx` files are refused with instructions.
* "Upload progress" is staged status text (reading → checking → importing), not a byte-level bar: files are small and sent as one request.
* If the valid rows are imported, rows with errors are never imported; fix them and upload the (smaller) file again. The problem report CSV lists every skipped row.

## 9. What was tested (and what was not)
Run here, on a real PostgreSQL 16: the full existing suite (151 tests) plus the 16 new ones: **167 / 167 pass**. The new tests cover all five types, invalid files, missing text/answers, invalid marks/difficulty/subject/type, commas, quotes, multi-line text, Unicode, BOM, CRLF, semicolon files, 5,000-character questions, duplicates, simultaneous double-commit (imports once), digest/ownership abuse, 401/403 for anonymous/student/admin, teacher isolation, 1,000-row and over-limit files, forced mid-import failure (full rollback), questions visible in the bank and addable to an exam, and manual creation. The dialog itself was also driven in a real Chromium (desktop and 375 px phone, 22 checks, no console errors). Not run: `npm run test:e2e` (needs Playwright's Node package, a dev-only tool) and any real Excel, Supabase or hosted deployment.
