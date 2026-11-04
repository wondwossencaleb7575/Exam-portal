# Deployment

Requirements: Node.js 22.13 or newer, a host that can run a Node server (not GitHub Pages: the portal grades exams and guards answer keys on the server), HTTPS, and a **Supabase project** for the database. The step-by-step database setup is in [`SUPABASE.md`](SUPABASE.md).

1. `npm ci`, then set the variables in `.env.example` on your host (never commit real values). `DATABASE_URL` is a secret.
2. Apply the database migrations once: `npm run migrate` (from your own computer, with `MIGRATION_DATABASE_URL`).
3. Set `NODE_ENV=production` (cookies become `Secure`, HSTS is sent) and `TRUST_PROXY=1` when behind your host's HTTPS proxy.
4. `npm start`. The portal checks the database schema first and refuses to serve (503) if the migrations were not applied. On the first start an administrator is created; if you did not set `ADMIN_PASSWORD` the one-time password appears in the log.
5. Smoke test over HTTPS: sign in as admin, run *System → Check database now*, create a teacher, run `npm run seed` **only on a pilot database**, take the demo exam as a student.
6. Run `npm test` (against a throw-away PostgreSQL, see `SUPABASE.md`) before every release, and a supervised pilot with dummy accounts before any real exam.

Run **one** server process (see *Scaling and limits* in `SUPABASE.md`). Do a load test with your real class sizes before a large simultaneous exam (autosave is roughly one small request per student every second or two while typing), against your real Supabase region and plan.

## Environment variables
| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Port to listen on |
| `NODE_ENV` | (unset) | `production` makes cookies `Secure` and sends HSTS: **set it in production** |
| `TRUST_PROXY` | 0 | Number of reverse proxies in front (1 behind nginx/Render/Fly). Needed for correct client IPs and `Secure` cookies |
| `DATABASE_URL` | (required) | Supabase **session pooler** string for the limited role `eagle_app.<project-ref>` (secret). See `SUPABASE.md` |
| `DATABASE_SSL`, `DATABASE_CA`, `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS` | verify, –, 10, 20000 | TLS verification, optional root certificate, connection and query limits |
| `MIGRATION_DATABASE_URL` | – | Privileged role, **only on your own computer** for `npm run migrate`; never on the web server |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | – | First run only: creates the administrator |
| `LOG_FORMAT`, `LOG_LEVEL` | `json`, `info` | See *Logs* below |
| `CSV_MAX_ROWS`, `CSV_MAX_BYTES` | 1000, 1000000 | Import limits |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `APP_BASE_URL` | – | Email sign-in codes through Gmail (a Google **App Password**, never the normal password). See `docs/EMAIL_OTP.md` |
| `OTP_LOGIN_MODE` | `staff` | `staff` (admins + teachers) · `all` · `off` (emergency switch) |
| `OTP_SECRET` | random per process | 32+ random characters keying the code hashes (set it; **required** if you ever run more than one process) |
| `OTP_*`, `SMTP_PORT`, `MAIL_FROM_NAME` | see `.env.example` | Code lifetime, attempt/resend/rate limits (defaults documented in `docs/EMAIL_OTP.md`) |

School settings (name, time zone, language, calendar, pass mark, grading scale, terms, colour) are **not** environment variables: the administrator edits them under *Settings*.

## Email sign-in codes and Render
Administrators and teachers must enter an emailed code after their password (`docs/EMAIL_OTP.md` has the Gmail and Render walkthrough, rollout order and troubleshooting). Two hosting facts matter: **free Render web services block outbound SMTP (ports 25/465/587)** so Gmail only works on a paid instance, and free instances sleep when idle. The database no longer needs a disk (it lives in Supabase). `render.yaml` describes a working paid setup. Set `ADMIN_EMAIL` to a mailbox you can really open. Gmail limits sending (about 500 recipients/day for a personal account); delivery is not guaranteed.

## The database connection: what to check
* Use the Supabase **session pooler** (port 5432) with the `eagle_app.<project-ref>` user. The direct connection is IPv6-only unless you buy the IPv4 add-on, and the transaction pooler (port 6543) is not suitable (`SUPABASE.md` explains why).
* Keep the portal and the database **in the same region**; every request makes several small queries.
* TLS to the database is **verified** by default. If that fails, supply Supabase's root certificate in `DATABASE_CA` rather than switching verification off.
* A paused or unreachable database makes the portal answer *503* and recover by itself; it does not lose saved answers.

## Running as a service
* **Linux (systemd):** `ExecStart=/usr/bin/node /srv/eagle/server.js`, `Restart=on-failure`, `TimeoutStopSec=20`, `EnvironmentFile=/srv/eagle/.env`. systemd sends `SIGTERM` on stop; the portal then finishes in-flight saves and submissions, closes its database connections and exits (give it a few seconds).
* **PM2:** `pm2 start server.js --name eagle --kill-timeout 20000`.
* **Windows:** run under a service wrapper (for example NSSM) with the same environment variables; stop it with the service manager rather than killing the process.
* **HTTPS:** terminate TLS at a reverse proxy (nginx, Caddy) or your host, forward to `PORT`, set `TRUST_PROXY=1`.

## Health check and logs
* `GET /api/health` returns `{"ok":true,"version":"…","migrations":N}` (HTTP 503 if the database does not answer). It reveals no data; point your uptime monitor at it.
* **Logs** go to standard output, one JSON object per line: `t`, `level`, `msg`, and for requests `req` (request id), `method`, `path` (no query string), `status`, `ms`, `user` (id). Every response carries `X-Request-Id`, and a server error response includes the same `error_id`: ask the teacher for it and search the log. Errors in the log include a short stack; clients never see one. There is no built-in alerting: forward the log to a service or watch it for `"level":"error"`.

## Upgrading
1. **Back up first**: confirm your Supabase backup situation and run `npm run backup` (see `RECOVERY.md`).
2. Stop the service (graceful), replace the files, keep `.env`, run `npm ci`.
3. Apply any new migrations **before** starting the new version: `npm run migrate` (or `supabase db push`, never both). Migrations are plain SQL in `supabase/migrations/`, each runs in one transaction, and the application refuses to start on a database that is missing the tables it needs.
4. Start. Check `/api/health` (the `migrations` count), sign in, run *System → Check database now*.
5. Roll back: stop, restore the previous files, and, if a migration had been applied, restore from the export/backup you made in step 1 (migrations are forward-only).

## Capacity
See `docs/PERFORMANCE.md` for measured figures and what was not measured. Run a supervised pilot with the real number of students before a large simultaneous exam.
