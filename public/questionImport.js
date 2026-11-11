/* Eagle Labs Exam Portal: "Import Questions (CSV)" dialog for the Question bank.
   Flow: download template -> choose file -> server-side preview (per-row errors) -> explicit confirmation -> summary.
   Nothing is saved before the confirmation. Everything shown comes from the server and goes through esc(); the server re-validates on commit.
   Uses helpers from core.js (modal, confirmDlg, post, esc, badge, toast, announce) and TYPE_NAMES from teacher.js. */
const QI_MAX_BYTES = 500000;
const QI_BADGE = { import: ['published', 'Valid'], fail: ['fail', 'Error'], duplicate: ['pending', 'Duplicate'] };
const qiSave = (name, text) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };

// Reads the file as bytes and decodes it here so that Excel's plain "CSV (Comma delimited)" (Windows-1252) is not silently turned into
// replacement characters: UTF-8 is tried first (strict); only if that fails is Windows-1252 used, and the teacher is told.
async function qiReadFile(f) {
  if (f.size > QI_MAX_BYTES) throw new Error(`That file is too large (maximum ${Math.round(QI_MAX_BYTES / 1000)} KB, about 1,000 questions). Split it into smaller files.`);
  if (!f.size) throw new Error('That file is empty.');
  const buf = await new Promise((ok, no) => { const r = new FileReader(); r.onerror = () => no(new Error('Could not read that file.')); r.onload = () => ok(r.result); r.readAsArrayBuffer(f); });
  const b = new Uint8Array(buf);
  if (b[0] === 0x50 && b[1] === 0x4B) throw new Error('This looks like an Excel workbook (.xlsx), not a CSV file. In Excel choose File → Save As → “CSV UTF-8 (Comma delimited) (*.csv)” and upload that file.');
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), note: '' }; }
  catch { return { text: new TextDecoder('windows-1252').decode(b), note: 'This file is not UTF-8, so it was read as Windows-1252 (Excel\'s plain CSV). Letters outside that set (for example Amharic) cannot be recovered from such a file: save it as “CSV UTF-8” instead.' }; }
}

function qiRows(p) {
  const order = { fail: 0, duplicate: 1, import: 2 }, rows = [...p.rows].sort((a, b) => order[a.action] - order[b.action] || a.line - b.line).slice(0, 300);
  const bd = { import: 'var(--ok)', fail: 'var(--bad)', duplicate: 'var(--g400)' };
  return `<div class="qi-list">${rows.map(r => `<div class="card" style="margin:8px 0;padding:10px 12px;border-left:4px solid ${bd[r.action]}">
    <div class="gap" style="align-items:center">${badge(...QI_BADGE[r.action])}<b>CSV line ${r.line}</b><span class="mu">${esc(TYPE_NAMES[r.type] || r.type || 'unknown type')} · ${esc(r.subject || 'no subject')}${r.topic ? ' · ' + esc(r.topic) : ''} · ${esc(r.difficulty || '')} · ${esc(r.marks ?? '')} mark${r.marks === 1 ? '' : 's'}</span></div>
    <div style="margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere">${esc(r.stem) || '<span class="mu">(no question text)</span>'}</div>
    ${r.options?.length ? `<div class="mu" style="overflow-wrap:anywhere">${r.options.map(o => `<b>${esc(o.id.toUpperCase())}.</b> ${esc(o.text)}`).join(' &nbsp; ')}</div>` : ''}
    ${r.answer ? `<div class="mu">Correct answer: <b>${esc(r.answer)}</b></div>` : ''}
    ${(r.errors || []).map(x => `<div style="color:var(--bad)"><b>${esc(x.column || 'row')}</b>: ${esc(x.message)}</div>`).join('')}${(r.notes || []).map(n => `<div class="mu">${esc(n)}</div>`).join('')}</div>`).join('')}</div>
    ${p.rows.length > 300 ? `<p class="mu">Showing the first 300 of ${p.rows.length} rows (errors first). Download the report to see all problems.</p>` : ''}`;
}
function qiSummary(p) {
  const s = p.summary, chips = [['Questions found', s.total], ['Valid', s.valid], ['Errors', s.invalid], ['Duplicates', s.duplicate]];
  return `<div class="gap" style="margin:8px 0">${chips.map(([k, v]) => `<span class="badge ${k === 'Errors' && v ? 'fail' : k === 'Valid' && v ? 'active' : ''}">${k}: ${v}</span>`).join('')}</div>
    ${s.empty_ignored ? `<div class="mu">${s.empty_ignored} completely empty row${s.empty_ignored > 1 ? 's were' : ' was'} ignored.</div>` : ''}
    ${p.ignored_columns?.length ? `<div class="alert warn">Ignored columns (not recognised): ${p.ignored_columns.map(esc).join(', ')}</div>` : ''}
    ${s.invalid || s.duplicate ? `<div class="alert warn">${s.valid ? `The <b>${s.valid}</b> valid question${s.valid > 1 ? 's' : ''} can still be imported now. ` : ''}${s.invalid ? `Rows with errors (${s.invalid}) are <b>not</b> imported; fix them in your file and upload it again if you need them. ` : ''}${s.duplicate ? `Duplicates (${s.duplicate}) are skipped. ` : ''}Nothing has been saved yet.</div>` : ''}`;
}

function openQuestionImport({ onDone } = {}) {
  const d = modal(`<h2>Import Questions (CSV)</h2>
    <div class="alert info"><b>How it works:</b> 1) download the template and add your questions, 2) upload the file, 3) check the preview, 4) confirm. Nothing is saved until you confirm.
      Required columns: <code>type</code> (mcq, tf, short, numeric, written) and <code>question</code>. For multiple choice give <code>option_a</code>… and the letter in <code>correct_answer</code> (<code>A|C</code> for several).
      In Excel use <b>Save As → CSV UTF-8 (Comma delimited)</b>. Delete the template's SAMPLE rows before uploading.</div>
    <div class="gap"><button type="button" class="sec sm" data-dl="/api/questions/import/template.csv">Download CSV template</button></div>
    <label class="f" for="qif">CSV file</label><input type="file" id="qif" accept=".csv,text/csv,text/plain,application/vnd.ms-excel">
    <div id="qio" aria-live="polite"></div>
    <div class="row l" style="margin-top:12px;position:sticky;bottom:0;background:inherit;padding:10px 0;border-top:1px solid var(--g100)"><button id="qigo" disabled>Import</button><button type="button" class="sec" id="qix">Close</button></div>`, { wide: true });
  d.setAttribute('aria-label', 'Import Questions (CSV)');
  const out = $('#qio', d), go = $('#qigo', d), fileIn = $('#qif', d), fail = m => `<div class="alert err" role="alert">${esc(m)}</div>`;
  let csv = null, digest = null, committed = false, busy = false, valid = 0, seq = 0;
  async function preview(note) {
    const my = ++seq; busy = true; go.disabled = true; go.textContent = 'Import'; digest = null;
    out.innerHTML = '<p><span class="spin"></span> Checking the questions on the server…</p>';
    try {
      const p = await post('/api/questions/import/preview', { csv }); if (my !== seq) return;
      digest = p.digest; valid = p.summary.valid;
      out.innerHTML = (note ? `<div class="alert warn">${esc(note)}</div>` : '') + qiSummary(p) + (p.report_csv ? '<p><button type="button" class="sec sm" id="qirep">Download problem report (CSV)</button></p>' : '') + qiRows(p);
      const rep = $('#qirep', d); if (rep) rep.onclick = () => qiSave('question-import-problems.csv', p.report_csv);
      go.textContent = valid ? `Import ${valid} question${valid > 1 ? 's' : ''}` : 'Nothing to import'; go.disabled = !valid;
      announce(`${p.summary.valid} valid, ${p.summary.invalid} with errors, ${p.summary.duplicate} duplicates`);
    } catch (e) { if (my !== seq) return; out.innerHTML = fail(e.message); go.textContent = 'Import'; }
    busy = false;
  }
  fileIn.onchange = async e => {
    const f = e.target.files[0]; if (!f || busy || committed) { if (committed) e.target.value = ''; return; }
    csv = null; go.disabled = true; out.innerHTML = '<p><span class="spin"></span> Reading the file…</p>';
    try { const r = await qiReadFile(f); csv = r.text; await preview(r.note); } catch (x) { csv = null; out.innerHTML = fail(x.message); }
  };
  go.onclick = async () => {
    if (busy || committed || csv == null || !digest) return;
    busy = true; go.disabled = true; // locked BEFORE the confirmation so a double click cannot start two imports
    if (!await confirmDlg('Import these questions?', `${valid} valid question${valid > 1 ? 's are' : ' is'} saved to your question bank now. Rows with errors and duplicates are skipped.`, { ok: 'Import' })) { busy = false; go.disabled = !valid; return; }
    out.insertAdjacentHTML('afterbegin', '<p id="qiwait"><span class="spin"></span> Importing…</p>'); fileIn.disabled = true;
    try {
      const r = await post('/api/questions/import/commit', { csv, digest }); committed = true; const s = r.summary;
      out.innerHTML = `<div class="alert ok" role="status"><b>Import finished.</b> ${s.imported} question${s.imported === 1 ? '' : 's'} added to your question bank (of ${s.total} rows${s.invalid ? `, ${s.invalid} with errors` : ''}${s.duplicate ? `, ${s.duplicate} duplicates skipped` : ''}).</div>
        ${r.rows.length ? `<h3>Not imported</h3>${qiRows({ rows: r.rows })}` : ''}${r.report_csv ? '<p><button type="button" class="sec sm" id="qirep">Download problem report (CSV)</button></p>' : ''}`;
      const rep = $('#qirep', d); if (rep) rep.onclick = () => qiSave('question-import-problems.csv', r.report_csv);
      go.textContent = 'Done'; toast(`${s.imported} question${s.imported === 1 ? '' : 's'} imported`); announce('Import finished');
    } catch (e) { out.innerHTML = fail(e.message + ' Nothing was imported.'); fileIn.disabled = false; go.disabled = false; if (e.status === 409) { go.disabled = true; } }
    busy = false;
  };
  $('#qix', d).onclick = () => d.close(); d.addEventListener('close', () => { if (committed) onDone?.(); });
  return d;
}
