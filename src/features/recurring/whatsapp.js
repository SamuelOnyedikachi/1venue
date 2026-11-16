/**
 * WhatsApp reminders behind a small provider interface. The only provider is Meta's WhatsApp
 * Cloud API. It is OFF unless WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are set in env AND the
 * admin setting platform.whatsappEnabled is 1. Secrets stay in env (never in the admin UI).
 *
 * Reminders are sent as an approved template (business-initiated messages need one):
 *   WHATSAPP_TEMPLATE (default "event_reminder"), WHATSAPP_TEMPLATE_LANG (default "en"),
 *   body parameters: {{1}} title, {{2}} when, {{3}} link.
 */
const meta = {
  id: 'meta',
  configured: () => !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
  async send({ to, params }) {
    const version = process.env.WHATSAPP_API_VERSION || 'v21.0';
    const base = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com';
    const body = {
      messaging_product: 'whatsapp', to: String(to).replace(/[^\d]/g, ''), type: 'template',
      template: { name: process.env.WHATSAPP_TEMPLATE || 'event_reminder', language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
        components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text).slice(0, 900) })) }] },
    };
    const r = await fetch(`${base}/${version}/${encodeURIComponent(process.env.WHATSAPP_PHONE_NUMBER_ID)}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { let m = ''; try { m = (await r.json()).error.message; } catch (_) {} throw new Error(`WhatsApp ${r.status}${m ? ': ' + String(m).slice(0, 120) : ''}`); }
    return { sent: true };
  },
};
let provider = meta;
/** Enabled = provider has credentials and the admin switch is on. */
function enabled(platform) { return !!(provider && provider.configured() && (!platform || platform.whatsappEnabled)); }
async function send(msg) { return provider.send(msg); }
module.exports = { enabled, send, providers: { meta }, _setProvider: (p) => { provider = p || meta; } };
