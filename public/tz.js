/* School time zone + calendar helpers. Pure functions (no DOM), so they are unit-tested in Node.
   Every stored time is an absolute UTC millisecond count. These functions only decide how a moment is DISPLAYED and how a typed wall-clock time is INTERPRETED:
   always in the school's time zone, never in whatever zone the teacher's computer happens to be set to.
   Ethiopian calendar output comes from the browser's built-in ICU (Intl 'ethiopic'); no hand-written date conversion. */
(function (root) {
  const DEFAULT_TZ = 'Africa/Addis_Ababa';
  const parts = (ms, tz) => {
    const o = {}; for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms))) o[p.type] = p.value; return o;
  };
  // epoch ms -> "YYYY-MM-DDTHH:mm" (the value format of <input type="datetime-local">) as the wall clock in tz
  function toZoned(ms, tz = DEFAULT_TZ) { if (ms == null || ms === '') return ''; const p = parts(ms, tz); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; }
  // "YYYY-MM-DDTHH:mm" typed as a wall clock in tz -> epoch ms (iterates so zones with daylight saving also resolve correctly)
  function fromZoned(s, tz = DEFAULT_TZ) {
    const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(s || ''); if (!m) return null;
    const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]); let t = want;
    for (let i = 0; i < 4; i++) { const p = parts(t, tz), got = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute); if (got === want) return t; t += want - got; }
    return t;
  }
  // Human display. calendar 'ethiopic' uses ICU; locale 'am' gives Amharic month names.
  function format(ms, o = {}) {
    if (!ms) return '–';
    const tz = o.tz || DEFAULT_TZ, cal = o.calendar === 'ethiopic' ? '-u-ca-ethiopic' : '', loc = (o.locale === 'am' ? 'am-ET' : 'en-US') + cal;
    return new Intl.DateTimeFormat(loc, { dateStyle: 'medium', ...(o.time === false ? {} : { timeStyle: 'short' }), timeZone: tz }).format(new Date(ms));
  }
  const api = { toZoned, fromZoned, format, DEFAULT_TZ };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TZ = api;
})(typeof self !== 'undefined' ? self : this);
