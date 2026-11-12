'use strict';
// User lifecycle: deactivate (reversible), restore, permanently delete (irreversible, by anonymisation).
//
//  * "Deactivated" is the existing users.status = 'suspended'. Nothing is removed. Login, sessions and every protected route already
//    require status = 'active' (lib/auth.js), so the block is enforced by the server, not by the screen.
//  * "Permanently deleted" NEVER issues DELETE FROM users: attempts, grades, exams and questions reference the row, and the application
//    role has no DELETE privilege on it. The row is anonymised in place (status = 'deleted'), so its id keeps every academic record
//    intact while name, e-mail, student number, password, sessions, codes and class/roster links are gone. It is final: a database trigger
//    (migration 20261111000000) refuses any later change to a deleted row.
//  * Every operation is ONE transaction, serialised by an advisory lock, and is audited in the same transaction.
const { db, tx } = require('./db');
const { HttpError } = require('./http');
const { audit } = require('./audit');
const OTP = require('./otp');

const LAST_ADMIN = 'This is the last active administrator. Create or restore another administrator first.';
const RESTRICT = '23001'; // restrict_violation: raised by the database guard trigger
const reasonOf = v => {
  const s = String(v ?? '').trim();
  if (s.length > 300) throw new HttpError(400, 'The reason is too long (maximum 300 characters).');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s)) throw new HttpError(400, 'The reason contains invalid characters.');
  return s;
};

// Runs fn in one transaction. Refused requests (400/409) are written to the audit trail too, after the rollback, so attempts are visible.
async function run(actor, action, id, role, reason, fn) {
  try {
    return await tx(async () => {
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get('user-lifecycle'); // one lifecycle change at a time
      // The request was authenticated before it waited for the lock: an administrator deactivated in the meantime must not act any more.
      if ((await db.prepare('SELECT status FROM users WHERE id=?').get(actor.id))?.status !== 'active') throw new HttpError(401, 'Please sign in.');
      return await fn();
    });
  } catch (e) {
    const err = e?.code === RESTRICT && /last active administrator/.test(e.message) ? new HttpError(409, LAST_ADMIN) : e;
    if (err instanceof HttpError && (err.status === 400 || err.status === 409)) {
      try { await audit(actor, action, 'user', id, { result: 'refused', why: err.message.slice(0, 200), ...(reason ? { reason } : {}) }); } catch { /* auditing a refusal must never hide the refusal */ }
    }
    throw err;
  }
}
async function target(actor, id, verb) {
  const u = await db.prepare('SELECT id,email,name,role,status FROM users WHERE id=? FOR UPDATE').get(id);
  if (!u || u.status === 'deleted') throw new HttpError(404, 'That account was not found.');
  if (u.id === actor.id) throw new HttpError(409, `You cannot ${verb} your own account.`);
  return u;
}
const isLastAdmin = async u => u.role === 'admin' && u.status === 'active' && !await db.prepare("SELECT 1 FROM users WHERE role='admin' AND status='active' AND id<>?").get(u.id);
const endSessions = async id => { await db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); await OTP.invalidateFor(id); };

async function deactivate(actor, id, reasonIn) {
  const reason = reasonOf(reasonIn);
  return run(actor, 'USER_DEACTIVATED', id, null, reason, async () => {
    const u = await target(actor, id, 'deactivate');
    if (u.status === 'suspended') throw new HttpError(409, 'This account is already deactivated.');
    if (await isLastAdmin(u)) throw new HttpError(409, LAST_ADMIN);
    await db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(id);
    await endSessions(id);
    await audit(actor, 'USER_DEACTIVATED', 'user', id, { role: u.role, result: 'success', ...(reason ? { reason } : {}) });
    return { id, status: 'suspended' };
  });
}

async function restore(actor, id, reasonIn) {
  const reason = reasonOf(reasonIn);
  return run(actor, 'USER_RESTORED', id, null, reason, async () => {
    const u = await target(actor, id, 'restore');
    if (u.status !== 'suspended') throw new HttpError(409, 'Only a deactivated account can be restored.');
    await db.prepare("UPDATE users SET status='active' WHERE id=?").run(id); // same row, same id: history, classes and exams are untouched
    await audit(actor, 'USER_RESTORED', 'user', id, { role: u.role, result: 'success', ...(reason ? { reason } : {}) });
    return { id, status: 'active' };
  });
}

const n = async (sql, ...p) => (await db.prepare(sql).get(...p)).n * 1;
async function remove(actor, id, body = {}) {
  if (body.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE (in capital letters) to confirm a permanent deletion.');
  const reason = reasonOf(body.reason);
  return run(actor, 'USER_PERMANENTLY_DELETED', id, null, reason, async () => {
    const u = await target(actor, id, 'delete');
    if (await isLastAdmin(u)) throw new HttpError(409, LAST_ADMIN);
    // Never delete while something live depends on the account. Each message says what to do first.
    const now = Date.now(), why = [];
    const inProg = await n("SELECT COUNT(*) n FROM attempts WHERE student_id=? AND status='in_progress'", id);
    if (inProg) why.push(`has ${inProg} exam attempt${inProg > 1 ? 's' : ''} in progress (wait until ${inProg > 1 ? 'they are' : 'it is'} submitted)`);
    const open = await n("SELECT COUNT(*) n FROM exams WHERE owner_id=? AND status='published' AND (closes IS NULL OR closes>?)", id, now);
    if (open) why.push(`owns ${open} published exam${open > 1 ? 's' : ''} that ${open > 1 ? 'are' : 'is'} still open or scheduled (close or archive ${open > 1 ? 'them' : 'it'} first)`);
    const live = await n("SELECT COUNT(*) n FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE e.owner_id=? AND a.status='in_progress'", id);
    if (live) why.push(`owns exams with ${live} student attempt${live > 1 ? 's' : ''} in progress`);
    if (why.length) throw new HttpError(409, `This account cannot be deleted yet: it ${why.join('; it ')}.`, { blockers: why });

    const kept = {
      exam_attempts: await n('SELECT COUNT(*) n FROM attempts WHERE student_id=?', id), exams_owned: await n('SELECT COUNT(*) n FROM exams WHERE owner_id=?', id),
      questions_owned: await n('SELECT COUNT(*) n FROM questions WHERE owner_id=?', id), classes_created: await n('SELECT COUNT(*) n FROM classes WHERE created_by=?', id),
      grades_entered: await n('SELECT COUNT(*) n FROM grades WHERE graded_by=?', id)
    };
    const gone = {};
    // 1. Anonymise the account row in place (same id, so every record that points at it stays valid).
    await db.prepare("UPDATE users SET email=?, name='Deleted user', student_number=NULL, pw_hash='deleted', status='deleted', must_change=0, otp_exempt=0, email_verified_at=NULL, last_login=NULL WHERE id=?")
      .run(`deleted-${id}@deleted.invalid`, id);
    // 2. Remove what only identified or connected the person.
    gone.sessions = (await db.prepare('DELETE FROM sessions WHERE user_id=?').run(id)).changes;
    await OTP.invalidateFor(id); await db.prepare('DELETE FROM otp_events WHERE user_id=?').run(id);
    gone.class_memberships = (await db.prepare('DELETE FROM class_members WHERE user_id=?').run(id)).changes;
    gone.unused_exam_enrolments = (await db.prepare('DELETE FROM exam_students es WHERE es.student_id=? AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.exam_id=es.exam_id AND a.student_id=es.student_id)').run(id)).changes; // never took the exam: no academic record exists
    await db.prepare("UPDATE accommodations SET note='' WHERE student_id=?").run(id); // free-text notes can describe the person; the extra time itself stays with the attempt record
    // 3. Content the person created is kept, never handed to someone else: archived under the anonymised owner.
    gone.questions_archived = (await db.prepare('UPDATE questions SET archived=1, updated=? WHERE owner_id=? AND archived=0').run(now, id)).changes;
    gone.draft_exams_archived = (await db.prepare("UPDATE exams SET status='archived', updated=? WHERE owner_id=? AND status='draft'").run(now, id)).changes;
    await audit(actor, 'USER_PERMANENTLY_DELETED', 'user', id, { role: u.role, result: 'success', retained: kept, removed: gone, ...(reason ? { reason } : {}) }); // no name, e-mail or number
    return { id, deleted: true, retained: kept, removed: gone };
  });
}
module.exports = { deactivate, restore, remove, LAST_ADMIN };
