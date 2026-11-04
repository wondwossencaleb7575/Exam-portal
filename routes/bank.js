const express = require('express');
const { db } = require('../lib/db');
const A = require('../lib/auth');
const { wrap, fail, notFound, idOf, paging } = require('../lib/http');
const { cleanQuestion } = require('../lib/validate');
const { audit } = require('../lib/audit');
const r = express.Router();
r.use(A.requireAuth({ roles: ['teacher'] }));
const parse = q => ({ ...q, options: JSON.parse(q.options), key: JSON.parse(q.key), settings: JSON.parse(q.settings) });
const mine = async req => { const q = await db.prepare('SELECT * FROM questions WHERE id=? AND owner_id=?').get(idOf(req.params.id), req.user.id); if (!q) notFound(); return q; };
async function save(id, req, c) {
  const sid = req.body.subject_id ? Number(req.body.subject_id) : null, j = JSON.stringify, now = Date.now();
  if (id) await db.prepare('UPDATE questions SET subject_id=?,type=?,stem=?,options=?,key=?,settings=?,marks=?,topic=?,difficulty=?,explanation=?,image_id=?,version=version+1,updated=? WHERE id=?')
    .run(sid, c.type, c.stem, j(c.options), j(c.key), j(c.settings), c.marks, c.topic, c.difficulty, c.explanation, c.image_id, now, id);
  else id = (await db.prepare('INSERT INTO questions(owner_id,subject_id,type,stem,options,key,settings,marks,topic,difficulty,explanation,image_id,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id')
    .run(req.user.id, sid, c.type, c.stem, j(c.options), j(c.key), j(c.settings), c.marks, c.topic, c.difficulty, c.explanation, c.image_id, now, now)).lastInsertRowid;
  return id;
}
r.get('/', wrap(async (req, res) => {
  const { page, size, offset } = paging(req, 20), f = ['owner_id=?', 'archived=0'], p = [req.user.id];
  if (req.query.q) { f.push('(stem ILIKE ? OR topic ILIKE ?)'); p.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  for (const k of ['topic', 'difficulty', 'type']) if (req.query[k]) { f.push(`${k}=?`); p.push(String(req.query[k])); }
  if (req.query.subject_id) { f.push('subject_id=?'); p.push(Number(req.query.subject_id)); }
  const w = f.join(' AND ');
  res.json({ total: (await db.prepare(`SELECT COUNT(*) n FROM questions WHERE ${w}`).get(...p)).n, page, size,
    items: (await db.prepare(`SELECT * FROM questions WHERE ${w} ORDER BY updated DESC LIMIT ? OFFSET ?`).all(...p, size, offset)).map(parse),
    topics: (await db.prepare("SELECT DISTINCT topic FROM questions WHERE owner_id=? AND archived=0 AND topic!='' ORDER BY topic").all(req.user.id)).map(x => x.topic) });
}));
r.get('/:id', wrap(async (req, res) => res.json(parse(await mine(req)))));
r.post('/', wrap(async (req, res) => { const id = await save(null, req, await cleanQuestion(req.body, { ownerId: req.user.id })); await audit(req.user, 'question.create', 'question', id); res.json({ id }); }));
r.put('/:id', wrap(async (req, res) => { const q = await mine(req); await save(q.id, req, await cleanQuestion(req.body, { ownerId: req.user.id })); await audit(req.user, 'question.update', 'question', q.id); res.json({ ok: true }); }));
r.post('/:id/duplicate', wrap(async (req, res) => {
  const q = parse(await mine(req)); const id = await save(null, { user: req.user, body: { subject_id: q.subject_id } }, { ...q, stem: q.stem });
  await audit(req.user, 'question.duplicate', 'question', id, { from: q.id }); res.json({ id });
}));
r.delete('/:id', wrap(async (req, res) => { const q = await mine(req); await db.prepare('UPDATE questions SET archived=1 WHERE id=?').run(q.id); await audit(req.user, 'question.archive', 'question', q.id); res.json({ ok: true }); }));
module.exports = r;
