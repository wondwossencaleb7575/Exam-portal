'use strict';
// Structured logging. One JSON object per line (LOG_FORMAT=text for humans). Silent under the test runner or LOG_LEVEL=silent.
// Privacy rule: we log method, path WITHOUT the query string, status, duration and user id. Never bodies, headers, cookies or passwords.
const crypto = require('crypto');
const silent = () => process.env.LOG_LEVEL === 'silent' || !!process.env.NODE_TEST_CONTEXT;
function log(level, msg, extra = {}) {
  if (silent()) return;
  const line = { t: new Date().toISOString(), level, msg, ...extra };
  const out = process.env.LOG_FORMAT === 'text' ? `${line.t} ${level.toUpperCase()} ${msg} ${Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' ')}` : JSON.stringify(line);
  (level === 'error' || level === 'warn' ? console.error : console.log)(out);
}
// Every request gets an id (echoed in the X-Request-Id header and in 500 responses) so a teacher can quote it and you can find the log line.
function requestLogger(req, res, next) {
  const given = String(req.headers['x-request-id'] || '');
  req.id = /^[A-Za-z0-9._-]{8,64}$/.test(given) ? given : crypto.randomBytes(8).toString('hex');
  res.set('X-Request-Id', req.id);
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const path = req.originalUrl.split('?')[0];
    if (!path.startsWith('/api/') || path === '/api/health') return;
    const s = res.statusCode;
    log(s >= 500 ? 'error' : s >= 400 ? 'warn' : 'info', 'request', { req: req.id, method: req.method, path, status: s, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), user: req.user?.id ?? null });
  });
  next();
}
module.exports = { log, requestLogger };
