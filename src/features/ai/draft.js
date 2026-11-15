/**
 * Helpers for "Write it for me": is the host's title+description rich enough to generate
 * from, and can we pull a date, time, venue or category out of free text?
 *
 * Dates go through the same chrono-node parser as /api/voice/date, so
 * "next Friday at 6pm" fills the Starts (and Ends, when a range is spoken) fields.
 */
'use strict';
const { parseSpokenDate } = require('../voice/date');

const MIN_WORDS = 15;
const CATEGORY_KEYS = ['talk_show', 'presentation', 'seminar', 'sermon', 'webinar', 'workshop', 'meeting', 'concert', 'class', 'other'];
const CATEGORY_HINTS = {
  talk_show: ['talk show', 'talk-show', 'panel discussion', 'podcast'],
  presentation: ['presentation', 'keynote', 'pitch night', 'demo day'],
  seminar: ['seminar'],
  sermon: ['sermon', 'sunday service', 'worship service', 'church service'],
  webinar: ['webinar'],
  workshop: ['workshop'],
  meeting: ['meeting', 'stand-up', 'standup', 'huddle'],
  concert: ['concert', 'live music', 'gig '],
  class: ['class', 'lesson', 'course', 'lecture', 'tutorial'],
};

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/** Title + description together, under MIN_WORDS (15), is too thin to generate from. */
function isRichInput(title, description, min = MIN_WORDS) {
  return wordCount(`${String(title || '').trim()} ${String(description || '').trim()}`) >= min;
}

function guessCategory(text, fallback) {
  const t = String(text || '').toLowerCase();
  for (const [k, words] of Object.entries(CATEGORY_HINTS)) {
    if (words.some((w) => t.includes(w))) return k;
  }
  if (CATEGORY_KEYS.includes(fallback)) return fallback;
  return null;
}

const TIMEISH = /^(?:the\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|noon|midnight|morning|afternoon|evening|night|dawn|dusk|weekend|start|end|least|most|first|last|once|home|work|all)$/i;

function extractVenue(text) {
  const s = String(text || '');
  const patterns = [
    /\bvenue\s*[:\-]\s*([^\n.,]{3,80})/i,
    /\b(?:held\s+)?(?:at|@)\s+(?:the\s+)?([A-Za-z][\w'&.-]*(?:\s+(?:the\s+)?[A-Za-z][\w'&.-]*){0,6}(?:,\s*[A-Za-z][\w'&.-]*)?)/g,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    const global = re.global;
    do {
      m = re.exec(s);
      if (!m) break;
      const v = String(m[1] || '').replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '');
      if (v && v.length >= 3 && v.length <= 80 && !TIMEISH.test(v)) return v;
    } while (global);
  }
  return null;
}

/**
 * Merge the model’s JSON with dates parsed from the host’s free text (preferred)
 * and any "when" / "venue" / "category" the model copied out of the notes.
 */
function enrichDraft(notes, ai = {}, { tzOffset = 0, now, category } = {}) {
  const when = [notes, ai.when, ai.date, ai.startsAt, ai.time].filter(Boolean).join('\n');
  const date = parseSpokenDate(when, { tzOffset, now });
  const venue = String(ai.venue || '').trim() || extractVenue(notes);
  const cat = (CATEGORY_KEYS.includes(ai.category) ? ai.category : null) || guessCategory(notes, category);
  return {
    start: date && date.start || null,
    end: date && date.end || null,
    hasTime: !!(date && date.hasTime),
    endHasTime: !!(date && date.endHasTime),
    venue: venue || null,
    category: cat,
  };
}

module.exports = { MIN_WORDS, CATEGORY_KEYS, wordCount, isRichInput, guessCategory, extractVenue, enrichDraft };
