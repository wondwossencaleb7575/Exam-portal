'use strict';
// CSV support: RFC 4180 parser + serializer. No external dependency; no line.split(',') anywhere.
const { fail } = require('./http');
class CsvError extends Error {}

// Limits are read at call time so they can be tuned with environment variables.
const limits = () => ({ bytes: Number(process.env.CSV_MAX_BYTES) || 1000000, rows: Number(process.env.CSV_MAX_ROWS) || 1000, cols: 30, field: 500 });

/* ---------- writing ---------- */
// Formula-injection defence: a cell that a spreadsheet could evaluate (starts with = + - @ TAB or CR)
// is stored as text by prefixing an apostrophe. Real numbers are written as-is.
const FORMULA = /^[=+\-@\t\r]/;
function safe(v) {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v); return FORMULA.test(s) ? "'" + s : s;
}
function cell(v) { const s = safe(v); return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
const line = a => a.map(cell).join(',');
// Small documents (templates, reports): BOM + CRLF so Excel opens UTF-8 correctly.
const toCsv = (headers, rows) => '\ufeff' + [headers, ...rows].map(line).join('\r\n') + '\r\n';
const safeName = (s, ext = '.csv') => (String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'export') + ext;
// Large downloads: stream in chunks (rows is any iterable OR async iterable of arrays) so memory stays flat.
async function sendCsv(res, name, headers, rows) {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${safeName(name.replace(/\.csv$/i, ''))}"` });
  // ONE drain listener and ONE close listener for the whole download (adding a new pair per chunk leaks listeners, especially behind the gzip layer).
  let closed = false, waiter = null; const wake = () => { const w = waiter; waiter = null; if (w) w(); };
  res.on('drain', wake); res.once('close', () => { closed = true; wake(); });
  res.write('\ufeff' + line(headers) + '\r\n');
  let buf = [];
  const flush = async () => { if (!buf.length) return; const ok = res.write(buf.join('')); buf = []; if (!ok && !closed) await new Promise(r => { waiter = r; }); };
  try { for await (const r of rows) { if (closed) return; buf.push(line(r) + '\r\n'); if (buf.length >= 200) await flush(); } await flush(); res.end(); }
  catch (e) { res.destroy(e); }
}

/* ---------- reading ---------- */
function detectDelimiter(text) { // Excel in many regions writes ';' or TAB; look at the first record only
  const c = { ',': 0, ';': 0, '\t': 0 }; let q = false;
  for (const ch of text) { if (ch === '"') q = !q; else if (!q) { if (ch === '\n' || ch === '\r') break; if (ch in c) c[ch]++; } }
  const [d, n] = Object.entries(c).sort((a, b) => b[1] - a[1])[0]; return n > 0 ? d : ',';
}
// Returns [{ line, cells, err }]. Handles quoted fields, "" escapes, delimiters and line breaks inside quotes, CRLF/LF/CR.
function parse(text, { delimiter } = {}) {
  text = String(text).replace(/^\uFEFF/, ''); const L = limits(), d = delimiter || detectDelimiter(text), out = [];
  let cells = [], field = '', inQ = false, quoted = false, after = false, err = null, lineNo = 1, recLine = 1;
  const endField = () => { if (field.length > L.field) throw new CsvError(`Row ${recLine}: a value is longer than ${L.field} characters.`); cells.push(field); field = ''; quoted = false; after = false; };
  const endRec = () => { endField(); if (!(cells.length === 1 && cells[0] === '' )) { out.push({ line: recLine, cells, err }); if (out.length > L.rows + 1) throw new CsvError(`Too many rows (the maximum is ${L.rows}).`); } cells = []; err = null; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { inQ = false; after = true; } } else { field += c; if (c === '\n') lineNo++; } continue; }
    if (c === '"') { if (field === '' && !quoted && !after) { inQ = true; quoted = true; } else { err = err || 'Unexpected quote character (quote the whole value and double any inner quotes).'; field += c; } continue; }
    if (after && c !== d && c !== '\n' && c !== '\r') { err = err || 'Unexpected text after a closing quote.'; field += c; continue; }
    if (c === d) { endField(); continue; }
    if (c === '\r' || c === '\n') { if (c === '\r' && text[i + 1] === '\n') i++; endRec(); lineNo++; recLine = lineNo; continue; }
    field += c;
  }
  if (inQ) throw new CsvError(`Row ${recLine}: a quoted value is never closed (missing closing quote).`);
  if (field !== '' || cells.length || quoted) endRec();
  return { records: out, delimiter: d };
}
// Header-aware reader. Header names are normalised (case, spaces, hyphens) and mapped through `aliases`.
function readTable(text, { required = [], optional = [], aliases = {} } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new CsvError('The file is empty or no file was received.');
  const L = limits(); if (Buffer.byteLength(text) > L.bytes) throw new CsvError(`The file is too large (maximum ${Math.round(L.bytes / 1000)} KB).`);
  const { records, delimiter } = parse(text); if (!records.length) throw new CsvError('The file is empty.');
  const norm = h => { const k = String(h).trim().toLowerCase().replace(/[\s\-]+/g, '_').replace(/[^a-z0-9_]/g, ''); return aliases[k] || k; };
  const cols = records[0].cells.map(norm); if (cols.length > L.cols) throw new CsvError('Too many columns.');
  const dup = cols.find((c, i) => c && cols.indexOf(c) !== i); if (dup) throw new CsvError(`The column "${dup}" appears more than once.`);
  const missing = required.filter(c => !cols.includes(c));
  if (missing.length) throw new CsvError(`Missing required column(s): ${missing.join(', ')}. Found: ${cols.filter(Boolean).join(', ') || '(none)'}.`);
  const known = new Set([...required, ...optional]);
  const rows = records.slice(1).map(r => {
    const data = {}; cols.forEach((c, i) => { if (known.has(c)) data[c] = String(r.cells[i] ?? '').trim(); });
    const extra = r.cells.length > cols.length && r.cells.slice(cols.length).some(x => x.trim());
    return { line: r.line, data, parseError: r.err || (extra ? 'More values than header columns (an unquoted comma in a value?).' : null) };
  });
  return { rows, columns: cols.filter(c => known.has(c)), ignored: cols.filter(c => c && !known.has(c)), delimiter };
}
// Turns a CsvError into a 400 response; any other error passes through.
const guard = async fn => { try { return await fn(); } catch (e) { if (e instanceof CsvError) fail(e.message); throw e; } }; // fn may be sync or async
module.exports = { CsvError, detectDelimiter, parse, readTable, toCsv, sendCsv, cell, line, safe, safeName, guard, limits };
