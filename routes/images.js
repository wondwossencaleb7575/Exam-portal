const express = require('express');
const { db } = require('../lib/db');
const A = require('../lib/auth');
const { wrap, fail, notFound, idOf } = require('../lib/http');
const r = express.Router();
r.use(A.requireAuth());
function sniff(b) {
  if (b.length > 12 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
  if (b.length > 12 && b.subarray(0, 4).toString() === 'GIF8') return 'image/gif';
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null; // SVG and everything else is rejected (script risk)
}
r.post('/', A.requireAuth({ roles: ['teacher'] }), wrap(async (req, res) => {
  const m = /^data:image\/(?:jpeg|png|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.data || ''));
  if (!m) fail('Upload a JPEG, PNG, GIF or WebP image.');
  const buf = Buffer.from(m[1], 'base64'); if (buf.length > 2 * 1024 * 1024) fail('Image is too large (max 2 MB).');
  const mime = sniff(buf); if (!mime) fail('That file is not a valid image.');
  res.json({ id: (await db.prepare('INSERT INTO images(owner_id,mime,data,created) VALUES(?,?,?,?) RETURNING id').run(req.user.id, mime, buf, Date.now())).lastInsertRowid });
}));
// Served only to the owner or to a student who has an attempt on an exam using the image.
r.get('/:id', wrap(async (req, res) => {
  const id = idOf(req.params.id), img = await db.prepare('SELECT * FROM images WHERE id=?').get(id); if (!img) notFound();
  const ok = img.owner_id === req.user.id || (req.user.role === 'student' && await db.prepare('SELECT 1 FROM exam_questions q JOIN attempts a ON a.exam_id=q.exam_id WHERE q.image_id=? AND a.student_id=?').get(id, req.user.id));
  if (!ok) notFound();
  res.set({ 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' }).send(Buffer.from(img.data));
}));
module.exports = r;
