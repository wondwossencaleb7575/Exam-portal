# Running the portal on Supabase (PostgreSQL)

Since v3 the portal stores everything in a **Supabase PostgreSQL database** instead of a SQLite file on the server's disk. This page is the step-by-step guide. The reasoning, the security model and the test evidence are in [`SUPABASE_INTEGRATION_REPORT.md`](SUPABASE_INTEGRATION_REPORT.md).

## How the pieces fit

```
 student / teacher / admin browser
            │  HTTPS (the only thing the public can reach)
            ▼
 Portal server  (Node + Express, e.g. on Render)      ← all permission checks, grading and answer keys live here
            │  TLS, database role "eagle_app" (limited), Supabase session pooler
            ▼
 Supabase PostgreSQL ── private schema "eagle" (not exposed through the Supabase Data API)
```

* **The browser never talks to Supabase.** There is no Supabase URL, `anon` key or `publishable` key in the front end, and none is needed. The portal's security rests on the server (as in every earlier version), and the database adds independent locks (section *Security model*).
* That is also why this app **cannot run on GitHub Pages**: Pages serves static files only, while the portal must run server code to grade exams and keep answer keys secret. Use any Node host (Render, Railway, Fly, a VPS).
* Do **not** put `DATABASE_URL` (or any Supabase key) into a GitHub Actions variable that is baked into a published bundle, a `NEXT_PUBLIC_*` / `VITE_*` variable, or a repository. It is a server-side secret.

## What you need

* A Supabase project (any plan; see *Scaling and limits* for connection limits).
* Node.js 22.13+ on the machine that runs the migrations, and a host that runs `npm start`.
* About 20 minutes.

## Setup

### 1. Create the project
Dashboard → **New project**. Choose the **region closest to your portal host**: every page makes several small queries, so network distance to the database is the biggest factor in speed. Write down the **database password** you set.

### 2. Apply the migrations (once)
The schema lives in `supabase/migrations/` (two files, applied in order). Use **one** of these ways (never mix them on the same database):

| | How | Needs |
|---|---|---|
| **A. npm (simplest)** | Put `MIGRATION_DATABASE_URL` (the **`postgres`** role, session pooler, port 5432: see step 4 for where to copy it) in `.env`, then `npm run migrate` | Node |
| **B. Supabase CLI** | `npx supabase login` → `npx supabase link --project-ref <ref>` → `npx supabase db push` | Supabase CLI |
| **C. SQL Editor** | Dashboard → SQL Editor: paste and run `20261024100000_eagle_core_schema.sql`, then `20261024100100_eagle_security.sql` | a browser |

The second file **verifies its own result** and aborts the whole migration if any table lacks Row Level Security or if `anon`, `authenticated` or `service_role` hold any privilege on it. If you see no error, the lock-down is in place. Re-running `npm run migrate` is safe (already-applied files are skipped).

### 3. Give the limited role a password
The migration creates a database role called `eagle_app` **without** a password (a password must never be in Git). Generate one and set it in the SQL Editor:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```
```sql
alter role eagle_app with password 'PASTE-THE-GENERATED-PASSWORD-HERE';
```
(That alphabet needs no URL-encoding. If you choose your own password with symbols such as `@` or `/`, URL-encode them in the connection string.)

### 4. Build `DATABASE_URL` (what the running portal uses)
Dashboard → **Connect** → choose the **Session pooler** (port **5432**). Copy the string and change two things: the user becomes `eagle_app.<your-project-ref>` and the password is the one from step 3:

```
DATABASE_URL=postgresql://eagle_app.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

* **Use the session pooler, port 5432.** The *direct* connection works only over IPv6 unless you buy Supabase's IPv4 add-on (their documentation says so), and not every host can reach IPv6 addresses: check yours, or simply use the pooler. The *transaction* pooler (port 6543) does not preserve per-connection settings (search path, statement timeout) that the portal sets, and `npm run migrate` needs a stable session.
* The menu names move around in the dashboard; look for "Session pooler" / "Shared pooler" on port 5432.
* For migrations, the same string with the user **`postgres.<project-ref>`** and your database password is `MIGRATION_DATABASE_URL`. Keep that one on your own computer: **never set it on the web server**.

### 5. Lock down the Supabase Data API (belt and braces)
The portal does not use Supabase's REST/GraphQL API, so the safest setting is that **nothing is reachable through it**:

1. Dashboard → **Project Settings → Data API**: the *Exposed schemas* list must **not** contain `eagle` (the default is `public` only). If you will never use the Data API for anything else, disable it entirely.
2. Optional check from any terminal, using your project's public `anon` key (it should return an error or an empty result, never student data):
   `curl "https://<ref>.supabase.co/rest/v1/users" -H "apikey: <anon key>"`
3. Optional SQL check (SQL Editor): every row of the first query must say `true`, the second must say `false | false`:
   ```sql
   select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'eagle' and c.relkind = 'r';
   select has_schema_privilege('anon','eagle','usage') as anon, has_schema_privilege('authenticated','eagle','usage') as authenticated;
   ```

> **Supabase default change, 30 Oct 2026.** From that date new tables in the `public` schema are no longer exposed to the Data API automatically (before, they were granted to `anon`/`authenticated`/`service_role` on creation). The portal is not affected: it connects directly and keeps everything in a private schema whose grants are revoked explicitly by the migration, so its security does not depend on that platform default in either direction.

### 6. Moving an existing portal's data in (skip on a brand-new install)
You need the old SQLite file (`data/eagle.db`, from the previous version, fully upgraded to its last migration).

```bash
# 1. Rehearsal: loads everything, checks it, then ROLLS BACK. Nothing is written.
npm run migrate:from-sqlite -- --sqlite ./data/eagle.db --dry-run
# 2. For real (stop the old portal first so no one is taking an exam):
npm run migrate:from-sqlite -- --sqlite ./data/eagle.db
```
It runs in **one transaction** (all or nothing) and refuses to run on a database that already has accounts. Ids, password hashes, timestamps, answers, grades, receipts, images and the audit trail are copied unchanged, so nobody has to reset a password. Sessions are not copied: everyone signs in again. It stops with a plain explanation, and writes nothing, if the old data breaks a rule the new database enforces (for example two accounts whose student numbers differ only by capital letters). Keep the SQLite file until you are satisfied.

### 7. Deploy the server
* **Render:** `render.yaml` is ready (no disk any more). Set `DATABASE_URL` (secret), `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and the Gmail variables if you use email sign-in codes ([`EMAIL_OTP.md`](EMAIL_OTP.md)). Keep **one instance** (see *Scaling and limits*).
* **Anywhere else:** `npm ci && npm start` with the same variables in the environment.
* On first start the portal checks that the migrations are applied (it refuses to serve otherwise, with a clear message) and creates the first administrator if there are no accounts.

### 8. Check that it works
`GET /api/health` should answer `{"ok":true,"version":"3.0.0","migrations":2}`. Sign in as administrator → **System → Check database now** (all checks should pass) → create a teacher → run a pilot exam with dummy students ([`TEST_CHECKLIST.md`](TEST_CHECKLIST.md)).

## Environment variables for the database

| Variable | Where | Meaning |
|---|---|---|
| `DATABASE_URL` | server (secret) | Session-pooler string for role `eagle_app.<ref>` |
| `MIGRATION_DATABASE_URL` | your computer / CI only (secret) | Same pooler, role `postgres.<ref>`: only for `npm run migrate` and `npm run migrate:from-sqlite` |
| `DATABASE_SSL` | server | `verify` (default for remote databases) · `no-verify` (encrypted, **not authenticated**: avoid) · `off` (only for a database on your own machine; refused in production for remote hosts) |
| `DATABASE_CA` | server | PEM text of a root certificate, only if verification fails with the default store (Dashboard → Database → Settings → SSL configuration). Write line breaks as `\n` |
| `DB_POOL_MAX` | server | Connections held (default 10). Keep well below your plan's limit |
| `DB_STATEMENT_TIMEOUT_MS` | server | A single query is cancelled after this long (default 20000) |
| `BACKUP_DIR` | your computer | Where `npm run backup` writes (default `./backups`) |

Removed since v2: `DB_FILE`, `BACKUP_EVERY_HOURS`, `BACKUP_KEEP` (the in-server snapshot scheduler is gone; see [`RECOVERY.md`](RECOVERY.md)).

There is deliberately **no** `SUPABASE_URL`, `SUPABASE_ANON_KEY` or service-role key anywhere in this project: the portal does not use the Supabase client library or the Data API, so the only credential that exists is the database login above.

## Security model in one page

Permissions are enforced by the portal server (unchanged from v2: per-request session lookup, role checks, ownership checks, CSRF protection, answer keys never sent to students before their result is released). The database adds four independent locks, so a leaked Supabase key or a platform setting mistake cannot expose student data:

1. **Not exposed:** everything lives in schema `eagle`, which the Data API does not serve.
2. **No API privileges:** `anon`, `authenticated` and `service_role` have no privilege on the schema, any table, sequence or function.
3. **Row Level Security on every table.** The only policy on each table names the application role `eagle_app`, so even if someone granted `anon` access by mistake it would see zero rows and could change none.
4. **Least privilege for the server itself:** `eagle_app` is not a superuser, cannot bypass RLS, cannot create or drop anything, cannot delete users, attempts or answers, and can only *append* to the audit log and grade history (which also have triggers that refuse changes even for the owner).

Roles (`admin`, `teacher`, `student`) are stored in the database and re-read on **every** request; the browser holds only an opaque session cookie. A role is assigned only by an administrator when creating an account (or by the first-run bootstrap): no endpoint changes it afterwards, and a user cannot edit it through their profile, browser storage or JavaScript. The detail, with the test evidence, is in the integration report.

## Scaling and limits

* **One server instance.** The wrong-password throttle and the general request limiter are kept in the server's memory, and so is the decoy store that makes "sign in with an emailed code" unable to reveal which addresses have accounts. With several instances these would be per instance. Exams are safe (all grading races are resolved by database locks, tested), but keep `numInstances: 1` unless you also move those counters into the database. If you do run more than one instance, `OTP_SECRET` **must** be set so every instance can verify codes another one sent.
* **Connections.** Each instance holds up to `DB_POOL_MAX` connections. Supabase plans limit the total; the session pooler multiplies nothing, so size it for one instance.
* **Latency.** Every query is a network round trip. Keep the portal and the database in the same region. The benchmark in `docs/PERFORMANCE.md` was run against a local database and **does not predict Supabase latency**; run `npm run bench` against your own setup (on a throw-away database) before a large exam.
* **Paused projects.** Supabase free projects can be paused when inactive. A paused database makes the portal answer *503 "database unavailable"* (and recover by itself when the project is restored). Use a plan that is not paused for anything exam-critical.
* **Images** (up to 4 MB each) are stored in the database as before. If the volume grows large, Supabase Storage would be the next step; it is not needed for typical use.

## Running the tests on your computer

The tests need a **throw-away** PostgreSQL server (never your Supabase project). Each test file creates its own database, migrates it, and removes it afterwards.

```bash
docker run -d --name eagle-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
npm test            # 151 tests: API, security, concurrency, migrations, SQLite import, backup/restore
npm run test:e2e    # 11 real-browser tests (needs Playwright; see tests/e2e/exam-player.e2e.js)
```
For safety, `scripts/test-db.js` and `scripts/restore-test.js` **refuse to run against any Supabase host** or any non-local host (they create databases and set a known password on the test role). The suite creates the roles Supabase pre-creates (`anon`, `authenticated`, `service_role`) when it finds them missing, so the permission tests behave as they would on Supabase. If a test run is killed, scratch databases named `eagle_t_…` may remain; drop them with `DROP DATABASE … WITH (FORCE)`.

## Troubleshooting

| Message | Likely cause and fix |
|---|---|
| `getaddrinfo ENOTFOUND` / `connect ENETUNREACH` to `db.<ref>.supabase.co` | You used the direct (IPv6-only) string. Use the **session pooler** string (step 4) |
| `Tenant or user not found` | The pooler user must be `eagle_app.<project-ref>` (with the project reference), not just `eagle_app` |
| `password authentication failed` | The step 3 password was not set, or has characters that need URL-encoding |
| `self-signed certificate in certificate chain` / `unable to verify` | Set `DATABASE_CA` to Supabase's root certificate (see the variable table). Avoid `no-verify` |
| `The database has no "eagle" schema yet` | Run the migrations (step 2) against the same project |
| `permission denied for schema eagle` | The migration's grants are missing or you connected as another role: connect as `eagle_app` |
| `too many clients` / `remaining connection slots are reserved` | Lower `DB_POOL_MAX`, or run only one instance |
| Responses `503 … database is temporarily unavailable or busy` | The database was unreachable, paused, or a query exceeded `DB_STATEMENT_TIMEOUT_MS`. The portal keeps running and recovers by itself; saved answers are not lost |
