'use strict';
// Runs one statement as the PRIVILEGED database role (the migration owner), bypassing the application role's limits. Tests use it to prove
// that a rule is enforced by the database itself (a trigger or constraint), not merely by the application role lacking a privilege.
const { Client } = require('pg');
module.exports = async function adminQuery(sql, params = []) {
  const c = new Client({ connectionString: process.env.TEST_ADMIN_DATABASE_URL }); await c.connect();
  try { await c.query('SET search_path TO eagle, pg_temp'); return await c.query(sql, params); } finally { await c.end(); }
};
