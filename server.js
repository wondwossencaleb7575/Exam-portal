const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { db, check: dbCheck, close: dbClose } = require('./lib/db');
const A = require('./lib/auth');
const { HttpError } = require('./lib/http');
const { sweepExpired } = require('./lib/grading');
const { audit } = require('./lib/audit');
const compression = require('compression');
const { log, requestLogger } = require('./lib/log');
const OTP = require('./lib/otp');
const mailer = require('./lib/mailer');
const VERSION = require('./package.json').version;

const PORT = process.env.PORT || 3000;
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

// ---- request ids + structured access log, then gzip (JSON, CSV, HTML, JS and CSS shrink a lot; matters on slow school links) ----
app.use(requestLogger);
app.use(compression({ threshold: 1024 }));

// ---- security headers ----
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin'
  });
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use('/api/images', express.json({ limit: '4mb' }));
app.use(express.json({ limit: '1mb' }));

// ---- CSRF: state-changing API calls must carry our custom header and come from our own origin ----
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const o = req.headers.origin;
    if (req.headers['x-requested-with'] !== 'eagle' || (o && new URL(o).host !== req.headers.host)) return next(new HttpError(403, 'Request blocked.'));
  }
  res.set('Cache-Control', 'no-store'); next();
});
// ---- rate limiting: per signed-in session (so a classroom behind one school IP is not blocked), per IP otherwise ----
const buckets = new Map();
setInterval(() => { const n = Date.now(); for (const [k, v] of buckets) if (n - v.at > 60000) buckets.delete(k); }, 30000).unref();
app.use('/api', (req, res, next) => {
  // Code-entry requests are bucketed per pending sign-in (otp_ch) instead of per IP, so a class signing in at once behind one school IP is not throttled.
  // That is safe because lib/otp.js has its own database-backed limits per account and per IP, and routes/auth.js adds a per-IP brake.
  const sid = A.cookieOf(req, 'sid'), och = !sid && req.path.startsWith('/auth/otp/') ? A.cookieOf(req, 'otp_ch') : null;
  const key = sid ? 's:' + sid.slice(0, 16) : och ? 'o:' + och.slice(0, 16) : 'i:' + req.ip, max = sid ? 900 : 120;
  const b = buckets.get(key); const now = Date.now();
  if (!b || now - b.at > 60000) { buckets.set(key, { n: 1, at: now }); return next(); }
  if (++b.n > max) return next(new HttpError(429, 'Too many requests. Slow down and try again shortly.'));
  next();
});

// ---- start-up: verify the database schema, then create the first administrator if there are no accounts. Requests wait for this. ----
async function bootstrap() {
  const info = await dbCheck(); // throws a clear message if the migrations have not been applied
  if (!await db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    const email = (process.env.ADMIN_EMAIL || 'admin@eagle.local').toLowerCase(), env = process.env.ADMIN_PASSWORD;
    const pw = env || A.tempPassword();
    await db.prepare("INSERT INTO users(email,name,role,pw_hash,must_change,created) VALUES(?,?,'admin',?,?,?)").run(email, 'Administrator', await A.hashPw(pw), env ? 0 : 1, Date.now());
    await audit(null, 'system.bootstrap', 'user', null, { email });
    console.log(env ? `Created administrator ${email}` : `\n  FIRST RUN: administrator ${email}\n  Temporary password: ${pw}\n  (You must change it at first sign-in. This is shown only once.)\n`);
  }
  return info;
}
const ready = bootstrap(); ready.catch(e => log('error', 'start-up check failed', { err: e.message }));
// Health check for load balancers and uptime monitors: proves the process is up AND the database answers. No secrets, no data.
app.get('/api/health', async (req, res) => {
  try { await db.prepare('SELECT 1').get(); res.json({ ok: true, version: VERSION, migrations: (await db.prepare('SELECT COUNT(*) n FROM schema_migrations').get()).n }); }
  catch (e) { log('error', 'health check failed', { err: e.message }); res.status(503).json({ ok: false }); }
});
// Everything below needs the database to be ready (an outage or a missing migration answers 503, not a hung request or a stack trace).
app.use('/api', (req, res, next) => ready.then(() => next(), () => next(new HttpError(503, 'The service is starting or the database is unavailable. Please try again in a moment.'))));
app.get('/api/settings', async (req, res, next) => { try { res.json(await require('./lib/settings').get()); } catch (e) { next(e); } });
// (public settings: branding, time zone, terms; nothing secret)
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/classes', require('./routes/classes'));
app.use('/api/students', require('./routes/students'));
app.use('/api/questions', require('./routes/bank'));
app.use('/api/images', require('./routes/images'));
app.use('/api/exams', require('./routes/exams'));
app.use('/api/student', require('./routes/student'));
app.use('/api', require('./routes/results')); // /dashboard, /exams/:id/results, /attempts/:id ...
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use('/katex', express.static(path.join(__dirname, 'node_modules/katex/dist'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

// PostgreSQL / connection errors -> a safe, honest answer. Messages never contain SQL, table names or parameters (those stay in the server log).
const BAD_INPUT = new Set(['22P02', '22003', '22007', '22008', '22001', '22021', '23502', '23514']); // malformed / out-of-range value, NOT NULL or CHECK violation
const UNAVAILABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', '57P01', '57P02', '57P03', '53300', '53400', '08000', '08001', '08003', '08004', '08006', '40001', '40P01', '57014', '25P03']);
function dbFailure(e) {
  const c = e && e.code;
  if (BAD_INPUT.has(c)) return { status: 400, level: 'warn', message: 'Invalid request.' };
  if (c === '23505') return { status: 409, level: 'warn', message: 'That already exists.' };
  if (c === '23503') return { status: 409, level: 'warn', message: 'That item does not exist or is still in use.' };
  if (UNAVAILABLE.has(c) || /timeout exceeded when trying to connect|Connection terminated|connection timeout|too many clients/i.test(String(e && e.message))) return { status: 503, level: 'error', message: 'The database is temporarily unavailable or busy. Nothing was lost; please try again in a moment.' };
  return null;
}
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too large.' });
  if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'Invalid request.' });
  const db_ = dbFailure(err); if (db_) { log(db_.level, 'database error', { req: req.id, method: req.method, path: req.originalUrl.split('?')[0], code: err.code, err: err.message }); return res.status(db_.status).json({ error: db_.message, ...(db_.status === 503 ? { retry: true } : {}) }); }
  log('error', 'unhandled error', { req: req.id, method: req.method, path: req.originalUrl.split('?')[0], err: err.message, stack: String(err.stack || '').split('\n').slice(1, 4).join(' | ') }); // details stay in the server log only
  res.status(500).json({ error: 'Something went wrong on the server. Your data was not lost; please try again.', error_id: req.id });
});

function start(port = PORT) {
  const srv = app.listen(port, () => console.log(`Eagle Labs Exam Portal ${VERSION} running on http://localhost:${srv.address().port}`));
  let sweeping = false; // never let two sweeps of this process overlap if the database is slow
  const timers = [setInterval(async () => { if (sweeping) return; sweeping = true; try { await ready; await sweepExpired(); } catch (e) { log('error', 'sweep failed', { err: e.message }); } finally { sweeping = false; } }, 15000)];
  timers.push(setInterval(async () => { try { await ready; await A.sweepSessions(); } catch (e) { log('error', 'session sweep failed', { err: e.message }); } }, 600000)); // expired sign-in sessions
  timers.push(setInterval(async () => { try { await ready; await OTP.sweep(); } catch (e) { log('error', 'otp sweep failed', { err: e.message }); } }, 60000)); // expired codes and old rate-limit counters
  timers.forEach(t => t.unref()); return srv;
}
module.exports = { app, start };
if (require.main === module) {
  const srv = start(); let closing = false;
  // Report the email-verification setup once, and (if enforced) prove the Gmail login works NOW rather than at the first sign-in.
  ready.then(async () => {
  const rep = await OTP.startupReport(); log('info', 'email verification', rep);
  if (rep.mode !== 'off' && rep.mail_configured) mailer.verify().then(v => log(v.ok ? 'info' : 'error', v.ok ? 'smtp login verified' : 'smtp check FAILED: verification emails will not be delivered', v.ok ? {} : { kind: v.kind })).catch(() => {});
  }).catch(() => { log('error', 'not starting: the database is not ready (see the message above). Run `npm run migrate` and check DATABASE_URL.'); process.exitCode = 1; });
  // Graceful shutdown (deploys, restarts): stop taking new requests, let in-flight saves and submissions finish, close the database connections, exit.
  const stop = sig => {
    if (closing) return; closing = true; log('info', 'shutting down', { signal: sig });
    const idle = setInterval(() => srv.closeIdleConnections?.(), 300);
    srv.close(async () => { clearInterval(idle); mailer.close(); try { await dbClose(); } catch (e) { log('error', 'db close failed', { err: e.message }); } log('info', 'stopped cleanly'); process.exit(0); });
    setTimeout(() => { log('error', 'forced exit after 15s'); process.exit(1); }, 15000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
  process.on('unhandledRejection', e => log('error', 'unhandled rejection', { err: String(e?.message || e) }));
}
// Export the app for Vercel serverless functions
module.exports = app;

// Only listen locally if not running on Vercel
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}