// Client-side check for "Write it for me": generate from the form only when the
// title and description together have enough words; otherwise ask for notes first.
// Keep MIN_WORDS in sync with src/features/ai/draft.js.
export const MIN_WORDS = 15;
export function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}
export function isRichInput(title, description, min = MIN_WORDS) {
  return wordCount(`${String(title || '').trim()} ${String(description || '').trim()}`) >= min;
}
