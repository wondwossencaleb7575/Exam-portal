'use strict';
// Guards the properties of the eagle loading screen that are easy to break by accident. Static checks: no browser or database needed.
// (The behaviour itself is exercised end-to-end in a real browser by tests/eagle-loader-browser, see its README.)
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const pub = path.join(__dirname, '..', 'public'), read = f => fs.readFileSync(path.join(pub, f), 'utf8');
const html = read('index.html'), css = read('eagle-loader.css'), js = read('eagle-loader.js'), core = read('core.js');

test('all eagle layers exist, are real WebP files, and are small', () => {
  let total = 0;
  for (const f of ['wing', 'tip', 'body', 'glow-wing', 'glow-body']) {
    const b = fs.readFileSync(path.join(pub, 'img/eagle', f + '.webp'));
    assert.equal(b.slice(0, 4).toString(), 'RIFF', f); assert.equal(b.slice(8, 12).toString(), 'WEBP', f); total += b.length;
    assert.ok(html.includes('/img/eagle/' + f + '.webp'), f + ' is not used by index.html');
  }
  assert.ok(total < 150 * 1024, 'eagle assets grew beyond 150 KB: ' + total);
});

test('index.html: loading screen is the first thing in <body>, styled before the app CSS, and nothing blocks the first paint', () => {
  assert.ok(/<body>\s*(<!--[\s\S]*?-->\s*)?<div id="eagle-splash"/.test(html), 'splash must come first in <body>');
  assert.ok(html.indexOf('/eagle-loader.css') < html.indexOf('/style.css'), 'eagle-loader.css before style.css');
  assert.ok(html.indexOf('/eagle-loader.js') < html.indexOf('/core.js'), 'eagle-loader.js must load before core.js (core calls EagleLoader)');
  assert.ok(/<script defer src="\/katex\/katex\.min\.js">/.test(html) && /<script defer src="\/katex\/contrib\/auto-render\.min\.js">/.test(html), 'KaTeX scripts must be deferred');
  assert.ok(/<link rel="stylesheet" href="\/katex\/katex\.min\.css" media="print" id="katex-css">/.test(html), 'KaTeX CSS must be non-blocking (core.js switches it to all)');
  assert.ok(/<noscript>[\s\S]*#eagle-splash\{display:none\}/.test(html), 'a no-JavaScript visitor must not be left on an endless splash');
  assert.ok(/class="es-failsafe"/.test(html));
});

test('animation only uses compositor properties (transform, opacity, visibility)', () => {
  const blocks = [...css.matchAll(/@keyframes\s+\w+\s*\{([\s\S]*?\})\s*\}/g)].map(m => m[1]);
  assert.ok(blocks.length >= 9, 'expected the keyframes to be found, got ' + blocks.length);
  for (const b of blocks) for (const m of b.matchAll(/([a-z-]+)\s*:/g)) assert.ok(['transform', 'opacity', 'visibility'].includes(m[1]), 'keyframes animate ' + m[1] + ' (causes layout/paint)');
  assert.ok(!/\bfilter\s*:/.test(css), 'filters are expensive to animate; glow is baked into the images');
});

test('motion is optional: every visible state is the default, with a reduced-motion block', () => {
  assert.ok(/@media \(prefers-reduced-motion: reduce\)/.test(css));
  assert.ok(/\.is-ready \.es-eagle \{ opacity: 1;/.test(css), 'eagle visibility must not depend on an animation (style.css disables animations for reduced motion)');
  assert.ok(/\.es-streak \{ display: none; \}/.test(css), 'decorative streaks are off for reduced motion');
});

test('loader has no external requests, no browser storage, no fake percentage; CSP-safe (no inline handlers/eval)', () => {
  for (const [n, t] of [['css', css], ['js', js]]) {
    assert.ok(!/https?:\/\//.test(t), n + ' references an external URL'); assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(t), n + ' touches storage');
    assert.ok(!/\beval\b|new Function|javascript:/.test(t), n); assert.ok(!/\bon(click|load|error)\s*=\s*["']/.test(t), n);
  }
  assert.ok(!/\d\s*%['"`<]/.test(js.replace(/\/\*[\s\S]*?\*\//g, '')), 'a percentage must never be displayed');
  for (const m of ['Preparing your examination environment...', 'Loading your dashboard...', 'Synchronizing your data...', 'Almost ready...']) assert.ok(js.includes(m), m);
});

test('safety: never covers a live exam; has a watchdog, an error state and a retry', () => {
  const player = read('student.js'); assert.ok(player.includes('class="xwrap"') || player.includes("'xwrap'") || /xwrap/.test(player), 'exam player root class changed');
  assert.ok(js.includes("querySelector('.xwrap')"), 'examLive() guard missing');
  assert.ok(/function timedOut\(/.test(js) && /timeout: \{/.test(js), 'watchdog missing');
  assert.ok(/function fail\(/.test(js) && /es-retry/.test(js), 'error state / retry missing');
});

test('core.js wiring: reveal only when content is rendered; start-up failure is reported honestly; API calls cannot queue behind a hung one', () => {
  assert.ok(/if \(!keepLoader\) EagleLoader\.end\(\)/.test(core), 'render() must end the loader');
  assert.ok(/keepLoader: true/.test(core), 'loading() must not end the loader');
  assert.ok(/EagleLoader\.isActive\(\)\) return EagleLoader\.fail\(/.test(core), 'errorPage must report on the loader');
  assert.ok(/catch \(e\) \{ state\.bootFailed = true; return EagleLoader\.fail\(/.test(core), 'boot() must not treat a failed /me as signed-out');
  assert.ok(/if \(state\.bootFailed\) return;/.test(core), 'route() must not run over a failed start-up');
  assert.ok(/cache: 'no-store'/.test(core), "api() fetch needs cache:'no-store' (retry otherwise queues behind a hung request)");
  assert.ok(/const EagleLoader = window\.EagleLoader \|\|/.test(core), 'core.js needs a no-op fallback so a cached older index.html cannot break the app after a deploy');
  for (const f of ['student.js', 'otp.js', 'admin.js']) assert.ok(/EagleLoader\./.test(read(f)), f + ' integration missing');
});

test('full-screen loader is limited to dashboards and exam preparation (not every request)', () => {
  const m = core.match(/const FULL_LOAD = (\[\[[\s\S]*?\]\]);/); assert.ok(m, 'FULL_LOAD table missing');
  assert.equal((m[1].match(/'dashboard'/g) || []).length, 3); assert.equal((m[1].match(/'exam'/g) || []).length, 1);
  assert.ok(!/EagleLoader\.begin/.test(read('teacher.js')) && !/EagleLoader\.begin/.test(read('students.js')), 'ordinary views must keep the small spinner');
});
