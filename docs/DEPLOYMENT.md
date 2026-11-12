# Deploying the User Lifecycle update safely

**The update itself deletes nothing.** The migration changes no rows. Permanent deletion only ever happens when an administrator clicks it and types `DELETE`. Do these steps **in this order**. Stop and ask if anything looks different from what is described.

## 1. Back up the production database FIRST (do not assume a backup exists)
Do at least (a) and (b), and keep (b) **off the hosting platform** (your computer or a drive).

a. **Supabase backups.** Dashboard → *Database → Backups*. What exists (daily backups, point-in-time recovery, download) depends on your Supabase plan: look at the page and note the time of the newest backup. If none is listed, rely on (b) and (c).

b. **The portal's own export** (works on every plan), from your project folder with `.env` pointing at production:
```
npm run backup
npm run verify-backup backups/<the file it just wrote>
```
It writes a verified `eagle-<time>.ndjson.gz` containing every table (accounts, exams, attempts, grades, audit, ...). See `docs/RECOVERY.md`.

c. *(Optional, extra safety)* a full dump with the privileged connection string:
```
pg_dump "<your MIGRATION_DATABASE_URL>" --schema=eagle -Fc -f eagle-before-lifecycle.dump
```

## 2. Put the files in place
1. `git commit -am "before user lifecycle"` (your undo point).
2. Extract the ZIP **into the project root** (the folder containing `package.json`), replacing `routes/admin.js`, `lib/students.js`, `public/admin.js` and `CHANGES.md`.
3. Optional local check on a **throw-away local PostgreSQL** (never on Supabase; the test scripts refuse remote hosts): `npm test`.

## 3. Apply the migration (production database)
It is additive and compatible with the version running now, so it is applied **before** the new code.

What it does (nothing else): widens the `users.status` CHECK to also allow `'deleted'`, and adds one guard trigger on `eagle.users` (never remove the last active administrator; a deleted account is final). It adds no table or column and changes no row.

```
npm run migrate
```
(uses `MIGRATION_DATABASE_URL`, the privileged role; see `docs/SUPABASE.md`. Use either this runner **or** `supabase db push`, never both.)

Check, in the Supabase SQL editor:
```sql
select version, name from eagle.schema_migrations order by version;      -- ends with 20261111000000 user_lifecycle
select count(*) from eagle.users;                                         -- same number as before
select pg_get_constraintdef(oid) from pg_constraint
 where conrelid = 'eagle.users'::regclass and contype = 'c' and conname = 'users_status_check';   -- mentions 'deleted'
```
If the new code is deployed **before** the migration, Deactivate and Restore still work but Permanently delete fails safely (nothing is changed) until the migration is applied.

## 4. Deploy the code
**This project is a long-running Node/Express server** (`npm start`; one process; `render.yaml`). It has **no Vercel configuration** and is not designed for Vercel's serverless functions, so I could not test a Vercel deployment.
* On **Render / any Node host** (as in `docs/DEPLOYMENT.md`): `git push`; the host rebuilds and restarts. No new environment variable, no new package.
* If you run your own **Vercel adaptation**: redeploy exactly the way you do today (it is plain files). Your Supabase project, database and environment variables stay as they are.

## 5. First use: rehearse on a throw-away account (never on a real student first)
1. Admin → Users → **+ New account** → create `test.delete@yourschool` (student).
2. **Deactivate** it → confirm it shows *Deactivated* and cannot sign in. **Restore** it → can sign in again.
3. **Delete permanently** it (type `DELETE`) → it disappears from the list.
4. Admin → **Audit log** → filter `USER_` to see the three entries.

## 6. How to use it
| Goal | Steps |
|---|---|
| **Deactivate** (reversible) | Users → find the person (search, role and status filters) → **Deactivate** → optional reason → confirm. They are signed out and cannot sign in. Everything they own or did is kept. |
| **Restore** | Users → filter *Deactivated* → **Restore** → confirm. Same account, same history. |
| **Permanently delete** (cannot be undone) | Users → **Delete permanently** → read the warning → type `DELETE` → confirm. Personal data is removed; results and content stay as "Deleted user". Refused (with a reason) if the person has an exam in progress or owns an open published exam: finish or close that first. If you only want to stop access, use Deactivate. |

## 7. If something goes wrong
* **Code problem:** redeploy the previous commit. The previous code works with the migration applied (verified by running the previous version's test suite against it).
* **Migration:** it normally never needs undoing. If you must, and **only while no account has been permanently deleted**, run as the privileged role:
```sql
drop trigger users_lifecycle_guard on eagle.users;
drop function eagle.guard_user_lifecycle();
alter table eagle.users drop constraint users_status_check;
alter table eagle.users add constraint users_status_check check (status in ('active','suspended'));
delete from eagle.schema_migrations where version = '20261111000000';
```
* **A deletion made by mistake cannot be undone from the portal.** The identifying data is gone by design. Only a backup from step 1 (or Supabase point-in-time recovery) can bring it back, which is why the backup comes first and why Deactivate exists.
* Recovery procedures: `docs/RECOVERY.md`.
