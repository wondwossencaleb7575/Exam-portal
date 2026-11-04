# Backup and recovery

## Who keeps which copy

| Copy | Made by | Covers | Notes |
|---|---|---|---|
| **Supabase backups** | Supabase | The whole database | What you get (daily backups, point-in-time recovery, how long they are kept, whether you can download them) **depends on your Supabase plan**: check *Dashboard → Database → Backups* and decide whether it is enough for exam records. The portal cannot verify this for you |
| **Independent export** | `npm run backup` | Every durable table: accounts, classes, exams, questions, attempts, answers, grades, grade history, audit log, images, settings | A gzip file you keep **off the platform and off the web server**. Sessions and pending sign-in codes are deliberately left out |
| **Consistency check** | *System → Check database now* | Nothing is copied; it looks for contradictions (graded attempts with ungraded answers, scores that do not equal the sum of marks, answers pointing at another exam's question, no active administrator, and more) | Read-only and safe during an exam |

The old in-server snapshot scheduler (`BACKUP_EVERY_HOURS`) and the `eagle.db.before-….bak` files no longer exist: a remote database is not a file on the server. Before a risky change, take an independent export first.

## Making and verifying an export
Run these on your own computer (or a scheduled job somewhere that is **not** the web server). They need `DATABASE_URL`; they only read.

```bash
npm run backup                     # writes ./backups/eagle-<time>.ndjson.gz (owner-only permissions) and verifies it at once
npm run verify-backup <file>       # re-reads the file and checks every row count and SHA-256 against its manifest
```
The export is taken from **one consistent snapshot** (a repeatable-read transaction), so it is safe while students are taking exams. The file contains **password hashes and student records**: store it like a password vault, never in Git or a shared drive, and delete old copies according to your retention policy.

## A backup only counts once it has been restored
```bash
RESTORE_ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
RESTORE_ADMIN_EMAIL=you@school.org RESTORE_ADMIN_PASSWORD='your admin password' \
npm run restore-test <file>
```
It verifies the file, builds a **brand-new throw-away database** on the server you name, applies the migrations, loads the export, compares **every row count** with the manifest, runs the consistency checks on the copy, and (when you give the two `RESTORE_ADMIN_*` values) confirms that the administrator's password works on the restored data. It prints `RESTORE TEST PASSED` or fails loudly: a damaged file, a tampered value, a missing administrator or a wrong password all fail. Point `RESTORE_ADMIN_DATABASE_URL` at a **local or Docker PostgreSQL**, never at your live Supabase project. Do this once per term, and after any change to how you back up.

## Restore procedure (database lost or damaged)
1. **Stop the portal** (or set it to maintenance) so nobody saves into the old database.
2. Decide the source: a Supabase backup/point-in-time restore (follow Supabase's dashboard procedure), or your latest verified export.
3. For an export: create a **new, empty Supabase project** (or reset a staging one), run the migrations (`docs/SUPABASE.md` steps 2–3), then load the file with the same code the restore test uses:
   `node -e "require('./lib/backup').restoreFrom(process.argv[1], { url: process.env.MIGRATION_DATABASE_URL }).then(v => console.log('restored', v.tables))" <file>`
   (It refuses a damaged file and refuses a database that already has accounts.)
4. Point `DATABASE_URL` at the restored database, start the portal, sign in as administrator, run *System → Check database now*, and spot-check a recent exam's results.
5. Everyone must sign in again (sessions are not part of an export).
6. Tell teachers the time of the restore point; any work after it must be redone (students may need an extra attempt via *Accommodation*).

## Common incidents
| Incident | What to do |
|---|---|
| Wrong mark entered | Open the attempt, enter the correct mark with a reason. The old value stays in the mark history and audit log. |
| Student lost connection / device failed | *Results → Extend time* with a reason (reopens an auto-submitted attempt). If they submitted deliberately, grant an extra attempt under *Accommodation*. |
| Exam deleted by mistake | Only drafts can be deleted. Published exams can only be archived, and archived exams are kept. |
| Account misuse suspected | Administrator: *Users → Suspend* (signs the user out everywhere), review *Audit log*, reset passwords. |
| Database damaged / server lost | Restore procedure above. |
