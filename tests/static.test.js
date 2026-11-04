const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const pub = path.join(__dirname, '..', 'public'), files = fs.readdirSync(pub).filter(f => /\.(js|html)$/.test(f));
test('no inline event handlers anywhere in the front end (the CSP blocks them, so they would silently never run)', () => {
  const bad = []; for (const f of files) { const t = fs.readFileSync(path.join(pub, f), 'utf8'); for (const m of t.matchAll(/\son(click|change|input|submit|load|error|keydown|keyup|focus|blur|mouse\w+)\s*=\s*\\?["']/gi)) bad.push(`${f}: ${m[0].trim()}`); if (/javascript:/i.test(t)) bad.push(f + ': javascript: URL'); }
  assert.deepEqual(bad, []);
});
test('every front-end script parses', () => { for (const f of files.filter(f => f.endsWith('.js'))) assert.doesNotThrow(() => new Function(fs.readFileSync(path.join(pub, f), 'utf8')), f); });
test('index.html loads tz.js before core.js, and students.js before admin.js (admin.js starts the app)', () => {
  const h = fs.readFileSync(path.join(pub, 'index.html'), 'utf8'), at = s => h.indexOf(`/${s}"`); assert.ok(at('tz.js') > 0 && at('tz.js') < at('core.js') && at('students.js') < at('admin.js'));
});
