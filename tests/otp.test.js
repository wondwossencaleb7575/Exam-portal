// Email OTP verification. Uses a MOCK mail transport: no network, no Gmail credentials, no real email is ever sent.
const test = require('node:test'), assert = require('node:assert/strict');
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-otp-'));
Object.assign(process.env, {
  ADMIN_EMAIL: 'admin@t.local', ADMIN_PASSWORD: 'Admin-Pass-12345',
  TRUST_PROXY: '1', // lets each test client present its own IP through X-Forwarded-For
  OTP_LOGIN_MODE: 'staff', GMAIL_USER: 'portal@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop', APP_BASE_URL: 'https://portal.example.test',
  OTP_SECRET: 'x'.repeat(48), OTP_BURST_PER_IP_10MIN: '5000'
});
delete process.env.OTP_RESEND_COOLDOWN_SECONDS;
const { start } = require('../server');
const { db } = require('../lib/db');
const A = require('../lib/auth'), OTP = require('../lib/otp'), mailer = require('../lib/mailer');
const { otpEmail } = require('../lib/emailTemplates');
const srv = start(0), base = `http://localhost:${srv.address().port}`;
test.after(async () => { srv.closeAllConnections(); srv.close(); await require('../lib/db').close(); });

// ---------- mock mail transport ----------
const outbox = []; let failWith = null, rejectAll = false;
mailer.setTransport({
  async sendMail(m) { if (failWith) throw failWith; if (rejectAll) return { accepted: [], rejected: [m.to] }; outbox.push(m); return { accepted: [m.to], rejected: [], messageId: '<mock@test>' }; },
  async verify() { if (failWith) throw failWith; return true; }
});
const codeFrom = m => /verification code: (\d{6})/.exec(m.text)?.[1];
const lastCode = () => codeFrom(outbox.at(-1));
const smtpError = (code, extra = {}) => Object.assign(new Error(`${code} from smtp: Invalid login abcdefghijklmnop for portal@gmail.com`), { code, ...extra });

// ---------- http client with a real cookie jar and its own source IP ----------
let ipN = 0;
function client(ip = `10.1.${Math.floor(++ipN / 250)}.${ipN % 250}`) {
  const jar = {};
  const call = async (method, url, body, hdr = {}) => {
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'eagle', 'X-Forwarded-For': ip, ...(cookie ? { cookie } : {}), ...hdr }, body: body ? JSON.stringify(body) : undefined });
    const setCookies = r.headers.getSetCookie();
    for (const sc of setCookies) { const kv = sc.split(';')[0], i = kv.indexOf('='), k = kv.slice(0, i), v = kv.slice(i + 1); if (!v || /Max-Age=0/i.test(sc)) delete jar[k]; else jar[k] = v; }
    const ct = r.headers.get('content-type') || '', data = ct.includes('json') ? await r.json() : await r.text();
    return { status: r.status, data, headers: r.headers, setCookies };
  };
  return { jar, ip, get: async u => await call('GET', u), post: async (u, b, h) => await call('POST', u, b || {}, h), patch: async (u, b) => await call('PATCH', u, b), put: async (u, b) => await call('PUT', u, b), raw: call };
}
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.data).slice(0, 400)); return r.data; };
const PW = 'Teacher-Pass-1234';
let seq = 0;
async function mkUser(role, { email = `${role}${++seq}@t.local`, pw = PW, must_change = 0, exempt = 0, status = 'active' } = {}) {
  const id = (await db.prepare('INSERT INTO users(email,name,role,pw_hash,status,must_change,otp_exempt,created) VALUES(?,?,?,?,?,?,?,?) RETURNING id').run(email, `${role} ${seq}`, role, await A.hashPw(pw), status, must_change, exempt, Date.now())).lastInsertRowid;
  return { id: Number(id), email, pw };
}
// Password step then code step. Returns the signed-in client.
async function signIn(u, c = client()) {
  const n = outbox.length, l = ok(await c.post('/api/auth/login', { email: u.email, password: u.pw }));
  assert.equal(l.otp_required, true); assert.equal(outbox.length, n + 1);
  const v = ok(await c.post('/api/auth/otp/verify', { code: lastCode() })); assert.ok(c.jar.sid); return Object.assign(c, { user: v.user });
}
const reset = async () => { await db.exec('DELETE FROM otp_events'); failWith = null; rejectAll = false; for (const k of ['OTP_MAX_SENDS_PER_USER_HOUR', 'OTP_MAX_REQUESTS_PER_IP_HOUR', 'OTP_MAX_FAILS_PER_USER', 'OTP_MAX_FAILS_PER_IP', 'OTP_MAX_ATTEMPTS', 'OTP_LOGIN_MODE', 'OTP_MAX_RESENDS', 'OTP_TTL_SECONDS']) delete process.env[k]; process.env.OTP_LOGIN_MODE = 'staff'; process.env.OTP_MAX_SENDS_PER_USER_HOUR = '30'; mailer.setTransport(mock); };
const mock = { sendMail: null, verify: null }; // filled below so reset() can restore it
{ const t = { async sendMail(m) { if (failWith) throw failWith; if (rejectAll) return { accepted: [], rejected: [m.to] }; outbox.push(m); return { accepted: [m.to], rejected: [], messageId: '<mock@test>' }; }, async verify() { if (failWith) throw failWith; return true; } }; Object.assign(mock, t); mailer.setTransport(mock); }
const chRow = async id => await db.prepare("SELECT * FROM otp_challenges WHERE user_id=? AND purpose='login'").get(id);
const ageCooldown = async id => await db.prepare("UPDATE otp_challenges SET last_sent=last_sent-120000 WHERE user_id=? AND purpose='login'").run(id);
const wrongCode = c => (c === '000000' ? '111111' : '000000');
const tokenOf = c => c.jar.otp_ch;

test('setup: the first administrator exists', async () => { for (let i = 0; i < 100 && !await db.prepare('SELECT 1 FROM users').get(); i++) await new Promise(r => setTimeout(r, 50)); await reset(); });

// ---------------------------------------------------------------- generation, storage, email content
test('OTP generation: six digits, from a CSPRNG, uniformly distributed', () => {
  const seen = new Set(); let lead0 = 0;
  for (let i = 0; i < 6000; i++) { const c = OTP.generateCode(); assert.match(c, /^\d{6}$/); seen.add(c); if (c[0] === '0') lead0++; }
  assert.ok(seen.size > 5900, 'codes must not repeat like a weak generator');
  assert.ok(lead0 > 400 && lead0 < 800, `leading zeros must occur about 10% of the time (got ${lead0}/6000)`); // proves zero-padding rather than a 100000-999999 range
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'otp.js'), 'utf8'); assert.match(src, /crypto\.randomInt/); assert.doesNotMatch(src, /Math\.random/);
});

test('login with a correct password sends a real code and does NOT create a session', async () => {
  await reset(); const u = await mkUser('teacher'), c = client(), n = outbox.length, r = await c.post('/api/auth/login', { email: u.email, password: u.pw });
  const d = ok(r); assert.equal(d.otp_required, true); assert.equal(d.user, undefined); assert.equal(outbox.length, n + 1);
  const m = outbox.at(-1); assert.equal(m.to, u.email); assert.match(lastCode(), /^\d{6}$/);
  assert.equal(c.jar.sid, undefined, 'no session cookie');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(u.id)).n, 0, 'no session row');
  const ch = r.setCookies.find(x => x.startsWith('otp_ch=')); assert.match(ch, /HttpOnly/); assert.match(ch, /SameSite=Strict/); assert.match(ch, /Path=\/api\/auth/);
  assert.equal(r.setCookies.some(x => x.startsWith('sid=')), false);
  const body = JSON.stringify(d); assert.equal(body.includes(lastCode()), false, 'the code is never in the API response'); assert.match(d.otp.email_hint, /^t\*\*\*@t\.local$/); assert.equal(body.includes(u.email), false);
  assert.ok(d.otp.expires_in > 290 && d.otp.expires_in <= 300); assert.equal(d.otp.attempts_left, 5);
});

test('the code is never stored: only a keyed hash, and no table or audit row contains it', async () => {
  await reset(); const u = await mkUser('teacher'), c = client(); ok(await c.post('/api/auth/login', { email: u.email, password: u.pw })); const code = lastCode(), row = await chRow(u.id);
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);
  const th = A.sha(tokenOf(c)); assert.equal(row.token_hash, th); assert.notEqual(row.token_hash, tokenOf(c), 'the cookie value itself is not stored');
  for (const unkeyed of [code, `${u.id}|login|${th}|${code}`]) assert.notEqual(row.code_hash, crypto.createHash('sha256').update(unkeyed).digest('hex'), 'an unkeyed hash of a 6-digit code could be brute-forced from a stolen database');
  assert.equal(row.code_hash, OTP.codeHash(u.id, 'login', th, code));
  const dump = JSON.stringify([await db.prepare('SELECT * FROM otp_challenges').all(), await db.prepare('SELECT * FROM otp_events').all(), await db.prepare('SELECT * FROM audit').all()]);
  assert.equal(dump.includes(code), false); assert.equal(dump.includes(tokenOf(c)), false);
  assert.equal((await db.prepare('SELECT ip_hash FROM otp_events WHERE user_id=?').get(u.id)).ip_hash.includes(c.ip), false, 'raw IP addresses are not stored');
  assert.ok(row.code_expires - row.created <= 300000 && row.code_expires > row.created); // short expiry
});

test('email templates: branded HTML and plain text with code, expiry and a do-not-share warning; everything escaped', () => {
  const m = otpEmail({ name: 'Ann <script>alert(1)</script>', code: '012345', minutes: 5, schoolName: 'Eagle "Labs" & Co', brandColor: 'red;}</style>', baseUrl: 'https://portal.example.test/' });
  assert.match(m.text, /012345/); assert.match(m.text, /5 minutes/); assert.match(m.text, /DO NOT SHARE/i); assert.match(m.text, /Eagle Labs/);
  assert.match(m.html, /012345/); assert.match(m.html, /5 minutes/); assert.match(m.html, /Never share this code/); assert.match(m.html, /Eagle Labs/);
  assert.equal(m.html.includes('<script>'), false); assert.match(m.html, /&lt;script&gt;/); assert.equal(m.html.includes('red;}'), false, 'an unsafe brand colour falls back to the default');
  assert.equal(m.subject.includes('012345'), false, 'the code is not in the subject (lock-screen previews)'); assert.match(m.html, /portal\.example\.test\/img\/emblem\.png/);
  const sent = outbox.at(-1); assert.ok(sent.html && sent.text && sent.subject);
});

// ---------------------------------------------------------------- the happy path and bypass attempts
test('correct code signs in; roles land on the right account; session cookie keeps its protections', async () => {
  await reset(); const adm = await mkUser('admin'), tea = await mkUser('teacher');
  const c = client(); ok(await c.post('/api/auth/login', { email: adm.email, password: adm.pw })); const v = await c.post('/api/auth/otp/verify', { code: lastCode() });
  const d = ok(v); assert.equal(d.user.role, 'admin'); assert.equal(d.user.email, adm.email); assert.equal(JSON.stringify(d).includes('pw_hash'), false);
  const sid = v.setCookies.find(x => x.startsWith('sid=')); assert.match(sid, /HttpOnly/); assert.match(sid, /SameSite=Strict/); assert.match(sid, /Path=\//);
  assert.match(v.setCookies.find(x => x.startsWith('otp_ch=')), /Max-Age=0/, 'the challenge cookie is cleared'); assert.equal(c.jar.otp_ch, undefined);
  assert.equal(ok(await c.get('/api/auth/me')).user.role, 'admin'); ok(await c.get('/api/admin/users'));
  const t = await signIn(tea); assert.equal(t.user.role, 'teacher'); ok(await t.get('/api/exams')); assert.equal((await t.get('/api/admin/users')).status, 403, 'a teacher is still not an administrator');
  assert.ok((await db.prepare('SELECT email_verified_at v FROM users WHERE id=?').get(tea.id)).v > 0, 'verifying proves the mailbox');
  assert.ok((await db.prepare('SELECT last_login v FROM users WHERE id=?').get(tea.id)).v > 0);
  // the dashboard each role is sent to by the front end
  const homeFor = new Function(`${/const homeFor = [^;]+;/.exec(fs.readFileSync(path.join(__dirname, '..', 'public', 'core.js'), 'utf8'))[0]}; return homeFor;`)();
  assert.deepEqual([homeFor({ role: d.user.role }), homeFor({ role: t.user.role }), homeFor({ role: 'student' })], ['#/a/users', '#/t', '#/s']);
});

test('students sign in with a password only in the default "staff" mode', async () => {
  await reset(); const s = await mkUser('student'), c = client(), r = ok(await c.post('/api/auth/login', { email: s.email, password: s.pw }));
  assert.equal(r.otp_required, undefined); assert.equal(r.user.role, 'student'); assert.ok(c.jar.sid); assert.equal(outbox.at(-1)?.to === s.email, false);
  ok(await c.get('/api/student/exams'));
});

test('protected routes cannot be reached after the password step alone, with any trick', async () => {
  await reset(); const u = await mkUser('admin'), c = client(); ok(await c.post('/api/auth/login', { email: u.email, password: u.pw })); const tok = tokenOf(c);
  for (const url of ['/api/admin/users', '/api/exams', '/api/classes', '/api/students', '/api/dashboard']) assert.equal((await c.get(url)).status, 401, url);
  assert.equal(ok(await c.get('/api/auth/me')).user, null);
  const forged = client(); forged.jar.sid = tok; assert.equal((await forged.get('/api/admin/users')).status, 401, 'the challenge token is not a session');
  forged.jar.sid = A.sha(tok); assert.equal((await forged.get('/api/admin/users')).status, 401);
  const none = client(); assert.equal((await none.post('/api/auth/otp/verify', { code: '123456' })).status, 401); assert.equal((await none.get('/api/auth/otp/status')).status, 401);
  none.jar.otp_ch = 'A'.repeat(43); assert.equal((await none.post('/api/auth/otp/verify', { code: '123456' })).status, 401);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(u.id)).n, 0);
});

test('the account that is signed in is the one the server challenged, never one named in the request', async () => {
  await reset(); const victim = await mkUser('admin'), me = await mkUser('teacher'), c = client(); ok(await c.post('/api/auth/login', { email: me.email, password: me.pw }));
  const v = ok(await c.post('/api/auth/otp/verify', { code: lastCode(), email: victim.email, user_id: victim.id, role: 'admin', purpose: 'password_reset' }));
  assert.equal(v.user.id, me.id); assert.equal(v.user.role, 'teacher'); assert.equal((await c.get('/api/admin/users')).status, 403);
});

test('a wrong password sends no email and gives the same answer for unknown and known accounts', async () => {
  await reset(); const u = await mkUser('admin'), n = outbox.length, a = await client().post('/api/auth/login', { email: u.email, password: 'wrong-wrong-1' }), b = await client().post('/api/auth/login', { email: 'nobody@t.local', password: 'wrong-wrong-1' });
  assert.equal(a.status, 401); assert.equal(b.status, 401); assert.deepEqual(a.data, b.data); assert.equal(outbox.length, n);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM otp_challenges WHERE user_id=?').get(u.id)).n, 0);
});

test('CSRF protection still applies to the code endpoints', async () => {
  await reset(); const r = await fetch(base + '/api/auth/otp/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"code":"123456"}' }); assert.equal(r.status, 403);
  const r2 = await fetch(base + '/api/auth/otp/resend', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'eagle', Origin: 'https://evil.example' }, body: '{}' }); assert.equal(r2.status, 403);
});

// ---------------------------------------------------------------- wrong, expired, reused, replaced
test('an incorrect code is rejected, counted, and creates no session', async () => {
  await reset(); const u = await mkUser('teacher'), c = client(); ok(await c.post('/api/auth/login', { email: u.email, password: u.pw })); const good = lastCode();
  const r = await c.post('/api/auth/otp/verify', { code: wrongCode(good) }); assert.equal(r.status, 400); assert.equal(r.data.code, 'otp_invalid'); assert.equal(r.data.attempts_left, 4);
  assert.equal(c.jar.sid, undefined); assert.equal((await chRow(u.id)).attempts, 1); assert.equal((await c.get('/api/exams')).status, 401);
  ok(await c.post('/api/auth/otp/verify', { code: good })); ok(await c.get('/api/exams')); // the right code still works afterwards
});

test('malformed codes are rejected without being counted as guesses', async () => {
  await reset(); const u = await mkUser('teacher'), c = client(); ok(await c.post('/api/auth/login', { email: u.email, password: u.pw }));
  for (const bad of ['12345', '1234567', 'abcdef', '12 456', '', null, undefined, { a: 1 }, ['123456'], '１２３４５６']) { const r = await c.post('/api/auth/otp/verify', bad === undefined ? {} : { code: bad }); assert.equal(r.status, 400, JSON.stringify(bad)); assert.equal(r.data.code, 'otp_format'); }
  assert.equal((await chRow(u.id)).attempts, 0);
});

test('an expired code is rejected; a resend issues a working replacement', async () => {
  await reset(); const u = await mkUser('teacher'), c = client(); ok(await c.post('/api/auth/login', { email: u.email, password: u.pw })); const old = lastCode();
  await db.prepare("UPDATE otp_challenges SET code_expires=? WHERE user_id=?").run(Date.now() - 1000, u.id);
  const r = await c.post('/api/auth/otp/verify', { code: old }); assert.equal(r.status, 410); assert.equal(r.data.code, 'otp_expired'); assert.equal(c.jar.sid, undefined);
  assert.equal(ok(await c.get('/api/auth/otp/status')).otp.expires_in, 0);
  await ageCooldown(u.id); const rs = ok(await c.post('/api/auth/otp/resend')); assert.ok(rs.otp.expires_in > 290);
  ok(await c.post('/api/auth/otp/verify', { code: lastCode() }));
});

test('the whole sign-in session expires too', async () => {
  await reset(); const u = await mkUser('teacher'), c = client(); ok(await c.post('/api/auth/login', { email: u.email, password: u.pw })); const code = lastCode();
  await db.prepare('UPDATE otp_challenges SET challenge_expires=? WHERE user_id=?').run(Date.now() - 1, u.id);
  const r = await c.post('/api/auth/otp/verify', { code }); assert.equal(r.status, 401); assert.equal(r.data.code, 'otp_session_missing'); assert.equal(await chRow(u.id), undefined);
});

test('a code can be used only once, even when replayed with the same cookie', async () => {
  await reset(); const u = await mkUser('teacher'), c = client(); ok(await c.post('/api/auth/login', { email: u.email, password: u.pw })); const code = lastCode(), tok = tokenOf(c);
  ok(await c.post('/api/auth/otp/verify', { code })); assert.equal(await chRow(u.id), undefined, 'the challenge is consumed');
  const replay = client(); replay.jar.otp_ch = tok; const r = await replay.post('/api/auth/otp/verify', { code }); assert.equal(r.status, 401); assert.equal(replay.jar.sid, undefined);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(u.id)).n, 1, 'exactly one session came from that code');
});

test('two simultaneous requests with the right code produce exactly one session', async () => {
  await reset(); const u = await mkUser('teacher'), c1 = client(), c2 = client(); ok(await c1.post('/api/auth/login', { email: u.email, password: u.pw })); c2.jar.otp_ch = tokenOf(c1); const code = lastCode();
  const rs = await Promise.all([c1.post('/api/auth/otp/verify', { code }), c2.post('/api/auth/otp/verify', { code })]);
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 401]); assert.equal((await db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(u.id)).n, 1);
});

test('a newer sign-in replaces the earlier code: two codes are never valid together', async () => {
  await reset(); const u = await mkUser('teacher'), c1 = client(), c2 = client(); ok(await c1.post('/api/auth/login', { email: u.email, password: u.pw })); const first = lastCode();
  ok(await c2.post('/api/auth/login', { email: u.email, password: u.pw })); const second = lastCode(); assert.notEqual(first, second);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM otp_challenges WHERE user_id=? AND purpose='login'").get(u.id)).n, 1);
  assert.equal((await c1.post('/api/auth/otp/verify', { code: first })).status, 401, 'the first browser lost its challenge'); assert.equal(c1.jar.sid, undefined);
  const x = client(); x.jar.otp_ch = tokenOf(c2); assert.equal((await x.post('/api/auth/otp/verify', { code: first })).status, 400, 'the old code does not work in the new challenge either');
  ok(await c2.post('/api/auth/otp/verify', { code: second }));
});

test('resending replaces the code in place: the previous code stops working immediately', async () => {
  await reset(); const u = await mkUser('teacher'), c = client(); ok(await c.post('/api/auth/login', { email: u.email, password: u.pw })); const first = lastCode(); await ageCooldown(u.id);
  const r = ok(await c.post('/api/auth/otp/resend')); const second = lastCode(); assert.notEqual(first, second); assert.equal(r.otp.resends_left, 2); assert.equal(outbox.at(-1).to, u.email);
  assert.equal((await c.post('/api/auth/otp/verify', { code: first })).status, 400); assert.equal(c.jar.sid, undefined);
  ok(await c.post('/api/auth/otp/verify', { code: second }));
});

// ---------------------------------------------------------------- attempt limits, cooldowns, rate limits
test('after the maximum wrong attempts the code is cancelled, even if the right code is then entered', async () => {
  await reset(); const u = await mkUser('teacher'), c = client(); ok(await c.post('/api/auth/login', { email: u.email, password: u.pw })); const good = lastCode(), bad = wrongCode(good);
  for (let i = 1; i <= 4; i++) { const r = await c.post('/api/auth/otp/verify', { code: bad }); assert.equal(r.status, 400); assert.equal(r.data.attempts_left, 5 - i); }
  const last = await c.post('/api/auth/otp/verify', { code: bad }); assert.equal(last.status, 400); assert.equal(last.data.attempts_left, 0); assert.match(last.data.error, /cancelled/);
  const r = await c.post('/api/auth/otp/verify', { code: good }); assert.equal(r.status, 429); assert.equal(r.data.code, 'otp_attempts_exhausted'); assert.equal(c.jar.sid, undefined);
  await ageCooldown(u.id); ok(await c.post('/api/auth/otp/resend')); ok(await c.post('/api/auth/otp/verify', { code: lastCode() })); // a fresh code works
});

test('resending does not buy unlimited guesses: the challenge locks after the total attempt cap', async () => {
  await reset(); const u = await mkUser('teacher'), c = client(); ok(await c.post('/api/auth/login', { email: u.email, password: u.pw }));
  for (let round = 0; round < 2; round++) { for (let i = 0; i < 5; i++) await c.post('/api/auth/otp/verify', { code: wrongCode(lastCode()) }); if (round === 0) { await ageCooldown(u.id); ok(await c.post('/api/auth/otp/resend')); } }
  const r = await c.post('/api/auth/otp/verify', { code: lastCode() }); assert.equal(r.status, 429); assert.equal(r.data.code, 'otp_locked'); assert.equal(c.jar.sid, undefined); assert.equal((await chRow(u.id))?.code_hash ?? '!', '!', 'the current code can never be accepted');
});

test('resend cooldown and resend cap are enforced and send nothing', async () => {
  await reset(); const u = await mkUser('teacher'), c = client(); ok(await c.post('/api/auth/login', { email: u.email, password: u.pw })); let n = outbox.length;
  const r = await c.post('/api/auth/otp/resend'); assert.equal(r.status, 429); assert.equal(r.data.code, 'otp_cooldown'); assert.ok(r.data.retry_after > 0 && r.data.retry_after <= 60); assert.equal(outbox.length, n);
  for (let i = 0; i < 3; i++) { await ageCooldown(u.id); ok(await c.post('/api/auth/otp/resend')); } n = outbox.length;
  await ageCooldown(u.id); const cap = await c.post('/api/auth/otp/resend'); assert.equal(cap.status, 429); assert.equal(cap.data.code, 'otp_resend_limit'); assert.equal(outbox.length, n);
  assert.equal(ok(await c.get('/api/auth/otp/status')).otp.resends_left, 0);
});

test('rate limit: emails per account per hour (stops mail-bombing one mailbox)', async () => {
  await reset(); process.env.OTP_MAX_SENDS_PER_USER_HOUR = '2'; const u = await mkUser('teacher'); let n;
  ok(await client().post('/api/auth/login', { email: u.email, password: u.pw })); ok(await client().post('/api/auth/login', { email: u.email, password: u.pw })); n = outbox.length;
  const r = await client().post('/api/auth/login', { email: u.email, password: u.pw }); assert.equal(r.status, 429); assert.equal(r.data.code, 'otp_rate_limited'); assert.ok(r.data.retry_after > 0); assert.equal(outbox.length, n);
  assert.equal(r.headers.get('set-cookie'), null, 'no challenge cookie and no session when rate limited');
});

test('rate limit: code requests per IP address per hour', async () => {
  await reset(); process.env.OTP_MAX_REQUESTS_PER_IP_HOUR = '5'; const ip = '203.0.113.9';
  for (let i = 0; i < 5; i++) { const u = await mkUser('teacher'); ok(await client(ip).post('/api/auth/login', { email: u.email, password: u.pw })); }
  const u = await mkUser('teacher'), n = outbox.length, r = await client(ip).post('/api/auth/login', { email: u.email, password: u.pw }); assert.equal(r.status, 429); assert.equal(outbox.length, n);
  const other = await client('203.0.113.10').post('/api/auth/login', { email: u.email, password: u.pw }); assert.equal(other.status, 200, 'another address is unaffected');
});

test('rate limit: wrong codes per account lock further guesses across challenges', async () => {
  await reset(); process.env.OTP_MAX_FAILS_PER_USER = '3'; const u = await mkUser('teacher'), c = client(); ok(await c.post('/api/auth/login', { email: u.email, password: u.pw })); const good = lastCode();
  for (let i = 0; i < 3; i++) assert.equal((await c.post('/api/auth/otp/verify', { code: wrongCode(good) })).status, 400);
  const r = await c.post('/api/auth/otp/verify', { code: good }); assert.equal(r.status, 429); assert.equal(r.data.code, 'otp_locked'); assert.ok(r.data.retry_after > 0); assert.equal(c.jar.sid, undefined, 'even the correct code is refused while locked');
  assert.ok((await db.prepare("SELECT COUNT(*) n FROM audit WHERE action='auth.otp_locked'").get()).n >= 1);
  const c2 = client(); ok(await c2.post('/api/auth/login', { email: u.email, password: u.pw })); assert.equal((await c2.post('/api/auth/otp/verify', { code: lastCode() })).status, 429, 'a new challenge does not escape the account lock');
});

test('rate limit: wrong codes per IP address', async () => {
  await reset(); process.env.OTP_MAX_FAILS_PER_IP = '10'; const ip = '198.51.100.7'; let last;
  for (let i = 0; i < 10; i++) { const u = await mkUser('teacher'), c = client(ip); ok(await c.post('/api/auth/login', { email: u.email, password: u.pw })); await c.post('/api/auth/otp/verify', { code: wrongCode(lastCode()) }); }
  const u = await mkUser('teacher'), c = client(ip); ok(await c.post('/api/auth/login', { email: u.email, password: u.pw })); last = await c.post('/api/auth/otp/verify', { code: lastCode() }); assert.equal(last.status, 429); assert.equal(c.jar.sid, undefined);
});

test('a successful sign-in clears that account\'s failure count', async () => {
  await reset(); const u = await mkUser('teacher'), c = client(); ok(await c.post('/api/auth/login', { email: u.email, password: u.pw })); await c.post('/api/auth/otp/verify', { code: wrongCode(lastCode()) });
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM otp_events WHERE user_id=? AND kind='fail'").get(u.id)).n, 1); ok(await c.post('/api/auth/otp/verify', { code: lastCode() }));
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM otp_events WHERE user_id=? AND kind='fail'").get(u.id)).n, 0);
});

test('limits are configurable through the environment, and bad values fall back safely', async () => {
  await reset(); process.env.OTP_TTL_SECONDS = '120'; process.env.OTP_MAX_ATTEMPTS = '3'; let c = OTP.config(); assert.equal(c.ttlMs, 120000); assert.equal(c.maxAttempts, 3);
  process.env.OTP_TTL_SECONDS = 'abc'; process.env.OTP_MAX_ATTEMPTS = '99999'; c = OTP.config(); assert.equal(c.ttlMs, 300000); assert.equal(c.maxAttempts, 5);
  process.env.OTP_LOGIN_MODE = 'sometimes'; assert.equal(OTP.config().mode, 'staff', 'an unrecognised mode never switches protection off'); process.env.OTP_LOGIN_MODE = 'OFF'; assert.equal(OTP.config().mode, 'off');
  await reset();
});

test('per-code attempt limit follows OTP_MAX_ATTEMPTS', async () => {
  await reset(); process.env.OTP_MAX_ATTEMPTS = '2'; const u = await mkUser('teacher'), c = client(); ok(await c.post('/api/auth/login', { email: u.email, password: u.pw })); const good = lastCode();
  assert.equal((await c.post('/api/auth/otp/verify', { code: wrongCode(good) })).data.attempts_left, 1); assert.equal((await c.post('/api/auth/otp/verify', { code: wrongCode(good) })).data.attempts_left, 0);
  assert.equal((await c.post('/api/auth/otp/verify', { code: good })).status, 429);
});

// ---------------------------------------------------------------- purposes
test('login and password-reset codes are separate: neither authorises the other', async () => {
  await reset(); const u = await mkUser('teacher'), user = await db.prepare('SELECT * FROM users WHERE id=?').get(u.id), ip = '192.0.2.1';
  const L = await OTP.start(user, 'login', ip), codeL = lastCode(); const R = await OTP.start(user, 'password_reset', ip), codeR = lastCode(); assert.notEqual(codeL, codeR);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM otp_challenges WHERE user_id=?').get(u.id)).n, 2, 'one pending challenge per purpose');
  assert.match(outbox.at(-1).subject, /password reset/i); assert.match(outbox.at(-1).text, /reset your password/i);
  await assert.rejects(async () => await OTP.verify(L.token, codeL, ip, { purpose: 'password_reset' }), e => e.status === 401);   // login token + reset purpose
  await assert.rejects(async () => await OTP.verify(R.token, codeR, ip, { purpose: 'login' }), e => e.status === 401);           // reset token + login purpose
  await assert.rejects(async () => await OTP.verify(L.token, codeR, ip, { purpose: 'login' }), e => e.status === 400);           // reset CODE on the login challenge
  await assert.rejects(async () => await OTP.verify(R.token, codeL, ip, { purpose: 'password_reset' }), e => e.status === 400);  // login CODE on the reset challenge
  // over HTTP: holding a password-reset challenge cookie never yields a login session
  const c = client(); c.jar.otp_ch = R.token; assert.equal((await c.post('/api/auth/otp/verify', { code: codeR })).status, 401); assert.equal(c.jar.sid, undefined);
  assert.equal((await OTP.verify(R.token, codeR, ip, { purpose: 'password_reset' })).user.id, u.id); assert.ok(await db.prepare("SELECT 1 FROM otp_challenges WHERE user_id=? AND purpose='login'").get(u.id), 'using the reset code leaves the login challenge alone');
  assert.equal((await OTP.verify(L.token, codeL, ip, { purpose: 'login' })).user.id, u.id);
  await assert.rejects(async () => await db.prepare("INSERT INTO otp_challenges(token_hash,user_id,purpose,email,code_hash,code_expires,challenge_expires,last_sent,created) VALUES('x',?,'anything','e','h',1,1,1,1)").run(u.id), /check constraint/i);
});

test('there is no self-service password reset to abuse: only the existing administrator-issued reset exists', async () => {
  await reset(); const n = outbox.length; for (const url of ['/api/auth/forgot-password', '/api/auth/reset-password', '/api/auth/otp/reset']) { const c = client(), r = await c.post(url, { email: 'admin@t.local' }); assert.ok([401, 404].includes(r.status), url); assert.equal(c.jar.sid, undefined); }
  assert.equal(outbox.length, n, 'no email is sent by any such route');
});

// ---------------------------------------------------------------- the challenge is tied to the account it was issued for
test('changing the password, the email address or the status of an account cancels its pending code', async () => {
  await reset(); const adm = await signIn(await mkUser('admin'));
  const t1 = await mkUser('teacher'), c1 = client(); ok(await c1.post('/api/auth/login', { email: t1.email, password: t1.pw })); const code1 = lastCode();
  ok(await adm.post(`/api/admin/users/${t1.id}/reset-password`)); assert.equal(await chRow(t1.id), undefined); assert.equal((await c1.post('/api/auth/otp/verify', { code: code1 })).status, 401);
  const t2 = await mkUser('teacher'), c2 = client(); ok(await c2.post('/api/auth/login', { email: t2.email, password: t2.pw })); const code2 = lastCode(); await db.prepare('UPDATE users SET email_verified_at=5 WHERE id=?').run(t2.id);
  ok(await adm.patch(`/api/admin/users/${t2.id}`, { email: 'new-address@t.local' })); assert.equal((await c2.post('/api/auth/otp/verify', { code: code2 })).status, 401); assert.equal((await db.prepare('SELECT email_verified_at v FROM users WHERE id=?').get(t2.id)).v, null, 'a new address is unverified');
  const t3 = await mkUser('teacher'), c3 = client(); ok(await c3.post('/api/auth/login', { email: t3.email, password: t3.pw })); const code3 = lastCode();
  ok(await adm.patch(`/api/admin/users/${t3.id}`, { status: 'suspended' })); assert.equal((await c3.post('/api/auth/otp/verify', { code: code3 })).status, 401);
  const t4 = await mkUser('teacher'), c4 = client(); ok(await c4.post('/api/auth/login', { email: t4.email, password: t4.pw })); const code4 = lastCode();
  await db.prepare('UPDATE users SET email=? WHERE id=?').run('moved@t.local', t4.id); assert.equal((await c4.post('/api/auth/otp/verify', { code: code4 })).status, 401, 'a code sent to an old address cannot be used once the address changed');
});

test('verification and session creation are one atomic step: if sign-in fails, the code is not spent', async () => {
  await reset(); const u = await mkUser('teacher'), user = await db.prepare('SELECT * FROM users WHERE id=?').get(u.id), L = await OTP.start(user, 'login', '192.0.2.5'), code = lastCode();
  await assert.rejects(async () => await OTP.verify(L.token, code, '192.0.2.5', { onSuccess: () => { throw new Error('boom'); } }), /boom/);
  assert.ok(await chRow(u.id), 'rolled back: the challenge still exists'); assert.equal((await db.prepare('SELECT email_verified_at v FROM users WHERE id=?').get(u.id)).v, null);
  assert.equal((await OTP.verify(L.token, code, '192.0.2.5')).user.id, u.id);
});

// ---------------------------------------------------------------- modes and exemptions (policy for accounts without a working email)
test('mode "all" also protects students; an administrator can exempt students (never staff)', async () => {
  await reset(); process.env.OTP_LOGIN_MODE = 'all'; const adm = await signIn(await mkUser('admin')), s1 = await mkUser('student'), s2 = await mkUser('student'), t = await mkUser('teacher');
  let r = ok(await client().post('/api/auth/login', { email: s1.email, password: s1.pw })); assert.equal(r.otp_required, true);
  ok(await adm.patch(`/api/admin/users/${s2.id}`, { otp_exempt: true })); r = ok(await client().post('/api/auth/login', { email: s2.email, password: s2.pw })); assert.equal(r.otp_required, undefined); assert.equal(r.user.role, 'student');
  assert.equal((await adm.patch(`/api/admin/users/${t.id}`, { otp_exempt: true })).status, 400, 'staff can never be exempt');
  await assert.rejects(async () => await db.prepare('UPDATE users SET otp_exempt=1 WHERE id=?').run(t.id), /users_otp_exempt_students_only/); await assert.rejects(async () => await db.prepare("UPDATE users SET role='teacher' WHERE id=?").run(s2.id), /users_otp_exempt_students_only/);
  const list = ok(await adm.get('/api/admin/users?role=student')); assert.equal(list.otp_mode, 'all'); assert.equal(list.items.find(x => x.id === s2.id).otp_required, false); assert.equal(list.items.find(x => x.id === s1.id).otp_required, true);
  const ex = await client().post('/api/auth/login', { email: s2.email, password: s2.pw }); assert.equal(ex.status, 200);
  assert.equal((await mkUser('student', { exempt: 1 })).id > 0, true);
  assert.equal(JSON.stringify(list).includes('code_hash'), false);
  assert.equal((await client().get('/api/admin/users')).status, 401); const tc = await signIn(t); assert.equal((await tc.patch(`/api/admin/users/${s1.id}`, { otp_exempt: true })).status, 403, 'only administrators can exempt');
});

test('mode "off" is the documented emergency switch: password only, no email', async () => {
  await reset(); process.env.OTP_LOGIN_MODE = 'off'; const u = await mkUser('admin'), n = outbox.length, r = ok(await client().post('/api/auth/login', { email: u.email, password: u.pw })); assert.equal(r.user.role, 'admin'); assert.equal(outbox.length, n);
});

test('first sign-in flow with a temporary password still works: code, then forced password change', async () => {
  await reset(); const adm = await signIn(await mkUser('admin')), made = ok(await adm.post('/api/admin/users', { email: 'newteach@t.local', name: 'New Teach', role: 'teacher' }));
  const c = await signIn({ email: 'newteach@t.local', pw: made.temp_password }); assert.equal(c.user.must_change, true);
  const blocked = await c.get('/api/exams'); assert.equal(blocked.status, 403); assert.equal(blocked.data.code, 'must_change');
  ok(await c.post('/api/auth/change-password', { current: made.temp_password, next: 'Brand-New-Pass-77' })); ok(await c.get('/api/exams'));
  const again = client(); assert.equal(ok(await again.post('/api/auth/login', { email: 'newteach@t.local', password: 'Brand-New-Pass-77' })).otp_required, true);
});

test('portal features keep working behind the code step (exams, classes, student view)', async () => {
  await reset(); const t = await signIn(await mkUser('teacher')), s = await mkUser('student'), sc = client(); ok(await sc.post('/api/auth/login', { email: s.email, password: s.pw }));
  const cl = ok(await t.post('/api/classes', { name: 'Grade 10A', grade: '10', academic_year: '2026/27', subject_id: 1 })); const ex = ok(await t.post('/api/exams', { title: 'Algebra' }));
  assert.ok(cl.id && ex.id); assert.equal(ok(await t.get('/api/exams')).items?.length ?? ok(await t.get('/api/exams')).length, 1); assert.equal((await sc.get('/api/exams')).status, 403); ok(await sc.get('/api/student/exams'));
  ok(await t.post('/api/auth/logout')); assert.equal((await t.get('/api/exams')).status, 401);
});

// ---------------------------------------------------------------- mail failures
test('SMTP failures: no session, no dangling challenge, a safe message, nothing secret', async () => {
  const cases = [['EAUTH', { responseCode: 535 }], ['ETIMEDOUT'], ['ECONNECTION'], ['ESOCKET'], ['EENVELOPE', { responseCode: 550 }]];
  for (const [code, extra] of cases) {
    await reset(); const u = await mkUser('teacher'), c = client(); failWith = smtpError(code, extra); const n = outbox.length;
    const r = await c.post('/api/auth/login', { email: u.email, password: u.pw });
    assert.equal(r.status, 503, code); assert.equal(r.data.code, 'otp_delivery_failed'); assert.equal(c.jar.sid, undefined); assert.equal(c.jar.otp_ch, undefined); assert.equal(r.data.otp_required, undefined);
    assert.equal(await chRow(u.id), undefined, 'a failed send leaves no usable challenge'); assert.equal(outbox.length, n);
    const body = JSON.stringify(r.data); for (const secret of ['abcdefghijklmnop', 'abcd efgh', 'portal@gmail.com', 'Invalid login', 'smtp', 'EAUTH', code]) assert.equal(body.includes(secret), false, `${code}: response leaked "${secret}"`);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM otp_events WHERE user_id=? AND kind='send'").get(u.id)).n, 0, 'a failed send is never recorded as sent');
    assert.equal(ok(await c.get('/api/auth/me')).user, null); assert.ok(await db.prepare("SELECT 1 FROM audit WHERE action='auth.otp_delivery_failed' AND resource_id=?").get(u.id));
  }
});

test('a provider that "accepts" the call but rejects the recipient is a failure, not a success', async () => {
  await reset(); const u = await mkUser('teacher'), c = client(); rejectAll = true; const r = await c.post('/api/auth/login', { email: u.email, password: u.pw });
  assert.equal(r.status, 503); assert.equal(await chRow(u.id), undefined); assert.equal(c.jar.sid, undefined); assert.equal((await db.prepare("SELECT COUNT(*) n FROM otp_events WHERE kind='send'").get()).n, 0);
});

test('when email is not configured, sign-in for accounts that need a code fails closed (no bypass)', async () => {
  await reset(); mailer.setTransport(null); const saved = [process.env.GMAIL_USER, process.env.GMAIL_APP_PASSWORD]; delete process.env.GMAIL_USER; delete process.env.GMAIL_APP_PASSWORD;
  try {
    const u = await mkUser('admin'), c = client(), r = await c.post('/api/auth/login', { email: u.email, password: u.pw });
    assert.equal(r.status, 503); assert.equal(r.data.code, 'otp_unavailable'); assert.equal(c.jar.sid, undefined); assert.equal(await chRow(u.id), undefined);
    const s = await mkUser('student'); assert.equal((await client().post('/api/auth/login', { email: s.email, password: s.pw })).status, 200, 'students (password only) are unaffected');
    assert.equal(mailer.configured(), false); assert.equal((await mailer.verify()).kind, 'not_configured');
  } finally { [process.env.GMAIL_USER, process.env.GMAIL_APP_PASSWORD] = saved; await reset(); }
});

test('mailer: provider errors are classified and scrubbed; credentials never reach the error', async () => {
  await reset(); mailer.setTransport({ async sendMail() { throw smtpError('EAUTH', { responseCode: 535 }); }, verify: async () => { throw smtpError('EAUTH'); } });
  await assert.rejects(mailer.sendMail({ to: 'a@b.cc', subject: 's', text: 't', html: 'h' }), e => { assert.equal(e.kind, 'auth'); assert.equal(String(e.detail).includes('abcdefghijklmnop'), false); assert.equal(String(e.detail).includes('portal@gmail.com'), false); assert.equal(e.message.includes('abcd'), false); return true; });
  const v = await mailer.verify(); assert.equal(v.ok, false); assert.equal(v.kind, 'auth'); assert.equal(JSON.stringify(v).includes('abcdefgh'), false);
  const kinds = { ETIMEDOUT: 'timeout', ECONNREFUSED: 'connection', ENOTFOUND: 'connection', EENVELOPE: 'rejected' };
  for (const [code, kind] of Object.entries(kinds)) { mailer.setTransport({ async sendMail() { throw smtpError(code); } }); await assert.rejects(mailer.sendMail({ to: 'a@b.cc', subject: 's', text: 't' }), e => e.kind === kind, code); }
  mailer.setTransport({ async sendMail() { throw Object.assign(new Error('550-5.4.5 Daily user sending quota exceeded'), { responseCode: 550 }); } }); await assert.rejects(mailer.sendMail({ to: 'a@b.cc', subject: 's', text: 't' }), e => e.kind === 'quota');
  await assert.rejects(mailer.sendMail({ to: 'not-an-address', subject: 's', text: 't' }), e => e.kind === 'rejected'); await reset();
});

test('a failed resend invalidates the replaced code, keeps the challenge, and allows an immediate retry', async () => {
  await reset(); const u = await mkUser('teacher'), c = client(); ok(await c.post('/api/auth/login', { email: u.email, password: u.pw })); const first = lastCode(); await ageCooldown(u.id);
  failWith = smtpError('ETIMEDOUT'); const r = await c.post('/api/auth/otp/resend'); assert.equal(r.status, 503); assert.equal(r.data.code, 'otp_delivery_failed');
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM otp_events WHERE user_id=? AND kind='send'").get(u.id)).n, 1, 'only the first, real send is counted');
  assert.equal((await c.post('/api/auth/otp/verify', { code: first })).status, 410, 'the code that was replaced no longer works');
  failWith = null; ok(await c.post('/api/auth/otp/resend')); ok(await c.post('/api/auth/otp/verify', { code: lastCode() }));
});

// ---------------------------------------------------------------- housekeeping, status, cancel, audit
test('status and cancel: reloading the code screen works, and going back never signs anyone in', async () => {
  await reset(); const u = await mkUser('teacher'), c = client(); ok(await c.post('/api/auth/login', { email: u.email, password: u.pw }));
  const s = ok(await c.get('/api/auth/otp/status')); assert.equal(s.otp.email_hint, 't***@t.local'); assert.ok(s.otp.expires_in > 0); assert.equal(JSON.stringify(s).includes(lastCode()), false);
  ok(await c.post('/api/auth/otp/cancel')); assert.equal(c.jar.otp_ch, undefined); assert.equal(await chRow(u.id), undefined); assert.equal(c.jar.sid, undefined);
  assert.equal((await c.get('/api/auth/otp/status')).status, 401);
});

test('housekeeping removes expired challenges and old counters', async () => {
  await reset(); const now = Date.now(); await db.prepare("INSERT INTO otp_events(ts,kind,user_id,ip_hash) VALUES(?,?,NULL,'h')").run(now - 25 * 3600e3, 'fail'); await db.prepare("INSERT INTO otp_events(ts,kind,user_id,ip_hash) VALUES(?,?,NULL,'h')").run(now, 'fail');
  const u = (await db.prepare('SELECT id FROM users LIMIT 1').get()).id; await db.prepare("INSERT INTO otp_challenges(token_hash,user_id,purpose,email,code_hash,code_expires,challenge_expires,last_sent,created) VALUES('old',?,'password_reset','e','h',1,?,1,1)").run(u, now - 1);
  await OTP.sweep(); assert.equal((await db.prepare("SELECT COUNT(*) n FROM otp_events WHERE ip_hash='h'").get()).n, 1); assert.equal((await db.prepare("SELECT COUNT(*) n FROM otp_challenges WHERE token_hash='old'").get()).n, 0);
});

test('audit trail records sends and verifications without any secret', async () => {
  await reset(); const u = await mkUser('teacher'); await signIn(u); const rows = await db.prepare("SELECT action,resource_id,detail FROM audit WHERE resource_id=? AND action LIKE 'auth.otp%'").all(u.id);
  assert.deepEqual(rows.map(r => r.action), ['auth.otp_sent', 'auth.otp_verified']); assert.equal(JSON.stringify(rows).includes(outbox.at(-1).text.match(/\d{6}/)[0]), false);
});

// ---------------------------------------------------------------- administrator diagnostics
test('admin email diagnostics: status hides the password; check and test work; only admins; test emails are limited', async () => {
  await reset(); const adm = await signIn(await mkUser('admin')), tea = await signIn(await mkUser('teacher'));
  const st = ok(await adm.get('/api/admin/email-status')); assert.equal(st.configured, true); assert.equal(st.mode, 'staff'); assert.equal(st.sender, 'p***@gmail.com'); assert.equal(JSON.stringify(st).includes('abcd'), false); assert.equal(JSON.stringify(st).includes('OTP_SECRET'), false); assert.equal(JSON.stringify(st).includes('x'.repeat(10)), false);
  assert.equal(ok(await adm.post('/api/admin/email-status/verify')).last_check.ok, true); failWith = smtpError('EAUTH'); const bad = ok(await adm.post('/api/admin/email-status/verify')); assert.equal(bad.last_check.ok, false); assert.equal(bad.last_check.kind, 'auth'); assert.equal(JSON.stringify(bad).includes('abcdefgh'), false); failWith = null;
  const n = outbox.length, t = ok(await adm.post('/api/admin/email-test')); assert.equal(outbox.length, n + 1); assert.equal(outbox.at(-1).to, adm.user.email); assert.match(t.to, /\*\*\*@/);
  for (const url of ['/api/admin/email-status', '/api/admin/email-status/verify', '/api/admin/email-test']) assert.equal((await tea[url.includes('status') && !url.includes('verify') ? 'get' : 'post'](url)).status, 403, url);
  for (let i = 0; i < 4; i++) ok(await adm.post('/api/admin/email-test')); assert.equal((await adm.post('/api/admin/email-test')).status, 429);
  failWith = smtpError('ETIMEDOUT'); await db.exec("DELETE FROM otp_events WHERE kind='test'"); const f = await adm.post('/api/admin/email-test'); assert.equal(f.status, 502); assert.equal(JSON.stringify(f.data).includes('smtp'), false); failWith = null;
});

test('startup report flags enforcement without credentials and undeliverable staff addresses', async () => {
  await reset(); const r = await OTP.startupReport(); assert.equal(r.mode, 'staff'); assert.equal(r.mail_configured, true); assert.equal(r.secret, 'environment');
});

// ---------------------------------------------------------------- sign in with an emailed code only (no password)
const until = async (f, ms = 1500) => { for (let t = 0; t < ms && !f(); t += 10) await new Promise(r => setTimeout(r, 10)); return f(); };
const shape = o => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)) ? Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]])) : v);
const types = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'object' && v ? types(v) : typeof v]));
const requestCode = (c, email) => c.post('/api/auth/code/request', { email });
delete process.env.OTP_CODE_LOGIN_ROLES;

test('a student can sign in with just an emailed code: no password, real email, session only after the code', async () => {
  await reset(); const st = await mkUser('student'), c = client(), n = outbox.length;
  const r = await requestCode(c, st.email); const d = ok(r); assert.equal(d.code_login, true); assert.equal(d.otp_required, true); assert.equal(d.user, undefined);
  assert.match(r.setCookies.find(x => x.startsWith('otp_ch=')), /HttpOnly.*SameSite=Strict.*Path=\/api\/auth|SameSite=Strict.*HttpOnly/s); assert.equal(c.jar.sid, undefined);
  await until(() => outbox.length > n); assert.equal(outbox.length, n + 1); assert.equal(outbox.at(-1).to, st.email); assert.match(outbox.at(-1).subject, /sign-in code/i); assert.match(outbox.at(-1).text, /instead of a password/);
  assert.equal(JSON.stringify(d).includes(lastCode()), false); assert.equal((await c.get('/api/student/exams')).status, 401, 'no access before the code');
  assert.equal(ok(await c.get('/api/auth/otp/status')).otp.email_hint, 's***@t.local');
  const v = ok(await c.post('/api/auth/otp/verify', { code: lastCode() })); assert.equal(v.user.role, 'student'); assert.equal(v.user.id, st.id); ok(await c.get('/api/student/exams')); assert.equal((await c.get('/api/exams')).status, 403);
  assert.ok((await db.prepare('SELECT email_verified_at v FROM users WHERE id=?').get(st.id)).v > 0);
  const rep = client(); rep.jar.otp_ch = c.jar.otp_ch ?? 'x'; assert.equal((await rep.post('/api/auth/otp/verify', { code: lastCode() })).status, 401, 'single use');
});

test('requesting a code cannot reveal who has an account: identical answers for registered, unknown, staff, suspended and temporary-password accounts', async () => {
  await reset(); const real = await mkUser('student'), teacher = await mkUser('teacher'), susp = await mkUser('student', { status: 'suspended' }), temp = await mkUser('student', { must_change: 1 }), exempt = await mkUser('student', { exempt: 1 });
  const n = outbox.length, cases = { real: real.email, unknown: 'nobody-here@t.local', teacher: teacher.email, suspended: susp.email, temp: temp.email, exempt: exempt.email }, out = {};
  for (const [k, email] of Object.entries(cases)) { const c = client(), r = await requestCode(c, email); out[k] = { r, c, mail: r.data.otp.email_hint }; }
  await until(() => outbox.length > n); await new Promise(r => setTimeout(r, 50));
  assert.equal(outbox.length, n + 1, 'only the eligible student got an email'); assert.equal(outbox.at(-1).to, real.email);
  const ref = out.real; for (const [k, o] of Object.entries(out)) {
    assert.equal(o.r.status, 200, k); assert.equal(shape(types(o.r.data)), shape(types(ref.r.data)), `${k}: same response shape`); assert.ok(o.c.jar.otp_ch, `${k}: a challenge cookie is set either way`);
    assert.equal(o.r.setCookies.length, ref.r.setCookies.length); assert.equal(o.c.jar.otp_ch.length, ref.c.jar.otp_ch.length, 'same token format'); assert.equal(o.r.data.otp.expires_in, ref.r.data.otp.expires_in);
    const st = await o.c.get('/api/auth/otp/status'); assert.equal(st.status, 200, `${k}: status`); assert.equal(shape(types(st.data)), shape(types((await ref.c.get('/api/auth/otp/status')).data)));
  }
  // wrong code and resend cooldown behave the same for a decoy as for the real thing
  const good = lastCode();
  for (const [k, o] of Object.entries(out)) {
    const w = await o.c.post('/api/auth/otp/verify', { code: wrongCode(good) }); assert.equal(w.status, 400, k); assert.equal(w.data.code, 'otp_invalid'); assert.equal(w.data.attempts_left, 4, k);
    const rs = await o.c.post('/api/auth/otp/resend'); assert.equal(rs.status, 429, k); assert.equal(rs.data.code, 'otp_cooldown'); assert.equal((await o.c.post('/api/auth/otp/verify', { code: '12345' })).data.code, 'otp_format');
    assert.equal(o.c.jar.sid, undefined);
  }
  // a decoy can never be verified, even by guessing "the" code, and can never produce a session
  const dec = out.unknown.c; let hit; for (let i = 0; i < 5 && !hit; i++) hit = (await dec.post('/api/auth/otp/verify', { code: good })).status === 200; assert.equal(hit, false); assert.equal(dec.jar.sid, undefined);
  for (let i = 0; i < 3; i++) { const e = await out.real.c.post('/api/auth/otp/verify', { code: wrongCode(good) }); assert.equal(e.status, 400); }
  assert.equal((await out.real.c.post('/api/auth/otp/verify', { code: wrongCode(good) })).data.code, 'otp_invalid');
  assert.equal((await out.real.c.post('/api/auth/otp/verify', { code: good })).status, 429, 'real code is cancelled after 5 wrong tries, as a decoy would be');
  assert.equal((await dec.post('/api/auth/otp/verify', { code: '000001' })).data.code, 'otp_attempts_exhausted');
});

test('staff cannot use code-only sign-in by default; the role list is configurable and administrators must be named explicitly', async () => {
  await reset(); const t = await mkUser('teacher'), a = await mkUser('admin'), n0 = outbox.length;
  await requestCode(client(), t.email); await requestCode(client(), a.email); await new Promise(r => setTimeout(r, 40)); assert.equal(outbox.length, n0);
  process.env.OTP_CODE_LOGIN_ROLES = 'student, teacher'; let c = client(), n = outbox.length; ok(await requestCode(c, t.email)); await until(() => outbox.length > n); assert.equal(ok(await c.post('/api/auth/otp/verify', { code: lastCode() })).user.role, 'teacher');
  n = outbox.length; await requestCode(client(), a.email); await new Promise(r => setTimeout(r, 40)); assert.equal(outbox.length, n, 'admin still excluded');
  process.env.OTP_CODE_LOGIN_ROLES = 'admin'; c = client(); n = outbox.length; ok(await requestCode(c, a.email)); await until(() => outbox.length > n); assert.equal(ok(await c.post('/api/auth/otp/verify', { code: lastCode() })).user.role, 'admin');
  process.env.OTP_CODE_LOGIN_ROLES = 'wizard,,'; assert.deepEqual(OTP.config().codeLoginRoles, []); delete process.env.OTP_CODE_LOGIN_ROLES;
});

test('code-only sign-in can be switched off; the login page learns about it from /api/auth/me', async () => {
  await reset(); assert.equal(ok(await client().get('/api/auth/me')).code_login, true);
  process.env.OTP_CODE_LOGIN_ROLES = 'none'; try { assert.equal(ok(await client().get('/api/auth/me')).code_login, false); const st = await mkUser('student'); assert.equal((await requestCode(client(), st.email)).status, 404); } finally { delete process.env.OTP_CODE_LOGIN_ROLES; }
});

test('code-only: a new request replaces the earlier code, wrong codes are limited, resend replaces the code', async () => {
  await reset(); const st = await mkUser('student'); let n = outbox.length; const c1 = client(), c2 = client();
  ok(await requestCode(c1, st.email)); await until(() => outbox.length > n); const first = lastCode(); n = outbox.length; ok(await requestCode(c2, st.email)); await until(() => outbox.length > n); const second = lastCode();
  assert.equal((await c1.post('/api/auth/otp/verify', { code: first })).status, 401, 'the first challenge was replaced');
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM otp_challenges WHERE user_id=? AND purpose='code_login'").get(st.id)).n, 1);
  await db.prepare("UPDATE otp_challenges SET last_sent=last_sent-120000 WHERE user_id=?").run(st.id); n = outbox.length; ok(await c2.post('/api/auth/otp/resend')); await until(() => outbox.length > n); const third = lastCode(); assert.notEqual(second, third);
  assert.equal((await c2.post('/api/auth/otp/verify', { code: second })).status, 400, 'the resent code replaced the old one');
  for (let i = 0; i < 4; i++) await c2.post('/api/auth/otp/verify', { code: wrongCode(third) }); assert.equal((await c2.post('/api/auth/otp/verify', { code: third })).status, 429); assert.equal(c2.jar.sid, undefined);
});

test('code-only: an email failure never signs anyone in and leaves nothing usable', async () => {
  await reset(); const st = await mkUser('student'), c = client(); failWith = smtpError('EAUTH', { responseCode: 535 });
  const r = await requestCode(c, st.email); assert.equal(r.status, 200, 'the answer stays generic so it cannot be used to probe accounts'); await until(async () => !await chRowCL(st.id)); assert.equal(await chRowCL(st.id), undefined);
  assert.equal((await c.post('/api/auth/otp/verify', { code: '123456' })).status, 401); assert.equal(c.jar.sid, undefined); assert.equal((await db.prepare("SELECT COUNT(*) n FROM otp_events WHERE kind='send'").get()).n, 0);
  assert.ok(await db.prepare("SELECT 1 FROM audit WHERE action='auth.otp_delivery_failed' AND resource_id=?").get(st.id));
});
const chRowCL = async id => await db.prepare("SELECT * FROM otp_challenges WHERE user_id=? AND purpose='code_login'").get(id);

test('code-only: rate limits do not depend on whether the account exists', async () => {
  await reset(); process.env.OTP_MAX_SENDS_PER_USER_HOUR = '2'; const st = await mkUser('student'); let n = outbox.length;
  for (let i = 0; i < 4; i++) { const r = await requestCode(client(), st.email); assert.equal(r.status, 200, 'never a distinguishing 429'); } await until(() => outbox.length >= n + 2); await new Promise(r => setTimeout(r, 50));
  assert.equal(outbox.length - n, 2, 'but only two emails were really sent to that mailbox');
  await reset(); process.env.OTP_MAX_REQUESTS_PER_IP_HOUR = '5'; const ip = '203.0.113.77'; for (let i = 0; i < 5; i++) ok(await requestCode(client(ip), `nobody${i}@t.local`));
  const r = await requestCode(client(ip), 'nobody9@t.local'); assert.equal(r.status, 429); assert.equal((await requestCode(client('203.0.113.78'), 'nobody9@t.local')).status, 200);
  assert.equal((await requestCode(client(), 'not-an-email')).status, 400);
});

test('code-only: the challenge stops working if the account changes, and is not a login-with-password or reset code', async () => {
  await reset(); const adm = await signIn(await mkUser('admin')), st = await mkUser('student'), st2 = await mkUser('student'); let n = outbox.length;
  const c = client(); ok(await requestCode(c, st.email)); await until(() => outbox.length > n); const code = lastCode(); ok(await adm.patch(`/api/admin/users/${st.id}`, { status: 'suspended' })); assert.equal((await c.post('/api/auth/otp/verify', { code })).status, 401);
  n = outbox.length; const c2 = client(); ok(await requestCode(c2, st2.email)); await until(() => outbox.length > n); const code2 = lastCode(); await db.prepare('UPDATE users SET must_change=1 WHERE id=?').run(st2.id); assert.equal((await c2.post('/api/auth/otp/verify', { code: code2 })).status, 401, 'a temporary password must be replaced first');
  const user = await db.prepare('SELECT * FROM users WHERE id=?').get(st2.id); await db.prepare('UPDATE users SET must_change=0 WHERE id=?').run(st2.id);
  const L = await OTP.requestCodeLogin(st2.email, '192.0.2.50'); await L.done; await assert.rejects(async () => await OTP.verify(L.token, lastCode(), '192.0.2.50', { purpose: 'password_reset' }), e => e.status === 401);
  assert.equal((await OTP.verify(L.token, lastCode(), '192.0.2.50', { purpose: OTP.SIGN_IN })).user.id, st2.id);
});

test('code-only: needs working email; invalid or missing addresses are rejected before anything happens', async () => {
  await reset(); for (const bad of [undefined, '', 'a', 'a@b', {}, ['a@b.cc']]) assert.equal((await requestCode(client(), bad)).status, 400, JSON.stringify(bad));
  mailer.setTransport(null); const saved = process.env.GMAIL_USER; delete process.env.GMAIL_USER; try { assert.equal((await requestCode(client(), 'x@t.local')).status, 503); } finally { process.env.GMAIL_USER = saved; await reset(); }
});

// ---------------------------------------------------------------- last: the per-IP burst brake (it keeps counting for the rest of the process)
test('burst brake: a flood of code requests from one address is answered with 429', async () => {
  await reset(); process.env.OTP_BURST_PER_IP_10MIN = '20'; let blocked = 0; const c = client('198.51.100.200');
  try { for (let i = 0; i < 40; i++) { const r = await c.get('/api/auth/otp/status'); if (r.status === 429) { blocked++; assert.equal(r.data.code, 'otp_rate_limited'); } } } finally { process.env.OTP_BURST_PER_IP_10MIN = '5000'; }
  assert.ok(blocked >= 15, `expected most of the flood to be blocked, got ${blocked}`);
});

// ---------- PostgreSQL-specific regressions: these protect behaviour that the old single-writer SQLite file used to provide for free ----------
test('parallel wrong guesses cannot multiply the attempt allowance (the challenge row is locked while a guess is counted)', async () => {
  await reset(); const u = await mkUser('teacher'), c = client(); ok(await c.post('/api/auth/login', { email: u.email, password: u.pw }));
  const real = lastCode(), wrong = real === '000000' ? '111111' : '000000';
  const rs = await Promise.all(Array.from({ length: 15 }, () => c.post('/api/auth/otp/verify', { code: wrong })));
  assert.ok(rs.every(r => r.status >= 400 && r.status < 500), JSON.stringify(rs.map(r => r.status)));
  const ch = await chRow(u.id); assert.ok(!ch || (ch.code_hash === '!' && ch.attempts <= OTP.config().maxAttempts), 'the code must be spent after the allowed number of wrong guesses, and never over-counted');
  // The point of the attack: 15 guesses at once must not leave the real code usable.
  const after = await c.post('/api/auth/otp/verify', { code: real }); assert.ok(after.status >= 400, 'the real code must no longer work: ' + after.status);
  assert.equal(c.jar.sid, undefined); assert.equal((await db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(u.id)).n, 0);
});

test('sign-in answers take the same minimum time whether the challenge is real or not (no account enumeration by timing)', async () => {
  await reset(); const u = await mkUser('teacher'), real = client(); ok(await real.post('/api/auth/login', { email: u.email, password: u.pw }));
  const wrong = lastCode() === '000000' ? '111111' : '000000', fake = client(); fake.jar.otp_ch = 'x'.repeat(43);
  const timed = async c => { const t0 = Date.now(); await c.post('/api/auth/otp/verify', { code: wrong }); return Date.now() - t0; };
  process.env.OTP_MIN_RESPONSE_MS = '400';
  try { const a = await timed(real), b = await timed(fake); assert.ok(a >= 380 && b >= 380, `both wait for the floor (${a} ms / ${b} ms)`); assert.ok(Math.abs(a - b) < 250, `and are indistinguishable (${a} ms vs ${b} ms)`); }
  finally { process.env.OTP_MIN_RESPONSE_MS = '0'; }
});

test('requesting a sign-in code returns before the email is sent, so its speed cannot reveal whether an address is registered', async () => {
  await reset(); const s = await mkUser('student'), n = outbox.length; let release; const gate = new Promise(r => release = r);
  process.env.OTP_CODE_LOGIN_ROLES = 'student'; mailer.setTransport({ async sendMail(m) { await gate; outbox.push(m); return { accepted: [m.to], rejected: [], messageId: '<slow@test>' }; }, async verify() { return true; } });
  try {
    const t0 = Date.now(), req = requestCode(client(), s.email);
    const first = await Promise.race([req.then(r => r), new Promise(r => setTimeout(() => r('timeout'), 3000))]); // fail fast instead of hanging if the server waits for the mail
    assert.notEqual(first, 'timeout', 'the response must not wait for a slow mail server'); ok(first); const took = Date.now() - t0;
    assert.ok(took < 1500, `the response must not wait for a slow mail server (took ${took} ms)`); assert.equal(outbox.length, n, 'the email is still on its way');
    release(); await until(() => outbox.length > n); assert.ok(lastCode());
  } finally { release(); delete process.env.OTP_CODE_LOGIN_ROLES; await reset(); }
});
