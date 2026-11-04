# CSV formats, enrollment rules and security notes

All files are UTF-8 with a byte-order mark (so Excel shows Amharic and other non-Latin names correctly) and CRLF line endings.
When **saving from Excel choose “CSV UTF-8”**. The importer accepts comma, semicolon or tab separated files (it detects which from the header line) because Excel in some regions writes semicolons.
Values containing commas, quotes or line breaks must be quoted, as Excel does automatically.

## Limits (all enforced on the server)
| Limit | Default | Change with |
|---|---|---|
| File size | 1,000,000 bytes (also the HTTP body ceiling) | `CSV_MAX_BYTES` (cannot exceed the 1 MB body limit in `server.js`) |
| Data rows per import | 1000 | `CSV_MAX_ROWS` |
| Any single value | 500 characters (parser guard); name 80, email 254, student number 30, class 80, grade/year 20 | fixed |
| Students per bulk enrollment | 500 ids, or 1000 when “select all matching” | fixed |
| Student export | 50,000 rows | fixed |

## Spreadsheet-formula injection policy
Every cell written by the portal passes through one function (`lib/csv.js → safe()`): if a text value begins with `=`, `+`, `-`, `@`, TAB or CR, an apostrophe is placed in front so Excel/Sheets/LibreOffice treat it as text instead of a formula. Real numbers are written as numbers. This applies to every export **and** to the import failure report. (A name stored as `=HYPERLINK(...)` therefore appears as `'=HYPERLINK(...)`.) Imports are never executed; they are only parsed.

## Student import (administrators): `Students → Import Students (CSV)`
Header: `student_number,full_name,email,class_name,grade,academic_year,status`

| Column | Required | Rules |
|---|---|---|
| `full_name` | yes | 1–80 characters, no line breaks |
| `email` | yes | valid address, stored lower-case; this is the **identity key** |
| `student_number` | no | letters/digits/space `. _ / -`, max 30; must not already belong to another account |
| `class_name` | no | must match an **existing** class (case-insensitive). Classes are never created by an import |
| `grade`, `academic_year` | no | used to pick the right class when two classes share a name, and validated against the class. Ignored when `class_name` is blank |
| `status` | no | `active` or `suspended`; blank = active for new accounts, unchanged for existing ones |

Behaviour: *preview* (nothing saved) → confirm → *commit*. Each row is saved in its own transaction, so one bad row never blocks the rest. The commit repeats every check against the live database and refuses to run if the file or options changed since the preview (a SHA-256 digest is compared).
* Existing email → the account is **matched, never duplicated**. Class membership is added. With **“Update existing students”** ticked, `full_name` and `status` differences are applied (shown as old → new in the preview); a blank `student_number` can be filled in. Without it, differences are reported and left alone.
* Identifier conflicts are **reported, never merged**: an email that already has a different student number; a student number already used by another account; the same student number on two different emails in one file.
* Administrator and teacher emails are rejected (“cannot be imported as students”).
* Rows ending in `@example.invalid` (the example file) are rejected so sample rows cannot be imported by accident.
* New accounts get a generated temporary password (same code as the *New account* form) and must change it at first sign-in. Temporary passwords are shown **once** on screen after the import (print them), and are **never** written to any CSV, report or log.
* The same student on several rows with different `class_name`s is allowed (adds each class) as long as name and student number agree.
* Failure report (`import-report.csv`): the template columns plus `line,result,reason` for failed and skipped rows, so you can fix and re-upload.

Templates: `GET /api/students/import/template.csv` (headers only) and `/import/example.csv` (two rows clearly marked EXAMPLE).

## Class membership CSV (teachers and administrators): class page → `Import students from CSV…`
Header: `student_number,full_name,email` (optional class columns must match the class you are importing into). Same engine and rules as above, fixed to that class; teachers can only import into classes they teach, cannot update existing students, and archived classes are refused. The old paste box on the class page now runs through this same engine.

## Exam roster import: exam page → `Students & Exam Enrollment → Import roster CSV…`
Header: `email,student_number` (either is enough; `full_name` is ignored; the roster export can be re-imported). Matches **existing** students from the teacher's own classes only. Accounts are never created. Already-enrolled students, students who already have access through a class, and duplicate rows are skipped and reported; suspended accounts and unknown/out-of-scope students are reported as errors (the message is identical for “does not exist” and “belongs to another teacher” so it cannot be used to probe accounts). If both columns are given they must identify the same student.

## Exports
| Download | Where | Who | Columns (exact header) |
|---|---|---|---|
| Students | Students page → *Export Students CSV* (honours the current filters; *Export selected* for ticked students) `GET /api/students/export.csv?q=&class_id=&grade=&academic_year=&status=&ids=` | admin (all), teacher (own classes) | `student_id,student_number,full_name,email,account_status,class_names,grades,academic_years,created_at` + `last_login` for administrators only |
| Classes | Classes page `GET /api/classes/export.csv` | admin (all), teacher (own) | `class_id,class_name,grade,academic_year,subject,student_count,teachers,archived,created_at` |
| Class roster | class page `GET /api/classes/:id/members.csv` | members of that class, admin | `class_id,class_name,grade,academic_year,student_id,student_number,full_name,email,account_status` |
| Exam roster | exam page `GET /api/exams/:id/roster.csv` | exam owner | `exam_id,exam_title,student_id,student_number,student_name,student_email,enrollment_source,enrolled_at,participation_status,attempt_count,submission_status` |
| Results | results page `GET /api/exams/:id/export.csv` | exam owner | `Exam ID,Exam title,Student ID,Student number,Student name,Student email,Subject,Class,Attempt,Attempt status,Started (ISO),Submitted at (ISO),Marks,Total marks,Percent,Grading,Finalized,Result released,Extra minutes (accommodation),Extra attempts (accommodation),Pass mark (%),Result,Letter grade` |
| User list | `GET /api/admin/users/export.csv?role=&q=` | admin | `user_id,full_name,email,role,student_number,account_status,created_at,last_login` |

Notes
* **Multi-class students**: `class_names`, `grades` and `academic_years` hold one entry per class, separated by `; `, in the same order (a missing grade is an empty entry), e.g. `Grade 9A; Math Club` / `9; 9`. Teachers only ever see the classes they teach.
* `enrollment_source` is `direct`, `class`, `direct+class` or `attempt_record_only` (a student who has an attempt but is no longer entitled; kept so results are never hidden). `enrolled_at` is filled for direct enrollments only (class membership has no timestamp). `participation_status` is `not_started`, `in_progress` or `completed`; `submission_status` is the latest attempt's status or `not_started`.
* **Results** (columns added in v2.1: `Pass mark (%)` = the exam's own pass mark or the school default; `Result` = `pass`/`fail`, **blank unless grading is complete**; `Letter grade` = from the school grading scale, blank when no scale is set or grading is incomplete): one row per attempt, plus a `not_started` row for every entitled student without an attempt (blank marks). `Marks`/`Percent` are filled **only when grading is complete** (`Grading = graded`); `pending` work and in-progress attempts show blank marks and are never presented as a final score. `Finalized` and `Result released` are `yes`/`no`. `Class` lists the assigned classes the student belongs to, or `(direct enrollment)`. No answer keys, no passwords, no hashes in any file.
* Date-times are ISO 8601 UTC. Downloads are streamed in chunks of 200 rows; file names are sanitised (`students.csv`, `roster-exam-12.csv`).
* Each export writes an entry to the audit log (`students.export`, `class.export`, `class.export_roster`, `roster.export`, `results.export`, `users.export`).

## Exam enrollment rules (server-enforced)
* **Access = direct enrollment OR an assigned class.** Both are checked on every student exam route (list, open, start, resume, submit).
* Enrolling never creates an attempt or starts a timer, and never bypasses publish status, opening/closing time or attempt limits.
* Adding is allowed on draft, published and closed exams, and refused on archived ones (HTTP 409). A draft exam can now be published with direct enrollments alone (the old “assign at least one class” rule became “a class or at least one enrolled student”).
* **Removing** a direct enrollment is allowed only if the student has **no attempt** on the exam (409 otherwise); attempts, answers, grades, receipts and history are never deleted. Students who have access through a class cannot be removed individually (change the class assignment on the draft, or the class membership).
* Teachers can enroll only students who share a class with them; suspended accounts cannot be enrolled; administrators do not manage exams (existing rule).
* *Duplicate exam* copies the direct enrollments along with the class assignments.
* All changes are audited: `exam.enroll` (count, first 60 ids, method, exam status) and `exam.unenroll`.
