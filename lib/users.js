const { db, guarded, uniqueViolation } = require('./db');
const { audit } = require('./audit');
const { HttpError } = require('./http');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Insert shared by every account-creation path (admin form, class import, CSV import).
// Callers supply the scrypt hash of a generated temporary password; must_change is always set.
async function insertUser(actor, { email, name, role, student_number, pw_hash, status = 'active' }) {
  let id;
  try {
    id = (await guarded(async () => await db.prepare('INSERT INTO users(email,name,role,student_number,pw_hash,status,must_change,created) VALUES(?,?,?,?,?,?,1,?) RETURNING id')
      .run(email, name, role, String(student_number || '').trim().slice(0, 30) || null, pw_hash, status, Date.now()))).lastInsertRowid;
  } catch (e) { throw friendly(e); }
  await audit(actor, 'user.create', 'user', id, { email, role });
  return id;
}
// Database rules (unique email, unique student number) surface as clear 409s, never as raw SQL errors.
function friendly(e) {
  if (uniqueViolation(e, 'users_student_number_key')) return new HttpError(409, 'That student number already belongs to another account.');
  if (uniqueViolation(e, 'users_email_key')) return new HttpError(409, 'An account with that email already exists.');
  return e;
}
module.exports = { insertUser, EMAIL_RE, friendly };
