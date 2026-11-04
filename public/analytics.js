/* Teacher analytics: real records only, filters, accessible chart + table alternative. The server decides what is counted and says so in `population`. */
const AN_BINS = ['0–9', '10–19', '20–29', '30–39', '40–49', '50–59', '60–69', '70–79', '80–89', '90–100'];
const pc = v => v == null ? '–' : v + '%';
function distChart(dist) {
  const max = Math.max(1, ...dist), W = 520, H = 190, bw = 40, gap = 12, base = 150, total = dist.reduce((a, b) => a + b, 0);
  const desc = `Score distribution of ${total} result${total === 1 ? '' : 's'}: ` + dist.map((n, i) => `${AN_BINS[i]} percent, ${n}`).join('; ') + '.';
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(desc)}" style="width:100%;max-width:560px;height:auto">${dist.map((n, i) => { const h = Math.round(n / max * 120), x = 10 + i * (bw + gap);
    return `<g><rect x="${x}" y="${base - h}" width="${bw}" height="${h}" rx="3" fill="var(--blue)"></rect><text x="${x + bw / 2}" y="${base - h - 5}" text-anchor="middle" font-size="12" fill="var(--g800)">${n || ''}</text><text x="${x + bw / 2}" y="${base + 16}" text-anchor="middle" font-size="10" fill="var(--g600)">${AN_BINS[i].split('–')[0]}</text></g>`; }).join('')}
    <line x1="6" y1="${base}" x2="${W - 6}" y2="${base}" stroke="var(--g400)"></line><text x="${W / 2}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--g600)">Score band, percent (lower edge)</text></svg>
    <details><summary>Show this chart as a table</summary><div class="tw"><table><tr><th>Score band (%)</th><th>Results</th></tr>${dist.map((n, i) => `<tr><td>${AN_BINS[i]}</td><td>${n}</td></tr>`).join('')}</table></div></details>`;
}
R(/^\/t\/analytics$/, async () => {
  loading(); const f = { subject_id: '', grade: '', academic_year: '', term: '', class_id: '', exam_id: '', from: '', to: '' }; let ready = false;
  page('<div id="x"></div>', { title: 'Analytics' });
  const qs = () => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v) p.set(k, k === 'from' ? fromLocal(v + 'T00:00') : k === 'to' ? fromLocal(v + 'T23:59') + 59999 : v); return p; };
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`;
  const shell = fc => { $('#x').innerHTML = `<h1>Analytics</h1><p class="mu">Based on your own published and closed exams. Only graded work counts toward scores.</p>
    <form class="card" id="anf" aria-label="Filters"><div class="two">
      <div><label class="f" for="a_sub">Subject</label><select id="a_sub" data-k="subject_id"><option value="">All</option>${fc.subjects.map(s => opt(s.id, s.name, f.subject_id)).join('')}</select></div>
      <div><label class="f" for="a_gr">Grade</label><select id="a_gr" data-k="grade"><option value="">All</option>${fc.grades.map(g => opt(g, g, f.grade)).join('')}</select></div>
      <div><label class="f" for="a_ay">Academic year</label><select id="a_ay" data-k="academic_year"><option value="">All</option>${fc.academic_years.map(g => opt(g, g, f.academic_year)).join('')}</select></div>
      <div><label class="f" for="a_tm">Term</label><select id="a_tm" data-k="term"><option value="">All</option>${fc.terms.map(g => opt(g, g, f.term)).join('')}</select></div>
      <div><label class="f" for="a_cl">Class</label><select id="a_cl" data-k="class_id"><option value="">All my classes</option>${fc.classes.map(c => opt(c.id, c.name, f.class_id)).join('')}</select></div>
      <div><label class="f" for="a_ex">Exam</label><select id="a_ex" data-k="exam_id"><option value="">All exams</option>${fc.exams.map(c => opt(c.id, c.title, f.exam_id)).join('')}</select></div>
      <div><label class="f" for="a_fr">Submitted from</label><input id="a_fr" type="date" data-k="from" value="${esc(f.from)}"></div>
      <div><label class="f" for="a_to">Submitted to</label><input id="a_to" type="date" data-k="to" value="${esc(f.to)}"></div></div>
      <div class="gap"><button type="button" class="sec sm" id="a_clr">Clear filters</button></div></form><div id="rep" aria-live="polite"></div>`;
    $('#anf').addEventListener('change', e => { const k = e.target.dataset.k; if (!k) return; f[k] = e.target.value; load(); }); $('#a_clr').onclick = () => { Object.keys(f).forEach(k => f[k] = ''); ready = false; load(); }; };
  async function load() {
    const rep = $('#rep'); if (rep) rep.innerHTML = '<p><span class="spin"></span> Calculating…</p>';
    try {
      const r = await get('/api/analytics?' + qs()); if (!ready) { shell(r.facets); ready = true; } const out = $('#rep'); if (!out) return;
      const tile = (v, l, sub) => `<div class="card"><div class="stat">${v}</div>${esc(l)}${sub ? `<div class="mu">${esc(sub)}</div>` : ''}</div>`;
      out.innerHTML = `<div class="alert info" role="note"><b>What these numbers cover.</b> ${esc(r.population)}</div>
        <div class="grid">${tile(r.exams_in_scope, 'Exams in scope')}${tile(r.enrollments, 'Enrollments', 'students entitled, summed over exams')}${tile(pc(r.submission_rate), 'Submission rate', `${r.students_submitted} of ${r.enrollments}`)}${tile(r.n, 'Graded results')}${tile(pc(r.mean), 'Mean score')}${tile(pc(r.median), 'Median score')}${tile(pc(r.pass_rate), 'Pass rate', r.n ? `${r.pass_n} of ${r.n}` : '')}${tile(r.grades_pending, 'Answers awaiting marking', r.oldest_pending_days != null ? `oldest submitted ${r.oldest_pending_days} day${r.oldest_pending_days === 1 ? '' : 's'} ago` : `${r.attempts_pending} attempt${r.attempts_pending === 1 ? '' : 's'} excluded from scores`)}</div>
        ${r.n ? `<div class="card"><h2>Score distribution</h2>${distChart(r.distribution)}${r.letters.length ? `<h3 style="margin-top:10px">By grade</h3><div class="tw"><table><tr>${r.letters.map(l => `<th scope="col">${esc(l.label)} (${l.min}%+)</th>`).join('')}</tr><tr>${r.letters.map(l => `<td>${l.count}</td>`).join('')}</tr></table></div>` : ''}</div>` : '<div class="card"><p class="mu">No graded results match these filters yet.</p></div>'}
        ${r.per_exam.length ? `<div class="card"><h2>By exam</h2><div class="tw"><table><tr><th>Exam</th><th>Graded</th><th>Awaiting grading</th><th>Mean</th><th>Median</th><th>Pass mark</th><th>Pass rate</th></tr>${r.per_exam.map(x => `<tr><td><a href="#/t/exam/${x.exam_id}/results">${esc(x.title)}</a></td><td>${x.graded}</td><td>${x.pending_attempts}</td><td>${pc(x.mean)}</td><td>${pc(x.median)}</td><td>${x.pass_mark}%</td><td>${pc(x.pass_rate)}</td></tr>`).join('')}</table></div></div>` : ''}
        <div class="card"><h2>Questions students found hardest</h2>${r.hardest_questions.length ? `<div class="tw"><table><tr><th>Exam</th><th>Q</th><th>Question</th><th>Topic</th><th>Average success</th><th>Responses</th></tr>${r.hardest_questions.map(q => `<tr><td>${esc(q.exam)}</td><td>${q.n}</td><td>${esc(q.stem)}</td><td>${esc(q.topic || '–')}</td><td>${pc(q.percent)}</td><td>${q.responses}</td></tr>`).join('')}</table></div>` : `<p class="mu">Shown once a question has at least ${r.min_sample} graded responses, so a handful of answers cannot make a question look hard.</p>`}</div>
        <div class="card"><h2>Topics</h2>${r.topics.length ? `<div class="tw"><table><tr><th>Topic</th><th>Questions</th><th>Responses</th><th>Average success</th></tr>${r.topics.map(t => `<tr><td>${esc(t.topic)}</td><td>${t.questions}</td><td>${t.responses}</td><td>${pc(t.percent)}</td></tr>`).join('')}</table></div><p class="mu">Lowest first: these are good revision candidates.</p>` : '<p class="mu">Topics appear once questions have enough graded responses.</p>'}</div>`;
    } catch (e) { const out = $('#rep') || $('#x'); out.innerHTML = `<div class="alert err" role="alert">${esc(e.message)} <button class="sec sm" id="a_retry">Try again</button></div>`; const b = $('#a_retry'); if (b) b.onclick = () => load(); }
  }
  await load();
}, ['teacher']);
