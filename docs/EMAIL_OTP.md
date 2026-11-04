# Email sign-in codes (OTP) through Gmail

After a correct password, accounts that need verification must enter a 6-digit code that the portal emails to the address on the account. Nothing is simulated: the code is generated on the server, sent through Gmail's SMTP server with Nodemailer, and checked only on the server.

> **Read this first: a Render fact that decides your hosting plan**
> * **Free Render web services block outbound SMTP** (ports 25, 465 and 587) since 26 Sept 2025. Gmail cannot be reached from them, so codes would never be sent. Use a **paid** instance (ports 465/587 work there; port 25 stays blocked everywhere).
> * Since v3 the data lives in Supabase, so **no disk is needed**. (A free service also sleeps when idle, which is a poor fit for exams.)
>
> So the intended Render setup is one paid *Starter* (or larger) web service. `render.yaml` in the project root describes exactly that. Verify current plans and prices on Render's site before you commit.

## 1. How it works

```
password ok? ──no──▶ 401 "Wrong email or password."          (same answer for unknown accounts)
     │yes
     ▼
account needs a code? ──no──▶ session created (students in the default mode)
     │yes
     ▼
POST /api/auth/login  → code emailed, challenge stored, HttpOnly cookie `otp_ch`   (NO session yet)
     ▼
#/verify screen  ⇄  POST /api/auth/otp/resend   (cooldown, caps)
     ▼
POST /api/auth/otp/verify  → code checked, challenge consumed and session created in ONE database transaction
     ▼
redirect to the dashboard for the role stored on the server (admin / teacher / student)
```

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/login` | Unchanged request. Returns `{ok:true, otp_required:true, otp:{email_hint, expires_in, resend_in, attempts_left, resends_left}}` when a code is needed; otherwise the same session response as before. |
| `GET /api/auth/otp/status` | Lets the code screen survive a page reload. 401 if nothing is pending. |
| `POST /api/auth/otp/verify` `{code}` | Checks the code. On success returns `{ok:true, user}` and sets the `sid` session cookie. |
| `POST /api/auth/otp/resend` | Replaces the code with a new one (old one stops working at once). |
| `POST /api/auth/otp/cancel` | "Use a different account": drops the pending code. Can never sign anyone in. |
| `GET /api/admin/email-status`, `POST /api/admin/email-status/verify`, `POST /api/admin/email-test` | Administrator diagnostics (System page). |

None of the `otp` endpoints accepts an email, user id or role from the request. The account is whatever the server-side challenge, found through the HttpOnly cookie, was created for after a correct password. The existing CSRF header/origin check, `HttpOnly; SameSite=Strict` cookies and `Secure` in production all apply.

### Security properties

* **Generation:** `crypto.randomInt(0, 1000000)`, zero-padded; uniform, no modulo bias.
* **Storage:** only `HMAC-SHA-256(secret, user | purpose | challenge | code)`. A plain or salted hash of a 6-digit code could be brute-forced in milliseconds from a stolen database, so the HMAC key (`OTP_SECRET`) lives only in the server environment. Comparison uses `crypto.timingSafeEqual`.
* **Expiry and single use:** 5 minutes by default. A successful check deletes the challenge and creates the session in the same transaction; two simultaneous requests yield exactly one session.
* **Binding:** each code belongs to one account, one address (it fails if the address changed), one purpose (`login` / `password_reset`) and one browser (the `otp_ch` cookie; only its SHA-256 is stored).
* **Replacement:** a new login or a resend overwrites the stored code. Two codes are never valid at the same time. A code spent by too many wrong guesses is invalidated even if the right digits are entered afterwards.
* **Limits (all on the server, stored in the database so a restart does not reset them)**

| Limit | Default | Setting |
|---|---|---|
| Code lifetime | 300 s | `OTP_TTL_SECONDS` (60–1800) |
| Wrong guesses per code | 5 | `OTP_MAX_ATTEMPTS` (1–10) |
| Wrong guesses per sign-in, across resends | 10 | `OTP_MAX_TOTAL_ATTEMPTS` |
| Wait between codes | 60 s | `OTP_RESEND_COOLDOWN_SECONDS` (5–600) |
| Replacement codes per sign-in | 3 | `OTP_MAX_RESENDS` |
| Code screen stays usable | 900 s | `OTP_CHALLENGE_TTL_SECONDS` |
| Emails per account per hour | 6 | `OTP_MAX_SENDS_PER_USER_HOUR` |
| Code requests per network address per hour | 100 | `OTP_MAX_REQUESTS_PER_IP_HOUR` |
| Wrong codes per account per 15 min before a lock | 10 | `OTP_MAX_FAILS_PER_USER` |
| Wrong codes per network address per 15 min before a lock | 60 | `OTP_MAX_FAILS_PER_IP` |
| Requests to the code endpoints per address per 10 min | 600 | `OTP_BURST_PER_IP_10MIN` |

Per-address limits only work if the portal sees real client addresses: keep `TRUST_PROXY=1` on Render. A whole school behind one public address shares the per-address numbers, hence the generous defaults; raise them if needed. IP addresses are stored only as a keyed hash, and counters are deleted after 24 hours.
* **Delivery truthfulness:** a code counts as sent only if the SMTP server *accepted this recipient*. If sending fails, the challenge is deleted, no cookie is issued and no session exists; the person sees a safe message, the server log has a scrubbed reason (category, SMTP code), never a password or code.
* **No enumeration:** unknown account and wrong password get the identical response, and no email is sent for either.

## 1b. Signing in with an email code only (no password)

The login page has a second form, **"No password? Use an email code"**: the person enters only their email, receives a 6-digit code, enters it and is signed in. It reuses everything above (hashed single-use codes, expiry, attempt limits, resend cooldown, rate limits, no session before verification).

* **Who:** `OTP_CODE_LOGIN_ROLES` (default `student`). `student,teacher` widens it; administrators only if you name `admin`; `none` removes the option. Staff stay on password + code by default because with code-only the mailbox becomes the only key.
* **Eligible accounts:** active, allowed role, **not** on a temporary password (the first sign-in must use the temporary password and set a new one, so nobody can take over an unactivated account through its mailbox), and not marked *password only*.
* **No account enumeration:** asking for a code gives the identical response for every well-formed address: registered, unknown, staff, suspended or still on a temporary password. Unknown/ineligible addresses get an in-memory decoy challenge that mimics the real one (same cooldown, attempt counts, expiry, messages) but sends nothing and can never be verified; the real email is sent in the background so response time does not leak either. The screen therefore says "If an account can sign in with a code, we sent a code…". Only network-level limits and server misconfiguration (which do not depend on the account) return errors.
* **Mail-bombing:** the same per-account (6 emails/hour) and per-address limits apply. At the account cap the portal still answers normally but quietly sends nothing.
* **Delivery failures** cannot be shown for this method (that would reveal the account exists): the pending code is removed and the person sees "session ended, start again" if they try it. Check the log (`mail send failed`) and *System → Check connection to Gmail*.
* Endpoint: `POST /api/auth/code/request {email}`; then the same `/api/auth/otp/status|verify|resend|cancel` endpoints. `/api/auth/me` returns `code_login: true/false` so the page knows whether to show the form.
* Migration `005_code_login.sql` rebuilds only the short-lived `otp_challenges` table to allow the new `code_login` purpose.

## 2. Policy: who must enter a code, and accounts without email

`OTP_LOGIN_MODE`:

| Value | Who enters a code |
|---|---|
| `staff` *(default)* | Administrators and teachers. Students sign in with their password only (they were never required to have a working mailbox). |
| `all` | Everyone, except students an administrator has marked **Allow password only** (Users page; students only, enforced by a database trigger too). |
| `off` | Nobody. Emergency switch (see "Locked out?"). |

* There is no self-registration; administrators and teachers create accounts and import students by CSV exactly as before. Nothing in that workflow changed and no CSV column was added.
* An account's email counts as **verified** the first time its owner enters a correct code (`email_verified_at`, shown on the Users page). Changing the address clears that and cancels any pending code.
* In `all` mode a student whose address is fake or mistyped can never receive a code. Before switching to `all`, fix addresses or mark those students *Allow password only*.
* **Existing password resets are unchanged:** an administrator issues a temporary password (*Reset password*). Signing in with it still requires the emailed code for accounts in scope, then forces a new password. No self-service "forgot password" exists, on purpose: adding one is a separate security decision. The code engine already supports a separate `password_reset` purpose (own challenge, own email text, never interchangeable with login), covered by tests, so it can be added later without redesign.
* An administrator who changes someone's address can redirect that person's codes to a mailbox they control. Administrators can already reset passwords, so this adds no new power, but it is recorded in the audit log (`user.update`).

## 3. Safe rollout on an existing installation (do this in order)

1. Back up (`npm run backup`). The portal also writes `eagle.db.before-004_email_otp.bak` automatically before migrating.
2. Deploy with `OTP_LOGIN_MODE=off`. Sign in as the administrator and open *Users*: make sure **every administrator and teacher has a real email address they can open**. (A default `admin@eagle.local` cannot receive mail; edit it in *Users*.) The log line `accounts that need a code have addresses that look undeliverable` lists problem accounts.
3. Set `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `APP_BASE_URL` (section 4/5). Open *System → Email verification → Check connection to Gmail*, then *Send a test email to me*.
4. Set `OTP_LOGIN_MODE=staff` (or remove the variable) and redeploy. Sign in on a second browser to confirm before you close the first.

If email is required but not configured, sign-in for those accounts **fails closed** (HTTP 503 "Email verification is not available") rather than silently skipping the code.

## 4. Gmail setup

1. **Create or choose a dedicated Gmail account** for the portal (for example `eagle.portal.notifications@gmail.com`). Do not use a personal inbox: the App Password grants mail access.
2. **Turn on 2-Step Verification:** Google Account → Security → 2-Step Verification.
3. **Create an App Password:** Google Account → Security → *App passwords* (search for it if hidden), name it "Eagle Portal", copy the 16 characters shown once. The option is missing if 2-Step Verification is off or set up only with security keys, if the account is a work/school account whose administrator disabled it, or if Advanced Protection is on. Use a plain consumer Gmail account for this.
4. Never use the normal Google password anywhere in this project; it will not work and must not be stored.
5. **Limits:** Google caps sending (about 500 recipients per rolling 24 hours for a personal Gmail account, about 2,000 for Google Workspace) and may temporarily block an account it considers suspicious. Roughly one email per sign-in plus resends; delivery speed and inbox placement (spam folder) are not guaranteed. Plan for a school's morning sign-in rush, and keep the per-account limits to prevent waste.

## 5. Render setup

1. Push the project to a private Git repository (`.env` is git-ignored; check `git status` shows no secrets).
2. Render → **New → Blueprint**, pick the repository (uses `render.yaml`), or create a **Web Service** manually: Node, **Starter or larger**, build `npm ci`, start `npm start`, health check `/api/health`, one instance (no disk: see `docs/SUPABASE.md`) (1 GB is plenty).
3. **Environment** (Dashboard → your service → *Environment*; values below are placeholders):

```
NODE_ENV=production
TRUST_PROXY=1
DATABASE_URL=postgresql://eagle_app.<project-ref>:<password>@<pooler-host>:5432/postgres   # Supabase SESSION pooler, secret (docs/SUPABASE.md)
ADMIN_EMAIL=you@yourschool.org            # first run only; MUST be a real mailbox you can open
ADMIN_PASSWORD=choose-a-long-password-1   # first run only
GMAIL_USER=your-dedicated-gmail@gmail.com
GMAIL_APP_PASSWORD=your-google-app-password
APP_BASE_URL=https://your-app.onrender.com
OTP_LOGIN_MODE=staff
OTP_SECRET=<32+ random characters; the blueprint generates one>
```
4. **Deploy.** In *Logs* look for `email verification` (mode, `mail_configured:true`) and `smtp login verified`. `smtp check FAILED` with a `kind` means the credentials or network are wrong (see Troubleshooting).
5. **Test:** open `https://your-app.onrender.com`, sign in as the administrator, enter the emailed code. Then *System → Send a test email to me*.
6. **Persistence test:** create a user, trigger *Manual Deploy*, confirm the user is still there.

## 6. Manual end-to-end test with a real mailbox

Use a test Gmail/Outlook address you can open (not a real teacher).

1. `npm run email:check -- yourtest@example.com` (with `.env` filled in). Expect "SMTP login OK" and "ACCEPTED a test message"; the message arrives (check spam).
2. Start the app (`npm start`), set the test address as a teacher's email (*Users*; or create the teacher with it).
3. Sign in as that teacher → code screen shows `y***@…`; an email arrives with the code, the expiry and the warning, branded correctly in both Gmail web and phone.
4. Enter a wrong code → "incorrect, 4 attempts left". Enter the right one → teacher dashboard.
5. Sign out, sign in again, press **Resend** before 60 s → button is disabled with a countdown; after it, the new email arrives and the **old** code is refused.
6. Let a code expire (5 min) → "expired", *Resend* works.
7. Enter 5 wrong codes → code cancelled; resend gives a fresh one.
8. Change the Gmail App Password to a wrong value in the environment, restart, sign in → "We could not send the verification email…", **no** session, nothing leaked; restore the value.
9. With the browser developer tools open, confirm: the code never appears in any response, and `otp_ch` is `HttpOnly`.

## 7. Troubleshooting (server log: `mail send failed` with `kind`)

| Symptom / `kind` | Cause and fix |
|---|---|
| `auth` (`EAUTH`, SMTP 535) | App Password wrong, revoked, or 2-Step Verification was turned off. Create a new App Password, update `GMAIL_APP_PASSWORD` (spaces are ignored), redeploy. `GMAIL_USER` must be the full address. |
| `timeout` / `connection` on Render | Free instance (SMTP blocked) → upgrade to a paid instance. Otherwise try `SMTP_PORT=587`, or check for a firewall. |
| `quota` | Gmail daily limit reached; it resets on a rolling 24-hour basis. Lower resends, or move to a transactional provider. |
| `rejected` | The recipient address is invalid or refused. Fix the address on the account. |
| Everything "accepted" but nothing arrives | Check spam/promotions; Gmail may delay or filter. The sent folder of the sending Gmail account shows what was sent. |
| `smtp check FAILED` at start-up | Same causes as above; also run `npm run email:check`. |
| Users see "Email verification is not available" | `GMAIL_USER`/`GMAIL_APP_PASSWORD` missing. Set them, or `OTP_LOGIN_MODE=off` temporarily. |
| "Too many requests… from your network" | Many sign-ins share one public address; raise `OTP_MAX_REQUESTS_PER_IP_HOUR`. |
| Codes stop working after every restart | Set `OTP_SECRET` (otherwise a random per-process key is used). |

**Locked out?** Set `OTP_LOGIN_MODE=off` in the Render environment, redeploy, sign in with the password, fix the email address or Gmail settings, then set it back. This is a deliberate operator action and is logged at start-up (`OTP sign-in verification is OFF`).

## 8. Limitations (be honest with users)

* Email is not instant or guaranteed; the free Gmail route is suitable for a school's staff sign-in, not for thousands of codes per day.
* Whoever controls a mailbox controls its codes. Use a protected mailbox (its own 2-Step Verification) for administrators.
* A single server process is assumed. Pending codes and the code limits are in the database, so they survive restarts and are shared. The wrong-password throttle, the request limiter and the decoy store behind code-only sign-in are in each process's memory, so a second process would need those moved into the database too, and `OTP_SECRET` must be set. Code answers are also held to a minimum response time (`OTP_MIN_RESPONSE_MS`, default 600 ms) so speed cannot reveal which addresses have accounts.
* Only the `login` and `code_login` purposes are wired to routes. `password_reset` exists in the engine and tests but is intentionally not exposed.
* The default `staff` mode leaves student sign-in at password only. Use `all` only after fixing student addresses.

## 9. Tests

`npm test` runs everything against a scratch database with a **mock mail transport** (no network, no credentials, no real email): `tests/otp.test.js` (57 tests: code-only sign-in and decoys, generation, hashing, verification, wrong/expired/reused/replaced/over-attempted codes, cooldown, caps, rate limits, purpose separation, bypass attempts, SMTP failures, roles, policy, admin diagnostics) and `tests/otp-migration.test.js` (upgrades 004 and 005 of a populated older database). The older suites run with `OTP_LOGIN_MODE=off` because they test exams, grading and enrollment, not sign-in.
