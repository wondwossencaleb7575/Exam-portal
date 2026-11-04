// npm run migrate: apply pending database migrations (supabase/migrations/*.sql). See docs/SUPABASE.md.
require('../lib/migrate').migrate({ log: m => console.log(m) })
  .then(r => { console.log(r.applied.length ? `Applied ${r.applied.length} migration(s).` : 'Database is up to date.'); })
  .catch(e => { console.error(e.message); process.exit(1); });
