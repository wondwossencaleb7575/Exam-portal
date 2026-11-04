/* Eagle Labs Exam Portal: student directory, exam enrollment (picker), CSV import/export UI.
   Everything shown here comes from the server; all dynamic text goes through esc(). Access rules are enforced by the API, not by this file. */
const CSV_MAX_BYTES = 1000000;

/* ---------- downloads ---------- */
const saveBlob = (name, blob) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };
const saveText = (name, text) => saveBlob(name, new Blob([text], { type: 'text/csv;charset=utf-8' }));
// Any element with data-dl="/api/....csv" downloads through fetch so errors (403, 404) show a message instead of a broken file.
async function downloadCsv(url) {
  try {
    const r = await fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'eagle' } });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'The download failed.'); }
    const m = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || ''); saveBlob(m ? m[1] : 'export.csv', await r.blob());
  } catch (e) { toast(e.message, 'err'); }
}
document.addEventListener('click', e => { const b = e.target.closest('[data-dl]'); if (!b) return; e.preventDefault(); if (b.disabled) return; b.disabled = true; downloadCsv(b.dataset.dl).finally(() => { b.disabled = false; }); });
const readCsvFile = f => new Promise((ok, no) => {
  if (f.size > CSV_MAX_BYTES) return no(new Error(`That file is too large (maximum ${Math.round(CSV_MAX_BYTES / 1000)} KB). Split it into smaller files.`));
  const r = new FileReader(); r.onerror = () => no(new Error('Could not read that file.')); r.onload = () => ok(String(r.result)); r.readAsText(f, 'utf-8');
});
const classLabel = c => `${c.name}${c.grade ? ' · Grade ' + c.grade : ''}${c.academic_year ? ' · ' + c.academic_year : ''}${c.archived ? ' (archived)' : ''}`;
const statusBadge = s => badge(s === 'active' ? 'active' : 'closed', s);

/* ---------- reusable CSV import dialog: choose file → preview (per-row errors) → confirm → summary + failure report ---------- */
const ROW_BADGE = { create: ['published', 'Will create'], update: ['scheduled', 'Will update'], enroll: ['published', 'Will enroll'], skip: ['closed', 'Skip'], fail: ['fail', 'Error'] };
function previewTable(p) {
  const s = p.summary, chips = Object.entries({ Rows: s.total, 'Will create': s.create, 'Will update': s.update, 'Will enroll': s.enroll, Skipped: s.skip, Errors: s.fail }).filter(([, v]) => v !== undefined);
  const rows = [...p.rows.filter(r => r.action === 'fail'), ...p.rows.filter(r => r.action !== 'fail')].slice(0, 300);
  return `<div class="gap" style="margin:8px 0">${chips.map(([k, v]) => `<span class="badge ${k === 'Errors' && v ? 'fail' : ''}">${esc(k)}: ${v}</span>`).join('')}</div>
    ${p.ignored_columns?.length ? `<div class="alert warn">Ignored columns: ${p.ignored_columns.map(esc).join(', ')}</div>` : ''}
    <div class="tw" style="max-height:40vh;overflow:auto"><table><tr><th>Line</th><th>Result</th><th>Student</th><th>Details</th></tr>${rows.map(r => `<tr><td>${r.line}</td><td>${badge(...ROW_BADGE[r.action])}</td>
      <td>${esc(r.full_name || '')}<div class="mu">${esc([r.email, r.student_number, r.class_name].filter(Boolean).join(' · '))}</div></td>
      <td>${(r.errors || []).map(x => `<div style="color:var(--bad)"><b>${esc(x.column || 'row')}</b>: ${esc(x.message)}</div>`).join('')}${(r.notes || []).map(n => `<div class="mu">${esc(n)}</div>`).join('')}${(r.changes || []).map(c => `<div class="mu">${esc(c.field)}: “${esc(c.from)}” → “${esc(c.to)}”${c.applied ? '' : ' (will not be applied)'}</div>`).join('')}</td></tr>`).join('')}</table></div>
    ${p.rows.length > 300 ? `<p class="mu">Showing the first 300 of ${p.rows.length} rows (errors first).</p>` : ''}`;
}
function importDialog({ title, previewUrl, commitUrl, templates, help, allowUpdate = false, onDone }) {
  const d = modal(`<h2>${esc(title)}</h2><div class="alert info">${help}</div>
    <div class="gap">${templates.map(t => `<button type="button" class="sec sm" data-dl="${esc(t.url)}">${esc(t.label)}</button>`).join('')}</div>
    <label class="f" for="imf">CSV file</label><input type="file" id="imf" accept=".csv,text/csv,text/plain">
    ${allowUpdate ? '<label class="chk"><input type="checkbox" id="imu"> Update existing students (names and status) when the file differs. Student numbers and emails are never overwritten.</label>' : ''}
    <div id="imo" aria-live="polite"></div><div class="row l" style="margin-top:12px"><button id="imgo" disabled>Import</button><button type="button" class="sec" id="imx">Close</button></div>`, { wide: true });
  d.setAttribute('aria-label', title);
  let csv = null, digest = null, committed = false, busy = false; const out = $('#imo', d), go = $('#imgo', d);
  const body = () => ({ csv, digest, update_existing: allowUpdate && $('#imu', d).checked });
  async function preview() {
    if (csv == null) return; busy = true; go.disabled = true; out.innerHTML = '<p><span class="spin"></span> Checking the file…</p>';
    try { const p = await post(previewUrl, { csv, update_existing: allowUpdate && $('#imu', d).checked }); digest = p.digest; out.innerHTML = previewTable(p);
      const n = (p.summary.create || 0) + (p.summary.update || 0) + (p.summary.enroll || 0); go.textContent = n ? `Import ${n} row${n > 1 ? 's' : ''}` : 'Nothing to import'; go.disabled = !n;
      if (p.summary.fail) out.insertAdjacentHTML('afterbegin', '<div class="alert warn">Rows with errors will be skipped; you will get a report to fix and re-upload them. Nothing has been saved yet.</div>'); }
    catch (e) { out.innerHTML = `<div class="alert err" role="alert">${esc(e.message)}</div>`; go.textContent = 'Import'; } busy = false;
  }
  $('#imf', d).onchange = async e => { const f = e.target.files[0]; if (!f) return; try { csv = await readCsvFile(f); } catch (x) { csv = null; out.innerHTML = `<div class="alert err" role="alert">${esc(x.message)}</div>`; return; } preview(); };
  if (allowUpdate) $('#imu', d).onchange = () => { committed || preview(); };
  go.onclick = async () => {
    if (busy || committed || csv == null) return;
    if (!await confirmDlg('Import this file?', 'The rows marked above are saved now. Rows with errors are skipped.', { ok: 'Import' })) return;
    busy = true; go.disabled = true; out.innerHTML = '<p><span class="spin"></span> Importing…</p>';
    try {
      const r = await post(commitUrl, body()); committed = true; const s = r.summary;
      out.innerHTML = `<div class="alert ok" role="status"><b>Import finished.</b> ${Object.entries(s).filter(([k]) => k !== 'total').map(([k, v]) => `${v} ${esc(k)}`).join(' · ')} (of ${s.total} rows)</div>
        ${r.credentials?.length ? `<div class="alert warn"><b>Write these down or print them now. Temporary passwords are shown only once and are never in any download.</b></div><div class="tw"><table><tr><th>Name</th><th>Email</th><th>Temporary password</th></tr>${r.credentials.map(c => `<tr><td>${esc(c.full_name)}</td><td>${esc(c.email)}</td><td><span class="pw">${esc(c.temp_password)}</span></td></tr>`).join('')}</table></div><button class="sec sm" data-print>Print</button>` : ''}
        ${s.failed || s.skipped ? `<p><button class="sec" id="imrep">Download report of failed / skipped rows (CSV)</button></p>` : ''}`;
      const rep = $('#imrep', d); if (rep) rep.onclick = () => saveText('import-report.csv', r.report_csv);
      go.textContent = 'Done'; toast('Import finished'); announce('Import finished');
    } catch (e) { out.innerHTML = `<div class="alert err" role="alert">${esc(e.message)}</div>`; go.disabled = false; } busy = false;
  };
  $('#imx', d).onclick = () => d.close(); d.addEventListener('close', () => { if (committed) onDone?.(); });
  return d;
}
const STUDENT_IMPORT_HELP = `<b>Columns:</b> <code>student_number, full_name, email, class_name, grade, academic_year, status</code>. Required: <b>full_name</b> and <b>email</b>. Others are optional; <code>status</code> is <code>active</code> or <code>suspended</code>.
  Existing emails are matched, never duplicated. <code>class_name</code> must match an existing class (add grade / academic_year if two classes share a name); classes are never created here. Use <b>CSV UTF-8</b> when saving from Excel. Passwords are generated by the portal and must be changed at first sign-in.`;

/* ---------- student directory (admin: every student + import; teacher: own students) ---------- */
async function studentsView() {
  const admin = state.user.role === 'admin', f = { q: '', class_id: '', grade: '', academic_year: '', status: '', sort: 'name', dir: 'asc', page: 1 }, sel = new Set(); let facets = null, last = null, delegated = false;
  page('<div id="x"></div>', { title: 'Students' });
  const qs = (extra = {}) => { const p = new URLSearchParams({ ...f, ...extra }); for (const [k, v] of [...p]) if (!v) p.delete(k); return p; };
  const shell = () => { $('#x').innerHTML = `<div class="row"><h1>Students</h1><div class="gap"><button class="sec" id="exa">Export Students CSV</button><button class="sec" id="exs" hidden>Export selected</button>${admin ? '<button id="imp">Import Students (CSV)</button><a class="btn sec" href="#/a/users">Create one account…</a>' : ''}</div></div>
    <p class="mu">${admin ? 'Every student account.' : 'Students in your own classes.'} Exports use exactly the filters you see here.</p>
    <div class="card"><div class="two"><div><label class="f" for="sq">Search name, email or student number</label><input id="sq"></div>
      <div><label class="f" for="sc">Class</label><select id="sc"><option value="">All classes</option>${facets.classes.map(c => `<option value="${c.id}">${esc(classLabel(c))}</option>`).join('')}</select></div>
      <div><label class="f" for="sg">Grade</label><select id="sg"><option value="">All</option>${facets.grades.map(g => `<option>${esc(g)}</option>`).join('')}</select></div>
      <div><label class="f" for="sy">Academic year</label><select id="sy"><option value="">All</option>${facets.academic_years.map(g => `<option>${esc(g)}</option>`).join('')}</select></div>
      <div><label class="f" for="ss">Account status</label><select id="ss"><option value="">All</option><option value="active">Active</option><option value="suspended">Suspended</option></select></div>
      <div><label class="f" for="so">Sort</label><select id="so"><option value="name:asc">Name A–Z</option><option value="name:desc">Name Z–A</option><option value="student_number:asc">Student number ↑</option><option value="student_number:desc">Student number ↓</option></select></div></div></div>
    <div class="card"><div id="tbl" aria-live="polite"></div></div>`; };
  const load = async () => {
    const tbl = $('#tbl'); if (tbl) tbl.innerHTML = '<p><span class="spin"></span> Loading…</p>';
    try {
      const r = await get('/api/students?' + qs({ size: 25 })); last = r; if (!facets) { facets = r.facets; shell(); bind(); }
      const t = $('#tbl'); if (!t) return;
      t.innerHTML = r.items.length ? `<div class="tw"><table><tr><th><input type="checkbox" id="sall" aria-label="Select all students on this page" ${r.items.every(s => sel.has(s.id)) ? 'checked' : ''}></th><th>Student</th><th>Email</th><th>Classes</th><th>Status</th>${admin ? '<th>Last sign-in</th>' : ''}<th></th></tr>
        ${r.items.map(s => `<tr><td><input type="checkbox" data-sel="${s.id}" aria-label="Select ${esc(s.name)}" ${sel.has(s.id) ? 'checked' : ''}></td><td>${esc(s.name)}<div class="mu">${esc(s.student_number || 'no student number')}</div></td><td>${esc(s.email)}</td>
        <td>${s.classes.map(c => `<div>${esc(c.name)}<span class="mu">${c.grade ? ' · Gr ' + esc(c.grade) : ''}${c.academic_year ? ' · ' + esc(c.academic_year) : ''}</span></div>`).join('') || '<span class="mu">none</span>'}</td><td>${statusBadge(s.status)}</td>${admin ? `<td class="n">${s.last_login ? fd(s.last_login) : 'never'}</td>` : ''}<td class="n"><button class="sec sm" data-det="${s.id}">Details</button></td></tr>`).join('')}</table></div>${pager(r.total, r.page, r.size)}`
        : `<div class="mu" style="padding:12px">No students match these filters.${admin ? ' Use “Import Students (CSV)” to add some.' : ' Students appear here once they are in one of your classes.'}</div>`;
      sync();
    } catch (e) { const t = $('#tbl'); if (t) t.innerHTML = `<div class="alert err" role="alert">${esc(e.message)} <button class="sec sm" id="retry">Try again</button></div>`; }
  };
  const sync = () => { const b = $('#exs'); if (!b) return; b.hidden = !sel.size; b.textContent = `Export selected (${sel.size})`; };
  const bind = () => {
    const re = debounce(() => { Object.assign(f, { q: $('#sq').value, class_id: $('#sc').value, grade: $('#sg').value, academic_year: $('#sy').value, status: $('#ss').value, page: 1 }); [f.sort, f.dir] = $('#so').value.split(':'); load(); }, 250);
    ['#sq', '#sc', '#sg', '#sy', '#ss', '#so'].forEach(s => $(s).oninput = re);
    $('#exa').onclick = () => downloadCsv('/api/students/export.csv?' + qs());
    $('#exs').onclick = () => { if (sel.size > 500) return toast('Select at most 500 students for one export, or use the filters.', 'err'); downloadCsv('/api/students/export.csv?ids=' + [...sel].join(',')); };
    if (admin) $('#imp').onclick = () => importDialog({ title: 'Import Students (CSV)', previewUrl: '/api/students/import/preview', commitUrl: '/api/students/import/commit', allowUpdate: true, help: STUDENT_IMPORT_HELP,
      templates: [{ label: 'Download blank template', url: '/api/students/import/template.csv' }, { label: 'Download example file', url: '/api/students/import/example.csv' }], onDone: () => { Object.assign(f, { q: '', class_id: '', grade: '', academic_year: '', status: '', sort: 'name', dir: 'asc', page: 1 }); facets = null; load(); } });
    if (delegated) return; delegated = true;
    $('#x').addEventListener('click', async e => {
      const b = e.target.closest('button,[data-pg]'); if (!b) return;
      if (b.dataset.pg) { f.page = +b.dataset.pg; return load(); } if (b.id === 'retry') return load();
      if (b.dataset.det) { try { const d = await get('/api/students/' + b.dataset.det), s = d.student;
        const dlg = modal(`<h2>${esc(s.name)}</h2><p>${esc(s.email)} · ${esc(s.student_number || 'no student number')} · ${statusBadge(s.status)}${admin ? ` · last sign-in ${s.last_login ? fd(s.last_login) : 'never'}` : ''}</p>
          <h3>Classes</h3>${s.classes.map(c => `<div>${esc(classLabel(c))}</div>`).join('') || '<p class="mu">Not in any class.</p>'}
          <h3 style="margin-top:12px">Exam participation</h3>${d.exams.length ? `<div class="tw"><table><tr><th>Exam</th><th>Access</th><th>Attempts</th><th>Latest</th>${admin ? '' : '<th>Marks</th>'}</tr>${d.exams.map(x => `<tr><td>${esc(x.title)}</td><td>${esc(x.source)}</td><td>${x.attempts}</td><td>${x.latest_status ? badge(x.latest_status) : '–'}</td>${admin ? '' : `<td>${x.score == null ? '–' : num(x.score) + ' / ' + num(x.total)}</td>`}</tr>`).join('')}</table></div>` : '<p class="mu">No exam enrollment or attempts yet.</p>'}
          ${admin ? `<h3 style="margin-top:12px">Edit student</h3><form id="edf" novalidate><div class="two"><div><label class="f" for="ed_n">Full name</label><input id="ed_n" maxlength="80" value="${esc(s.name)}"></div><div><label class="f" for="ed_e">Email</label><input id="ed_e" type="email" maxlength="254" value="${esc(s.email)}"></div><div><label class="f" for="ed_s">Student number</label><input id="ed_s" maxlength="30" value="${esc(s.student_number || '')}"></div></div>
            <div class="alert err" id="ed_err" role="alert" hidden></div><div class="gap" style="margin-top:8px"><button type="submit" id="ed_save">Save changes</button><button type="button" class="sec" id="ed_st">${s.status === 'active' ? 'Suspend account' : 'Reactivate account'}</button></div></form>` : ''}
          <form method="dialog" style="margin-top:14px"><button>Close</button></form>`, { wide: true }); dlg.setAttribute('aria-label', 'Student details');
        if (admin) {
          $('#edf', dlg).onsubmit = async ev => { ev.preventDefault(); const sv = $('#ed_save', dlg), er = $('#ed_err', dlg); er.hidden = true; sv.disabled = true;
            try { await patch('/api/admin/users/' + s.id, { name: $('#ed_n', dlg).value, email: $('#ed_e', dlg).value, student_number: $('#ed_s', dlg).value }); toast('Student updated'); dlg.close(); load(); } catch (x) { er.textContent = x.message; er.hidden = false; sv.disabled = false; } };
          $('#ed_st', dlg).onclick = async () => { const to = s.status === 'active' ? 'suspended' : 'active'; if (!await confirmDlg(to === 'suspended' ? 'Suspend this account?' : 'Reactivate this account?', to === 'suspended' ? `${s.name} will be signed out and unable to sign in. Their records are kept.` : `${s.name} will be able to sign in again.`, { ok: to === 'suspended' ? 'Suspend' : 'Reactivate', danger: to === 'suspended' })) return;
            try { await patch('/api/admin/users/' + s.id, { status: to }); toast(to === 'suspended' ? 'Account suspended' : 'Account reactivated'); dlg.close(); load(); } catch (x) { toast(x.message, 'err'); } };
        } } catch (x) { toast(x.message, 'err'); } }
    });
    $('#x').addEventListener('change', e => {
      const t = e.target; if (t.id === 'sall') { (last?.items || []).forEach(s => t.checked ? sel.add(s.id) : sel.delete(s.id)); $$('[data-sel]').forEach(c => c.checked = t.checked); sync(); }
      else if (t.dataset.sel) { t.checked ? sel.add(+t.dataset.sel) : sel.delete(+t.dataset.sel); sync(); }
    });
  };
  await load();
}
R(/^\/t\/students$/, studentsView, ['teacher']); R(/^\/a\/students$/, studentsView, ['admin']);

/* ---------- Students & Exam Enrollment (exam detail page) ---------- */
const ENROLL_FILTERS = [['', 'All students'], ['not_started', 'Not started'], ['started', 'Started'], ['in_progress', 'In progress'], ['submitted', 'Submitted'], ['direct', 'Directly enrolled'], ['class', 'Via class']];
const ENR_BADGE = { not_enrolled: 'closed', enrolled: 'enrolled', attempted: 'pending', submitted: 'submitted', ineligible: 'fail' };
function enrollmentPanel(examId, exam) {
  const host = $('#enr'); if (!host) return; const f = { q: '', filter: '', page: 1 }, archived = exam.status === 'archived', off = archived ? 'disabled' : '';
  host.innerHTML = `<div class="card"><div class="row"><h2>Students &amp; Exam Enrollment</h2><div class="gap"><button id="addst" ${off}>+ Add Existing Students</button><button class="sec" id="addcl" ${off}>Add a class…</button><button class="sec" id="impr" ${off}>Import roster CSV…</button><button class="sec" data-dl="/api/exams/${examId}/roster.csv">Export roster CSV</button></div></div>
    ${archived ? '<div class="alert info">This exam is archived, so enrollment cannot change. Duplicate the exam to run it again.</div>' : '<p class="mu">Enroll students one by one or in bulk without creating a new class. Enrolling never starts a timer or creates an attempt, and the exam’s own opening time, closing time and attempt limits still apply.</p>'}
    <div id="en-sum" class="grid"><span class="spin"></span></div>
    <div class="two" style="margin-top:10px"><div><label class="f" for="en-q">Search the roster</label><input id="en-q" placeholder="Name, email or student number"></div><div><label class="f" for="en-f">Show</label><select id="en-f">${ENROLL_FILTERS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div></div>
    <div id="en-list" aria-live="polite"></div><p class="mu"><button class="sec sm" data-dl="/api/exams/${examId}/enrollment/template.csv">Download enrollment CSV template</button></p></div>`;
  const load = async () => {
    try {
      const r = await get(`/api/exams/${examId}/enrollment?` + new URLSearchParams({ q: f.q, filter: f.filter, page: f.page, size: 15 })); if (!$('#en-list')) return; const s = r.summary;
      $('#en-sum').innerHTML = [[s.eligible, 'Enrolled', `${s.enrolled_direct} directly · ${s.via_class} via class`], [s.not_enrolled, 'Not enrolled', 'your students without access'], [s.not_started, 'Not started'], [s.attempting, 'Attempting now'], [s.submitted, 'Submitted'], [s.awaiting_grading, 'Awaiting grading']].map(([n, l, sub]) => `<div class="card"><div class="stat">${n}</div>${l}${sub ? `<div class="mu">${sub}</div>` : ''}</div>`).join('');
      $('#en-list').innerHTML = r.items.length ? `<div class="tw"><table><tr><th>Student</th><th>Email</th><th>Access</th><th>Added</th><th>Progress</th><th></th></tr>${r.items.map(s => `<tr><td>${esc(s.name)}<div class="mu">${esc(s.student_number || '')}</div></td><td>${esc(s.email)}</td><td>${badge(s.direct ? 'scheduled' : 'closed', s.source)}${s.account_status !== 'active' ? ' ' + badge('fail', 'suspended') : ''}</td><td class="n">${s.enrolled_at ? fd(s.enrolled_at) : '–'}${s.enrolled_by ? `<div class="mu">by ${esc(s.enrolled_by)}</div>` : ''}</td>
        <td>${s.in_progress ? badge('in_progress') : s.submitted ? badge('submitted', `submitted${s.submitted > 1 ? ' ×' + s.submitted : ''}`) : s.attempts ? badge('pending', 'attempted') : '<span class="mu">Not started</span>'}</td><td class="n">${s.can_remove && !archived ? `<button class="sec sm" data-rm="${s.id}" data-name="${esc(s.name)}">Remove</button>` : s.direct && s.attempts ? '<span class="mu">Has attempts</span>' : ''}</td></tr>`).join('')}</table></div>${pager(r.total, r.page, r.size)}`
        : `<div class="mu" style="padding:14px 4px">${f.q || f.filter ? 'No students match.' : 'No students enrolled yet. Use <b>+ Add Existing Students</b>, add a whole class, or import a roster CSV.'}</div>`;
    } catch (e) { $('#en-list').innerHTML = `<div class="alert err" role="alert">${esc(e.message)} <button class="sec sm" id="en-retry">Try again</button></div>`; }
  };
  const re = debounce(() => { f.q = $('#en-q').value; f.filter = $('#en-f').value; f.page = 1; load(); }, 250); $('#en-q').oninput = re; $('#en-f').onchange = re;
  host.addEventListener('click', async e => {
    const b = e.target.closest('button,[data-pg]'); if (!b) return;
    try {
      if (b.dataset.pg) { f.page = +b.dataset.pg; return load(); } if (b.id === 'en-retry') return load();
      if (b.id === 'addst') pickerDialog(examId, exam.title, load);
      if (b.id === 'addcl') classEnrollDialog(examId, load);
      if (b.id === 'impr') importDialog({ title: 'Import roster CSV', previewUrl: `/api/exams/${examId}/enrollment/import/preview`, commitUrl: `/api/exams/${examId}/enrollment/import/commit`, onDone: load,
        help: 'Columns: <code>email</code> and/or <code>student_number</code> (the exam roster export works too). Only <b>existing</b> student accounts from your own classes are matched; no accounts are created, and students already enrolled are skipped.',
        templates: [{ label: 'Download template', url: `/api/exams/${examId}/enrollment/template.csv` }] });
      if (b.dataset.rm && await confirmDlg('Remove from this exam?', `${b.dataset.name} will no longer be enrolled directly. This is only possible while they have no attempts; nothing is deleted.`, { ok: 'Remove', danger: true })) {
        b.disabled = true; try { const r = await del(`/api/exams/${examId}/enrollment/${b.dataset.rm}`); toast(r.still_has_access_via_class ? 'Removed. They can still take the exam through an assigned class.' : 'Removed from the exam'); load(); } catch (x) { b.disabled = false; throw x; }
      }
    } catch (x) { toast(x.message, 'err'); }
  });
  load();
}
const resultBox = r => `<div class="alert ${r.summary.added ? 'ok' : 'info'}" role="status"><b>${r.summary.added} added</b>${r.summary.already ? ` · ${r.summary.already} already enrolled` : ''}${r.summary.failed ? ` · ${r.summary.failed} could not be added` : ''}</div>
  ${[...r.failed, ...r.already].slice(0, 12).map(x => `<div class="mu">${esc(x.name || 'Student #' + x.id)}: ${esc(x.reason)}</div>`).join('')}${r.failed.length + r.already.length > 12 ? '<div class="mu">…and more.</div>' : ''}`;

/* ---------- "+ Add Existing Students": search, filter, per-row Add, bulk add, select-all-matching ---------- */
function pickerDialog(examId, examTitle, onChange) {
  const d = modal(`<h2>Add existing students</h2><p class="mu">${esc(examTitle)} · your students only. Nothing is created; existing accounts are enrolled.</p>
    <div class="two"><div><label class="f" for="pq">Search name, email or student number</label><input id="pq" autocomplete="off"></div><div><label class="f" for="pc">Class</label><select id="pc"><option value="">All my classes</option></select></div>
    <div><label class="f" for="pg_">Grade</label><select id="pg_"><option value="">All</option></select></div><div><label class="f" for="py">Academic year</label><select id="py"><option value="">All</option></select></div></div>
    <label class="chk"><input type="checkbox" id="ph"> Hide students who already have access</label>
    <div id="pb" aria-live="polite"></div><div id="pl" style="max-height:44vh;overflow:auto" aria-live="polite"></div><div id="pr"></div>
    <div class="row" style="margin-top:12px"><div class="gap"><button id="padd" disabled>Add Selected Students</button><button class="sec" id="pcl">Close</button></div></div>`, { wide: true });
  d.setAttribute('aria-label', 'Add existing students');
  const p = { q: '', class_id: '', grade: '', academic_year: '', hide: false, page: 1 }, sel = new Set(); let allMatching = false, total = 0, items = [], facetsDone = false, busy = false;
  const filters = () => ({ q: p.q, class_id: p.class_id, grade: p.grade, academic_year: p.academic_year });
  const count = () => allMatching ? total : sel.size, refresh = () => { const b = $('#padd', d); b.disabled = busy || !count(); b.textContent = count() ? `Add Selected Students (${count()})` : 'Add Selected Students'; };
  const selectable = s => s.enroll.key === 'not_enrolled';
  const banner = () => { const pb = $('#pb', d), can = items.filter(selectable), all = can.length && can.every(s => sel.has(s.id));
    pb.innerHTML = allMatching ? `<div class="alert info">All ${total} matching students are selected (those who already have access are skipped). <button class="sec sm" id="pclr">Clear selection</button></div>`
      : all && total > items.length ? `<div class="alert info">${can.length} selected on this page. <button class="sec sm" id="pall">Select all ${total} matching students</button></div>` : ''; };
  async function load() {
    $('#pl', d).innerHTML = '<p><span class="spin"></span> Loading…</p>';
    try {
      const r = await get(`/api/exams/${examId}/candidates?` + new URLSearchParams({ ...filters(), hide_enrolled: p.hide ? '1' : '', page: p.page, size: 10 }));
      if (!facetsDone) { facetsDone = true; $('#pc', d).insertAdjacentHTML('beforeend', r.facets.classes.map(c => `<option value="${c.id}">${esc(classLabel(c))}</option>`).join('')); $('#pg_', d).insertAdjacentHTML('beforeend', r.facets.grades.map(g => `<option>${esc(g)}</option>`).join('')); $('#py', d).insertAdjacentHTML('beforeend', r.facets.academic_years.map(g => `<option>${esc(g)}</option>`).join('')); }
      items = r.items; total = r.total;
      $('#pl', d).innerHTML = items.length ? `<div class="tw"><table><tr><th><input type="checkbox" id="pall_" aria-label="Select all selectable students on this page"></th><th>Student</th><th>Email</th><th>Class</th><th>Status</th><th></th></tr>${items.map(s => `<tr><td><input type="checkbox" data-s="${s.id}" aria-label="Select ${esc(s.name)}" ${selectable(s) ? '' : 'disabled'} ${sel.has(s.id) || (allMatching && selectable(s)) ? 'checked' : ''}></td>
        <td>${esc(s.name)}<div class="mu">${esc(s.student_number || '')}</div></td><td>${esc(s.email)}</td><td>${s.classes.map(c => esc(c.name)).join(', ') || '<span class="mu">–</span>'}</td>
        <td>${badge(ENR_BADGE[s.enroll.key], s.enroll.label)}${s.enroll.reason ? `<div class="mu">${esc(s.enroll.reason)}</div>` : ''}</td><td class="n">${selectable(s) ? `<button class="sec sm" data-add="${s.id}" aria-label="Add ${esc(s.name)}">Add</button>` : ''}</td></tr>`).join('')}</table></div>${pager(r.total, r.page, r.size)}`
        : '<div class="mu" style="padding:14px 4px">No students match. Try a different search, or check that the student is in one of your classes.</div>';
      const pa = $('#pall_', d); if (pa) { const can = items.filter(selectable); pa.checked = !!can.length && can.every(s => sel.has(s.id) || allMatching); pa.disabled = !can.length; }
    } catch (e) { $('#pl', d).innerHTML = `<div class="alert err" role="alert">${esc(e.message)} <button class="sec sm" id="pretry">Try again</button></div>`; items = []; }
    banner(); refresh();
  }
  async function submit(body) {
    if (busy) return; busy = true; refresh(); $$('[data-add]', d).forEach(b => b.disabled = true);
    try { const r = await post(`/api/exams/${examId}/enrollment`, body); $('#pr', d).innerHTML = resultBox(r); toast(`${r.summary.added} added${r.summary.failed ? `, ${r.summary.failed} could not be added` : ''}`, r.summary.failed && !r.summary.added ? 'err' : ''); announce(`${r.summary.added} students added`); sel.clear(); allMatching = false; onChange?.(); }
    catch (e) { $('#pr', d).innerHTML = `<div class="alert err" role="alert">${esc(e.message)}</div>`; toast(e.message, 'err'); }
    busy = false; await load();
  }
  const re = debounce(() => { Object.assign(p, { q: $('#pq', d).value, class_id: $('#pc', d).value, grade: $('#pg_', d).value, academic_year: $('#py', d).value, hide: $('#ph', d).checked, page: 1 }); allMatching = false; sel.clear(); load(); }, 250);
  ['#pq', '#pc', '#pg_', '#py', '#ph'].forEach(s => $(s, d).oninput = re);
  d.addEventListener('click', e => { const b = e.target.closest('button,[data-pg]'); if (!b) return;
    if (b.dataset.pg) { p.page = +b.dataset.pg; return load(); } if (b.id === 'pretry') return load(); if (b.id === 'pcl') return d.close();
    if (b.dataset.add) return submit({ student_ids: [+b.dataset.add] });
    if (b.id === 'pall') { allMatching = true; $$('[data-s]:not(:disabled)', d).forEach(c => c.checked = true); banner(); refresh(); }
    if (b.id === 'pclr') { allMatching = false; sel.clear(); $$('[data-s],#pall_', d).forEach(c => c.checked = false); banner(); refresh(); }
    if (b.id === 'padd') { if (allMatching) submit({ filters: filters() }); else if (sel.size) submit({ student_ids: [...sel].slice(0, 500) }); } });
  d.addEventListener('change', e => { const t = e.target;
    if (t.id === 'pall_') { allMatching = false; items.filter(selectable).forEach(s => t.checked ? sel.add(s.id) : sel.delete(s.id)); $$('[data-s]:not(:disabled)', d).forEach(c => c.checked = t.checked); }
    else if (t.dataset.s) { allMatching = false; t.checked ? sel.add(+t.dataset.s) : sel.delete(+t.dataset.s); const pa = $('#pall_', d), can = items.filter(selectable); if (pa) pa.checked = can.every(s => sel.has(s.id)); }
    else return; banner(); refresh(); });
  load(); $('#pq', d).focus();
}
/* ---------- add every student of one of the teacher's classes ---------- */
async function classEnrollDialog(examId, onChange) {
  let cl; try { cl = await get('/api/classes'); } catch (e) { return toast(e.message, 'err'); }
  const mine = cl.items.filter(c => !c.archived && c.students > 0);
  const d = modal(`<h2>Add a whole class</h2><p class="mu">Enrolls every active student of the class directly. Students who already have access are skipped. (To make a draft exam available to a class as a group, tick the class in the exam editor instead.)</p>
    ${mine.length ? `<label class="f" for="cc">Class</label><select id="cc">${mine.map(c => `<option value="${c.id}">${esc(classLabel(c))} (${c.students} students)</option>`).join('')}</select>` : '<div class="alert info">You have no classes with students yet.</div>'}
    <div id="cr"></div><div class="row l" style="margin-top:12px">${mine.length ? '<button id="cgo">Add all students</button>' : ''}<button class="sec" id="ccl">Close</button></div>`);
  d.setAttribute('aria-label', 'Add a whole class'); $('#ccl', d).onclick = () => d.close();
  const go = $('#cgo', d); if (go) go.onclick = async () => { go.disabled = true; try { const r = await post(`/api/exams/${examId}/enrollment`, { class_id: +$('#cc', d).value }); $('#cr', d).innerHTML = resultBox(r); onChange?.(); announce(`${r.summary.added} students added`); } catch (e) { $('#cr', d).innerHTML = `<div class="alert err" role="alert">${esc(e.message)}</div>`; } go.disabled = false; };
}
