// Stub API (NOT the real server, no database) for browser-testing the front end against the REAL public/ files under the REAL CSP.
// Response shapes follow what the views consume (read from student.js / teacher.js / admin.js / core.js).
const path = require('path');
const APP = process.env.APP_ROOT || path.join(__dirname, '..', '..');   // the exam-portal folder
const express = require(path.join(APP, 'node_modules/express'));
const app = express();
app.use(express.json());
const cfg = { delay: {}, fail: {}, assetDelay: {}, log: [] };   // delay[name]=ms ; fail[name]='net'|'503'|'hang' ; assetDelay[prefix]=ms
const users = {
  'student@x.test': { id: 1, name: 'Sara Student', role: 'student', email: 'student@x.test', must_change: false },
  'teacher@x.test': { id: 2, name: 'Tom Teacher', role: 'teacher', email: 'teacher@x.test', must_change: false },
  'admin@x.test':   { id: 3, name: 'Ada Admin', role: 'admin', email: 'admin@x.test', must_change: false },
};
const sessions = new Map();
const cookieOf = req => (/(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '') || [])[1];
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.use((req, res, next) => {
  res.set({ 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'", 'X-Content-Type-Options': 'nosniff' });
  next();
});
// control + slow assets
app.post('/__ctl', (req, res) => { if (req.body.reset) { cfg.delay = {}; cfg.fail = {}; cfg.assetDelay = {}; cfg.log = []; } Object.assign(cfg.delay, req.body.delay || {}); Object.assign(cfg.fail, req.body.fail || {}); Object.assign(cfg.assetDelay, req.body.assetDelay || {}); res.json({ ok: true, cfg: { delay: cfg.delay, fail: cfg.fail, assetDelay: cfg.assetDelay } }); });
app.get('/__log', (req, res) => res.json(cfg.log));
app.use(async (req, res, next) => { for (const [p, ms] of Object.entries(cfg.assetDelay)) if (req.path.startsWith(p) && ms) await sleep(ms); next(); });
app.use('/katex', express.static(path.join(APP, 'node_modules/katex/dist')));
app.use(express.static(process.env.PUBLIC_DIR || path.join(APP, 'public'), { maxAge: 0, etag: false }));

// API wrapper: latency + failure injection
const ep = (name, fn) => async (req, res) => {
  res.set('Cache-Control', 'no-store');   // the real server does this for every /api response
  cfg.log.push(`${Date.now()} ${req.method} ${req.path}`);
  if (cfg.delay[name]) await sleep(cfg.delay[name]);
  const f = cfg.fail[name];
  if (f === 'net') return req.socket.destroy();
  if (f === 'hang') return;                                    // never answers
  if (f === '503') return res.status(503).json({ error: 'The service is temporarily unavailable. Please try again.' });
  try { await fn(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
};
const need = (req, role) => { const u = sessions.get(cookieOf(req)); if (!u) throw Object.assign(new Error('Please sign in.'), { status: 401 }); if (role && u.role !== role) throw Object.assign(new Error('Forbidden'), { status: 403 }); return u; };

app.get('/api/auth/me', ep('me', (req, res) => res.json({ user: sessions.get(cookieOf(req)) || null, settings: { school_name: 'Eagle Labs', brand_color: '#0b1f4d', timezone: 'UTC' }, code_login: false })));
app.post('/api/auth/login', ep('login', (req, res) => {
  const u = users[String(req.body.email || '').toLowerCase()];
  if (!u || req.body.password !== 'pw') throw Object.assign(new Error('Wrong email or password.'), { status: 401 });
  const sid = Math.random().toString(36).slice(2); sessions.set(sid, u); res.append('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`); res.json({ user: u });
}));
app.post('/api/auth/logout', ep('logout', (req, res) => { sessions.delete(cookieOf(req)); res.append('Set-Cookie', 'sid=; Path=/; Max-Age=0'); res.json({ ok: true }); }));

// student
app.get('/api/student/exams', ep('s_exams', (req, res) => { need(req, 'student'); res.json({ classes: [{ name: '10-A' }], items: [
  { id: 11, title: 'Physics Midterm', subject: 'Physics', minutes: 45, total_marks: 20, attempts_used: 0, max_attempts: 1, phase: 'active', opens: null, closes: null, in_progress_attempt: null, result: null },
  { id: 12, title: 'Maths Quiz (in progress)', subject: 'Maths', minutes: 30, total_marks: 10, attempts_used: 1, max_attempts: 1, phase: 'active', opens: null, closes: null, in_progress_attempt: 77, result: null }] }); }));
app.get('/api/student/exams/:id', ep('s_exam', (req, res) => { need(req, 'student'); res.json({ id: +req.params.id, title: 'Physics Midterm', minutes: 45, total_marks: 20, questions: 2, max_attempts: 1, attempts_used: 0, instructions: 'Answer all questions.', release_mode: 'manual', phase: 'active' }); }));
app.post('/api/student/exams/:id/start', ep('s_start', (req, res) => { need(req, 'student'); res.json({ attempt: { id: 77 } }); }));
app.get('/api/student/attempts/:id', ep('s_attempt', (req, res) => { need(req, 'student'); res.json({ attempt: { id: 77, serverNow: Date.now(), deadline: Date.now() + 45 * 60000 }, exam: { title: 'Maths Quiz' }, answers: {},
  questions: [{ id: 1, type: 'mcq', stem: 'What is $x^2$ when $x=3$?', marks: 5, options: [{ id: 'a', text: '6' }, { id: 'b', text: '9' }, { id: 'c', text: '12' }] }, { id: 2, type: 'short', stem: 'Name the SI unit of force.', marks: 5, options: [] }] }); }));
app.put('/api/student/attempts/:id/answers', ep('s_save', (req, res) => { need(req, 'student'); res.json({ ok: true, serverNow: Date.now(), deadline: Date.now() + 45 * 60000, saved: [] }); }));
// teacher
app.get('/api/dashboard', ep('t_dash', (req, res) => { need(req, 'teacher'); res.json({ classes: 3, students: 74, active: 1, scheduled: 2, draft: 1, in_progress: 0, awaiting: 4, avg_pct: 71, upcoming: [], recent: [] }); }));
// admin
app.get('/api/admin/users', ep('a_users', (req, res) => { need(req, 'admin'); res.json({ items: [{ id: 1, name: 'Sara Student', email: 'student@x.test', student_number: 'S-001', role: 'student', created: '2026-01-01T00:00:00Z', last_login: null, status: 'active', email_verified_at: null, otp_exempt: false, otp_required: false }], total: 1, page: 1, size: 25, otp_mode: 'off' }); }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found (stub)' }));
app.listen(+process.env.PORT || 4100, () => console.log('stub up'));
