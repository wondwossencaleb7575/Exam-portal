'use strict';
// "?" / "?N" placeholders -> PostgreSQL "$n". Quoted strings, quoted identifiers and -- comments are never touched.
const cache = new Map();
function convert(sql) {
  let c = cache.get(sql); if (c) return c;
  let out = '', n = 0, i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') { let j = i + 1; while (j < sql.length) { if (sql[j] === ch) { if (sql[j + 1] === ch) j += 2; else break; } else j++; } out += sql.slice(i, j + 1); i = j + 1; continue; }
    if (ch === '-' && sql[i + 1] === '-') { const j = sql.indexOf('\n', i), e = j < 0 ? sql.length : j; out += sql.slice(i, e); i = e; continue; }
    if (ch === '?') { // ?N is parameter N; a bare ? is one more than the highest number used so far (SQLite's rule, which the queries were written for)
      let j = i + 1; while (/\d/.test(sql[j] || '')) j++;
      if (j > i + 1) { const k = Number(sql.slice(i + 1, j)); n = Math.max(n, k); out += '$' + k; } else out += '$' + (++n);
      i = j; continue;
    }
    out += ch; i++;
  }
  if (cache.size > 2000) cache.clear();
  cache.set(sql, out); return out;
}

module.exports = { convert };
