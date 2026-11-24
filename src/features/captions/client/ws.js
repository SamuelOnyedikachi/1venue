// captions: room WebSocket messages handled in the browser.
// Return false to skip the re-render; anything else re-renders the room (R.changed()).
import { onMessage } from '/js/room/registry.js';
import { feedOwnCaption } from '/js/voice.js';

onMessage('caption', (R, m) => { if (m.final !== false && m.participantId === R.me?.id) feedOwnCaption(m.text); if (m.final !== false) { R.data.captions.push({ participantId: m.participantId, name: m.name, text: m.text, at: m.at || Date.now() }); if (R.data.captions.length > 2000) R.data.captions.shift(); const last = R.data.captions[R.data.captions.length - 1]; if (!(R.panel.appendCaption && R.panel.appendCaption(last)) && R.panel.tab === 'tools' && R.panel.sub.tools === 'captions') R.panel.refresh(); } R.stageR.caption(m); return false; });
onMessage('transcript-state', (R, m) => { R.transcribe = !!m.on; if (m.historyId) R.historyId = m.historyId; R.captioner && R.captioner.autoSync(); });
