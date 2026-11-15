// content: room WebSocket messages handled in the browser.
// Return false to skip the re-render; anything else re-renders the room (R.changed()).
import { onMessage } from '/js/room/registry.js';

onMessage('content-state', (R, m) => { R.content = m.content; R.stageView = null; if (R._presentPending && m.content && m.content.ownerId === R.me?.id) { R._presentPending = false; R._presentToast && R._presentToast(); } });
onMessage('content-update', (R, m) => { if (R.content && m.content) { const pg = R.content.page; const pagesChanged = Array.isArray(m.content.pages); R.content = { ...R.content, ...m.content }; if (m.content.media && R.applyMediaSync) R.applyMediaSync(m.content.media); if (pagesChanged) R.renderStage(true); else if (m.content.page !== pg && R.applyPage) R.applyPage(m.content.page); } R.applySlideshow && R.applySlideshow(!!R.content?.slideshow); R.panel.refresh(); return false; });
