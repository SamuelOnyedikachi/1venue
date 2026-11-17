// Whiteboard text editor lifecycle. Pure (no DOM), unit-tested in test/whiteboard-text.test.js.
//
// Root cause of the "text box keeps disappearing" bug: the board committed (and removed) the editor on
// every blur and on every resize. On phones, focusing the textarea opens the virtual keyboard, which
// resizes the viewport -> ResizeObserver -> commit an empty box -> gone. iOS also blurs/refocuses while
// it scrolls the field into view, and the tap's compatibility click could move focus to the board.
// The rules now:
//   * a resize or a blur on its own never closes the editor (the editor is just re-positioned);
//   * it closes when the person taps / clicks somewhere else, presses Enter / Escape, switches tool or
//     page, or the board goes away;
//   * a blur only commits when it follows a real outside pointer-down, or when focus clearly moved to
//     another text field / control outside the board (not to the board itself or <body>).
export function textSession(now = Date.now()) {
  return { openedAt: now, outsideDown: false, closed: false };
}
/** A pointer went down somewhere. Returns true when the editor should be committed now. */
export function onPointerDown(s, { insideEditor }) {
  if (s.closed || insideEditor) return false;
  s.outsideDown = true;
  return true;
}
/**
 * Focus left the textarea. `next` describes where it went: 'board' (the canvas wrapper), 'body'
 * (nothing / the page: what the keyboard, iOS scrolling and window switches do), 'control' (another
 * input, button or link outside the board) or 'hidden' (the tab was hidden).
 * Returns 'keep' (refocus / leave open) or 'commit'.
 */
export function onBlur(s, { next, now = Date.now() }) {
  if (s.closed) return 'keep';
  if (s.outsideDown) return 'commit';
  if (next === 'control' && now - s.openedAt > 350) return 'commit';
  return 'keep';
}
/** Resizes (virtual keyboard, rotation, visualViewport) never close the editor. */
export const onResize = () => 'reposition';
