// Test harness ONLY (not shipped). Serves the project's real public/ files with the project's exact CSP,
// and fakes just enough of the API for the three dashboards and the exam flow, with controllable delay / failure.
const path = require('path');
const ROOT = process.env.ROOT;
const express = require(path.join(ROOT, 'node_modules/express'));
const app = express(); app.use(express.json());
const cfg = { delay: {}, fail: {}, hits: {} };           // delay[substr]=ms ; fail[substr]=status|'drop'
app.use((req, res, next) => {
  res.set({ 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'", 'X-Content-Type-Options': 'nosniff' });
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
app.post('/__cfg', (req, res) => { Object.assign(cfg, { delay: req.body.delay || {}, fail: req.body.fail || {}, hits: {} }); res.json({ ok: true }); });
app.get('/__hits', (req, res) => res.json(cfg.hits));
const cookie = req => (/sess=(\w+)/.exec(req.headers.cookie || '') || [])[1];
const users = { student: { id: 11, name: 'Sara Student', role: 'student', email: 's@x', must_change: false }, teacher: { id: 12, name: 'Tom Teacher', role: 'teacher', email: 't@x', must_change: false }, admin: { id: 13, name: 'Ada Admin', role: 'admin', email: 'a@x', must_change: false } };
const settings = { school_name: 'Eagle Labs', timezone: 'Africa/Addis_Ababa', locale: 'en', calendar: 'gregory', brand_color: '#0b1f4d' };
app.use('/api', (req, res, next) => {
  const key = Object.keys({ ...cfg.delay, ...cfg.fail }).find(k => (req.method + ' ' + req.originalUrl).includes(k));
  cfg.hits[req.method + ' ' + req.originalUrl.split('?')[0]] = (cfg.hits[req.method + ' ' + req.originalUrl.split('?')[0]] || 0) + 1;
  const go = () => { const f = key && cfg.fail[key]; if (f === 'drop') return req.socket.destroy(); if (f) return res.status(f).json({ error: 'Injected failure ' + f }); next(); };
  key && cfg.delay[key] ? setTimeout(go, cfg.delay[key]) : go();
});
app.get('/api/auth/me', (req, res) => { const r = cookie(req); res.json({ user: r ? users[r] : null, settings, code_login: false }); });
app.post('/api/auth/login', (req, res) => { const r = String(req.body.email || '').split('@')[0]; if (!users[r] || req.body.password !== 'pw') return res.status(403).json({ error: 'Wrong email or password.' }); res.set('Set-Cookie', 'sess=' + r + '; Path=/'); res.json({ user: users[r] }); });
app.post('/api/auth/logout', (req, res) => { res.set('Set-Cookie', 'sess=; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/student/exams', (req, res) => res.json({ classes: [{ name: '9A' }], items: [{ id: 1, title: 'Algebra Test', subject: 'Math', minutes: 30, total_marks: 4, max_attempts: 2, attempts_used: 0, phase: 'active', opens: null, closes: null, in_progress_attempt: null }] }));
app.get('/api/student/exams/1', (req, res) => res.json({ id: 1, title: 'Algebra Test', minutes: 30, total_marks: 4, questions: 2, max_attempts: 2, attempts_used: 0, instructions: 'Answer all questions.', release_mode: 'manual', phase: 'active' }));
app.post('/api/student/exams/1/start', (req, res) => res.json({ attempt: { id: 7 } }));
const saved = {};
app.get('/api/student/attempts/7', (req, res) => res.json({ attempt: { id: 7, serverNow: Date.now(), deadline: Date.now() + 1800000 }, exam: { title: 'Algebra Test' }, answers: saved,
  questions: [{ id: 1, type: 'mcq', marks: 2, stem: 'What is 2 + 2?', options: [{ id: 'a', text: '3' }, { id: 'b', text: '4' }] }, { id: 2, type: 'short', marks: 2, stem: 'Capital of Ethiopia?' }] }));
app.put('/api/student/attempts/7/answers', (req, res) => { req.body.items.forEach(i => saved[i.qid] = { value: i.value, seq: i.seq, flagged: i.flagged }); res.json({ saved: req.body.items.map(i => ({ qid: i.qid, seq: i.seq })), rejected: [], stale: [], serverNow: Date.now(), deadline: Date.now() + 1800000 }); });
app.post('/api/student/attempts/7/events', (req, res) => res.json({ ok: true }));
app.get('/api/dashboard', (req, res) => res.json({ classes: 3, students: 90, active: 1, scheduled: 0, draft: 2, in_progress: 0, awaiting: 4, avg_pct: 71, upcoming: [], recent: [] }));
app.get('/api/admin/users', (req, res) => res.json({ items: [{ id: 11, name: 'Sara Student', email: 's@x', role: 'student', status: 'active', created: Date.now(), last_login: null }], total: 1, otp_mode: 'off' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'not mocked' }));
app.use('/katex', express.static(path.join(ROOT, 'node_modules/katex/dist')));
app.use(express.static(path.join(ROOT, 'public'), { maxAge: 0 }));
app.listen(+process.env.PORT || 4010, () => console.log('mock up'));
