// scripture: room WebSocket messages handled in the browser.
// Return false to skip the re-render; anything else re-renders the room (R.changed()).
import { onMessage } from '/js/room/registry.js';

const scrTool = (s) => (/^quran_/i.test(s?.translation || '') ? 'quran' : 'bible');

onMessage('scripture-show', (R, m) => {
  const first = !R.scripture; R.scripture = m.scripture; R.scrOwnTr = first ? false : R.scrOwnTr;
  const tool = scrTool(m.scripture);
  if ((m.scripture.mode || 'side') === 'stage') R.stageView = null;
  // Default: read it in the sidebar (Tools → matching Bible / Qur’an tool), not over the stage.
  else if (first || !(R.panel.tab === 'tools' && R.panel.sub.tools === tool)) { if (first) R.panel.open('tools', tool); }
  if (R.panel.tab === 'tools' && R.panel.sub.tools === tool) R.panel.refresh('tools');
});
onMessage('scripture-clear', (R, m) => {
  const tool = scrTool(R.scripture);
  R.scripture = null; R.scrOwnTr = false;
  if (R.panel.tab === 'tools' && (R.panel.sub.tools === tool || R.panel.sub.tools === 'bible' || R.panel.sub.tools === 'quran')) R.panel.refresh('tools');
});
