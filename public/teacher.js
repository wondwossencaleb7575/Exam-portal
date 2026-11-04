/* Teacher: dashboard, exams, builder, question bank, results, grading, classes */
const T_ = ['teacher'], LET = 'ABCDEFGH';
const newQ = (type = 'mcq') => ({ type, stem: '', marks: 1, topic: '', difficulty: 'medium', explanation: '', image_id: null, section: '',
  options: type === 'mcq' ? ['a', 'b', 'c', 'd'].map(id => ({ id, text: '' })) : type === 'tf' ? [{ id: 'true', text: 'True' }, { id: 'false', text: 'False' }] : [],
  key: type === 'mcq' ? { correct: [] } : type === 'tf' ? { correct: null } : type === 'short' ? { accepted: [''] } : type === 'numeric' ? { value: '', tol: 0, tolType: 'abs', decimals: '' } : { guide: '' },
  settings: type === 'mcq' ? { multi: false, scoring: 'all' } : type === 'short' ? { caseSensitive: false, review: true } : type === 'numeric' ? { unit: '' } : {} });
const normQ = q => { q = JSON.parse(JSON.stringify(q)); if (q.type === 'numeric') { q.key.value = q.key.value ?? ''; q.key.decimals = q.key.decimals ?? ''; } return q; };
const TYPE_NAMES = { mcq: 'Multiple choice', tf: 'True / false', short: 'Short answer', numeric: 'Numerical', written: 'Written (teacher marked)' };
const typeSelect = (i, v) => `<select data-i="${i}" data-f="type" aria-label="Question type">${Object.entries(TYPE_NAMES).map(([k, n]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
const previewHtml = q => `<div class="mu">Student preview</div>${esc(q.stem || '…')}${q.image_id ? `<img class="qimg" src="/api/images/${q.image_id}" alt="">` : ''}` +
  (q.type === 'mcq' || q.type === 'tf' ? q.options.map((o, j) => `\n<b>${q.type === 'mcq' ? LET[j] + '.' : '○'}</b> ${esc(o.text)}`).join('') : q.type === 'written' ? '\n<i>[long answer box]</i>' : `\n<i>[answer box${q.settings.unit ? ' · ' + esc(q.settings.unit) : ''}]</i>`);

function qEditor(q, i, { section = false } = {}) {
  const d = `data-i="${i}"`, multi = q.type === 'mcq' && q.settings.multi; let body = '';
  if (q.type === 'mcq') body = `<fieldset><legend class="f">Answer options (tick the correct answer${multi ? 's' : ''})</legend>${q.options.map((o, j) => `<div class="gap" style="margin:4px 0;flex-wrap:nowrap"><input type="${multi ? 'checkbox' : 'radio'}" name="c${i}" ${d} data-f="correct" data-id="${o.id}" ${q.key.correct.includes(o.id) ? 'checked' : ''} aria-label="Option ${LET[j]} is correct"><input type="text" ${d} data-f="opt" data-j="${j}" value="${esc(o.text)}" placeholder="Option ${LET[j]}" aria-label="Option ${LET[j]} text"><button type="button" class="sec sm" data-act="rmopt" ${d} data-j="${j}" aria-label="Remove option ${LET[j]}">✕</button></div>`).join('')}</fieldset>
    <button type="button" class="sec sm" data-act="addopt" ${d}>+ Add option</button><label class="chk"><input type="checkbox" ${d} data-f="multi" ${multi ? 'checked' : ''}> Allow several correct answers</label>
    ${multi ? `<label class="f">Marking of several-answer questions</label><select ${d} data-f="scoring"><option value="all" ${q.settings.scoring === 'all' ? 'selected' : ''}>All-or-nothing</option><option value="partial" ${q.settings.scoring === 'partial' ? 'selected' : ''}>Partial credit (wrong picks cancel right ones)</option></select>` : ''}`;
  else if (q.type === 'tf') body = `<fieldset><legend class="f">Correct answer</legend>${['true', 'false'].map(v => `<label class="chk"><input type="radio" name="tf${i}" ${d} data-f="tf" value="${v}" ${q.key.correct === v ? 'checked' : ''}> ${v === 'true' ? 'True' : 'False'}</label>`).join('')}</fieldset>`;
  else if (q.type === 'short') body = `<label class="f">Accepted answers (one per line)</label><textarea rows="3" ${d} data-f="accepted">${esc((q.key.accepted || []).join('\n'))}</textarea>
    <label class="chk"><input type="checkbox" ${d} data-f="cs" ${q.settings.caseSensitive ? 'checked' : ''}> Case sensitive</label><label class="chk"><input type="checkbox" ${d} data-f="review" ${q.settings.review !== false ? 'checked' : ''}> Send non-matching answers to me for review (instead of 0 marks)</label>`;
  else if (q.type === 'numeric') body = `<div class="two"><div><label class="f">Correct value</label><input type="text" inputmode="decimal" ${d} data-f="nvalue" value="${esc(q.key.value)}"></div>
    <div><label class="f">Tolerance (±)</label><input type="text" inputmode="decimal" ${d} data-f="tol" value="${esc(q.key.tol)}"></div>
    <div><label class="f">Tolerance type</label><select ${d} data-f="tolType"><option value="abs" ${q.key.tolType === 'abs' ? 'selected' : ''}>Absolute</option><option value="rel" ${q.key.tolType === 'rel' ? 'selected' : ''}>Percent of value</option></select></div>
    <div><label class="f">Round correct value to (decimals, optional)</label><input type="text" inputmode="numeric" ${d} data-f="decimals" value="${esc(q.key.decimals)}"></div>
    <div><label class="f">Unit shown to student (optional)</label><input type="text" ${d} data-f="unit" value="${esc(q.settings.unit)}" maxlength="20"></div></div>
    <div class="mu">Students type a number; fractions like 1/2 and decimal commas are understood. No answer is treated as equivalent unless it falls inside your tolerance.</div>`;
  else body = `<label class="f">Marking guide (only you see this)</label><textarea rows="3" ${d} data-f="guide">${esc(q.key.guide)}</textarea><div class="mu">Written answers are marked by you, with partial marks and feedback.</div>`;
  return `<div class="two"><div><label class="f">Type</label>${typeSelect(i, q.type)}</div><div><label class="f">Marks</label><input type="text" inputmode="decimal" ${d} data-f="marks" value="${esc(q.marks)}"></div></div>
    ${section ? `<label class="f">Section (optional, groups questions)</label><input type="text" ${d} data-f="section" value="${esc(q.section || '')}" maxlength="80">` : ''}
    <label class="f">Question</label><textarea rows="3" ${d} data-f="stem">${esc(q.stem)}</textarea>
    <div class="gap"><label class="btn sec sm" style="cursor:pointer">📷 ${q.image_id ? 'Replace' : 'Add'} image<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden data-imgfor="${i}"></label>${q.image_id ? `<img src="/api/images/${q.image_id}" alt="Question image" style="height:48px;border-radius:6px"><button type="button" class="sec sm" data-act="rmimg" ${d}>Remove image</button>` : ''}</div>
    ${body}<div class="two"><div><label class="f">Topic</label><input type="text" ${d} data-f="topic" value="${esc(q.topic)}" placeholder="e.g. Algebra" maxlength="60"></div>
    <div><label class="f">Difficulty</label><select ${d} data-f="difficulty">${['easy', 'medium', 'hard'].map(x => `<option ${q.difficulty === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div></div>
    <label class="f">Explanation shown with results (optional)</label><textarea rows="2" ${d} data-f="explanation">${esc(q.explanation)}</textarea>
    <div class="pv" data-pv="${i}">${previewHtml(q)}</div>`;
}
const shrink = f => new Promise((ok, no) => { const r = new FileReader(); r.onerror = () => no(new Error('Could not read the file.')); r.onload = () => { const im = new Image(); im.onerror = () => no(new Error('That file is not a usable image.')); im.onload = () => { const s = Math.min(1, 1200 / Math.max(im.width, im.height)), c = document.createElement('canvas'); c.width = im.width * s; c.height = im.height * s; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height); ok(c.toDataURL('image/jpeg', .85)); }; im.src = r.result; }; r.readAsDataURL(f); });
function bindQ(root, qs, hooks = {}) {
  const upd = i => { const pv = $(`[data-pv="${i}"]`, root); if (pv) { pv.innerHTML = previewHtml(qs[i]); math(pv); } hooks.change?.(i); };
  const handle = (e, isChange) => {
    const t = e.target; if (t.dataset.i === undefined || !t.dataset.f) return; const i = +t.dataset.i, q = qs[i], f = t.dataset.f, v = t.type === 'checkbox' ? t.checked : t.value;
    switch (f) {
      case 'stem': case 'topic': case 'explanation': case 'section': case 'marks': case 'difficulty': q[f] = v; break;
      case 'type': if (!isChange) return; { const keep = {}; for (const k of ['stem', 'marks', 'topic', 'difficulty', 'explanation', 'image_id', 'section']) keep[k] = q[k]; for (const k of Object.keys(q)) delete q[k]; Object.assign(q, newQ(v), keep); hooks.rerender(); } return;
      case 'opt': q.options[+t.dataset.j].text = v; break;
      case 'correct': if (!isChange) return; if (q.settings.multi) { const s = new Set(q.key.correct); v ? s.add(t.dataset.id) : s.delete(t.dataset.id); q.key.correct = [...s]; } else q.key.correct = [t.dataset.id]; break;
      case 'multi': if (!isChange) return; q.settings.multi = v; if (!v) q.key.correct = q.key.correct.slice(0, 1); hooks.rerender(); return;
      case 'scoring': q.settings.scoring = v; break; case 'tf': if (!isChange) return; q.key.correct = t.value; break;
      case 'accepted': q.key.accepted = v.split('\n'); break; case 'cs': q.settings.caseSensitive = v; break; case 'review': q.settings.review = v; break;
      case 'nvalue': q.key.value = v; break; case 'tol': q.key.tol = v; break; case 'tolType': q.key.tolType = v; break; case 'decimals': q.key.decimals = v; break; case 'unit': q.settings.unit = v; break; case 'guide': q.key.guide = v; break;
    }
    upd(i);
  };
  root.addEventListener('input', e => handle(e, false)); root.addEventListener('change', async e => {
    const t = e.target; if (t.dataset.imgfor !== undefined) { const q = qs[+t.dataset.imgfor]; try { const u = await shrink(t.files[0]); q.image_id = (await post('/api/images', { data: u })).id; hooks.rerender(); hooks.change?.(); } catch (x) { toast(x.message, 'err'); } return; }
    handle(e, true); });
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return; const i = +b.dataset.i, act = b.dataset.act, q = qs[i];
    if (act === 'addopt' && q.options.length < 8) { const used = q.options.map(o => o.id); q.options.push({ id: [...'abcdefgh'].find(l => !used.includes(l)), text: '' }); hooks.rerender(); hooks.change?.(i); }
    else if (act === 'rmopt' && q.options.length > 2) { const [o] = q.options.splice(+b.dataset.j, 1); q.key.correct = q.key.correct.filter(x => x !== o.id); hooks.rerender(); hooks.change?.(i); }
    else if (act === 'rmimg') { q.image_id = null; hooks.rerender(); hooks.change?.(i); }
    else hooks.action?.(act, i, b);
  });
}
const qBody = q => ({ type: q.type, stem: q.stem, marks: q.marks, topic: q.topic, difficulty: q.difficulty, explanation: q.explanation, image_id: q.image_id, section: q.section, options: q.options, key: q.key, settings: q.settings, source_qid: q.source_qid, source_version: q.source_version });

/* ---- dashboard ---- */
R(/^\/t$/, async () => {
  loading(); const d = await get('/api/dashboard'), c = (n, l, href) => `<div class="card"><div class="stat">${n ?? '–'}</div><div>${l}</div>${href ? `<a href="${href}">Open</a>` : ''}</div>`;
  page(`<div class="row"><h1>Dashboard</h1><div class="gap"><a class="btn" href="#/t/exams/new">+ New exam</a><a class="btn sec" href="#/t/bank/new">+ New question</a></div></div>
    <div class="grid">${c(d.classes, 'Classes', '#/t/classes')}${c(d.students, 'Students')}${c(d.active, 'Exams open now', '#/t/exams')}${c(d.scheduled, 'Scheduled')}${c(d.draft, 'Drafts')}${c(d.in_progress, 'Students taking exams now')}${c(d.awaiting, 'Written answers awaiting marking')}${c(d.avg_pct == null ? null : d.avg_pct + '%', 'Average score (graded exams)')}</div>
    <div class="card"><h2>Upcoming and open exams</h2>${d.upcoming.map(e => `<div class="row"><a href="#/t/exam/${e.id}">${esc(e.title)}</a><span class="mu">${e.opens ? 'opens ' + fd(e.opens) : 'open'}${e.closes ? ' · closes ' + fd(e.closes) : ''}</span></div>`).join('') || '<p class="mu">Nothing scheduled.</p>'}</div>
    <div class="card"><h2>Recent results</h2><div class="tw"><table><tr><th>Exam</th><th>Submitted</th><th>Average</th><th>Awaiting marking</th></tr>${d.recent.map(e => `<tr><td><a href="#/t/exam/${e.id}/results">${esc(e.title)}</a></td><td>${e.submitted}</td><td>${e.avg_pct ?? '–'}%</td><td>${e.pending || 0}</td></tr>`).join('') || '<tr><td colspan="4" class="mu">No submissions yet.</td></tr>'}</table></div></div>`, { title: 'Dashboard' });
}, T_);

/* ---- exams list ---- */
R(/^\/t\/exams$/, async () => {
  loading(); const cl = await get('/api/classes'), f = { q: '', status: '', class_id: '', year: '', page: 1 }; page('<div id="x"></div>', { title: 'Exams' });
  const years = [...new Set(cl.items.map(c => c.academic_year).filter(Boolean))];
  $('#x').innerHTML = `<div class="row"><h1>Exams</h1><a class="btn" href="#/t/exams/new">+ New exam</a></div><div class="card"><div class="two">
    <div><label class="f" for="fq">Search title</label><input id="fq"></div><div><label class="f" for="fs">Status</label><select id="fs"><option value="">All</option>${['draft', 'scheduled', 'active', 'closed', 'awaiting_grading', 'graded', 'archived'].map(s => `<option value="${s}">${s.replace('_', ' ')}</option>`).join('')}</select></div>
    <div><label class="f" for="fc">Class</label><select id="fc"><option value="">All</option>${cl.items.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div><div><label class="f" for="fy">Academic year</label><select id="fy"><option value="">All</option>${years.map(y => `<option>${esc(y)}</option>`).join('')}</select></div></div></div><div id="lst"></div>`;
  const load = async () => { const qs = new URLSearchParams({ ...f, size: 15 }); for (const [k, v] of [...qs]) if (!v) qs.delete(k); const r = await get('/api/exams?' + qs); if (!$('#lst')) return;
    $('#lst').innerHTML = r.items.map(e => `<div class="card"><div class="row"><div><h2><a href="#/t/exam/${e.id}">${esc(e.title)}</a></h2><div class="mu">${esc(e.class_names || 'No class assigned')} · ${e.qcount} questions · ${num(e.total_marks)} marks · ${e.minutes} min</div>
      <div class="mu">${e.submitted} submitted${e.in_progress ? ` · ${e.in_progress} in progress` : ''}${e.pending ? ` · <b>${e.pending} awaiting marking</b>` : ''}</div></div><div class="gap">${badge(e.phase)}${e.graded ? badge('graded') : ''}</div></div></div>`).join('') + pager(r.total, r.page, r.size) || '';
    if (!r.items.length) $('#lst').innerHTML = '<div class="card mu">No exams match.</div>'; };
  const re = debounce(() => { f.q = $('#fq').value; f.status = $('#fs').value; f.class_id = $('#fc').value; f.year = $('#fy').value; f.page = 1; load(); }, 250);
  ['#fq', '#fs', '#fc', '#fy'].forEach(s => $(s).oninput = re); $('#lst').onclick = e => { const b = e.target.closest('[data-pg]'); if (b) { f.page = +b.dataset.pg; load(); } }; load();
}, T_);
R(/^\/t\/exams\/new$/, async () => { const r = await post('/api/exams', { title: '' }); location.replace('#/t/exam/' + r.id + '/edit'); }, T_);

/* ---- exam detail ---- */
R(/^\/t\/exam\/(\d+)$/, async id => {
  loading(); const [x, cl] = await Promise.all([get('/api/exams/' + id), get('/api/classes')]), e = x.exam, st = e.status, names = x.class_ids.map(c => cl.items.find(k => k.id === c)?.name).filter(Boolean);
  page(`<div class="row"><h1>${esc(e.title)}</h1><div class="gap">${badge(e.phase)}</div></div>
    <div class="card"><div class="two"><div><b>${e.minutes} min</b><div class="mu">Duration</div></div><div><b>${x.questions.length} · ${num(x.total_marks)} marks</b><div class="mu">Questions</div></div><div><b>${esc(names.join(', ') || 'None')}</b><div class="mu">Classes</div></div><div><b>${e.opens ? fd(e.opens) : 'Immediately'} → ${e.closes ? fd(e.closes) : 'No end'}</b><div class="mu">Available (latest start time)</div></div>
      <div><b>${e.max_attempts}</b><div class="mu">Attempts</div></div><div><b>${{ manual: 'Teacher releases', on_finalize: 'On finalize', immediate: 'Objective score immediately' }[e.release_mode]}</b><div class="mu">Result release</div></div></div>
      <div id="iss"></div><div class="gap" style="margin-top:14px">
      ${st === 'draft' ? `<a class="btn" href="#/t/exam/${id}/edit">Edit</a><button id="val" class="sec">Check before publishing</button><button id="pub">Publish…</button>` : ''}
      <a class="btn sec" href="#/t/exam/${id}/preview">Preview as student</a>${st !== 'draft' ? `<a class="btn" href="#/t/exam/${id}/results">Results &amp; grading</a>` : ''}
      ${st === 'published' ? '<button class="sec" id="cl">Close exam…</button>' : ''}${st === 'closed' ? '<button class="sec" id="ro">Reopen</button>' : ''}<button class="sec" id="du">Duplicate</button>
      ${st === 'draft' ? '<button class="dng" id="dl">Delete draft</button>' : ''}${st !== 'published' && st !== 'archived' ? '<button class="sec" id="ar">Archive…</button>' : ''}</div></div>
    ${e.instructions ? `<div class="card"><h2>Instructions</h2><div class="stem">${esc(e.instructions)}</div></div>` : ''}
    ${st === 'published' || st === 'closed' ? `<div class="card"><h2>Availability and release</h2><div class="alert info">A published exam's questions are locked so every student sees the same paper. You can still adjust these settings (each change is logged).</div><div class="two"><div><label class="f" for="so">Opens</label><input type="datetime-local" id="so" value="${toLocal(e.opens)}"></div><div><label class="f" for="sc">Closes (latest start)</label><input type="datetime-local" id="sc" value="${toLocal(e.closes)}"></div>
      <div><label class="f" for="sr">Result release</label><select id="sr">${[['manual', 'I release manually'], ['on_finalize', 'Automatically when finalized'], ['immediate', 'Objective score right after submission']].map(([v, l]) => `<option value="${v}" ${e.release_mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <label class="chk"><input type="checkbox" id="sa" ${e.show_answers ? 'checked' : ''}> Show correct answers and explanations after results are released <span class="mu">(only once the exam has closed for everyone, so finished students cannot pass the answers to classmates who have not taken it yet)</span></label><button id="ss">Save settings</button></div>` : ''}
    <div id="enr"></div>
    <div class="card"><h2>Questions</h2>${x.questions.map((q, i) => `<div style="margin:10px 0"><span class="qn">${i + 1}. ${TYPE_NAMES[q.type]} · ${num(q.marks)} marks${q.topic ? ' · ' + esc(q.topic) : ''}</span><div class="stem" style="font-size:1rem">${esc(q.stem)}</div></div>`).join('') || '<p class="mu">No questions yet.</p>'}</div>`, { title: e.title });
  enrollmentPanel(id, e);
  const act = (sel, fn) => { const b = $(sel); if (b) b.onclick = async () => { try { await fn(); } catch (er) { toast(er.message, 'err'); } }; };
  act('#val', async () => { const r = await post(`/api/exams/${id}/validate`); $('#iss').innerHTML = r.issues.length ? `<div class="alert err" role="alert"><b>Fix before publishing:</b><ul>${r.issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>` : `<div class="alert ok">Ready to publish. ${num(r.total_marks)} total marks.</div>`; });
  act('#pub', async () => { const r = await post(`/api/exams/${id}/validate`); if (r.issues.length) { $('#iss').innerHTML = `<div class="alert err" role="alert"><b>Fix before publishing:</b><ul>${r.issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>`; return; }
    if (await confirmDlg('Publish this exam?', `<p>It becomes visible to students in: <b>${esc(names.join(', '))}</b>.</p><p>After publishing, the questions are <b>locked</b> so every student gets the same paper. To change them you would duplicate the exam.</p>`, { ok: 'Publish', html: true })) { await post(`/api/exams/${id}/publish`); toast('Published'); route(); } });
  act('#cl', async () => { if (await confirmDlg('Close this exam?', 'Students can no longer start it. Attempts already in progress can finish.', { ok: 'Close exam', danger: true })) { await post(`/api/exams/${id}/close`); route(); } });
  act('#ro', async () => { await post(`/api/exams/${id}/reopen`); route(); });
  act('#du', async () => { const r = await post(`/api/exams/${id}/duplicate`); location.hash = `#/t/exam/${r.id}/edit`; });
  act('#dl', async () => { if (await confirmDlg('Delete this draft?', 'This cannot be undone.', { ok: 'Delete', danger: true })) { await del('/api/exams/' + id); location.hash = '#/t/exams'; } });
  act('#ar', async () => { if (await confirmDlg('Archive this exam?', 'It disappears from students\' dashboards. Records are kept.', { ok: 'Archive' })) { await post(`/api/exams/${id}/archive`); location.hash = '#/t/exams'; } });
  act('#ss', async () => { await patch(`/api/exams/${id}/settings`, { opens: fromLocal($('#so').value), closes: fromLocal($('#sc').value), release_mode: $('#sr').value, show_answers: $('#sa').checked }); toast('Settings saved'); route(); });
}, T_);

R(/^\/t\/exam\/(\d+)\/preview$/, async id => {
  loading(); const p = await get(`/api/exams/${id}/preview`);
  page(`<div class="alert info">Preview: this is what students see (no answer key is ever sent to students). Nothing you click here is saved.</div><h1>${esc(p.exam.title)}</h1>${p.exam.instructions ? `<div class="card"><div class="stem">${esc(p.exam.instructions)}</div></div>` : ''}
    ${p.questions.map((q, i) => `<div class="card"><div class="row"><span class="qn">${q.section ? esc(q.section) + ' · ' : ''}Question ${i + 1}</span><span class="mu">${num(q.marks)} marks</span></div><div class="stem">${esc(q.stem)}</div>${q.image_id ? `<img class="qimg" src="/api/images/${q.image_id}" alt="">` : ''}
    ${q.options.length ? q.options.map((o, j) => `<label class="opt"><input type="${q.multi ? 'checkbox' : 'radio'}" name="p${i}"><span>${q.type === 'mcq' ? '<b>' + LET[j] + '.</b> ' : ''}${esc(o.text)}</span></label>`).join('') : q.type === 'written' ? '<textarea rows="5" aria-label="Answer"></textarea>' : `<input type="text" style="max-width:260px" aria-label="Answer"> ${esc(q.unit)}`}</div>`).join('')}<a href="#/t/exam/${id}">← Back to exam</a>`, { title: 'Preview' });
}, T_);

/* ---- builder ---- */
R(/^\/t\/exam\/(\d+)\/edit$/, async id => {
  loading(); const [x, cl] = await Promise.all([get('/api/exams/' + id), get('/api/classes')]); if (x.exam.status !== 'draft') return (location.hash = '#/t/exam/' + id);
  const e = x.exam, d = { title: e.title, subject_id: e.subject_id || 1, instructions: e.instructions, minutes: e.minutes, max_attempts: e.max_attempts, opens: e.opens, closes: e.closes, shuffle_q: !!e.shuffle_q, shuffle_o: !!e.shuffle_o, release_mode: e.release_mode, show_answers: !!e.show_answers, declared_total: e.declared_total ?? '', pass_mark: e.pass_mark ?? '', academic_year: e.academic_year || '', term: e.term || '', grade: e.grade || '', grace_s: e.grace_s ?? 15, class_ids: x.class_ids };
  const qs = x.questions.map(normQ); let dirty = false;
  const total = () => Math.round(qs.reduce((t, q) => t + (Number(q.marks) || 0), 0) * 100) / 100;
  const mark = () => { dirty = true; $('#tot').textContent = total(); $('#ds').textContent = 'Unsaved changes'; };
  const mine = cl.items.filter(c => !c.archived);
  page(`<div class="row"><h1>Edit exam</h1><a href="#/t/exam/${id}">Cancel</a></div>
    <div class="card"><h2>Basics</h2><label class="f" for="m_title">Title</label><input id="m_title" data-m="title" value="${esc(d.title)}" maxlength="120">
    <label class="f" for="m_instructions">Instructions for students</label><textarea id="m_instructions" data-m="instructions" rows="4">${esc(d.instructions)}</textarea>
    <div class="two"><div><label class="f" for="m_subject_id">Subject</label><select id="m_subject_id" data-m="subject_id">${cl.subjects.map(s => `<option value="${s.id}" ${s.id == d.subject_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
    <div><label class="f" for="m_minutes">Duration (minutes)</label><input id="m_minutes" data-m="minutes" type="number" min="1" max="600" value="${d.minutes}"></div>
    <div><label class="f" for="m_max_attempts">Attempts allowed</label><input id="m_max_attempts" data-m="max_attempts" type="number" min="1" max="5" value="${d.max_attempts}"></div>
    <div><label class="f" for="m_declared_total">Expected total marks (optional check)</label><input id="m_declared_total" data-m="declared_total" type="number" min="0" step="any" value="${esc(d.declared_total)}"></div>
    <div><label class="f" for="m_opens">Opens</label><input id="m_opens" data-m="opens" type="datetime-local" value="${toLocal(d.opens)}"></div><div><label class="f" for="m_closes">Closes (latest start time)</label><input id="m_closes" data-m="closes" type="datetime-local" value="${toLocal(d.closes)}"></div>
    <div><label class="f" for="m_release_mode">Result release</label><select id="m_release_mode" data-m="release_mode">${[['manual', 'I release manually'], ['on_finalize', 'Automatically when finalized'], ['immediate', 'Objective score right after submission']].map(([v, l]) => `<option value="${v}" ${d.release_mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
    <p class="mu">Opens and closes use the school time zone: <b>${esc(schoolTz())}</b>.</p>
    <label class="chk"><input type="checkbox" data-m="shuffle_q" ${d.shuffle_q ? 'checked' : ''}> Shuffle question order (within each section)</label><label class="chk"><input type="checkbox" data-m="shuffle_o" ${d.shuffle_o ? 'checked' : ''}> Shuffle answer options</label>
    <label class="chk"><input type="checkbox" data-m="show_answers" ${d.show_answers ? 'checked' : ''}> Show correct answers and explanations after results are released <span class="mu">(only once the exam has closed for everyone, so finished students cannot pass the answers to classmates who have not taken it yet)</span></label></div>
    <div class="card"><h2>Assessment details</h2><div class="two">
      <div><label class="f" for="m_academic_year">Academic year</label><input id="m_academic_year" data-m="academic_year" maxlength="20" placeholder="e.g. 2026/27" value="${esc(d.academic_year)}"></div>
      <div><label class="f" for="m_term">Term</label><select id="m_term" data-m="term"><option value="">(none)</option>${[...new Set([...(state.settings?.terms || []), ...(d.term ? [d.term] : [])])].map(t => `<option ${t === d.term ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      <div><label class="f" for="m_grade">Grade level</label><input id="m_grade" data-m="grade" maxlength="20" placeholder="e.g. 9" value="${esc(d.grade)}"></div>
      <div><label class="f" for="m_pass_mark">Pass mark (%)</label><input id="m_pass_mark" data-m="pass_mark" type="number" min="0" max="100" step="0.5" placeholder="${esc(state.settings?.default_pass_mark ?? 50)} (school default)" value="${esc(d.pass_mark)}"></div>
      <div><label class="f" for="m_grace_s">Late grace after the timer ends (seconds)</label><input id="m_grace_s" data-m="grace_s" type="number" min="0" max="300" value="${esc(d.grace_s)}"><div class="mu">Answers that arrive within this time of the deadline are still accepted (slow connections). 0 means none.</div></div></div></div>
    <div class="card"><h2>Assign to classes</h2>${mine.map(c => `<label class="chk"><input type="checkbox" data-cls="${c.id}" ${d.class_ids.includes(c.id) ? 'checked' : ''}> ${esc(c.name)} <span class="mu">(${c.students} students)</span></label>`).join('') || '<p class="mu">You have no classes yet. <a href="#/t/classes">Create one</a> first.</p>'}</div>
    <div id="bar" class="card sticky"><div class="mu">Insert maths into the question or option you are editing, or type LaTeX between dollar signs, e.g. $x^2+1$.</div>${mathBar()}</div>
    <div id="qs"></div><div class="card"><div class="gap"><select id="nt" aria-label="New question type">${Object.entries(TYPE_NAMES).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select><button id="aq" class="sec">+ New question</button><button id="fb" class="sec">+ From question bank</button></div></div>
    <div class="card sticky" style="bottom:0;top:auto"><div class="row"><div><b>Total: <span id="tot">${total()}</span> marks</b> · <span class="mu" id="ds">Saved</span></div><div class="gap"><button id="sv" class="sec">Save draft</button><button id="ck">Save &amp; check</button></div></div><div id="iss"></div></div>`, { title: 'Edit exam' });
  const rq = () => { $('#qs').innerHTML = qs.map((q, i) => `<div class="card qcard" data-card="${i}"><div class="row"><span class="qn">Question ${i + 1}</span><div class="gap"><button class="sec sm" data-act="up" data-i="${i}" ${i ? '' : 'disabled'} aria-label="Move up">↑</button><button class="sec sm" data-act="dn" data-i="${i}" ${i < qs.length - 1 ? '' : 'disabled'} aria-label="Move down">↓</button><button class="sec sm" data-act="dup" data-i="${i}">Duplicate</button><button class="dng sm" data-act="rm" data-i="${i}" aria-label="Remove question ${i + 1}">Remove</button></div></div>${qEditor(q, i, { section: true })}</div>`).join('') || '<div class="card mu">No questions yet. Add one below.</div>'; math($('#qs')); };
  rq(); bindMathBar($('#main'), true);
  bindQ($('#qs'), qs, { rerender: rq, change: mark, action: (a, i) => { if (a === 'rm') qs.splice(i, 1); else if (a === 'up') [qs[i - 1], qs[i]] = [qs[i], qs[i - 1]]; else if (a === 'dn') [qs[i + 1], qs[i]] = [qs[i], qs[i + 1]]; else if (a === 'dup') { const c = normQ(qs[i]); delete c.source_qid; qs.splice(i + 1, 0, c); } rq(); mark(); } });
  $('#main').addEventListener('input', ev => { const t = ev.target, k = t.dataset.m; if (!k) return; d[k] = t.type === 'checkbox' ? t.checked : t.type === 'datetime-local' ? fromLocal(t.value) : t.value; mark(); });
  $('#main').addEventListener('change', ev => { const t = ev.target; if (t.dataset.cls) { const c = +t.dataset.cls; d.class_ids = t.checked ? [...new Set([...d.class_ids, c])] : d.class_ids.filter(x => x !== c); mark(); } });
  $('#aq').onclick = () => { qs.push(newQ($('#nt').value)); rq(); mark(); $$('[data-card]').pop().scrollIntoView(); };
  $('#fb').onclick = async () => {
    const dlg = modal(`<h2>Add from question bank</h2><input id="bq" placeholder="Search questions or topics" aria-label="Search question bank"><div id="bl" style="max-height:50vh;overflow:auto;margin:10px 0"></div><div class="row l"><button id="ba">Add selected</button><button class="sec" id="bc">Cancel</button></div>`, { wide: true }); let items = [];
    const load = async () => { const r = await get('/api/questions?size=50&q=' + encodeURIComponent($('#bq', dlg).value)); items = r.items; $('#bl', dlg).innerHTML = items.map((q, i) => `<label class="opt"><input type="checkbox" data-b="${i}"><span><span class="mu">${TYPE_NAMES[q.type]} · ${num(q.marks)} marks · ${esc(q.topic || 'no topic')} · ${q.difficulty}</span><br>${esc(q.stem.slice(0, 220))}</span></label>`).join('') || '<p class="mu">Nothing found.</p>'; math($('#bl', dlg)); };
    $('#bq', dlg).oninput = debounce(load, 250); $('#bc', dlg).onclick = () => dlg.close(); load();
    $('#ba', dlg).onclick = () => { $$('[data-b]:checked', dlg).forEach(c => { const q = normQ(items[+c.dataset.b]); q.source_qid = q.id; q.source_version = q.version; qs.push(q); }); dlg.close(); rq(); mark(); };
  };
  async function save() {
    const body = { ...d, declared_total: d.declared_total === '' ? null : d.declared_total, questions: qs.map(qBody) };
    await put('/api/exams/' + id, body); dirty = false; $('#ds').textContent = 'Saved'; }
  $('#sv').onclick = async () => { try { await save(); toast('Draft saved'); } catch (er) { toast(er.message, 'err'); } };
  $('#ck').onclick = async () => { try { await save(); const r = await post(`/api/exams/${id}/validate`); $('#iss').innerHTML = r.issues.length ? `<div class="alert err" role="alert"><b>Fix before publishing:</b><ul>${r.issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>` : `<div class="alert ok">Looks good. <a href="#/t/exam/${id}">Go to the exam page to publish</a>.</div>`; } catch (er) { toast(er.message, 'err'); } };
  const bu = ev => { if (dirty) { ev.preventDefault(); ev.returnValue = ''; } }; addEventListener('beforeunload', bu); cleanup = () => removeEventListener('beforeunload', bu);
}, T_);

/* ---- question bank ---- */
R(/^\/t\/bank$/, async () => {
  loading(); const f = { q: '', topic: '', difficulty: '', type: '', page: 1 }; page('<div id="x"></div>', { title: 'Question bank' });
  const load = async () => { const qs = new URLSearchParams({ ...f, size: 15 }); for (const [k, v] of [...qs]) if (!v) qs.delete(k); const r = await get('/api/questions?' + qs); if (!$('#x')) return;
    $('#x').innerHTML = `<div class="row"><h1>Question bank</h1><a class="btn" href="#/t/bank/new">+ New question</a></div><div class="card"><div class="two"><div><label class="f" for="bq">Search</label><input id="bq" value="${esc(f.q)}"></div>
      <div><label class="f" for="bt">Topic</label><select id="bt"><option value="">All</option>${r.topics.map(t => `<option ${t === f.topic ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      <div><label class="f" for="bd">Difficulty</label><select id="bd"><option value="">All</option>${['easy', 'medium', 'hard'].map(t => `<option ${t === f.difficulty ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div><label class="f" for="by">Type</label><select id="by"><option value="">All</option>${Object.entries(TYPE_NAMES).map(([k, n]) => `<option value="${k}" ${k === f.type ? 'selected' : ''}>${n}</option>`).join('')}</select></div></div></div>
      ${r.items.map(q => `<div class="card"><div class="row"><span class="mu">${TYPE_NAMES[q.type]} · ${num(q.marks)} marks · ${esc(q.topic || 'no topic')} · ${q.difficulty}</span><div class="gap"><a class="btn sec sm" href="#/t/bank/${q.id}">Edit</a><button class="sec sm" data-dup="${q.id}">Duplicate</button><button class="sec sm" data-arc="${q.id}">Archive</button></div></div><div class="stem" style="font-size:1rem">${esc(q.stem.slice(0, 300))}</div></div>`).join('') || '<div class="card mu">No questions found.</div>'}${pager(r.total, r.page, r.size)}`;
    math($('#x')); const q = $('#bq'); q.oninput = debounce(() => { f.q = q.value; f.page = 1; load().then(() => { const n = $('#bq'); n.focus(); n.setSelectionRange(99, 99); }); }, 300);
    for (const [s, k] of [['#bt', 'topic'], ['#bd', 'difficulty'], ['#by', 'type']]) $(s).onchange = e => { f[k] = e.target.value; f.page = 1; load(); }; };
  $('#x').onclick = async e => { const b = e.target.closest('button,[data-pg]'); if (!b) return; try {
    if (b.dataset.pg) { f.page = +b.dataset.pg; load(); } else if (b.dataset.dup) { await post(`/api/questions/${b.dataset.dup}/duplicate`); toast('Duplicated'); load(); }
    else if (b.dataset.arc && await confirmDlg('Archive this question?', 'It leaves the bank. Exams that already use it are not affected.', { ok: 'Archive' })) { await del('/api/questions/' + b.dataset.arc); load(); } } catch (er) { toast(er.message, 'err'); } };
  load();
}, T_);
R(/^\/t\/bank\/(new|\d+)$/, async which => {
  loading(); const isNew = which === 'new', cl = await get('/api/classes'); const q = isNew ? newQ() : normQ(await get('/api/questions/' + which)); const qs = [q];
  page(`<div class="row"><h1>${isNew ? 'New question' : 'Edit question'}</h1><a href="#/t/bank">← Bank</a></div>${isNew ? '' : '<div class="alert info">Editing this question does <b>not</b> change exams that already use it. They keep their own copy.</div>'}
    <div class="card sticky"><div class="mu">Type LaTeX between dollar signs, or use the buttons.</div>${mathBar()}</div><div class="card" id="ed"></div><div class="alert err" id="er" role="alert" hidden></div><button id="sv">Save question</button>`, { title: 'Question' });
  const rq = () => { $('#ed').innerHTML = qEditor(q, 0); math($('#ed')); }; rq(); bindMathBar($('#main'), true); bindQ($('#ed'), qs, { rerender: rq });
  $('#sv').onclick = async () => { try { const b = { ...qBody(q), subject_id: cl.subjects[0]?.id }; isNew ? await post('/api/questions', b) : await put('/api/questions/' + which, b); toast('Saved'); location.hash = '#/t/bank'; } catch (e) { $('#er').hidden = false; $('#er').textContent = e.message; } };
}, T_);

/* ---- results, analytics, grading ---- */
R(/^\/t\/exam\/(\d+)\/results$/, async id => {
  loading(); const f = { q: '', page: 1 }; let anHtml = '';
  page('<div id="x"></div>', { title: 'Results' });
  const load = async () => {
    const r = await get(`/api/exams/${id}/results?q=${encodeURIComponent(f.q)}&page=${f.page}&size=25`), s = r.summary; if (!$('#x')) return;
    $('#x').innerHTML = `<div class="row"><h1>${esc(r.exam.title)}</h1><a href="#/t/exam/${id}">← Exam</a></div>
    <div class="grid"><div class="card"><div class="stat">${s.submitted}<span class="mu"> / ${s.roster}</span></div>Submitted of enrolled</div><div class="card"><div class="stat">${s.in_progress}</div>In progress now</div><div class="card"><div class="stat">${s.pending}</div>Awaiting your marking</div><div class="card"><div class="stat">${s.finalized}</div>Finalized (${s.unreleased} not released)</div></div>
    <div class="card"><div class="gap"><button id="fin">Finalize results…</button><button id="rel" class="sec">Release finalized results…</button><button id="wh" class="sec">Withhold all</button><button class="sec" data-dl="/api/exams/${id}/export.csv">Export Results CSV</button><button id="acc" class="sec">Accommodation…</button></div>
      <p class="mu">Finalizing is only possible when every written or reviewed answer has a mark. Students see nothing until results are released.</p></div>
    <div class="card"><label class="f" for="sq">Search student</label><input id="sq" value="${esc(f.q)}" style="max-width:320px"><div class="tw"><table><tr><th>Student</th><th>#</th><th>Status</th><th>Marks</th><th>%</th><th>Grading</th><th>Tab events</th><th></th></tr>
    ${r.rows.map(a => `<tr><td>${esc(a.name)}<div class="mu">${esc(a.student_number || a.email)}</div></td><td>${a.attempt_no}</td><td>${badge(a.status)}${a.extra_s ? '<div class="mu">+' + Math.round(a.extra_s / 60) + ' min</div>' : ''}</td>
      <td class="n">${a.status === 'in_progress' ? '–' : num(a.score) + ' / ' + num(a.total)}</td><td>${a.percent != null ? a.percent + '%' + (a.result ? ' ' + badge(a.result) : '') : a.provisional_percent != null ? '<span class="mu">' + a.provisional_percent + '% provisional</span>' : '–'}</td><td>${a.status === 'in_progress' ? '' : badge(a.finalized_at ? (a.released_at ? 'released' : 'graded') : a.grading_status, a.finalized_at ? (a.released_at ? 'released' : 'finalized') : a.grading_status)}</td>
      <td title="Tab hidden / offline events. Context only, not proof of misconduct.">${a.events || 0}</td><td class="n"><a class="btn sec sm" href="#/t/attempt/${a.id}">${a.status === 'in_progress' ? 'View' : 'Mark / review'}</a> ${!a.finalized_at && a.status !== 'submitted' ? `<button class="sec sm" data-ex="${a.id}">Extend time</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="mu">No attempts yet.</td></tr>'}</table></div>${pager(r.total, r.page, r.size)}</div><div id="an">${anHtml || '<span class="spin"></span>'}</div>`;
    const sq = $('#sq'); sq.oninput = debounce(() => { f.q = sq.value; f.page = 1; load().then(() => { const n = $('#sq'); n.focus(); n.setSelectionRange(99, 99); }); }, 300);
  };
  const analytics = async () => { const a = await get(`/api/exams/${id}/analytics`); if (!$('#an')) return; const mx = Math.max(1, ...a.distribution);
    $('#an').innerHTML = anHtml = `<div class="card"><h2>Class performance</h2>${a.n ? `<div class="grid"><div><div class="stat">${a.mean_percent}%</div>Mean</div><div><div class="stat">${a.median_percent}%</div>Median</div><div><div class="stat">${a.highest}%</div>Highest</div><div><div class="stat">${a.lowest}%</div>Lowest</div></div>
      <div class="bars" role="img" aria-label="Score distribution">${a.distribution.map(n => `<div style="height:${n / mx * 100}%"><span>${n || ''}</span></div>`).join('')}</div><div class="axis">${a.distribution.map((_, i) => `<span>${i * 10}–${i === 9 ? 100 : i * 10 + 9}</span>`).join('')}</div>` : '<p class="mu">No fully-marked submissions yet.</p>'}
      <p class="mu">${esc(a.note)}${a.excluded_pending ? ` ${a.excluded_pending} submission(s) still awaiting marking are excluded.` : ''}</p></div>
      ${a.n ? `<div class="card"><h2>By question</h2><div class="tw"><table><tr><th>#</th><th>Type</th><th>Topic</th><th>Average</th><th>Success</th></tr>${a.questions.map(q => `<tr><td>${q.n}</td><td>${TYPE_NAMES[q.type]}</td><td>${esc(q.topic || '–')}</td><td>${num(q.avg_marks)} / ${num(q.marks)}</td><td><div class="meter" role="img" aria-label="${q.percent}%"><i style="width:${q.percent || 0}%"></i></div>${q.percent ?? '–'}%</td></tr>`).join('')}</table></div></div>
      <div class="card"><h2>By topic</h2><div class="tw"><table><tr><th>Topic</th><th>Questions</th><th>Average success</th></tr>${a.topics.map(t => `<tr><td>${esc(t.topic)}</td><td>${t.n_questions}</td><td>${t.percent}%</td></tr>`).join('')}</table></div></div>` : ''}`; };
  await load(); analytics().catch(() => { $('#an').textContent = ''; });
  $('#x').onclick = async e => { const b = e.target.closest('button,[data-pg]'); if (!b) return; try {
    if (b.dataset.pg) { f.page = +b.dataset.pg; return load(); }
    if (b.id === 'fin' && await confirmDlg('Finalize results?', 'All fully-marked submissions become official. Submissions with unmarked answers are skipped.', { ok: 'Finalize' })) { const r = await post(`/api/exams/${id}/finalize`, {}); toast(`${r.finalized} finalized${r.blocked.length ? `, ${r.blocked.length} blocked by unmarked answers` : ''}`); await load(); analytics(); }
    if (b.id === 'rel' && await confirmDlg('Release results to students?', 'Students will see their marks (and correct answers if enabled for this exam).', { ok: 'Release' })) { const r = await post(`/api/exams/${id}/release`, {}); toast(`${r.released} released`); load(); }
    if (b.id === 'wh' && await confirmDlg('Withhold all results?', 'Students will no longer see results until you release them again.', { ok: 'Withhold', danger: true })) { await post(`/api/exams/${id}/withhold`, {}); load(); }
    if (b.dataset.ex) await formDlg('Extend time', `<p class="mu">Use for approved accommodations or documented technical problems. If the attempt was auto-submitted, it is reopened.</p><label class="f">Minutes</label><input name="minutes" type="number" min="1" max="240" value="10" required><label class="f">Reason (recorded in the audit log)</label><textarea name="reason" required minlength="3"></textarea>`, v => post(`/api/attempts/${b.dataset.ex}/extend`, { minutes: v.minutes, reason: v.reason }), { ok: 'Extend' }) && (toast('Time extended'), load());
    if (b.id === 'acc') { const ro = await get(`/api/exams/${id}/roster`); await formDlg('Accommodation', `<label class="f">Student</label><select name="student_id">${ro.map(s => `<option value="${s.id}">${esc(s.name)} ${s.extra_minutes ? '(+' + s.extra_minutes + ' min)' : ''}</option>`).join('')}</select><label class="f">Extra minutes for this student</label><input name="extra_minutes" type="number" min="0" max="240" value="0"><label class="f">Extra attempts</label><input name="extra_attempts" type="number" min="0" max="3" value="0"><label class="f">Reason</label><input name="note" required minlength="3">`, v => post(`/api/exams/${id}/accommodations`, v)) && toast('Accommodation saved'); }
  } catch (er) { toast(er.message, 'err'); } };
}, T_);

R(/^\/t\/attempt\/(\d+)$/, async id => {
  loading(); const v = await get('/api/attempts/' + id), a = v.attempt, L = x => [].concat(x ?? []);
  const show = (q, ans) => q.type === 'mcq' || q.type === 'tf' ? (q.options.filter(o => L(ans).includes(o.id)).map(o => o.text).join('; ') || '—') : (ans || '—');
  const keyTxt = q => q.type === 'mcq' || q.type === 'tf' ? q.options.filter(o => L(q.key.correct).includes(o.id)).map(o => o.text).join('; ') : q.type === 'short' ? q.key.accepted.join(' / ') : q.type === 'numeric' ? `${q.key.value} (±${q.key.tol}${q.key.tolType === 'rel' ? '%' : ''}${q.key.decimals != null ? ', rounded to ' + q.key.decimals + ' dp' : ''})${q.settings.unit ? ' ' + q.settings.unit : ''}` : (q.key.guide || '(no guide)');
  page(`<div class="row"><h1>${esc(v.student.name)}</h1><a href="#/t/exam/${a.exam_id}/results">← Results</a></div>
    <div class="card"><div class="row"><div>${esc(v.exam.title)} · attempt ${a.attempt_no} · ${badge(a.status)} ${a.finalized_at ? badge('graded', 'finalized') : ''}${a.released_at ? badge('released') : ''}<div class="mu">Started ${fd(a.started)}${a.submitted_at ? ' · submitted ' + fd(a.submitted_at) : ''}${a.receipt ? ' · receipt ' + esc(a.receipt) : ''}</div></div><div class="stat" id="sc">${a.status === 'in_progress' ? '–' : num(a.score) + ' / ' + num(a.total)}</div></div>
    ${v.events.length ? `<div class="alert info">Context only (not proof of misconduct): ${v.events.map(e => `${e.kind.replace('_', ' ')} ×${e.n}`).join(', ')}.</div>` : ''}</div>
    ${v.items.map(it => { const q = it.q, g = it.grade; return `<div class="card qcard"><div class="row"><span class="qn">Q${it.n} · ${TYPE_NAMES[q.type]} · ${num(q.marks)} marks</span>${g ? badge(g.status === 'pending' ? 'pending' : g.status === 'graded' ? 'graded' : 'submitted', g.status === 'auto' ? 'auto-marked' : g.status) : ''}</div>
      <div class="stem">${esc(q.stem)}</div>${q.image_id ? `<img class="qimg" src="/api/images/${q.image_id}" alt="">` : ''}<div><span class="mu">Student answer:</span><div class="pv">${esc(show(q, it.answer))}</div></div><div class="mu" style="margin-top:6px">Expected: ${esc(keyTxt(q))}</div>
      ${g ? `<div class="two" style="align-items:end"><div><label class="f">Marks (0–${num(q.marks)})</label><input type="number" step="0.25" min="0" max="${q.marks}" data-mk="${q.id}" value="${g.status === 'pending' ? '' : g.marks}" placeholder="${g.status === 'pending' ? 'Needs marking' : ''}"></div><div><label class="f">Feedback to student</label><input data-fb="${q.id}" value="${esc(g.feedback)}" maxlength="3000"></div>
      ${g.status !== 'pending' ? `<div><label class="f">Reason for changing (required if different)</label><input data-rs="${q.id}" maxlength="500"></div>` : ''}<div><button data-save="${q.id}">Save mark</button></div></div>` : '<p class="mu">Not marked yet (attempt in progress).</p>'}
      ${it.history.length ? `<details><summary class="mu">Mark history (${it.history.length})</summary>${it.history.map(h => `<div class="mu">${fd(h.at)} · ${esc(h.by_name)}: ${h.old_marks == null ? '–' : h.old_marks} → <b>${h.new_marks}</b>${h.reason ? ' · ' + esc(h.reason) : ''}</div>`).join('')}</details>` : ''}</div>`; }).join('')}
    ${a.status !== 'in_progress' && !a.finalized_at ? `<button id="fin">Finalize this student's result</button>` : ''}`, { title: 'Mark attempt' });
  $('#main').onclick = async e => { const b = e.target.closest('button'); if (!b) return; try {
    if (b.dataset.save) { const q = b.dataset.save, mk = $(`[data-mk="${q}"]`).value; if (mk === '') return toast('Enter a mark first', 'err'); const r = await put(`/api/attempts/${id}/grade`, { eq_id: +q, marks: mk, feedback: $(`[data-fb="${q}"]`).value, reason: $(`[data-rs="${q}"]`)?.value || '' }); $('#sc').textContent = `${num(r.attempt.score)} / ${num(r.attempt.total)}`; toast('Mark saved'); }
    if (b.id === 'fin') { const r = await post(`/api/exams/${a.exam_id}/finalize`, { attempt_id: id * 1 }); if (r.blocked.length) toast(`${r.blocked[0].pending} answer(s) still need a mark`, 'err'); else { toast('Finalized'); route(); } }
  } catch (er) { toast(er.message, 'err'); } };
}, T_);

/* ---- classes (teacher + admin) ---- */
const CL = ['teacher', 'admin'];
async function classesView() {
  loading(); const d = await get('/api/classes'), base = state.user.role === 'admin' ? '#/a/classes' : '#/t/classes';
  page(`<div class="row"><h1>Classes</h1><button class="sec" data-dl="/api/classes/export.csv">Export classes CSV</button></div><div class="card"><h2>New class</h2><form id="f" class="two"><div><label class="f" for="cn">Name</label><input id="cn" required maxlength="80" placeholder="e.g. Grade 10A"></div><div><label class="f" for="cg">Grade</label><input id="cg" maxlength="20"></div><div><label class="f" for="cy">Academic year</label><input id="cy" maxlength="20" placeholder="2026/27"></div>
    <div><label class="f" for="cs">Subject</label><select id="cs">${d.subjects.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div><div style="align-self:end"><button>Create class</button></div></form></div>
    ${d.items.map(c => `<div class="card"><div class="row"><div><h2><a href="${base}/${c.id}">${esc(c.name)}</a></h2><div class="mu">${esc([c.grade && 'Grade ' + c.grade, c.academic_year, c.subject_name].filter(Boolean).join(' · '))} · ${c.students} students</div></div>${c.archived ? badge('archived') : ''}</div></div>`).join('') || '<div class="card mu">No classes yet.</div>'}`, { title: 'Classes' });
  $('#f').onsubmit = async e => { e.preventDefault(); try { await post('/api/classes', { name: $('#cn').value, grade: $('#cg').value, academic_year: $('#cy').value, subject_id: $('#cs').value }); toast('Class created'); classesView(); } catch (x) { toast(x.message, 'err'); } };
}
async function classView(id) {
  loading(); const d = await get('/api/classes/' + id), c = d.class, back = state.user.role === 'admin' ? '#/a/classes' : '#/t/classes', admin = state.user.role === 'admin';
  page(`<div class="row"><h1>${esc(c.name)}</h1><a href="${back}">← Classes</a></div>
    <div class="card"><h2>Add students</h2><p class="mu">One per line: <b>Full name, email, student number (optional)</b>. New accounts get a temporary password that the student must change at first sign-in. There is no public sign-up.</p><textarea id="im" rows="5" placeholder="Abebe Kebede, abebe@school.org, S1001"></textarea><button id="imb" style="margin-top:8px">Create / add students</button><div id="imr"></div></div>
    <div class="card"><h2>Class CSV</h2><p class="mu">Export this class list, or add students from a CSV file (columns <code>student_number, full_name, email</code>). Existing students are never duplicated; new accounts get a temporary password.</p><div class="gap"><button class="sec" data-dl="/api/classes/${id}/members.csv">Export class roster CSV</button><button class="sec" data-dl="/api/classes/members-template.csv">Download CSV template</button><button id="cimp">Import students from CSV…</button></div></div>
    ${admin ? `<div class="card"><h2>Add a teacher or existing account</h2><div class="gap"><input id="ae" type="email" placeholder="email" style="max-width:300px"><button id="ab" class="sec">Add to class</button></div></div>` : ''}
    <div class="card"><h2>Members (${d.members.length})</h2><div class="tw"><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr>${d.members.map(m => `<tr><td>${esc(m.name)}<div class="mu">${esc(m.student_number || '')}</div></td><td>${esc(m.email)}</td><td>${m.role}</td><td>${badge(m.status === 'active' ? 'active' : 'closed', m.status)}</td><td class="n">${m.role === 'student' ? `<button class="sec sm" data-rp="${m.id}">Reset password</button> ` : ''}<button class="sec sm" data-rm="${m.id}">Remove</button></td></tr>`).join('')}</table></div></div>
    <div class="gap"><button class="sec" id="arch">${c.archived ? 'Unarchive' : 'Archive'} class</button></div>`, { title: c.name });
  const creds = rows => `<div class="alert warn"><b>Write these down or print them now. Temporary passwords are shown only once.</b></div><div class="tw"><table><tr><th>Name</th><th>Email</th><th>Result</th><th>Temporary password</th></tr>${rows.map(r => `<tr><td>${esc(r.name || '')}</td><td>${esc(r.email || r.line)}</td><td>${esc(r.status)}${r.error ? ': ' + esc(r.error) : ''}</td><td>${r.temp_password ? `<span class="pw">${esc(r.temp_password)}</span>` : ''}</td></tr>`).join('')}</table></div><button class="sec sm" data-print>Print</button>`;
  $('#cimp').onclick = () => importDialog({ title: `Import students into ${c.name}`, previewUrl: `/api/classes/${id}/import-csv/preview`, commitUrl: `/api/classes/${id}/import-csv/commit`, help: STUDENT_IMPORT_HELP.replace(/<code>student_number.*?<\/code>/, '<code>student_number, full_name, email</code> (class columns are optional and must match this class)'),
    templates: [{ label: 'Download blank template', url: '/api/classes/members-template.csv' }], onDone: () => classView(id) });
  $('#imb').onclick = async () => { try { const r = await post(`/api/classes/${id}/import`, { text: $('#im').value }); $('#imr').innerHTML = creds(r.results); $('#im').value = ''; } catch (e) { toast(e.message, 'err'); } };
  if (admin) $('#ab').onclick = async () => { try { await post(`/api/classes/${id}/members`, { email: $('#ae').value }); classView(id); } catch (e) { toast(e.message, 'err'); } };
  $('#arch').onclick = async () => { await patch('/api/classes/' + id, { archived: !c.archived }); classView(id); };
  $('#main').addEventListener('click', async e => { const b = e.target.closest('button'); if (!b) return; try {
    if (b.dataset.rp && await confirmDlg('Reset password?', 'A new temporary password will be generated and the student signed out everywhere.', { ok: 'Reset' })) { const r = await post(`/api/classes/${id}/members/${b.dataset.rp}/reset-password`); modal(`<h2>New temporary password</h2><p class="pw">${esc(r.temp_password)}</p><p class="mu">Shown once. The student must change it at next sign-in.</p><form method="dialog"><button>Close</button></form>`); }
    if (b.dataset.rm && await confirmDlg('Remove from class?', 'The account stays; the student loses access to this class\'s exams.', { ok: 'Remove', danger: true })) { await del(`/api/classes/${id}/members/${b.dataset.rm}`); classView(id); } } catch (er) { toast(er.message, 'err'); } });
}
R(/^\/t\/classes$/, classesView, CL); R(/^\/a\/classes$/, classesView, CL); R(/^\/t\/class\/?(\d+)?$/, () => (location.hash = '#/t/classes'), CL);
R(/^\/t\/classes\/(\d+)$/, classView, CL); R(/^\/a\/classes\/(\d+)$/, classView, CL);
