import { h, I, api, toast, toastErr } from '../ui.js';

export async function mount(view, params) {
  const code = String(params.code || '').toUpperCase();
  document.title = 'Certificate · 1venue';
  const box = h('div', { class: 'cert-page' },
    h('p', { class: 'muted' }, 'Loading certificate…'));
  view.append(box);
  try {
    const c = await api(`/api/certs/${encodeURIComponent(code)}`);
    document.title = `${c.attendeeName} · ${c.title || 'Certificate'} · 1venue`;
    const when = c.dateLabel || (c.issuedAt ? new Date(c.issuedAt).toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Africa/Lagos' }) : '');
    const issuer = c.issuerName || c.hostName || '';
    const eventHref = c.eventSlug ? '/e/' + c.eventSlug : null;
    const copyLink = async () => {
      const url = c.url || (location.origin + '/cert/' + c.code);
      try { await navigator.clipboard.writeText(url); toast('Link copied', { icon: 'copy' }); }
      catch (e) { toastErr(e); }
    };
    const linkedin = c.linkedinUrl || '';
    box.replaceChildren(
      h('div', { class: 'cert-verify-card' },
        h('div', { class: 'cert-badge', 'aria-label': 'Verified' },
          I('check', 18),
          h('div', { class: 'cert-badge-text' },
            h('strong', null, 'Verified'),
            h('span', null, `Issued to ${c.attendeeName}${when ? ` on ${when}` : ''}${issuer ? ` by ${issuer}` : ''}`))),
        h('div', { class: 'cert-frame', 'data-design': c.design, style: { '--cert-accent': c.accent || '#2563eb' } },
          h('iframe', { class: 'cert-iframe', title: 'Certificate', src: `/api/certs/${encodeURIComponent(c.code)}/pdf` })),
        h('div', { class: 'cert-actions' },
          h('a', { class: 'btn primary', href: (c.pdfUrl || `/api/certs/${c.code}/pdf`) + (String(c.pdfUrl || '').includes('?') ? '&' : '?') + 'download=1', target: '_blank', rel: 'noopener' }, I('download', 16), ' Download PDF'),
          linkedin ? h('a', { class: 'btn', href: linkedin, target: '_blank', rel: 'noopener' }, I('linkedin', 16), ' Add to LinkedIn') : null,
          h('button', { type: 'button', class: 'btn', onclick: copyLink }, I('copy', 16), ' Copy link')),
        h('div', { class: 'cert-details' },
          h('h1', null, c.title || 'Certificate'),
          h('p', { class: 'cert-detail-line' },
            h('span', { class: 'muted' }, 'Awarded to '),
            h('strong', null, c.attendeeName)),
          c.programme || c.eventTitle ? h('p', { class: 'cert-detail-line' },
            h('span', { class: 'muted' }, 'Programme '),
            eventHref ? h('a', { href: eventHref }, c.programme || c.eventTitle) : h('strong', null, c.programme || c.eventTitle)) : null,
          c.programme && c.eventTitle && c.programme !== c.eventTitle
            ? h('p', { class: 'cert-detail-line' }, h('span', { class: 'muted' }, 'Event '), eventHref ? h('a', { href: eventHref }, c.eventTitle) : h('span', null, c.eventTitle))
            : null,
          issuer ? h('p', { class: 'cert-detail-line' }, h('span', { class: 'muted' }, 'Issued by '), h('strong', null, issuer)) : null,
          when ? h('p', { class: 'cert-detail-line' }, h('span', { class: 'muted' }, 'Date '), h('span', null, when)) : null,
          h('p', { class: 'tiny muted cert-code' }, 'Certificate no. ' + c.code))));
  } catch (e) {
    box.replaceChildren(
      h('div', { class: 'cert-verify-card' },
        h('h1', null, 'Certificate not found'),
        h('p', { class: 'muted' }, e.message || 'This link may be incorrect.')));
  }
}
