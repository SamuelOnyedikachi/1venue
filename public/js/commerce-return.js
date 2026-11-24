/** Confirm a Paystack return (`?reference=1vc-…`) once, then toast with an Open action for materials. */
import { api, toast, toastErr } from './ui.js';
import { navigate } from './app.js';

const claimed = new Set();

export async function claimCommerceReturn() {
  const q = new URLSearchParams(location.search);
  const ref = q.get('reference') || q.get('trxref');
  if (!ref || !String(ref).startsWith('1vc-') || claimed.has(ref)) return null;
  claimed.add(ref);
  q.delete('reference'); q.delete('trxref');
  const qs = q.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  try {
    const p = await api(`/api/commerce/payments/${encodeURIComponent(ref)}/verify`, { method: 'POST', body: {} });
    if (p.status !== 'paid') {
      toast(`Payment ${p.status}`, { icon: 'ticket' });
    } else if (p.kind === 'material' && p.materialId) {
      toast('You now have this material', { icon: 'check', action: { label: 'Open', run: () => navigate('/materials/' + p.materialId) } });
    } else if (p.kind === 'donation') {
      toast('Thank you for your gift!', { icon: 'heart' });
    } else {
      toast('Payment confirmed. Your ticket is ready.', { icon: 'ticket' });
    }
    window.dispatchEvent(new CustomEvent('commerce-paid', { detail: p }));
    return p;
  } catch (e) { toastErr(e); return null; }
}
