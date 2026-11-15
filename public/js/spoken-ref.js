// Spoken scripture references -> what the / bar understands, so voice can SUGGEST a passage
// (the host still taps to open it).
//   "John chapter three verse sixteen"          -> "John 3:16"
//   "turn with me to first Corinthians 13"      -> "1 Corinthians 13"
//   "Psalm one hundred and nineteen verse 105"  -> "Psalm 119:105"
//   "Surah Al-Kahf verse ten" / "surah 18 10"    -> "surah al kahf 10" / "surah 18 10"
// Pure (no DOM): unit-tested in Node.

const SMALL = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORD = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3 };

/** "one hundred and nineteen" -> "119", "twenty-three" -> "23", "two fifteen" -> "2 15" (inside a sentence). */
export function wordsToDigits(text) {
  const toks = String(text).replace(/(?<=[a-z])-(?=[a-z])/g, ' ').split(/\s+/).filter(Boolean);
  const out = []; let i = 0;
  while (i < toks.length) {
    let cur = 0, last = null, j = i, used = 0;
    while (j < toks.length) {
      const t = toks[j];
      if (t in SMALL) {
        const v = SMALL[t];
        if (last === 'small' || last === 'teen' || (last === 'tens' && v >= 10)) break;
        cur += v; last = v >= 10 ? 'teen' : 'small';
      } else if (t in TENS) {
        if (last === 'small' || last === 'teen' || last === 'tens') break;
        cur += TENS[t]; last = 'tens';
      } else if (t === 'hundred') {
        if (!(last === 'small' || last === null) || cur >= 10) break;
        cur = (cur || 1) * 100; last = 'hundred';
      } else if (t === 'and' && last === 'hundred' && j + 1 < toks.length && (toks[j + 1] in SMALL || toks[j + 1] in TENS)) { j++; continue; }
      else break;
      used++; j++;
    }
    if (!used) { out.push(toks[i]); i++; continue; }
    out.push(String(cur)); i = j;
  }
  return out.join(' ');
}

// Bible book names as spoken (lowercase), longest first so "song of solomon" beats "song".
const BOOKS = ['genesis', 'exodus', 'leviticus', 'numbers', 'deuteronomy', 'joshua', 'judges', 'ruth', 'samuel', 'kings', 'chronicles', 'ezra', 'nehemiah', 'esther', 'job',
  'psalms', 'psalm', 'proverbs', 'ecclesiastes', 'song of solomon', 'song of songs', 'songs of solomon', 'isaiah', 'jeremiah', 'lamentations', 'ezekiel', 'daniel', 'hosea', 'joel', 'amos',
  'obadiah', 'jonah', 'micah', 'nahum', 'habakkuk', 'zephaniah', 'haggai', 'zechariah', 'malachi', 'matthew', 'mark', 'luke', 'john', 'acts', 'romans', 'corinthians',
  'galatians', 'ephesians', 'philippians', 'colossians', 'thessalonians', 'timothy', 'titus', 'philemon', 'hebrews', 'james', 'peter', 'jude', 'revelation', 'revelations',
  'tobit', 'judith', 'wisdom', 'sirach', 'baruch', 'maccabees'].sort((a, b) => b.length - a.length);
const NUMBERED = new Set(['samuel', 'kings', 'chronicles', 'corinthians', 'thessalonians', 'timothy', 'peter', 'john', 'maccabees']);
const CANON = { psalms: 'Psalm', revelations: 'Revelation', 'songs of solomon': 'Song of Solomon', 'song of songs': 'Song of Solomon' };
const title = (s) => CANON[s] || s.replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bOf\b/g, 'of');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BOOK_RE = new RegExp(`(?:\\b([1-3])\\s+)?\\b(${BOOKS.map(esc).join('|')})\\s+(\\d{1,3})(?:\\s*[:.]\\s*|\\s+)?(\\d{1,3})?(?:\\s*-\\s*(\\d{1,3}))?`, 'i');

function prep(text) {
  let t = String(text || '').toLowerCase().replace(/[“”"’',;!?]/g, ' ').replace(/\.(?!\d)/g, ' ');
  t = t.replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1');
  t = wordsToDigits(t);
  t = t.replace(/\b(first|second|third|1st|2nd|3rd)\s+(?=[a-z])/g, (m, w) => `${ORD[w]} `);
  t = t.replace(/\b(?:the\s+)?(?:book|gospel|epistle|letter)\s+(?:of|according to)\s+(?:saint\s+|st\s+)?/g, '');
  t = t.replace(/\bchapters?\s+/g, '').replace(/\b(?:verses?|vs?)\s+/g, ':').replace(/\s*:\s*/g, ':');
  t = t.replace(/(\d)\s+(?:to|through|thru|till|until)\s+(\d)/g, '$1-$2').replace(/(\d)\s+and\s+(\d)/g, '$1-$2');
  return t.replace(/\s+/g, ' ').trim();
}

/** A scripture reference found in speech, as bar text, or null. */
export function spokenReference(text) {
  const t = prep(text);
  // Qur'an: "surah al kahf 10", "surat yasin", "quran 2 255", "surah 18 verse 10"
  const q = t.match(/\b(?:surah|surat|sura|quran|koran)\s+((?:al|an|ar|as|at|ad|ash|az)?\s?[a-z]+(?:\s[a-z]+)?|\d{1,3})(?:\s*:?\s*(\d{1,3}))?/);
  if (q && !/^(chapter|verse)$/.test(q[1])) {
    const name = q[1].replace(/:/g, '').trim();
    return `surah ${name}${q[2] ? ' ' + q[2] : ''}`.replace(/\s+/g, ' ');
  }
  const m = t.match(BOOK_RE);
  if (!m) return null;
  const [, n, book, ch, v1, v2] = m;
  if (n && !NUMBERED.has(book)) return null;
  let ref = `${n ? n + ' ' : ''}${title(book)} ${Number(ch)}`;
  if (v1) ref += `:${Number(v1)}${v2 ? '-' + Number(v2) : ''}`;
  return ref;
}

/** What voice should put in the / bar: a reference when one was spoken, else the cleaned sentence. */
export function spokenToQuery(text) {
  const ref = spokenReference(text);
  if (ref) return ref;
  return String(text || '').replace(/\s+/g, ' ').replace(/[.!?。]+$/, '').trim();
}
