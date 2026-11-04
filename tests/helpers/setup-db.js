'use strict';
(function () {
// Preloaded into every test process (node --require): gives each test file its own freshly migrated PostgreSQL database and removes it at exit.
const { execFileSync } = require('child_process'), path = require('path');
if (process.execArgv.includes('--test')) return; // the test-runner parent process needs no database; each test file (child process) gets its own
const script = path.join(__dirname, '..', '..', 'scripts', 'test-db.js');
let made;
try { made = JSON.parse(execFileSync(process.execPath, [script, 'create'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
catch (e) { console.error('Could not create the test database:\n' + String(e.stderr || e.message)); process.exit(2); }
process.env.OTP_MIN_RESPONSE_MS = process.env.OTP_MIN_RESPONSE_MS ?? '0'; // no artificial delay in tests (a dedicated test checks the floor)
Object.assign(process.env, { DATABASE_URL: made.app, MIGRATION_DATABASE_URL: made.admin, TEST_ADMIN_DATABASE_URL: made.admin, TEST_DB_NAME: made.name });
process.on('exit', () => { try { execFileSync(process.execPath, [script, 'drop', made.name], { stdio: 'ignore' }); } catch {} });
})();
