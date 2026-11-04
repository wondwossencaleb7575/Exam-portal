'use strict';
const { types } = require('pg');
// bigint (ids, epoch-millisecond timestamps, COUNT(*)) and numeric (AVG/ROUND) come back as JavaScript numbers. Every value the application stores is
// far below 2^53, so nothing is lost; without this, node-postgres would return bigints as strings ("0" is truthy!). Installed here so that EVERY
// entry point (server, scripts, tests) that imports this module behaves identically.
types.setTypeParser(20, v => Number(v));
types.setTypeParser(1700, v => parseFloat(v));
// One place that decides how to connect to PostgreSQL (used by the app, the migration runner and the maintenance scripts).
const hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };
const isLocalUrl = u => { const h = hostOf(u); return ['localhost', '127.0.0.1', '::1', ''].includes(h) || h.startsWith('/'); };
// TLS is verified by default for every remote database. DATABASE_SSL=off|no-verify|verify overrides it. DATABASE_CA is an optional PEM root certificate.
function sslFor(u, env = process.env) {
  const local = isLocalUrl(u), mode = (env.DATABASE_SSL || (local ? 'off' : 'verify')).toLowerCase();
  if (!['off', 'no-verify', 'verify'].includes(mode)) throw new Error('DATABASE_SSL must be verify, no-verify or off.');
  if (mode === 'off' && !local && env.NODE_ENV === 'production') throw new Error('Refusing to connect to a remote database without TLS in production (DATABASE_SSL=off).');
  const ssl = mode === 'off' ? false : mode === 'no-verify' ? { rejectUnauthorized: false } : { rejectUnauthorized: true, ...(env.DATABASE_CA ? { ca: env.DATABASE_CA.replace(/\\n/g, '\n') } : {}) };
  return { ssl, mode };
}
// TLS is configured by sslFor(), in one place; ignore any sslmode= in the URL so two settings can never disagree.
const stripSsl = u => { try { const x = new URL(u); x.searchParams.delete('sslmode'); x.searchParams.delete('ssl'); return x.toString(); } catch { return u; } };
module.exports = { hostOf, isLocalUrl, sslFor, stripSsl };
