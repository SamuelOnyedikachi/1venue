// Where a popover menu goes, given its anchor's rect and its own size. Pure (no DOM), so it is unit-tested.
// Opens below and to the right of the anchor; flips left when it would cross the right edge and up when
// it would cross the bottom; is clamped inside the viewport with `pad` px to spare; and when it is
// taller than both sides allow, takes the roomier side and scrolls inside (maxHeight).
export function menuPosition(r, mw, mh, vw, vh, { pad = 8, gap = 6 } = {}) {
  const width = Math.min(mw, vw - pad * 2);
  let left = r.left, flipX = false;
  if (left + width > vw - pad) { left = r.right - width; flipX = true; }
  left = Math.max(pad, Math.min(left, vw - pad - width));
  const below = vh - pad - (r.bottom + gap), above = r.top - gap - pad;
  let top, maxHeight = null, flipY = false;
  if (mh <= below) top = r.bottom + gap;
  else if (mh <= above) { top = r.top - gap - mh; flipY = true; }
  else if (below >= above) { top = r.bottom + gap; maxHeight = Math.max(120, below); }
  else { maxHeight = Math.max(120, above); top = r.top - gap - maxHeight; flipY = true; }
  top = Math.max(pad, Math.min(top, vh - pad - Math.min(mh, maxHeight || mh)));
  if (maxHeight != null) maxHeight = Math.min(maxHeight, vh - pad * 2);
  return { left: Math.round(left), top: Math.round(top), maxHeight: maxHeight == null ? null : Math.round(maxHeight), maxWidth: mw > vw - pad * 2 ? vw - pad * 2 : null, flipX, flipY };
}
