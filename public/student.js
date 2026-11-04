/* Student: dashboard, instructions, exam player, results */
const S_ = ['student'];
// Unsent answers are buffered in this browser (eagle.pend.<attempt>) so a dropped connection never loses typing. They hold only the student's own typed
// answers (never questions or answer keys), are deleted once the server confirms the exam is submitted, and anything untouched for a week is deleted at start-up.
const PEND = 'eagle.pend.', PEND_T = 'eagle.pt.';
const dropPending = id => { try { localStorage.removeItem(PEND + id); localStorage.removeItem(PEND_T + id); } catch {} };
(function purgeOldPending() { try { const now = Date.now(); for (const k of Object.keys(localStorage)) if (k.startsWith(PEND_T) && now - Number(localStorage.getItem(k)) > 7 * 864e5) dropPending(k.slice(PEND_T.length)); } catch {} })();
const phaseLabel = { scheduled: 'Not open yet', active: 'Open', closed: 'Closed' };

R(/^\/s$/, async () => {
  loading(); const d = await get('/api/student/exams');
  const card = e => {
    let act = '';
    if (e.in_progress_attempt) act = `<a class="btn" href="#/s/attempt/${e.in_progress_attempt}">Resume exam</a>`;
    else if (e.phase === 'active' && e.attempts_used < e.max_attempts) act = `<a class="btn" href="#/s/exam/${e.id}">${e.attempts_used ? 'Start another attempt' : 'View instructions'}</a>`;
    const r = e.result, res = r && (r.state === 'released' ? `<div class="alert ok">Result: <b>${num(r.score)} / ${num(r.total)}</b>${r.percent != null ? ` (${r.percent}%)` : ''}${passText(r)} <a href="#/s/result/${e.last_attempt_id}">Details</a></div>`
      : r.state === 'provisional' ? `<div class="alert warn">Provisional (objective questions only): <b>${num(r.score)} / ${num(r.total)}</b>. ${esc(r.note)}</div>` : r.state === 'awaiting' ? '<div class="alert info">Submitted. Your result has not been released yet.</div>' : '');
    return `<div class="card"><div class="row"><h2>${esc(e.title)}</h2>${badge(e.in_progress_attempt ? 'in_progress' : e.phase, e.in_progress_attempt ? 'In progress' : phaseLabel[e.phase])}</div>
      <div class="mu">${esc(e.subject || '')} · ${e.minutes} min · ${num(e.total_marks)} marks · attempts ${e.attempts_used}/${e.max_attempts}<br>${e.opens ? 'Opens ' + fd(e.opens) : 'Open now'}${e.closes ? ' · Closes ' + fd(e.closes) : ''}</div>${res || ''}<div style="margin-top:10px">${act}</div></div>`;
  };
  page(`<h1>My exams</h1><p class="mu">${d.classes.length ? 'Classes: ' + d.classes.map(c => esc(c.name)).join(', ') : 'You are not in any class yet. Ask your teacher.'}</p>
    ${d.items.map(card).join('') || '<div class="card mu">No exams have been assigned to you yet.</div>'}`, { title: 'My exams' });
}, S_);

R(/^\/s\/exam\/(\d+)$/, async id => {
  loading(); const e = await get('/api/student/exams/' + id);
  const rel = { manual: 'Your teacher will release results after marking.', on_finalize: 'Results are released automatically once marking is complete.', immediate: 'Your score for objective questions appears right after you submit; the rest follows after marking.' }[e.release_mode];
  page(`<h1>${esc(e.title)}</h1><div class="card"><div class="two"><div><b>${e.minutes} minutes</b><div class="mu">Duration</div></div><div><b>${num(e.total_marks)}</b><div class="mu">Total marks (${e.questions} questions)</div></div><div><b>${e.max_attempts}</b><div class="mu">Attempts allowed (${e.attempts_used} used)</div></div></div>
    ${e.instructions ? `<h2 style="margin-top:14px">Instructions</h2><div class="stem" id="ins">${esc(e.instructions)}</div>` : ''}
    <h2>Before you begin</h2><ul>
    <li>The timer starts the moment you press <b>Start exam</b> and is kept by the server. Refreshing or closing the page does not pause it.</li>
    <li>Your answers are saved automatically. Watch the save indicator at the top of the screen.</li>
    <li>Submitting is final for that attempt. When time ends, your last saved answers are submitted automatically.</li>
    <li>${esc(rel)}</li>
    <li>If you lose your connection, keep the page open. Answers are kept on this device and sent when you reconnect. If a technical problem prevents you finishing, tell your teacher right away; they can review and extend time.</li>
    <li><b>Monitoring notice:</b> the portal records only when this browser tab is hidden or goes offline during the exam. Your teacher sees these as context, never as proof of misconduct. No camera, microphone or screen recording is used.</li></ul>
    <div class="row l"><button id="go" ${e.phase !== 'active' || e.attempts_used >= e.max_attempts ? 'disabled' : ''}>Start exam</button><a href="#/s">← Back</a></div><div class="alert err" id="er" role="alert" hidden></div></div>`, { title: e.title, narrow: true });
  $('#go').onclick = async ev => { ev.target.disabled = true; try { const d = await post(`/api/student/exams/${id}/start`); location.hash = '#/s/attempt/' + d.attempt.id; } catch (x) { $('#er').hidden = false; $('#er').textContent = x.message; ev.target.disabled = false; } };
}, S_);

R(/^\/s\/attempt\/(\d+)$/, async id => {
  loading(); let d;
  try { d = await get('/api/student/attempts/' + id); } catch (e) { if (e.data?.finalized) { dropPending(id); toast(e.message); return (location.hash = '#/s/result/' + id); } throw e; }
  player(id, d);
}, S_);

function player(id, d) {
  const qs = d.questions, ans = {}, LK = PEND + id;
  qs.forEach(q => ans[q.id] = d.answers[q.id] ? { ...d.answers[q.id] } : { value: null, seq: 0, flagged: false });
  let pend = {}; try { pend = JSON.parse(localStorage.getItem(LK) || '{}'); } catch {}
  for (const [k, v] of Object.entries(pend)) { if (ans[k] && v.seq > ans[k].seq) ans[k] = { ...v }; else delete pend[k]; } // keep only buffered changes newer than the server's copy
  let off = d.attempt.serverNow - Date.now(), deadline = d.attempt.deadline, cur = 0, view = 'q', inflight = false, fails = 0, failKind = '', savedAt = 0, autoWait = 0, ft, closed = false, said = {};
  const persist = () => { try { localStorage.setItem(LK, JSON.stringify(pend)); localStorage.setItem(PEND_T + id, String(Date.now())); } catch {} };
  const answered = q => { const v = ans[q.id].value; return v != null && v !== '' && !(Array.isArray(v) && !v.length); };

  render(`<div class="xbar"><b id="xt"></b><div class="gap"><span class="save" id="sv" aria-live="polite"></span><span class="timer" id="tm" role="timer" aria-label="Time remaining"></span></div><div class="pg" aria-hidden="true"><i id="pgb"></i></div></div>
    <div id="off" class="alert warn" role="alert" hidden style="max-width:1100px;margin:10px auto">You appear to be offline. Keep this page open: answers are stored on this device and will be sent when you reconnect. They are <b>not</b> safely stored on the server until the indicator says saved.</div>
    <div class="xwrap"><main id="main"><div id="pane"></div></main><aside class="xside"><div class="card"><h2>Questions</h2><div class="nav" id="nav"></div><p class="mu">Blue = answered · amber underline = flagged</p>
    <button class="sec" id="rv" style="width:100%">Review &amp; submit</button></div></aside></div>`, { title: d.exam.title });
  $('#xt').textContent = d.exam.title;

  const setSave = (t, cls = '') => { const s = $('#sv'); if (s) { s.textContent = t; s.className = 'save ' + cls; } };
  const refreshNav = () => { $('#nav').innerHTML = qs.map((q, i) => `<button type="button" data-n="${i}" class="${answered(q) ? 'done' : ''} ${ans[q.id].flagged ? 'flag' : ''}" ${i === cur && view === 'q' ? 'aria-current="true"' : ''} aria-label="Question ${i + 1}, ${answered(q) ? 'answered' : 'not answered'}${ans[q.id].flagged ? ', flagged for review' : ''}">${i + 1}</button>`).join('');
    $('#pgb').style.width = qs.filter(answered).length / qs.length * 100 + '%'; };
  // The save indicator only says "saved" when the server confirmed every change. Each way of failing says what is actually wrong.
  const FAIL = { offline: 'Not saved: no connection. Kept on this device. Retrying…', server: 'Not saved: server problem. Kept on this device. Retrying…', busy: 'Not saved: server busy. Kept on this device. Retrying…', other: 'Not saved yet. Kept on this device. Retrying…' };
  const at = ms => { try { return new Intl.DateTimeFormat(undefined, { timeStyle: 'short', timeZone: schoolTz() }).format(ms); } catch { return ''; } };
  const status = () => { if (!Object.keys(pend).length) setSave(inflight ? 'Saving…' : 'All answers saved' + (savedAt ? ' · ' + at(savedAt) : ''), 'ok'); else if (fails) setSave(FAIL[failKind] || FAIL.other, 'bad'); else setSave('Saving…'); };
  // Another tab or window saved a newer answer for the same question first: show the server's copy instead of pretending ours was saved.
  function adoptStale(list) {
    const moved = []; let curChanged = false;
    for (const x of list) {
      const q = qs.find(z => z.id === x.qid), a = q && ans[q.id]; if (!a) continue;
      if (pend[q.id] && pend[q.id].seq > x.seq) continue; // a newer change made here is still queued and will be sent next
      a.value = x.value; a.seq = x.seq; a.flagged = x.flagged; delete pend[q.id]; moved.push(qs.indexOf(q) + 1); if (qs[cur] === q && view === 'q') curChanged = true;
    }
    if (!moved.length) return;
    toast(`Question ${moved.join(', ')} ${moved.length > 1 ? 'were' : 'was'} changed in another tab or window. The newer saved answer was kept here.`, 'err'); announce('An answer was changed in another tab. The newer saved answer was kept.');
    refreshNav(); if (curChanged) showQ();
  }

  async function flush() {
    if (inflight || closed) return; const items = Object.entries(pend).map(([qid, v]) => ({ qid: +qid, value: v.value, seq: v.seq, flagged: v.flagged })); if (!items.length) return status();
    inflight = true; status();
    try {
      const r = await put(`/api/student/attempts/${id}/answers`, { items });
      for (const s of r.saved) if (pend[s.qid] && pend[s.qid].seq === s.seq) delete pend[s.qid];
      for (const x of r.rejected) delete pend[x.qid]; if (r.rejected.length) toast('Some answers were rejected by the server. Please re-enter them.', 'err');
      adoptStale(r.stale || []);
      off = r.serverNow - Date.now(); deadline = r.deadline; fails = 0; failKind = ''; savedAt = r.serverNow; persist();
    } catch (e) {
      if (e.data?.finalized) { closed = true; dropPending(id); toast(e.message); return (location.hash = '#/s/result/' + id); }
      fails++; failKind = e.network ? 'offline' : e.status === 429 ? 'busy' : e.status >= 500 ? 'server' : 'other'; clearTimeout(ft); ft = setTimeout(flush, Math.min(15000, 1000 * 2 ** fails));
    }
    inflight = false; status(); if (Object.keys(pend).length && !fails) setTimeout(flush, 300);
  }
  const queue = debounce(flush, 700);
  function change(q, value, flagged) {
    const a = ans[q.id]; a.value = value ?? a.value; if (value !== undefined) a.value = value; if (flagged !== undefined) a.flagged = flagged; a.seq++;
    pend[q.id] = { value: a.value, seq: a.seq, flagged: a.flagged }; persist(); setSave('Saving…'); refreshNav(); queue();
  }

  function showQ() {
    view = 'q'; const q = qs[cur], a = ans[q.id], L = i => String.fromCharCode(65 + i); let ctl = '';
    if (q.type === 'mcq' || q.type === 'tf') {
      const t = q.multi ? 'checkbox' : 'radio', sel = new Set([].concat(a.value ?? []));
      ctl = `<fieldset><legend class="vh">Answer options for question ${cur + 1} of ${qs.length}</legend>${q.options.map((o, i) => `<label class="opt"><input type="${t}" name="a" value="${esc(o.id)}" ${sel.has(o.id) ? 'checked' : ''}><span>${q.type === 'mcq' ? `<b>${L(i)}.</b> ` : ''}${esc(o.text)}</span></label>`).join('')}</fieldset>${q.multi ? '<div class="mu">Select all that apply.</div>' : ''}`;
    } else if (q.type === 'short') ctl = `<label class="f" for="ai">Your answer</label><input id="ai" type="text" maxlength="500" autocomplete="off" value="${esc(a.value || '')}">`;
    else if (q.type === 'numeric') ctl = `<label class="f" for="ai">Your answer (a number${q.unit ? ', in ' + esc(q.unit) : ''})</label><div class="gap"><input id="ai" type="text" inputmode="decimal" maxlength="40" autocomplete="off" style="max-width:260px" value="${esc(a.value || '')}">${q.unit ? `<b>${esc(q.unit)}</b>` : ''}</div>`;
    else ctl = `<label class="f" for="ai">Your working and answer</label>${mathBar()}<textarea id="ai" rows="10" maxlength="20000">${esc(a.value || '')}</textarea><div class="mu">Tip: write maths between dollar signs, e.g. $x^2+1$.</div><div class="pv" id="pv" aria-label="Preview of your answer"></div>`;
    $('#pane').innerHTML = `<div class="card"><div class="row"><span class="qn">${q.section ? esc(q.section) + ' · ' : ''}Question ${cur + 1} of ${qs.length}</span><span class="mu">${num(q.marks)} mark${q.marks === 1 ? '' : 's'}</span></div>
      <div class="stem">${esc(q.stem)}</div>${q.image_id ? `<img class="qimg" src="/api/images/${q.image_id}" alt="Diagram for question ${cur + 1}">` : ''}${ctl}
      <div class="row" style="margin-top:14px"><div class="gap"><button class="sec" id="pv_" ${cur === 0 ? 'disabled' : ''}>← Previous</button><button class="sec" id="nx" ${cur === qs.length - 1 ? 'disabled' : ''}>Next →</button></div>
      <label class="chk"><input type="checkbox" id="fl" ${a.flagged ? 'checked' : ''}> Flag for review</label></div></div>`;
    math($('#pane')); refreshNav(); announce(`Question ${cur + 1} of ${qs.length}`);
    $('#pv_').onclick = () => { cur--; showQ(); }; $('#nx').onclick = () => { cur++; showQ(); }; $('#fl').onchange = e => change(q, undefined, e.target.checked);
    if (q.type === 'mcq' || q.type === 'tf') $$('input[name=a]').forEach(i => i.onchange = () => change(q, q.multi ? $$('input[name=a]:checked').map(x => x.value) : i.value));
    else { const inp = $('#ai'), pv = $('#pv'), up = debounce(() => { pv.textContent = inp.value || '…'; math(pv); }, 250);
      inp.oninput = () => { change(q, inp.value); if (pv) up(); }; inp.onblur = flush; if (pv) { pv.textContent = inp.value || '…'; math(pv); bindMathBar($('#pane')); } }
  }
  function showReview() {
    view = 'r'; const un = qs.filter(q => !answered(q)).length, fl = qs.filter(q => ans[q.id].flagged).length;
    $('#pane').innerHTML = `<div class="card"><h1>Review your answers</h1><p>${un ? `<b>${un}</b> question${un > 1 ? 's are' : ' is'} unanswered.` : 'All questions are answered.'}${fl ? ` <b>${fl}</b> flagged for review.` : ''}</p>
      <div class="tw"><table><tr><th>#</th><th>Status</th><th></th></tr>${qs.map((q, i) => `<tr><td>${i + 1}</td><td>${answered(q) ? 'Answered' : '<b>Not answered</b>'}${ans[q.id].flagged ? ' · flagged' : ''}</td><td><button class="sec sm" data-g="${i}">Go to question</button></td></tr>`).join('')}</table></div>
      <div class="alert warn">Submitting is final for this attempt. You cannot change answers afterwards.</div><div class="row l"><button id="sub">Submit exam</button><button class="sec" id="bk">Keep working</button></div><div class="alert err" id="er" role="alert" hidden></div></div>`;
    refreshNav(); $$('[data-g]').forEach(b => b.onclick = () => { cur = +b.dataset.g; showQ(); }); $('#bk').onclick = showQ;
    $('#sub').onclick = async () => { if (await confirmDlg('Submit your exam?', un ? `You still have ${un} unanswered question${un > 1 ? 's' : ''}. This cannot be undone.` : 'This cannot be undone.', { ok: 'Yes, submit', danger: true })) submit(false); };
  }
  $('#nav').onclick = e => { const b = e.target.closest('[data-n]'); if (b) { cur = +b.dataset.n; showQ(); } };
  $('#rv').onclick = showReview;

  let submitting = false;
  async function submit(auto) {
    if (submitting || closed) return; submitting = true; clearTimeout(ft);
    if (auto) { $('#pane').innerHTML = '<div class="card"><h1>Time is up</h1><p><span class="spin"></span> Submitting your answers…</p><div class="alert err" id="er" role="alert" hidden></div></div>'; announce('Time is up. Submitting your answers.'); }
    for (let n = 0; ; n++) {
      try {
        const items = Object.entries(ans).filter(([k]) => pend[k]).map(([qid, v]) => ({ qid: +qid, value: v.value, seq: v.seq, flagged: v.flagged }));
        const r = await post(`/api/student/attempts/${id}/submit`, { items }); closed = true; dropPending(id);
        return render(`<main id="main" class="narrow"><h1>Submission received ✓</h1><div class="card"><div class="alert ok" role="status">The server has accepted your submission${r.late || r.status === 'auto_submitted' ? ' (submitted automatically when time ended)' : ''}.</div>
          <p>Receipt code: <span class="pw">${esc(r.receipt)}</span><br><span class="mu">Received ${fd(r.submitted_at)}. Keep this code if you need to discuss your submission.</span></p><a class="btn" href="#/s">Back to my exams</a></div></main>`, { title: 'Submitted' });
      } catch (e) {
        if (e.status && e.status < 500 && e.status !== 429) { submitting = false; autoWait = Date.now() + 5000; const er = $('#er'), m = e.message + (auto ? ' Your saved answers are safe: the server also submits them automatically when time ends.' : ''); if (er) { er.hidden = false; er.textContent = m; } toast(e.message, 'err'); return; }
        if (!auto && n >= 2) { submitting = false; const er = $('#er'); if (er) { er.hidden = false; er.textContent = 'Could not reach the server. Your answers are kept on this device. Check your connection and press Submit again.'; } return; }
        await new Promise(r => setTimeout(r, Math.min(8000, 1000 * (n + 1)))); // when time is up we keep retrying
      }
    }
  }
  const clock = () => {
    const s = Math.max(0, Math.ceil((deadline - (Date.now() + off)) / 1000)), h = Math.floor(s / 3600), t = $('#tm'); if (!t) return;
    t.textContent = (h ? h + ':' : '') + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); t.classList.toggle('low', s < 60);
    for (const m of [300, 60]) if (s <= m && s > m - 2 && !said[m]) { said[m] = 1; announce(`${m / 60} minute${m > 60 ? 's' : ''} remaining`); }
    if (s <= 0 && Date.now() >= autoWait) submit(true);
  };
  const timer = setInterval(clock, 500), poll = setInterval(flush, 20000);
  const ev = k => { if (!closed) post(`/api/student/attempts/${id}/events`, { kind: k }).catch(() => {}); };
  const onVis = () => ev(document.hidden ? 'hidden' : 'visible'), onOff = () => { $('#off').hidden = false; ev('offline'); }, onOn = () => { $('#off').hidden = true; fails = 0; flush(); ev('online'); };
  const onUnload = e => { if (!closed && Object.keys(pend).length) { e.preventDefault(); e.returnValue = ''; } };
  document.addEventListener('visibilitychange', onVis); addEventListener('offline', onOff); addEventListener('online', onOn); addEventListener('beforeunload', onUnload);
  cleanup = () => { clearInterval(timer); clearInterval(poll); clearTimeout(ft); document.removeEventListener('visibilitychange', onVis); removeEventListener('offline', onOff); removeEventListener('online', onOn); removeEventListener('beforeunload', onUnload); };
  if (!navigator.onLine) onOff();
  showQ(); clock(); status(); if (Object.keys(pend).length) flush();
}

R(/^\/s\/result\/(\d+)$/, async id => {
  loading(); const r = await get(`/api/student/attempts/${id}/result`), s = r.result;
  const body = s.state === 'released' ? `<div class="card"><div class="stat">${num(s.score)} / ${num(s.total)}</div><div class="mu">${s.percent != null ? s.percent + '%' : ''}${passText(s)}</div></div>${r.items.map(i => {
    const L = x => [].concat(x ?? []), ids = new Set(L(i.answer)), cor = i.key ? new Set(L(i.key.correct)) : null;
    const shown = i.type === 'mcq' || i.type === 'tf' ? (i.options.filter(o => ids.has(o.id)).map(o => o.text).join('; ') || '—') : (i.answer || '—');
    return `<div class="card"><div class="row"><span class="qn">Question ${i.n}</span><b>${num(i.got)} / ${num(i.marks)}</b></div><div class="stem">${esc(i.stem)}</div>${i.image_id ? `<img class="qimg" src="/api/images/${i.image_id}" alt="">` : ''}
      <div><span class="mu">Your answer:</span> <span class="stem" style="display:inline">${esc(shown)}</span></div>
      ${cor ? `<div><span class="mu">Correct answer:</span> ${i.options.length ? esc(i.options.filter(o => cor.has(o.id)).map(o => o.text).join('; ')) : esc(i.key.accepted ? i.key.accepted.join(' / ') : i.key.value != null ? i.key.value : i.key.guide ? '(marked by your teacher)' : '')}</div>` : ''}
      ${i.explanation ? `<div class="alert info">${esc(i.explanation)}</div>` : ''}${i.feedback ? `<div class="alert info"><b>Teacher feedback:</b> ${esc(i.feedback)}</div>` : ''}</div>`; }).join('')}`
    : s.state === 'provisional' ? `<div class="card"><div class="alert warn">Provisional score (objective questions only): <b>${num(s.score)} / ${num(s.total)}</b><br>${esc(s.note)}</div></div>`
    : `<div class="card"><div class="alert info">Your submission was received${r.receipt ? ` (receipt <span class="pw">${esc(r.receipt)}</span>)` : ''}. Your result has not been released yet.</div></div>`;
  const wh = r.answers_withheld ? `<div class="alert info" role="status">${r.answers_withheld === 'in_progress' ? 'Correct answers will be shown once everyone has finished this exam.' : 'Correct answers will be shown after this exam closes for everyone, so that classmates who have not taken it yet are not given the answers.'}</div>` : '';
  page(`<h1>${esc(r.exam.title)}</h1><p class="mu">Submitted ${fd(r.submitted_at)}</p>${wh}${body}<a href="#/s">← My exams</a>`, { title: 'Result' });
}, S_);

// Pass/fail and letter grade appear only for RELEASED results (the server sends them only in that state).
const passText = r => r.result ? ` · <b>${r.result === 'pass' ? 'Pass' : 'Not passed'}</b> (pass mark ${num(r.pass_mark)}%)${r.letter ? ` · Grade ${esc(r.letter)}` : ''}` : '';
