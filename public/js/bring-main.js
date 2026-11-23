/** Bring the main 1venue tab forward when a PiP action needs it (meeting setup, /new, upgrade). */
let flashT = null, flashOrig = '';

function flashTitle() {
  if (typeof document === 'undefined') return;
  if (!flashOrig) flashOrig = document.title;
  clearInterval(flashT);
  let n = 0;
  document.title = 'Continue in 1venue';
  flashT = setInterval(() => {
    document.title = n % 2 ? flashOrig : '● Continue in 1venue';
    if (++n >= 8) { clearInterval(flashT); document.title = flashOrig; flashOrig = ''; }
  }, 450);
}

export function showContinueInTab(doc) {
  if (!doc || !doc.body) return;
  const host = doc.querySelector('.app-pip') || doc.body;
  if (host.querySelector('.app-pip-continue')) return;
  const bar = doc.createElement('div');
  bar.className = 'app-pip-continue';
  bar.innerHTML = '<span>The meeting continues in the 1venue tab.</span><button type="button" class="btn sm primary">Continue in the 1venue tab</button>';
  bar.querySelector('button').addEventListener('click', () => {
    try { window.focus(); } catch { /* ignore */ }
    flashTitle();
  });
  host.append(bar);
}

/** Focus the opener window (this module runs there). Falls back to a PiP prompt + tab-title flash. */
export function bringMainToFront(pipDoc) {
  flashTitle();
  let ok = false;
  try { window.focus(); ok = !!(document.hasFocus && document.hasFocus()); } catch { ok = false; }
  if (!ok && pipDoc) showContinueInTab(pipDoc);
  return ok;
}
