import { h, api } from '../ui.js';
import { icon } from '../icons.js';

export async function mount(view, params) {
  const code = String(params.code || '').toUpperCase();
  document.title = 'Certificate - 1venue';
  const box = h('div', { class: 'cert-page col', style: { gap: '1rem', maxWidth: '52rem', margin: '1.5rem auto', padding: '0 1rem' } },
    h('p', { class: 'muted' }, 'Loading certificate…'));
  view.append(box);
  try {
    const c = await api(`/api/certs/${encodeURIComponent(code)}`);
    document.title = `${c.attendeeName} · ${c.eventTitle} - 1venue`;
    box.replaceChildren(
      h('div', { class: 'cert-frame', 'data-design': c.design, style: { '--cert-accent': c.accent || '#2563eb' } },
        h('iframe', { class: 'cert-iframe', title: 'Certificate', src: `/api/certs/${encodeURIComponent(c.code)}/pdf` })),
      h('div', { class: 'col', style: { gap: '.4rem' } },
        h('h1', { style: { margin: 0 } }, 'Certificate of attendance'),
        h('p', { class: 'muted', style: { margin: 0 } }, `${c.attendeeName} attended ${c.eventTitle}${c.hostName ? `, hosted by ${c.hostName}` : ''}.`),
        h('p', { class: 'tiny muted', style: { margin: 0 } }, `Verification code ${c.code}`),
        h('a', { class: 'btn primary', href: c.pdfUrl || `/api/certs/${c.code}/pdf`, target: '_blank', rel: 'noopener', html: icon('file', { size: 16 }) + ' Download PDF' }))
    );
  } catch (e) {
    box.replaceChildren(h('h1', null, 'Certificate not found'), h('p', { class: 'muted' }, e.message || 'This link may be incorrect.'));
  }
}
