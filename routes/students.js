const express = require('express');
const A = require('../lib/auth');
const { wrap, fail, notFound, idOf, paging } = require('../lib/http');
const { audit } = require('../lib/audit');
const CSV = require('../lib/csv');
const S = require('../lib/students');
const I = require('../lib/studentImport');
const r = express.Router();
r.use(A.requireAuth({ roles: ['teacher', 'admin'] }));
const adminOnly = A.requireAuth({ roles: ['admin'] });
const EXPORT_CAP = 50000;

// Student directory. Admin: all students. Teacher: only students in the teacher's own classes.
r.get('/', wrap(async (req, res) => {
  const f = S.readFilters(req.query), { page, size, offset } = paging(req, 25, 100), ids = req.query.ids ? S.parseIds(req.query.ids) : null;
  res.json({ page, size, ...await S.list(req.user, f, { size, offset }, ids), facets: await S.facets(req.user) });
}));
// Same filters as the list; optional ids= restricts to a selected group (still scope-checked).
r.get('/export.csv', wrap(async (req, res) => {
  const f = S.readFilters(req.query), ids = req.query.ids ? S.parseIds(req.query.ids) : null, list = (await S.allIds(req.user, f, EXPORT_CAP)).filter(id => !ids || ids.includes(id));
  await audit(req.user, 'students.export', 'student', null, { rows: list.length, filters: { q: f.q, class_id: f.class_id, grade: f.grade, academic_year: f.academic_year, status: f.status }, selected: !!ids });
  await CSV.sendCsv(res, 'students', S.EXPORT_HEAD(req.user.role === 'admin'), await S.exportRows(req.user, list));
}));

// ---- Import (administrators). Teachers import into their own class via /api/classes/:id/import-csv/*. ----
r.get('/import/template.csv', adminOnly, wrap((req, res) => res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="students-template.csv"' }).send(CSV.toCsv(I.COLUMNS, []))));
r.get('/import/example.csv', adminOnly, wrap((req, res) => res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="students-example.csv"' }).send(CSV.toCsv(I.COLUMNS, I.templateRows(true)))));
const body = req => { if (typeof req.body.csv !== 'string') fail('Choose a CSV file first.'); return req.body.csv; };
r.post('/import/preview', adminOnly, wrap(async (req, res) => res.json(await CSV.guard(async () => await I.plan(req.user, body(req), { allowUpdate: !!req.body.update_existing })))));
r.post('/import/commit', adminOnly, wrap(async (req, res) => {
  const text = body(req), opts = { allowUpdate: !!req.body.update_existing };
  await CSV.guard(async () => await I.plan(req.user, text, opts)); // validates structure + limits before any write
  try { res.json(await I.run(req.user, text, opts, req.body.digest)); } catch (e) { if (e instanceof CSV.CsvError) fail(e.message); throw e; }
}));

r.get('/:id', wrap(async (req, res) => { const d = await S.detail(req.user, idOf(req.params.id)); if (!d) notFound(); res.json(d); }));
module.exports = r;
