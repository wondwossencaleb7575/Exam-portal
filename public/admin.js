/* Administrator: users, audit log, system */
const A_ = ['admin'];
R(/^\/a$/, () => (location.hash = '#/a/users'), A_);
R(/^\/a\/users$/, async () => {
  loading(); const f = { q: '', role: '', page: 1 }; page('<div id="x"></div>', { title: 'Users' });
  const load = async () => {
    const r = await get(`/api/admin/users?q=${encodeURIComponent(f.q)}&role=${f.role}&page=${f.page}&size=25`); if (!$('#x')) return;
    $('#x').innerHTML = `<div class="row"><h1>Users</h1><button id="nu">+ New account</button></div><div class="card"><div class="gap"><input id="uq" placeholder="Search name, email, student number" value="${esc(f.q)}" style="max-width:320px" aria-label="Search users"><select id="ur" style="max-width:180px" aria-label="Role">${['', 'admin', 'teacher', 'student'].map(x => `<option value="${x}" ${f.role === x ? 'selected' : ''}>${x || 'All roles'}</option>`).join('')}</select></div>
      <div class="tw"><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th>Status</th><th></th></tr>${r.items.map(u => `<tr><td>${esc(u.name)}<div class="mu">${esc(u.student_number || '')}</div></td><td>${esc(u.email)}${r.otp_mode !== 'off' ? `<span class="vf ${u.email_verified_at ? 'ok' : ''}">${u.otp_required ? (u.email_verified_at ? '✓ Email verified ' + fd(u.email_verified_at) : 'Email not verified yet') : (u.otp_exempt ? 'Password only (exempt)' : 'Password only')}</span>` : ''}</td><td>${u.role}</td><td>${u.last_login ? fd(u.last_login) : 'never'}</td><td>${badge(u.status === 'active' ? 'active' : 'closed', u.status)}</td>
      <td class="n"><button class="sec sm" data-rp="${u.id}">Reset password</button> ${u.role === 'student' && r.otp_mode === 'all' ? `<button class="sec sm" data-ex="${u.id}" data-to="${u.otp_exempt ? 0 : 1}">${u.otp_exempt ? 'Require email code' : 'Allow password only'}</button> ` : ''}${u.id !== state.user.id ? `<button class="sec sm" data-st="${u.id}" data-to="${u.status === 'active' ? 'suspended' : 'active'}">${u.status === 'active' ? 'Suspend' : 'Reactivate'}</button>` : ''}</td></tr>`).join('')}</table></div>${pager(r.total, r.page, r.size)}</div>`;
    const q = $('#uq'); q.oninput = debounce(() => { f.q = q.value; f.page = 1; load().then(() => { const n = $('#uq'); n.focus(); n.setSelectionRange(99, 99); }); }, 300); $('#ur').onchange = e => { f.role = e.target.value; f.page = 1; load(); };
  };
  const tempDlg = (who, pw) => modal(`<h2>Temporary password for ${esc(who)}</h2><p class="pw">${esc(pw)}</p><p class="mu">Shown only once. They must choose their own password at first sign-in.</p><form method="dialog"><button>Close</button></form>`);
  $('#x').onclick = async e => { const b = e.target.closest('button,[data-pg]'); if (!b) return; try {
    if (b.dataset.pg) { f.page = +b.dataset.pg; return load(); }
    if (b.id === 'nu') { let made; await formDlg('New account', `<label class="f">Role</label><select name="role"><option value="teacher">Teacher</option><option value="student">Student</option><option value="admin">Administrator</option></select><label class="f">Full name</label><input name="name" required maxlength="80"><label class="f">Email</label><input name="email" type="email" required><label class="f">Student number (optional)</label><input name="student_number" maxlength="30">`, async v => { made = await post('/api/admin/users', v); }, { ok: 'Create' }); if (made) { tempDlg(made.email, made.temp_password); load(); } }
    if (b.dataset.rp && await confirmDlg('Reset password?', 'A new temporary password is generated and the user is signed out everywhere.', { ok: 'Reset' })) { const r = await post(`/api/admin/users/${b.dataset.rp}/reset-password`); tempDlg('this user', r.temp_password); }
    if (b.dataset.ex && await confirmDlg(b.dataset.to === '1' ? 'Allow password-only sign-in?' : 'Require an email code?', b.dataset.to === '1' ? 'This student will sign in with their password only, without an emailed code. Use this for students who do not have a working email address.' : 'This student must enter a code sent to their email address each time they sign in. Check that the address on the account is real first.', { ok: 'Confirm' })) { await patch('/api/admin/users/' + b.dataset.ex, { otp_exempt: b.dataset.to === '1' }); load(); }
    if (b.dataset.st && await confirmDlg(b.dataset.to === 'suspended' ? 'Suspend account?' : 'Reactivate account?', b.dataset.to === 'suspended' ? 'They are signed out and cannot sign in until reactivated. Their records are kept.' : 'They can sign in again.', { ok: 'Confirm', danger: b.dataset.to === 'suspended' })) { await patch('/api/admin/users/' + b.dataset.st, { status: b.dataset.to }); load(); }
  } catch (er) { toast(er.message, 'err'); } };
  load();
}, A_);
R(/^\/a\/audit$/, async () => {
  loading(); const f = { action: '', actor: '', page: 1 }; page('<div id="x"></div>', { title: 'Audit log' });
  const load = async () => { const r = await get(`/api/admin/audit?action=${encodeURIComponent(f.action)}&actor=${encodeURIComponent(f.actor)}&page=${f.page}&size=50`); if (!$('#x')) return;
    $('#x').innerHTML = `<h1>Audit log</h1><p class="mu">Append-only record of sensitive actions. It cannot be edited or deleted from inside the application.</p><div class="card"><div class="gap"><input id="aa" placeholder="Action, e.g. grade or exam.publish" value="${esc(f.action)}" style="max-width:260px" aria-label="Filter by action"><input id="ac" placeholder="Actor email" value="${esc(f.actor)}" style="max-width:260px" aria-label="Filter by actor"></div>
      <div class="tw"><table><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>Detail</th></tr>${r.items.map(a => `<tr><td class="n">${fd(a.ts)}</td><td>${esc(a.actor_email)}</td><td><b>${esc(a.action)}</b></td><td>${esc(a.resource || '')} ${a.resource_id ?? ''}</td><td class="mu" style="white-space:normal;word-break:break-word">${esc(a.detail || '')}</td></tr>`).join('')}</table></div>${pager(r.total, r.page, r.size)}</div>`;
    const go = debounce(() => { f.action = $('#aa').value; f.actor = $('#ac').value; f.page = 1; const k = document.activeElement.id; load().then(() => { const n = $('#' + k); if (n) { n.focus(); n.setSelectionRange(99, 99); } }); }, 300); $('#aa').oninput = $('#ac').oninput = go; };
  $('#x').onclick = e => { const b = e.target.closest('[data-pg]'); if (b) { f.page = +b.dataset.pg; load(); } }; load();
}, A_);
R(/^\/a\/system$/, async () => {
  loading(); const h = await get('/api/admin/health'), cl = await get('/api/classes'), em = await get('/api/admin/email-status'), mb = x => (x / 1048576).toFixed(2) + ' MB';
  const MODE = { off: 'Off: password only', staff: 'Administrators and teachers', all: 'Everyone (except exempt students)' };
  const emCard = e => `<div class="card" id="emc"><h2>Email verification (sign-in codes)</h2><p class="mu">After the password, these accounts must enter a 6-digit code sent to their email address: <b>${esc(MODE[e.mode])}</b>. Change this with the <code>OTP_LOGIN_MODE</code> setting on the server.</p>
    <p>Sending account: <b>${e.configured ? esc(e.sender) : 'not configured'}</b> · limits: ${e.limits.ttl_seconds / 60} min code life, ${e.limits.maxAttempts} tries, resend every ${e.limits.resend_cooldown_seconds}s, ${e.limits.maxSendsPerUserHour} emails per account per hour</p>
    ${e.configured ? '' : '<div class="alert err">GMAIL_USER and GMAIL_APP_PASSWORD are not set on the server. Accounts that need a code cannot sign in until they are (see docs/EMAIL_OTP.md).</div>'}
    ${e.last_check ? `<div class="alert ${e.last_check.ok ? 'ok' : 'err'}">${fd(e.last_check.at)}: ${esc(e.last_check.message)}</div>` : ''}
    <div class="gap"><button id="emv" class="sec" ${e.configured ? '' : 'disabled'}>Check connection to Gmail</button><button id="emt" class="sec" ${e.configured ? '' : 'disabled'}>Send a test email to me</button></div></div>`;
  page(`<h1>System</h1><div class="grid"><div class="card"><div class="stat">OK</div>Server healthy · up ${Math.round(h.uptime_s / 60)} min</div><div class="card"><div class="stat">${h.attempts_in_progress}</div>Exams being taken right now</div><div class="card"><div class="stat">${mb(h.db_bytes)}</div>Database size</div><div class="card"><div class="stat">${h.users}</div>Accounts · ${h.exams} exams</div></div>
    ${emCard(em)}
    <div class="card"><h2>Database and backups</h2><p class="mu">Your data is stored in Supabase (PostgreSQL), which keeps its own backups: confirm what your plan includes in the Supabase dashboard. Also keep an independent export off the platform (<code>npm run backup</code>) and test a restore (see docs/RECOVERY.md).</p><p>Last database check: <b>${h.last_check ? fd(h.last_check) : 'none yet'}</b></p><button id="bk">Check database now</button><div id="bo"></div></div>
    <div class="card"><h2>Subjects</h2><p>${cl.subjects.map(s => esc(s.name)).join(', ')}</p><div class="gap"><input id="sn" placeholder="New subject" style="max-width:260px" aria-label="New subject name"><button id="sa" class="sec">Add subject</button></div></div>`, { title: 'System' });
  const emRefresh = async () => { $('#emc').outerHTML = emCard(await get('/api/admin/email-status')); emBind(); };
  const emBind = () => {
    $('#emv').onclick = async e => { e.target.disabled = true; try { $('#emc').outerHTML = emCard(await post('/api/admin/email-status/verify')); emBind(); } catch (x) { toast(x.message, 'err'); e.target.disabled = false; } };
    $('#emt').onclick = async e => { e.target.disabled = true; try { const r = await post('/api/admin/email-test'); toast('Test email accepted for ' + r.to + '. Check that inbox.'); } catch (x) { toast(x.message, 'err'); } await emRefresh().catch(() => {}); };
  }; emBind();
  $('#bk').onclick = async e => { e.target.disabled = true; try { const r = await post('/api/admin/backup'); $('#bo').innerHTML = `<div class="alert ${r.verify.ok ? 'ok' : 'err'}">Database check: <b>${esc(r.verify.integrity)}</b> (${r.verify.checks_run} checks) · ${r.verify.users} users, ${r.verify.exams} exams, ${r.verify.attempts} attempts${r.verify.issues.map(i => `<br>• ${esc(i.check)}: ${i.count}`).join('')}</div>`; } catch (x) { toast(x.message, 'err'); } e.target.disabled = false; };
  $('#sa').onclick = async () => { try { await post('/api/admin/subjects', { name: $('#sn').value }); route(); } catch (x) { toast(x.message, 'err'); } };
}, A_);
boot();

/* ---------- School settings: time zone, language, calendar, pass mark, grading scale, terms, branding ---------- */
R(/^\/a\/settings$/, async () => {
  loading(); const s = (await get('/api/settings')); page('<div id="x"></div>', { title: 'School settings' });
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [schoolTz()];
  const scale = s.grading_scale.map(g => ({ ...g }));
  const preview = () => { const tz = $('#st_tz').value, cal = $('#st_cal').value, loc = $('#st_loc').value; let t; try { t = TZ.format(Date.now(), { tz, calendar: cal, locale: loc }); } catch { t = 'That time zone is not recognised.'; } $('#st_prev').textContent = t; };
  const grades = () => `<table><tr><th scope="col">From (%)</th><th scope="col">Grade label</th><th></th></tr>${scale.map((g, i) => `<tr><td><input type="number" min="0" max="100" step="0.5" data-gi="${i}" data-gk="min" value="${g.min}" aria-label="Minimum percent for grade ${i + 1}" style="width:100px"></td><td><input data-gi="${i}" data-gk="label" value="${esc(g.label)}" maxlength="12" aria-label="Label for grade ${i + 1}" style="width:120px"></td><td><button type="button" class="sec sm" data-gdel="${i}" aria-label="Remove grade ${i + 1}">Remove</button></td></tr>`).join('')}</table>${scale.length ? '' : '<p class="mu">No grading scale: results show marks, percent and pass/fail only.</p>'}<button type="button" class="sec sm" id="st_gadd">+ Add a grade</button>`;
  $('#x').innerHTML = `<h1>School settings</h1><p class="mu">These apply to the whole school. Times everywhere are shown in the school time zone below, not the time zone of each person's computer.</p>
    <form id="stf" class="card" novalidate><div class="two">
      <div><label class="f" for="st_name">School name</label><input id="st_name" maxlength="80" value="${esc(s.school_name)}"></div>
      <div><label class="f" for="st_tz">Time zone</label><input id="st_tz" list="st_zl" value="${esc(s.timezone)}" autocomplete="off"><datalist id="st_zl">${zones.map(z => `<option value="${esc(z)}">`).join('')}</datalist></div>
      <div><label class="f" for="st_loc">Language for dates</label><select id="st_loc"><option value="en" ${s.locale === 'en' ? 'selected' : ''}>English</option><option value="am" ${s.locale === 'am' ? 'selected' : ''}>አማርኛ (Amharic)</option></select></div>
      <div><label class="f" for="st_cal">Calendar</label><select id="st_cal"><option value="gregory" ${s.calendar === 'gregory' ? 'selected' : ''}>Gregorian</option><option value="ethiopic" ${s.calendar === 'ethiopic' ? 'selected' : ''}>Ethiopian</option></select></div>
      <div><label class="f" for="st_pm">Default pass mark (%)</label><input id="st_pm" type="number" min="0" max="100" step="0.5" value="${s.default_pass_mark}"><div class="mu">Used by every exam that does not set its own.</div></div>
      <div><label class="f" for="st_col">Brand colour</label><input id="st_col" type="color" value="${esc(s.brand_color)}" style="max-width:90px;padding:2px"><div class="mu" id="st_colw"></div></div></div>
      <p><b>Preview:</b> <span id="st_prev" aria-live="polite"></span></p>
      <label class="f" for="st_terms">Terms (one per line; e.g. Semester 1, Semester 2, or Term 1 to 3)</label><textarea id="st_terms" rows="4" style="max-width:320px">${esc(s.terms.join('\n'))}</textarea>
      <h2 style="margin-top:16px">Grading scale</h2><p class="mu">Optional letter grades. The lowest grade must start at 0%. Pass/fail always uses the pass mark, never the letters.</p><div id="st_g" class="tw">${grades()}</div>
      <div class="alert err" id="st_err" role="alert" hidden></div><div class="row l" style="margin-top:14px"><button type="submit" id="st_save">Save settings</button></div></form>`;
  const warn = () => { const c = $('#st_col').value, n = parseInt(c.slice(1), 16), lin = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }, L = .2126 * lin(n >> 16) + .7152 * lin((n >> 8) & 255) + .0722 * lin(n & 255); $('#st_colw').textContent = 1.05 / (L + .05) >= 4.5 ? 'Readable with white text.' : 'Too light for white text: it will not be applied.'; };
  ['#st_tz', '#st_cal', '#st_loc'].forEach(q => $(q).oninput = preview); $('#st_col').oninput = warn; preview(); warn();
  $('#st_g').addEventListener('input', e => { const i = e.target.dataset.gi; if (i == null) return; scale[i][e.target.dataset.gk] = e.target.dataset.gk === 'min' ? Number(e.target.value) : e.target.value; });
  $('#st_g').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (b.id === 'st_gadd') scale.push({ min: 0, label: '' }); else if (b.dataset.gdel != null) scale.splice(+b.dataset.gdel, 1); $('#st_g').innerHTML = grades(); });
  $('#stf').onsubmit = async e => {
    e.preventDefault(); const btn = $('#st_save'), er = $('#st_err'); er.hidden = true; btn.disabled = true;
    try { const r = await put('/api/admin/settings', { school_name: $('#st_name').value, timezone: $('#st_tz').value.trim(), locale: $('#st_loc').value, calendar: $('#st_cal').value, default_pass_mark: $('#st_pm').value, brand_color: $('#st_col').value, terms: $('#st_terms').value.split('\n'), grading_scale: scale.filter(g => g.label.trim() || g.min) });
      state.settings = r; applyBrand(); toast('Settings saved'); announce('Settings saved'); route(); } catch (x) { er.textContent = x.message; er.hidden = false; }
    btn.disabled = false;
  };
}, A_);
