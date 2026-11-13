// The flying-eagle loading screen. No database needed: this checks the wiring in the files and runs the real loader.js
// state machine against a tiny fake DOM with fake timers. (The browser-level checks live in tests/browser-loader/.)
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), vm = require('vm');
const pub = path.join(__dirname, '..', 'public'), read = f => fs.readFileSync(path.join(pub, f), 'utf8');

test('the three eagle layers exist, are real WebP files and stay small', () => {
  for (const n of ['body', 'wingA', 'wingB']) {
    const b = fs.readFileSync(path.join(pub, 'img', 'eagle', `eagle-${n}.webp`));
    assert.equal(b.subarray(0, 4).toString(), 'RIFF'); assert.equal(b.subarray(8, 12).toString(), 'WEBP'); assert.ok(b.length < 40000, `${n} is ${b.length} bytes`);
  }
});

test('index.html ships the splash, loads loader.css, and loads loader.js before any app script (CSP: no inline script)', () => {
  const h = read('index.html'), at = s => h.indexOf(s);
  assert.ok(at('id="eagle-loader"') > 0 && at('/loader.css') > 0 && at('/loader.js') > 0);
  assert.ok(at('/loader.js') < at('/core.js'), 'the splash controller must run before the app starts');
  assert.ok(at('<noscript><style>#eagle-loader{display:none}') > 0, 'without JavaScript the splash must not cover the page forever');
  assert.ok(at('EXAM PORTAL') > 0 && at('EAGLE LABS') > 0);
  assert.doesNotMatch(h.replace(/<script src="[^"]+"><\/script>/g, ''), /<script/i, 'an inline <script> would be blocked by the CSP');
});

test('loader.css animates only transform/opacity-class properties and honours prefers-reduced-motion', () => {
  const c = read('loader.css');
  assert.match(c, /@media \(prefers-reduced-motion:reduce\)\{[^}]*\.el,\.el \*[^}]*animation:none!important/);
  const ks = [...c.matchAll(/@keyframes (el\w+)\{([\s\S]*?)\n(?=@|\/\*|$)/g)]; assert.ok(ks.length >= 8, 'keyframes were not found');
  for (const k of ks) assert.doesNotMatch(k[2], /\b(width|height|top|left|margin|padding)\s*:/, `${k[1]} would trigger layout every frame`);
});

test('the app is wired to the loader: render ends it, dashboards and exam preparation start it, ordinary pages do not', () => {
  const core = read('core.js');
  assert.match(core, /if \(!hold && window\.EagleLoader\) EagleLoader\.done\(\)/);
  assert.match(core, /errorPage[\s\S]*EagleLoader\.fail\(/, 'a failure while the loader is up must show on it');
  assert.match(core, /EagleLoader\.fail\([^\n]*'Open sign-in page'/, 'start-up must not treat an unreachable server as "signed out"');
  assert.match(read('student.js'), /R\(\/\^\\\/s\$\/, async \(\) => \{\n\s*loading\('dash'\)/);
  assert.match(read('student.js'), /R\(\/\^\\\/s\\\/attempt\\\/\(\\d\+\)\$\/, async id => \{\n\s*loading\('exam'\)/);
  assert.match(read('teacher.js'), /R\(\/\^\\\/t\$\/, async \(\) => \{\n\s*loading\('dash'\)/);
  assert.match(read('admin.js'), /R\(\/\^\\\/a\\\/users\$\/, async \(\) => \{\n\s*loading\('dash'\)/);
  assert.equal((read('teacher.js').match(/loading\('(dash|exam)'\)/g) || []).length, 1, 'only the dashboard gets the full screen, not every teacher page');
});

// ---- the state machine itself, run for real against a fake DOM and fake timers
function rig({ exam = false, reduced = false } = {}) {
  const cls = new Set(), attrs = { 'aria-busy': 'true' }, btn = () => ({ hidden: false, textContent: '', _l: {}, addEventListener(e, f) { this._l[e] = f; }, focus() {}, click() { this._l.click && this._l.click(); } });
  const msg = { textContent: 'Preparing your examination environment...', classList: { remove() {}, add() {} }, get offsetWidth() { return 0; } }, etxt = { textContent: '' }, retry = btn(), dismiss = btn();
  const el = { hidden: false, dataset: { state: 'loading' }, classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) }, setAttribute: (k, v) => { attrs[k] = v; },
    querySelector: s => ({ '.el-msg': msg, '.el-etxt': etxt, '.el-retry': retry, '.el-dismiss': dismiss })[s] };
  const root = { _i: false, setAttribute() { this._i = true; }, removeAttribute() { this._i = false; } };
  const w = { _l: {} };
  const ctx = { console, setTimeout, clearTimeout, Date, navigator: { onLine: true }, location: { reload() { ctx.reloaded = true; } }, addEventListener(e, f) { w._l[e] = f; },
    matchMedia: () => ({ matches: reduced }), document: { getElementById: id => id === 'eagle-loader' ? el : id === 'root' ? root : null, querySelector: s => (s === '.xwrap' && exam) ? {} : null } };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(read('loader.js'), ctx);
  return { L: ctx.window.EagleLoader, el, root, msg, etxt, cls, retry, dismiss, ctx };
}
test('state machine: a load that finishes inside the grace period never shows, and the page is released at once', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const r = rig();
  assert.equal(r.root._i, true); t.mock.timers.tick(60); r.L.done();
  assert.equal(r.el.hidden, true); assert.equal(r.root._i, false); assert.equal(r.L.isOn(), false);
});
test('state machine: a visible screen is held to its minimum time, then fades and is released', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const r = rig(); t.mock.timers.tick(300); r.L.done();
  assert.equal(r.msg.textContent, 'Almost ready...'); assert.equal(r.L.isOn(), true);
  t.mock.timers.tick(500); assert.ok(r.cls.has('is-out')); t.mock.timers.tick(460); assert.equal(r.el.hidden, true); assert.equal(r.root._i, false);
});
test('state machine: reduced motion leaves at once (no animation to protect)', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const r = rig({ reduced: true }); t.mock.timers.tick(300); r.L.done(); assert.equal(r.el.hidden, true);
});
test('state machine: it can never start over a live exam (boot excepted) and never loads forever', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); let r = rig({ exam: true }); r.L.done(); t.mock.timers.tick(10);
  assert.equal(r.L.begin('exam'), false); assert.equal(r.L.begin('dash'), false);
  r = rig(); t.mock.timers.tick(3600); assert.equal(r.msg.textContent, 'Synchronizing your data...');
  t.mock.timers.tick(12000); assert.match(r.msg.textContent, /longer than usual/);
  t.mock.timers.tick(25000); assert.equal(r.el.dataset.state, 'error'); assert.match(r.etxt.textContent, /too long/); assert.equal(r.root._i, true, 'the half-loaded page stays unusable');
});
test('state machine: fail() never fades out as success; Try again resumes; a late success still ends it', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const r = rig(); let tried = 0; t.mock.timers.tick(500);
  r.L.fail('Server down', () => { tried++; }, () => {}, 'Show details'); assert.equal(r.el.dataset.state, 'error'); assert.equal(r.etxt.textContent, 'Server down'); assert.equal(r.dismiss.textContent, 'Show details');
  t.mock.timers.tick(60000); assert.equal(r.el.hidden, false, 'an error screen must stay until the user acts');
  r.retry.click(); assert.equal(tried, 1); assert.equal(r.el.dataset.state, 'loading');
  r.L.done(); t.mock.timers.tick(2000); assert.equal(r.el.hidden, true);
});
test('state machine: begin() while fading out brings the screen back instead of leaving it invisible but blocking', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const r = rig(); t.mock.timers.tick(700); r.L.done(); assert.ok(r.cls.has('is-out'));
  r.L.begin('dash'); assert.equal(r.cls.has('is-out'), false); assert.equal(r.L.isOn(), true); t.mock.timers.tick(2000); assert.equal(r.el.hidden, false);
});
