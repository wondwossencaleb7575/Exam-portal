// npm run verify-backup <file>: re-read an export and check every row count and SHA-256 against its manifest.
const B = require('../lib/backup');
const f = process.argv[2]; if (!f) { console.error('usage: node scripts/verify-backup.js <file.ndjson.gz>'); process.exit(2); }
B.verifyFile(f).then(v => { if (v.ok) console.log('OK: ' + f + ' (created ' + v.created + ')\n' + Object.entries(v.tables).map(([t, n]) => `  ${t}: ${n}`).join('\n')); else { console.error('DAMAGED: ' + v.problems.join('; ')); process.exit(1); } })
  .catch(e => { console.error('DAMAGED: ' + e.message); process.exit(1); });
