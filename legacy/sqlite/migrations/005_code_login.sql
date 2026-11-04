-- "Sign in with an email code" (no password). Adds a third challenge purpose, 'code_login'.
-- SQLite cannot change a CHECK constraint in place, so the challenge table created by migration 004 is rebuilt.
-- That table holds only short-lived pending codes (minutes); no user, exam, grade, submission or audit data is touched.
DROP TABLE otp_challenges;
CREATE TABLE otp_challenges(
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('login','password_reset','code_login')),
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
CREATE UNIQUE INDEX idx_otp_user_purpose ON otp_challenges(user_id, purpose);
CREATE INDEX idx_otp_expiry ON otp_challenges(challenge_expires);
