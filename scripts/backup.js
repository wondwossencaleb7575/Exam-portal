// npm run backup [file]: a portable, checksummed, off-platform copy of the durable data (see docs/RECOVERY.md).
// Run it from any machine that can reach the database (a laptop, a cron job, a CI schedule) with DATABASE_URL set.
// The file contains password hashes and student records: store it like a password vault, never in Git.
const path = require('path'), fs = require('fs');
const B = require('../lib/backup');
(async () => {
  const dir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = process.argv[2] || path.join(dir, 'eagle-' + new Date().toISOString().replace(/[:.]/g, '-') + '.ndjson.gz');
  await B.exportTo(file); const v = await B.verifyFile(file);
  if (!v.ok) { console.error('BACKUP FAILED verification: ' + v.problems.join('; ')); process.exit(1); }
  console.log(`Backup written and verified: ${file}\n` + Object.entries(v.tables).map(([t, n]) => `  ${t}: ${n}`).join('\n'));
})().catch(e => { console.error('BACKUP FAILED: ' + e.message); process.exit(1); });
