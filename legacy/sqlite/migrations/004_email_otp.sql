-- Email one-time-password (OTP) verification. Purely additive: no existing table is dropped or rebuilt, no existing row is changed.
-- All timestamps are integer milliseconds since the Unix epoch (UTC), like every other table in this database.

-- users.email_verified_at : set the first time the account holder proves control of the mailbox with a correct OTP. NULL = never proven.
-- users.otp_exempt        : 1 = a STUDENT account that signs in with a password only (for students without a working mailbox).
--                           Only administrators can set it, and only on student accounts (trigger below).
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
ALTER TABLE users ADD COLUMN otp_exempt INTEGER NOT NULL DEFAULT 0 CHECK(otp_exempt IN (0,1));

CREATE TRIGGER users_otp_exempt_ins BEFORE INSERT ON users
WHEN NEW.otp_exempt = 1 AND NEW.role != 'student'
BEGIN SELECT RAISE(ABORT,'only student accounts can be exempt from email verification'); END;
CREATE TRIGGER users_otp_exempt_upd BEFORE UPDATE OF otp_exempt, role ON users
WHEN NEW.otp_exempt = 1 AND NEW.role != 'student'
BEGIN SELECT RAISE(ABORT,'only student accounts can be exempt from email verification'); END;

-- One pending verification ("challenge") per user and purpose. It is created only AFTER the password was accepted, and it is
-- the only thing that exists between "password correct" and "fully signed in": there is no session until the code is verified.
--   token_hash     : SHA-256 of a random value held by the browser in an HttpOnly cookie. Binds the challenge to that browser.
--   code_hash      : HMAC-SHA-256 (server secret) of the 6-digit code. The code itself is never stored.
--   email          : the address the code was sent to. Verification fails if the account's address has changed since.
--   attempts       : wrong guesses against the CURRENT code. Replacing the code (resend) starts a new count.
--   total_attempts : wrong guesses over the whole challenge. Never reset, so resending cannot buy more guesses.
--   resends        : how many replacement codes were issued for this challenge.
CREATE TABLE otp_challenges(
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('login','password_reset')),
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  code_expires INTEGER NOT NULL,
  challenge_expires INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  total_attempts INTEGER NOT NULL DEFAULT 0 CHECK(total_attempts >= 0),
  resends INTEGER NOT NULL DEFAULT 0 CHECK(resends >= 0),
  last_sent INTEGER NOT NULL,
  created INTEGER NOT NULL
);
-- A new challenge for the same user and purpose replaces the old one, so an earlier code can never stay valid beside a newer one.
CREATE UNIQUE INDEX idx_otp_user_purpose ON otp_challenges(user_id, purpose);
CREATE INDEX idx_otp_expiry ON otp_challenges(challenge_expires);

-- Counters for rate limiting that survive restarts. ip_hash is a keyed hash, never the raw address. Rows are deleted after 24 hours.
--   kind: 'send' (a code email was accepted by the mail server), 'attempt' (a code was requested; counted even if sending failed),
--         'fail' (a wrong code was entered), 'test' (an administrator test email)
CREATE TABLE otp_events(
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('send','attempt','fail','test')),
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  ip_hash TEXT
);
CREATE INDEX idx_otp_events_user ON otp_events(user_id, kind, ts);
CREATE INDEX idx_otp_events_ip ON otp_events(ip_hash, kind, ts);
CREATE INDEX idx_otp_events_ts ON otp_events(ts);
