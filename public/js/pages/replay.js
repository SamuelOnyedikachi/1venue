// /replay/:id: watch one replay (uploaded file, cloud recording, or external link).
import { h, api } from '../ui.js';
import { icon } from '../icons.js';

const EMBED = [[/^https:\/\/(?:www\.)?youtube\.com\/watch\?v=([\w-]{6,})/, (m) => `https://www.youtube-nocookie.com/embed/${m[1]}`], [/^https:\/\/youtu\.be\/([\w-]{6,})/, (m) => `https://www.youtube-nocookie.com/embed/${m[1]}`], [/^https:\/\/vimeo\.com\/(\d+)/, (m) => `https://player.vimeo.com/video/${m[1]}`]];

export async function mount(view, { id }) {
  let r;
  try { r = await api('/api/replays/' + id); }
  catch (e) {
    view.append(h('div', { class: 'card pad' }, h('h1', null, 'Replay unavailable'), h('p', { class: 'muted' }, e.message || 'This replay is not available.'),
      e.message && /ticket/i.test(e.message) && e.data && e.data.eventSlug ? h('a', { class: 'btn primary', href: '/e/' + e.data.eventSlug, 'data-link': '' }, 'Get a ticket') : null));
    return;
  }
  let player;
  if (!r.mediaUrl) player = h('p', { class: 'muted' }, r.status === 'recording' ? 'Still recording. Check back after the session ends.' : 'This replay is being prepared.');
  else if (r.external) {
    const hit = EMBED.map(([re, f]) => { const m = r.mediaUrl.match(re); return m && f(m); }).find(Boolean);
    player = hit ? h('iframe', { src: hit, allow: 'autoplay; fullscreen; picture-in-picture', allowfullscreen: true, style: { width: '100%', aspectRatio: '16/9', border: 0, borderRadius: '12px' }, title: r.title })
      : h('a', { class: 'btn primary', href: r.mediaUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Watch replay ↗');
  } else player = h('video', { src: r.mediaUrl, controls: true, preload: 'metadata', playsinline: true, style: { width: '100%', borderRadius: '12px', background: '#000' } });
  view.append(h('div', { class: 'page-head' }, h('h1', { html: icon('play', { size: 24 }) + ' ' }, r.title),
    h('p', { class: 'muted' }, `${r.host && r.host.name ? 'By ' + r.host.name + ' · ' : ''}${new Date(r.createdAt).toLocaleDateString()}`, r.event ? h('span', null, ' · ', h('a', { href: '/e/' + r.event.slug, 'data-link': '' }, r.event.title)) : null)),
  h('div', { class: 'card pad' }, player));
}
export function unmount() {}
