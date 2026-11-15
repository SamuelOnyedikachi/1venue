/**
 * Fine-tune a feed post: clean grammar and punctuation, keep the writer's
 * meaning, voice and language (including Nigerian Pidgin), and leave
 * scripture references and @mentions untouched.
 */
'use strict';

const MENTION = /@[a-zA-Z0-9._]{2,30}/g;
// Bible ("John 3:16", "1 Corinthians 13:4-7") and simple Qur'an ("Surah Al-Kahf 10")
const SCRIPTURE = /\b(?:(?:[1-3]|I{1,3})\s+)?[A-Za-z][A-Za-z]+(?:\s+[A-Za-z]+)?\s+\d+:\d+(?:\s*[-–]\s*\d+)?\b|\bSurah\s+[\w'-]+(?:\s+\d+(?:\s*[-–]\s*\d+)?)?\b/g;

function protect(text) {
  const held = [];
  const park = (m) => {
    held.push(m);
    return `\u0000${held.length - 1}\u0000`;
  };
  let t = String(text || '');
  t = t.replace(MENTION, park);
  t = t.replace(SCRIPTURE, park);
  return { t, held };
}
function restore(t, held) {
  return String(t).replace(/\u0000(\d+)\u0000/g, (_, i) => held[Number(i)] || '');
}

/** Deterministic local fallback used when AI_MOCK=true or no provider is configured. */
function mockFineTune(text) {
  const { t, held } = protect(text);
  let s = t.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  s = s.replace(/\s+([,.;:!?])/g, '$1');
  s = s.replace(/([,.;:!?])(?![\s\u0000])/g, '$1 ');
  s = s.replace(/(^|[.!?]\s+)([a-z])/g, (_, a, b) => a + b.toUpperCase());
  if (s && !/[.!?…]$/.test(s) && !s.endsWith('\u0000')) s += '.';
  return restore(s, held).replace(/[ ]+\n/g, '\n').trim();
}

const SYSTEM = `You clean up short social posts for 1venue, a Nigerian live-events app.
Rules:
- Fix grammar, punctuation and obvious typos only.
- Keep the writer's meaning, voice, tone and language. If they wrote Nigerian Pidgin or mixed English, keep that. Do not translate.
- Leave scripture references (e.g. John 3:16, Psalm 23:1, Surah Al-Kahf) exactly as written.
- Leave @mentions (e.g. @adaeze) exactly as written.
- Do not add hashtags, emojis, titles or commentary the writer did not use.
- Reply with the cleaned post only, no quotes or preamble.`;

module.exports = { MENTION, SCRIPTURE, protect, restore, mockFineTune, SYSTEM };
