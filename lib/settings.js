'use strict';
// School settings: validated on write, cached nowhere (one tiny row), exposed read-only to every signed-in user.
const { db } = require('./db');
const { fail } = require('./http');
const validTz = tz => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return typeof tz === 'string' && tz.length < 60; } catch { return false; } };
const parse = (s, d) => { try { const v = JSON.parse(s); return v ?? d; } catch { return d; } };
async function get() {
  const r = await db.prepare('SELECT * FROM school_settings WHERE id=1').get();
  return { school_name: r.school_name, timezone: r.timezone, locale: r.locale, calendar: r.calendar, default_pass_mark: r.default_pass_mark, grading_scale: parse(r.grading_scale, []), terms: parse(r.terms, []), brand_color: r.brand_color };
}
async function update(b = {}) {
  const cur = await get(), n = { ...cur };
  if (b.school_name !== undefined) { n.school_name = String(b.school_name).trim(); if (!n.school_name || n.school_name.length > 80) fail('School name must be 1 to 80 characters.'); }
  if (b.timezone !== undefined) { if (!validTz(b.timezone)) fail('That is not a valid time zone (for example Africa/Addis_Ababa).'); n.timezone = b.timezone; }
  if (b.locale !== undefined) { if (!['en', 'am'].includes(b.locale)) fail('Language must be en or am.'); n.locale = b.locale; }
  if (b.calendar !== undefined) { if (!['gregory', 'ethiopic'].includes(b.calendar)) fail('Calendar must be gregory or ethiopic.'); n.calendar = b.calendar; }
  if (b.default_pass_mark !== undefined) { const p = Number(b.default_pass_mark); if (!(p >= 0 && p <= 100)) fail('The pass mark must be between 0 and 100 percent.'); n.default_pass_mark = p; }
  if (b.brand_color !== undefined) { if (!/^#[0-9a-fA-F]{6}$/.test(b.brand_color)) fail('Brand colour must look like #0b1f4d.'); n.brand_color = b.brand_color.toLowerCase(); }
  if (b.terms !== undefined) { const t = (Array.isArray(b.terms) ? b.terms : []).map(x => String(x).trim()).filter(Boolean); if (t.length < 1 || t.length > 8 || t.some(x => x.length > 30) || new Set(t.map(x => x.toLowerCase())).size !== t.length) fail('Give 1 to 8 different terms, each up to 30 characters.'); n.terms = t; }
  if (b.grading_scale !== undefined) {
    const g = Array.isArray(b.grading_scale) ? b.grading_scale.map(x => ({ min: Number(x?.min), label: String(x?.label ?? '').trim() })) : null;
    if (!g || g.length > 12 || g.some(x => !(x.min >= 0 && x.min <= 100) || !x.label || x.label.length > 12)) fail('Each grade needs a minimum percent (0 to 100) and a short label.');
    if (g.length && !g.some(x => x.min === 0)) fail('The lowest grade must start at 0 percent so every score has a grade.');
    if (new Set(g.map(x => x.min)).size !== g.length) fail('Two grades cannot have the same minimum percent.');
    n.grading_scale = g.sort((a, c) => c.min - a.min);
  }
  await db.prepare('UPDATE school_settings SET school_name=?,timezone=?,locale=?,calendar=?,default_pass_mark=?,grading_scale=?,terms=?,brand_color=?,updated=? WHERE id=1')
    .run(n.school_name, n.timezone, n.locale, n.calendar, n.default_pass_mark, JSON.stringify(n.grading_scale), JSON.stringify(n.terms), n.brand_color, Date.now());
  return { before: cur, after: n };
}
module.exports = { get, update, validTz };
