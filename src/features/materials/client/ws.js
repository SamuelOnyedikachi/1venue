import { onMessage } from '/js/room/registry.js';
import { offerChat, showBuyChip, hideBuyChip } from '/js/room/buy.js';

onMessage('material-offer', (R, m) => { offerChat(R, m); });
onMessage('material-overlay', (R, m) => {
  if (!m.material) { hideBuyChip(); return false; }
  showBuyChip(R, m.material);
  return false;
});
