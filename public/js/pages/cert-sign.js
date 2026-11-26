import { h } from '../ui.js';

/** Old signature-invitation links land here. Drawn signatures were retired. */
export async function mount(view) {
  document.title = 'Signature · 1venue';
  view.append(h('div', { class: 'cert-page' },
    h('div', { class: 'cert-verify-card' },
      h('h1', null, 'A drawn signature is no longer needed'),
      h('p', { class: 'muted' }, 'Certificates now use the signer’s name in a handwriting font, with their role underneath. You can close this page.'))));
}
