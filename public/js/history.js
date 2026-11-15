/** Text version history for the Feed composer (Fine-tune undo/redo). At least 10 versions. */
export const HISTORY_LIMIT = 12;

export function createHistory(limit = HISTORY_LIMIT) {
  const cap = Math.max(10, limit);
  let stack = [];
  let i = -1;
  return {
    push(value) {
      const v = String(value ?? '');
      if (i >= 0 && stack[i] === v) return;
      stack = stack.slice(0, i + 1);
      stack.push(v);
      if (stack.length > cap) stack = stack.slice(stack.length - cap);
      i = stack.length - 1;
    },
    undo() {
      if (i <= 0) return null;
      i -= 1;
      return stack[i];
    },
    redo() {
      if (i < 0 || i >= stack.length - 1) return null;
      i += 1;
      return stack[i];
    },
    canUndo() { return i > 0; },
    canRedo() { return i >= 0 && i < stack.length - 1; },
    current() { return i >= 0 ? stack[i] : ''; },
    original() { return stack.length ? stack[0] : ''; },
    size() { return stack.length; },
    index() { return i; },
    reset() { stack = []; i = -1; },
  };
}
