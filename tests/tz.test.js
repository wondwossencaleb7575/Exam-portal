const test = require('node:test'), assert = require('node:assert/strict');
const TZ = require('../public/tz.js');
test('wall clock <-> epoch round trips in the school time zone (UTC+3, no daylight saving)', () => {
  const t = TZ.fromZoned('2026-10-20T09:30', 'Africa/Addis_Ababa'); assert.equal(new Date(t).toISOString(), '2026-10-20T06:30:00.000Z'); // 09:30 in Addis = 06:30 UTC
  assert.equal(TZ.toZoned(t, 'Africa/Addis_Ababa'), '2026-10-20T09:30');
  for (const s of ['2026-01-01T00:00', '2026-12-31T23:59', '2027-02-28T12:00']) assert.equal(TZ.toZoned(TZ.fromZoned(s), TZ.DEFAULT_TZ), s);
});
test('the SAME typed time means different moments in different zones: the browser zone no longer decides', () => {
  const addis = TZ.fromZoned('2026-10-20T09:00', 'Africa/Addis_Ababa'), london = TZ.fromZoned('2026-10-20T09:00', 'Europe/London'), ny = TZ.fromZoned('2026-10-20T09:00', 'America/New_York');
  assert.equal(london - addis, 3600e3 * (3 - 1)); // Addis is UTC+3, London (British Summer Time) is UTC+1: 09:00 in Addis happens 2 hours before 09:00 in London
  assert.ok(addis < london && london < ny);
  assert.equal(new Date(london).toISOString(), '2026-10-20T08:00:00.000Z'); assert.equal(new Date(ny).toISOString(), '2026-10-20T13:00:00.000Z');
});
test('daylight-saving zones resolve correctly on both sides of a change', () => {
  assert.equal(new Date(TZ.fromZoned('2026-03-07T12:00', 'America/New_York')).toISOString(), '2026-03-07T17:00:00.000Z'); // EST
  assert.equal(new Date(TZ.fromZoned('2026-03-09T12:00', 'America/New_York')).toISOString(), '2026-03-09T16:00:00.000Z'); // EDT
});
test('invalid input is rejected, not guessed', () => { assert.equal(TZ.fromZoned(''), null); assert.equal(TZ.fromZoned('tomorrow'), null); assert.equal(TZ.toZoned(null), ''); assert.equal(TZ.format(null), '–'); });
test('Ethiopian calendar comes from ICU and matches known dates (Enkutatash, Meskerem 1)', () => {
  const d = Date.UTC(2025, 8, 11, 9);
  assert.match(TZ.format(d, { calendar: 'ethiopic', time: false }), /Meskerem 1, 2018/);
  assert.match(TZ.format(Date.UTC(2026, 8, 11, 9), { calendar: 'ethiopic', time: false }), /Meskerem 1, 2019/);
  assert.match(TZ.format(d, { calendar: 'ethiopic', locale: 'am', time: false }), /መስከረም/); // Amharic month name
  assert.match(TZ.format(d, { time: false }), /Sep 11, 2025/);
  // the school zone, not the machine, decides the calendar DAY: 22:30 UTC on Sep 10 is already Sep 11 in Addis
  assert.match(TZ.format(Date.UTC(2025, 8, 10, 22, 30), { calendar: 'ethiopic', time: false }), /Meskerem 1, 2018/);
});
