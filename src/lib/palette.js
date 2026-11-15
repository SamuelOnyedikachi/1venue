/**
 * Event colour pairs. Same list as ACCENTS in public/js/app.js (keep them in sync).
 * pickPalette() chooses a pair that fits the event so not every event looks the same.
 */
const PALETTE = [
  ['Ocean', '#2563eb', '#7c3aed'], ['Violet', '#7c3aed', '#db2777'], ['Rose', '#e11d48', '#f59e0b'], ['Sunset', '#ea580c', '#e11d48'],
  ['Gold', '#b7791f', '#ea580c'], ['Emerald', '#059669', '#0891b2'], ['Teal', '#0d9488', '#2563eb'], ['Graphite', '#334155', '#2563eb'],
];
const MOODS = [
  [/\b(animal|wildlife|nature|green|climate|environment|farm|agric|garden|health|wellness|eco)/i, ['Emerald', 'Teal']],
  [/\b(ocean|water|sea|marine|calm|peace|tech|ai|data|cloud|software|code|developer|science)/i, ['Ocean', 'Teal']],
  [/\b(love|valentine|women|wedding|beauty|fashion|art|music|concert|worship|praise)/i, ['Violet', 'Rose']],
  [/\b(youth|party|festival|sport|fitness|energy|launch|summer|food)/i, ['Sunset', 'Rose']],
  [/\b(gold|finance|money|business|invest|leadership|career|award|gala|royal|jubilee|thanksgiving)/i, ['Gold', 'Graphite']],
  [/\b(law|policy|government|security|strategy|board|corporate|research)/i, ['Graphite', 'Ocean']],
  [/\b(prayer|sermon|church|bible|faith|gospel|quran|mosque|ramadan|islam|easter|christmas)/i, ['Violet', 'Gold']],
];
const BY_CATEGORY = { sermon: ['Violet', 'Gold'], concert: ['Violet', 'Rose'], talk_show: ['Sunset', 'Rose'], seminar: ['Ocean', 'Emerald'], webinar: ['Ocean', 'Teal'], workshop: ['Teal', 'Sunset'], presentation: ['Graphite', 'Ocean'], class: ['Emerald', 'Ocean'], meeting: ['Teal', 'Graphite'] };
const byName = (n) => PALETTE.find((p) => p[0].toLowerCase() === String(n || '').toLowerCase());
const out = (p) => ({ name: p[0], accent: p[1], accent2: p[2] });
function hash(s) { let x = 2166136261; for (const c of String(s)) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619); } return Math.abs(x); }

/** AI suggestion (a palette name) wins when valid; else keywords; else category; spread by title hash. */
function pickPalette({ suggestion, title = '', description = '', category = '' } = {}) {
  const s = byName(suggestion);
  if (s) return out(s);
  const text = `${title} ${description}`;
  const mood = MOODS.find(([re]) => re.test(text));
  const options = (mood && mood[1]) || BY_CATEGORY[category] || PALETTE.map((p) => p[0]);
  return out(byName(options[hash(title || category) % options.length]));
}

module.exports = { PALETTE, pickPalette };
