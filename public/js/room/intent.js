// Decide whether visiting a room URL should create a meeting or join the existing one.
// A leftover sessionStorage venue.intent of { create: true } (often without intent.code)
// must never turn a visit to an existing code into /api/create.
export const fmtCode = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function wantsCreate(intent, code, params = {}) {
  if (params && (params.rejoin === '1' || params.rejoin === 'true' || params.rejoin === true)) return false;
  if (!code) return !!(intent && intent.create);
  if (!intent || !intent.create) return false;
  const ic = fmtCode(intent.code || '');
  return !!(ic && ic === fmtCode(code));
}
