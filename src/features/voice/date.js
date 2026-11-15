/**
 * Spoken / typed dates -> the value a <input type="datetime-local"> wants ("YYYY-MM-DDTHH:mm"),
 * in the speaker's own timezone. Uses chrono-node.
 *
 *   parseSpokenDate('february 16 2027 at 6pm', { now, tzOffset: -60 })
 *     -> { start: '2027-02-16T18:00', end: null, hasTime: true, text: 'february 16 2027 at 6pm' }
 * tzOffset follows Date#getTimezoneOffset (minutes, UTC - local; Lagos = -60).
 */
const chrono = require('chrono-node');

const pad = (n) => String(n).padStart(2, '0');
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const MONTHS = ['january', 'february', 'april', 'august', 'september', 'october', 'november', 'december'];
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// Misheard / misspelt long month names ("februray", "septmber") -> the real name.
const fixMonths = (s) => s.replace(/\b[a-z]{5,}\b/g, (w) => (MONTHS.includes(w) ? w : MONTHS.find((m) => Math.abs(m.length - w.length) <= 2 && lev(w, m) <= 2) || w));
function tidy(text) {
  return fixMonths(String(text || '').toLowerCase())
    .replace(/[“”"]/g, '')
    // "6 p.m." / "6 pm" / "six pm"
    .replace(/\b(a|p)\.\s?m\.?/g, '$1m')
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(am|pm|o'?clock)\b/g, (m, w, s) => `${WORDS[w]} ${s}`)
    .replace(/\bo'?clock\b/g, ':00')
    .replace(/\s+:00/g, ':00')
    .replace(/\bnoon\b/g, '12pm').replace(/\bmidnight\b/g, '12am')
    .replace(/\s+/g, ' ').trim();
}
function wall(comp) {
  return `${comp.get('year')}-${pad(comp.get('month'))}-${pad(comp.get('day'))}T${pad(comp.get('hour'))}:${pad(comp.get('minute'))}`;
}
function parseSpokenDate(text, { now = new Date(), tzOffset = 0 } = {}) {
  const t = tidy(text).slice(0, 200);
  if (!t) return null;
  const ref = { instant: new Date(now), timezone: -Number(tzOffset || 0) }; // chrono: minutes east of UTC
  const results = chrono.parse(t, ref, { forwardDate: true });
  const r = results[0];
  if (!r) return null;
  const hasTime = r.start.isCertain('hour');
  return { start: wall(r.start), end: r.end ? wall(r.end) : null, hasTime, endHasTime: !!(r.end && r.end.isCertain('hour')), text: r.text };
}

module.exports = { parseSpokenDate, tidy };
