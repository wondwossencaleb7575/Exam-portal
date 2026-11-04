# Privacy, data handling and retention (draft for school approval)

**Data collected:** name, school email, optional student number, class membership, exam answers, marks, feedback, and an audit trail of staff actions (including enrollment changes and CSV imports/exports; the audit log never stores temporary passwords or file contents).
For each exam attempt it also records start/submit times and a count of "tab hidden / went offline" events. These are shown to the teacher as context only and are never treated as proof of misconduct. No camera, microphone, screen or keystroke recording exists.

**Who sees what:** students see only their own released results. Teachers see only their own exams and the students in their classes. Administrators manage accounts, classes and the audit log; they cannot open or change exam marks.
Passwords are stored only as salted scrypt hashes. Answer keys and marking guides are never sent to students.

**Suggested retention (the school must confirm against its own policy and local law):**
| Record | Suggested period |
|---|---|
| Results and attempts | Current academic year + 1 year |
| Audit log | 2 years |
| Backups | 14 daily snapshots (configurable); delete older off-site copies |
| Graduated / left students | Suspend the account, then remove per school policy |

Deleting or anonymising old records is a manual administrative task in this version; agree the schedule with the school before launch.
**Before launch:** tell students and parents what is recorded, using the notice shown on the exam instruction screen.

## Logs
Server logs record request method, path **without the query string**, status, duration and the numeric user id, never request bodies, headers, cookies, passwords, or temporary credentials. Treat log files as internal operational data and rotate them (for example 30 days).
