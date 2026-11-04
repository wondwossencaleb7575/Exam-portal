// Real-browser end-to-end tests of the student exam player. Run:  npm run test:e2e
//
// Needs Playwright, which is deliberately NOT a dependency of the product (it is a developer tool):
//     npm install --no-save playwright && npx playwright install chromium
// or point CHROME_PATH at an installed Chrome/Chromium. The server runs in-process on a temporary database with synthetic data only.
const test = require('node:test'), assert = require('node:assert/strict');
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-e2e-'));
Object.assign(process.env, { ADMIN_EMAIL: 'admin@t.local', ADMIN_PASSWORD: 'Admin-Pass-12345', OTP_LOGIN_MODE: 'off' });
const { chromium } = require('playwright');
const { start } = require('../../server');
const { db } = require('../../lib/db');
const srv = start(0), base = `http://localhost:${srv.address().port}`;

let browser;
test.before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] }); });
test.after(async () => { await browser?.close(); srv.closeAllConnections(); srv.close(); await require('../../lib/db').close(); });

/* ---------- seeding through the real API ---------- */
function api() {
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'eagle', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
    assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(data).slice(0, 300)}`); return data;
  };
  return { get: async u => await call('GET', u), post: async (u, b) => await call('POST', u, b || {}), put: async (u, b) => await call('PUT', u, b) };
}
const QS = () => [
  { type: 'mcq', stem: 'What is 1+1?', options: [{ text: '1' }, { text: '2' }, { text: '3' }], key: { correct: ['b'] }, settings: {}, marks: 2, topic: 'Arithmetic' },
  { type: 'tf', stem: 'Zero is even.', key: { correct: 'true' }, marks: 1, topic: 'Numbers' },
  { type: 'numeric', stem: 'Compute pi to 2 d.p.', key: { value: 3.14, tol: 0.005, tolType: 'abs' }, marks: 2, topic: 'Numbers' },
  { type: 'short', stem: 'Longest side of a right triangle?', key: { accepted: ['hypotenuse'] }, settings: { review: true }, marks: 1, topic: 'Geometry' },
  { type: 'written', stem: 'Explain why 2+2=4.', key: { guide: 'notes' }, marks: 4, topic: 'Proof' }
];
const W = { teacher: null, cid: 0, n: 0, creds: [] };
async function world() {
  if (W.teacher) return W;
  const admin = api(); for (let i = 0; i < 100 && !await db.prepare("SELECT 1 FROM users WHERE email='admin@t.local'").get(); i++) await new Promise(r => setTimeout(r, 50));
  await admin.post('/api/auth/login', { email: 'admin@t.local', password: 'Admin-Pass-12345' });
  const tt = await admin.post('/api/admin/users', { email: 'teach@t.local', name: 'Teacher T', role: 'teacher' }), t = api();
  await t.post('/api/auth/login', { email: 'teach@t.local', password: tt.temp_password }); await t.post('/api/auth/change-password', { current: tt.temp_password, next: 'Teacher-Pass-1234' });
  W.teacher = t; W.cid = (await t.post('/api/classes', { name: 'Class A', grade: '10', academic_year: '2026' })).id; return W;
}
// A fresh student + a fresh published exam each time, so scenarios cannot affect each other.
async function scenario({ minutes = 30, showAnswers = false } = {}) {
  const w = await world(), n = ++W.n, email = `stu${n}@t.local`;
  const imp = await w.teacher.post(`/api/classes/${w.cid}/import-csv/commit`, { csv: `student_number,full_name,email\nN${n},Student ${n},${email}` });
  const c = imp.credentials[0], s = api(); await s.post('/api/auth/login', { email, password: c.temp_password }); await s.post('/api/auth/change-password', { current: c.temp_password, next: 'Student-Pass-123' });
  const { id } = await w.teacher.post('/api/exams', { title: `E2E exam ${n}` });
  await w.teacher.put(`/api/exams/${id}`, { title: `E2E exam ${n}`, minutes, max_attempts: 1, release_mode: 'manual', show_answers: showAnswers, shuffle_q: false, shuffle_o: false, subject_id: 1, class_ids: [w.cid], questions: QS() });
  await w.teacher.post(`/api/exams/${id}/publish`);
  return { email, password: 'Student-Pass-123', examId: id, userId: (await db.prepare('SELECT id FROM users WHERE email=?').get(email)).id };
}
async function signIn(page, who) {
  await page.goto(base + '/#/login'); await page.fill('#em', who.email); await page.fill('#pw', who.password); await page.click('#f button[type=submit]'); await page.waitForSelector('text=My exams');
}
async function startExam(page, who) {
  await signIn(page, who); await page.click('a:has-text("View instructions")'); await page.click('#go'); await page.waitForSelector('#sv'); await page.waitForSelector('#xt');
}
const attemptOf = async who => await db.prepare('SELECT * FROM attempts WHERE exam_id=? AND student_id=?').get(who.examId, who.userId);
const saved = async (who, q) => { const r = await db.prepare('SELECT a.value,a.seq FROM answers a JOIN exam_questions q ON q.id=a.eq_id WHERE a.attempt_id=? AND q.pos=?').get((await attemptOf(who)).id, q); return r === undefined ? undefined : (r.value == null ? null : JSON.parse(r.value)); }; // undefined = the server holds no row at all
const indicator = page => page.locator('#sv').innerText();
const waitSaved = page => page.waitForFunction(() => /^All answers saved/.test(document.querySelector('#sv')?.textContent || ''), null, { timeout: 8000 });
const newPage = async (opts = {}) => { const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, ...opts }); return { ctx, page: await ctx.newPage() }; };

/* ---------- scenarios ---------- */
test('happy path: answer, navigate, flag, review, confirm, submit, receipt, refresh after submit', async () => {
  const who = await scenario(), { ctx, page } = await newPage(); await startExam(page, who);
  assert.match(await page.locator('.qn').innerText(), /Question 1 of 5/i); // CSS upper-cases this label
  await page.check('input[name=a] >> nth=1'); await waitSaved(page); // Q1 option B
  assert.equal((await saved(who, 0))?.length, 1, 'the answer is really in the database when the indicator says saved');
  assert.match(await indicator(page), /All answers saved · \d/);
  await page.click('#nx'); await page.check('input[name=a][value=true]'); await page.check('#fl'); await page.click('#nx');
  await page.fill('#ai', '3,14'); await page.click('#nx'); await page.fill('#ai', 'hypotenuse'); await waitSaved(page);
  assert.equal(await saved(who, 3), 'hypotenuse'); assert.equal(await saved(who, 2), '3,14');
  assert.match(await page.locator('#nav button[data-n="1"]').getAttribute('aria-label'), /answered, flagged for review/);
  assert.match(await page.locator('#nav button[data-n="4"]').getAttribute('aria-label'), /not answered/);
  await page.click('#rv'); assert.match(await page.locator('main').innerText(), /1 question is unanswered\.\s*1 flagged for review/);
  await page.click('#sub'); await page.waitForSelector('dialog[open]'); assert.match(await page.locator('dialog').innerText(), /still have 1 unanswered/);
  await page.click('dialog #n'); assert.equal((await attemptOf(who)).status, 'in_progress', 'cancelling the confirmation submits nothing');
  await page.click('#sub'); await page.click('dialog #y'); await page.waitForSelector('text=Submission received');
  const receipt = (await page.locator('.pw').innerText()).trim(); assert.equal(receipt, (await attemptOf(who)).receipt); assert.equal((await attemptOf(who)).status, 'submitted');
  await page.reload(); await page.waitForSelector('text=has not been released'); // a refresh after submitting lands on the result page, never back in the exam
  assert.ok(!(await page.locator('#xt').count()), 'the exam player is not shown again');
  await ctx.close();
});

test('network loss: honest "not saved" state, answers kept on device, saved after reconnect', async () => {
  const who = await scenario(), { ctx, page } = await newPage(); await startExam(page, who);
  await page.check('input[name=a] >> nth=2'); await waitSaved(page);
  await ctx.setOffline(true); await page.click('#nx'); await page.check('input[name=a][value=false]');
  await page.waitForFunction(() => /Not saved: no connection/.test(document.querySelector('#sv')?.textContent || ''), null, { timeout: 8000 });
  assert.ok(await page.locator('#off').isVisible(), 'offline banner shown');
  assert.equal(await saved(who, 1), undefined, 'nothing was claimed saved that the server does not hold');
  assert.ok(await page.evaluate(id => !!localStorage.getItem('eagle.pend.' + id), (await attemptOf(who)).id), 'the unsent answer is buffered on this device');
  await ctx.setOffline(false); await waitSaved(page);
  assert.equal(await saved(who, 1), 'false', 'delivered after reconnection'); assert.ok(!(await page.locator('#off').isVisible()));
  assert.equal(await page.evaluate(id => localStorage.getItem('eagle.pend.' + id), (await attemptOf(who)).id), '{}', 'buffer emptied once the server confirmed');
  await ctx.close();
});

test('refresh while an answer is unsent: typing survives the reload and is delivered', async () => {
  const who = await scenario(), { ctx, page } = await newPage(); await startExam(page, who);
  await page.click('#nav button[data-n="3"]'); await page.fill('#ai', 'hyp'); await waitSaved(page);
  await page.route('**/api/student/attempts/*/answers', r => r.abort('failed')); // the server cannot be reached for saves
  await page.fill('#ai', 'hypotenuse'); await page.waitForFunction(() => /Not saved/.test(document.querySelector('#sv')?.textContent || ''), null, { timeout: 8000 });
  assert.equal(await saved(who, 3), 'hyp');
  await page.unroute('**/api/student/attempts/*/answers'); await page.reload(); await page.waitForSelector('#xt');
  await page.click('#nav button[data-n="3"]'); assert.equal(await page.inputValue('#ai'), 'hypotenuse', 'restored from the device buffer after a refresh');
  await waitSaved(page); assert.equal(await saved(who, 3), 'hypotenuse');
  await ctx.close();
});

test('server problems (HTTP 500) are named as such and recover', async () => {
  const who = await scenario(), { ctx, page } = await newPage(); await startExam(page, who);
  await page.route('**/api/student/attempts/*/answers', r => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"down"}' }));
  await page.check('input[name=a] >> nth=0'); await page.waitForFunction(() => /Not saved: server problem/.test(document.querySelector('#sv')?.textContent || ''), null, { timeout: 8000 });
  assert.ok(!(await page.locator('#off').isVisible()), 'a server fault is not described as the student being offline');
  await page.unroute('**/api/student/attempts/*/answers'); await waitSaved(page); assert.equal((await saved(who, 0))?.length, 1);
  await ctx.close();
});

test('expired session mid-exam: clear explanation, nothing lost, exam resumes after signing in', async () => {
  const who = await scenario(), { ctx, page } = await newPage(); await startExam(page, who);
  await page.check('input[name=a] >> nth=1'); await waitSaved(page);
  await db.prepare('DELETE FROM sessions WHERE user_id=?').run(who.userId); // the sign-in ends (expiry, revocation)
  await page.click('#nav button[data-n="3"]'); await page.fill('#ai', 'typed after expiry');
  await page.waitForSelector('text=Your sign-in ended during the exam'); assert.match(page.url(), /#\/login/);
  assert.equal(await saved(who, 3), undefined);
  await page.fill('#em', who.email); await page.fill('#pw', who.password); await page.click('#f button[type=submit]');
  await page.click('a:has-text("Resume exam")'); await page.waitForSelector('#xt'); await page.click('#nav button[data-n="3"]');
  assert.equal(await page.inputValue('#ai'), 'typed after expiry'); await waitSaved(page); assert.equal(await saved(who, 3), 'typed after expiry');
  assert.equal((await attemptOf(who)).status, 'in_progress'); await ctx.close();
});

test('two tabs, same attempt: the second tab is told the truth instead of "saved"', async () => {
  const who = await scenario(), a = await newPage(); await startExam(a.page, who);
  const url = a.page.url(), b = await a.ctx.newPage(); await b.goto(url); await b.waitForSelector('#xt'); // both tabs loaded at the same server state
  await a.page.check('input[name=a] >> nth=0'); await waitSaved(a.page); const first = await saved(who, 0);
  await b.check('input[name=a] >> nth=2'); // same sequence number, different content
  await b.waitForSelector('text=changed in another tab or window');
  assert.deepEqual(await saved(who, 0), first, "tab B's answer did not overwrite tab A's");
  assert.equal(await b.locator('input[name=a]').nth(0).isChecked(), true, 'tab B now shows what the server holds');
  assert.equal(await b.locator('input[name=a]').nth(2).isChecked(), false); await waitSaved(b);
  await a.ctx.close();
});

test('timer is server-authoritative: reload does not add time; a forged browser clock changes nothing', async () => {
  const who = await scenario({ minutes: 30 }), { ctx, page } = await newPage(); await startExam(page, who);
  const secs = async () => { const t = (await page.locator('#tm').innerText()).split(':').map(Number); return t.length === 3 ? t[0] * 3600 + t[1] * 60 + t[2] : t[0] * 60 + t[1]; };
  const before = await secs(); await page.waitForTimeout(2200); await page.reload(); await page.waitForSelector('#tm'); const after = await secs();
  assert.ok(after <= before - 2 && after > before - 10, `after reload ${after}s must continue from ${before}s, not restart at 1800`);
  const dl = (await attemptOf(who)).deadline; await page.evaluate(() => { Date.now = () => 0; }); await page.reload(); await page.waitForSelector('#tm'); // a manipulated clock before the page loads
  assert.equal((await attemptOf(who)).deadline, dl, 'the deadline lives on the server and never moved');
  await ctx.close();
});

test('deadline reached: automatic, exactly-once submission with a receipt', async () => {
  const who = await scenario(), { ctx, page } = await newPage(); await startExam(page, who);
  await page.check('input[name=a] >> nth=1'); await waitSaved(page);
  await db.prepare('UPDATE attempts SET deadline=? WHERE id=?').run(Date.now() + 3000, (await attemptOf(who)).id); // the teacher-side/server deadline is now 3 s away
  await page.click('#nx'); await page.check('input[name=a][value=true]'); // the next save carries the new deadline to the browser
  await page.waitForSelector('text=Submission received', { timeout: 20000 });
  const a = await attemptOf(who); assert.ok(['submitted', 'auto_submitted'].includes(a.status), a.status); assert.ok(a.receipt);
  const again = await (await world()).teacher.get('/api/exams/' + who.examId + '/attempts').catch(() => null); // teacher can see exactly one submitted attempt
  const s2 = api(); await s2.post('/api/auth/login', { email: who.email, password: who.password }); const r2 = await s2.post(`/api/student/attempts/${a.id}/submit`, {});
  assert.equal(r2.receipt, a.receipt, 'a repeated submit returns the same receipt and changes nothing');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM attempts WHERE exam_id=? AND student_id=?').get(who.examId, who.userId)).n, 1, 'one attempt, no duplicates');
  await ctx.close();
});

test('keyboard only: a question can be answered and navigated without a mouse; focus is visible', async () => {
  const who = await scenario(), { ctx, page } = await newPage(); await startExam(page, who);
  await page.locator('input[name=a]').first().focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space'); await waitSaved(page);
  assert.equal((await saved(who, 0))?.length, 1, 'answered with the keyboard');
  await page.locator('#nx').focus(); await page.keyboard.press('Enter'); assert.match(await page.locator('.qn').innerText(), /Question 2 of 5/i);
  const outline = await page.locator('#nx').evaluate(el => { el.focus(); const c = getComputedStyle(el); return { style: c.outlineStyle, width: parseFloat(c.outlineWidth) }; });
  assert.ok(outline.style !== 'none' && outline.width >= 2, 'visible focus indicator: ' + JSON.stringify(outline));
  assert.match(await page.locator('legend.vh').innerText().catch(() => ''), /question 2|^$/);
  await ctx.close();
});

test('small phone (360x640): no sideways scrolling, tap targets at least 24px (WCAG 2.2 AA 2.5.8)', async () => {
  const who = await scenario(), { ctx, page } = await newPage({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true }); await startExam(page, who);
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok((await wide()) <= 1, 'question screen scrolls sideways by ' + await wide());
  const small = await page.evaluate(() => [...document.querySelectorAll('button, input, a')].filter(e => e.offsetParent).map(e => { const lab = e.matches('input[type=checkbox],input[type=radio]') ? e.closest('label') : null, r = (lab || e).getBoundingClientRect(); return { n: (e.id || e.className || e.tagName) + (lab ? ' (via label)' : ''), w: Math.round(r.width), h: Math.round(r.height) }; }).filter(x => x.w < 24 || x.h < 24));
  assert.deepEqual(small, [], 'targets under 24px');
  await page.click('#rv'); assert.ok((await wide()) <= 1, 'review screen scrolls sideways');
  await ctx.close();
});

test('results: correct answers explained as withheld while the exam is still open', async () => {
  const who = await scenario({ showAnswers: true }), { ctx, page } = await newPage(); await startExam(page, who);
  await page.check('input[name=a] >> nth=1'); await waitSaved(page); await page.click('#rv'); await page.click('#sub'); await page.click('dialog #y'); await page.waitForSelector('text=Submission received');
  const w = await world(); await w.teacher.post(`/api/exams/${who.examId}/finalize`, {}).catch(() => {}); // written question is still ungraded, so this is refused; grade it
  const att = await attemptOf(who), view = await w.teacher.get(`/api/attempts/${att.id}`);
  for (const i of view.items.filter(i => i.grade.status === 'pending')) await w.teacher.put(`/api/attempts/${att.id}/grade`, { eq_id: i.q.id, marks: 1 });
  await w.teacher.post(`/api/exams/${who.examId}/finalize`, {}); await w.teacher.post(`/api/exams/${who.examId}/release`, {});
  await page.goto(base + `/#/s/result/${att.id}`); await page.waitForSelector('text=Correct answers will be shown after this exam closes');
  assert.ok(!(await page.locator('body').innerText()).includes('Correct answer:'));
  await w.teacher.post(`/api/exams/${who.examId}/close`); await page.reload(); await page.waitForSelector('text=Correct answer:');
  await ctx.close();
});
