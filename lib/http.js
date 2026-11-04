class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const fail = (m, x) => { throw new HttpError(400, m, x); };
const forbidden = (m = 'Not allowed') => { throw new HttpError(403, m); };
const notFound = (m = 'Not found') => { throw new HttpError(404, m); };
const conflict = (m, x) => { throw new HttpError(409, m, x); };
const wrap = fn => (req, res, next) => { try { const r = fn(req, res, next); if (r && r.catch) r.catch(next); } catch (e) { next(e); } };
const idOf = v => { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) notFound(); return n; };
const paging = (req, def = 25, max = 100) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), size = Math.min(max, Math.max(1, parseInt(req.query.size) || def));
  return { page, size, offset: (page - 1) * size };
};
const text = (v, max, { min = 0, label = 'Field' } = {}) => {
  const s = String(v ?? '').trim();
  if (s.length < min) fail(`${label} is required.`);
  if (s.length > max) fail(`${label} is too long (max ${max} characters).`);
  return s;
};
const bool = v => (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
const timeOrNull = v => { if (v == null || v === '') return null; const n = Number(v); if (!Number.isFinite(n) || n < 0) fail('Invalid date.'); return Math.floor(n); };
module.exports = { HttpError, fail, forbidden, notFound, conflict, wrap, idOf, paging, text, bool, timeOrNull };
