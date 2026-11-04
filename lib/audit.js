const { db } = require('./db');
// Never pass passwords, tokens or other secrets in `detail`.
async function audit(actor, action, resource, resourceId, detail) {
  await db.prepare('INSERT INTO audit(ts,actor_id,actor_email,action,resource,resource_id,detail) VALUES(?,?,?,?,?,?,?)')
    .run(Date.now(), actor?.id ?? null, actor?.email ?? 'system', action, resource ?? null, resourceId ?? null, detail ? JSON.stringify(detail).slice(0, 4000) : null);
}
module.exports = { audit };
