// Which fields voice typing may listen in. Pure (works on any element-like object): unit-tested in Node.
// Never: password, email, phone, number, one-time codes, payment fields, or anything marked data-voice="off".
const SKIP_TYPES = /^(password|email|tel|number|hidden|file|checkbox|radio|range|color|submit|button|reset|image|month|week|time)$/i;
const SENSITIVE = /(pass(word|code)?|otp|one[-_ ]?time|\bcode\b|verif|pin\b|cvv|cvc|card|cc-|iban|account[-_ ]?num|phone|mobile|\btel\b|e-?mail|bvn|\bnin\b|secret|token|api[-_ ]?key|\bkey\b)/i;
export function voiceKind(el) {
  if (!el || el.disabled || el.readOnly) return null;
  if (el.closest && el.closest('[data-voice="off"]')) return null;
  if (el.dataset && el.dataset.voice === 'off') return null;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return SENSITIVE.test(`${el.name || ''} ${el.id || ''} ${el.getAttribute('autocomplete') || ''} ${el.getAttribute('aria-label') || ''}`) ? null : 'text';
  if (tag !== 'INPUT') return null;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  if (type === 'datetime-local' || type === 'date') return 'date';
  if (SKIP_TYPES.test(type)) return null;
  if (!/^(text|search|url|)$/.test(type)) return null;
  const im = (el.getAttribute('inputmode') || '').toLowerCase();
  if (/^(numeric|decimal|tel|email)$/.test(im)) return null;
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  if (/(one-time-code|password|email|tel|cc-|username)/.test(ac)) return null;
  if (SENSITIVE.test(`${el.name || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''}`)) return null;
  if (el.closest && el.closest('.cmdbar')) return 'bar';
  return 'text';
}

