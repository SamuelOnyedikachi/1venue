// Small dependency-free SVG charts for host analytics: area/line over days, bars and a donut.
// Colours come from the theme (--accent and friends), so light and dark both work. Every chart has an
// empty state, an aria-label summary, and a pointer/keyboard tooltip.
import { h } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, ...kids) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v); n.append(...kids.filter(Boolean)); return n; };
export const PALETTE = ['var(--accent)', 'var(--chart-2, #10b981)', 'var(--chart-3, #f59e0b)', 'var(--chart-4, #ec4899)', 'var(--chart-5, #8b5cf6)'];
const nf = (n) => new Intl.NumberFormat().format(n);
const shortDay = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
const niceMax = (m) => { if (m <= 4) return Math.max(1, m); const p = 10 ** Math.floor(Math.log10(m)); const n = m / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };

function empty(text) { return h('div', { class: 'chart-empty' }, h('span', { class: 'chart-empty-art', 'aria-hidden': 'true' }), h('span', null, text)); }
function tipBox(wrap) { const t = h('div', { class: 'chart-tip', role: 'status', 'aria-live': 'polite' }); wrap.append(t); return t; }
function placeTip(tip, wrap, x, y, html) {
  tip.innerHTML = html; tip.classList.add('show');
  const w = wrap.clientWidth; const tw = tip.offsetWidth;
  tip.style.left = Math.min(Math.max(0, x - tw / 2), w - tw) + 'px'; tip.style.top = Math.max(0, y - tip.offsetHeight - 10) + 'px';
}

/**
 * Area/line chart over days. series: [{ name, values: [{ day, value }], color? }] (same days in each).
 */
const narrow = () => typeof innerWidth === 'number' && innerWidth < 640;
export function areaChart(series, { height = 200, label = 'Chart', emptyText = 'Nothing in this range yet.' } = {}) {
  const days = (series[0] && series[0].values) || [];
  const total = series.reduce((a, s) => a + s.values.reduce((b, v) => b + v.value, 0), 0);
  if (!days.length || !total) return empty(emptyText);
  const W = narrow() ? 380 : 900, H = height, pl = 34, pr = 10, pt = 12, pb = 24;
  const max = niceMax(Math.max(...series.flatMap((s) => s.values.map((v) => v.value))));
  const x = (i) => pl + (days.length === 1 ? (W - pl - pr) / 2 : (i * (W - pl - pr)) / (days.length - 1));
  const y = (v) => pt + (H - pt - pb) * (1 - v / max);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': `${label}: ${series.map((s) => `${s.name} ${nf(s.values.reduce((a, v) => a + v.value, 0))}`).join(', ')}`, preserveAspectRatio: 'none' });
  const defs = el('defs');
  svg.append(defs);
  for (let g = 0; g <= 4; g++) { const v = (max * g) / 4; svg.append(el('line', { x1: pl, x2: W - pr, y1: y(v), y2: y(v), class: 'chart-grid' }), el('text', { x: pl - 6, y: y(v) + 3, class: 'chart-axis', 'text-anchor': 'end' }, document.createTextNode(nf(Math.round(v))))); }
  const step = Math.max(1, Math.ceil(days.length / 6));
  days.forEach((d, i) => { if (i % step === 0 || i === days.length - 1) svg.append(el('text', { x: x(i), y: H - 6, class: 'chart-axis', 'text-anchor': i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle' }, document.createTextNode(shortDay(d.day)))); });
  series.forEach((s, si) => {
    const c = s.color || PALETTE[si % PALETTE.length]; const id = `cg${Math.random().toString(36).slice(2, 8)}`;
    defs.append(el('linearGradient', { id, x1: 0, x2: 0, y1: 0, y2: 1 }, el('stop', { offset: '0%', 'stop-color': c, 'stop-opacity': si ? '.18' : '.32' }), el('stop', { offset: '100%', 'stop-color': c, 'stop-opacity': '0' })));
    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v.value).toFixed(1)}`);
    svg.append(el('path', { d: `M${x(0)},${y(0)} L${pts.join(' L')} L${x(s.values.length - 1)},${y(0)} Z`, fill: `url(#${id})`, stroke: 'none' }));
    svg.append(el('path', { d: `M${pts.join(' L')}`, class: 'chart-line', stroke: c, 'vector-effect': 'non-scaling-stroke' }));
  });
  const guide = el('line', { class: 'chart-guide', y1: pt, y2: H - pb, x1: -10, x2: -10 });
  const dots = series.map((s, si) => el('circle', { r: 4, cx: -10, cy: -10, class: 'chart-dot', fill: s.color || PALETTE[si % PALETTE.length], 'vector-effect': 'non-scaling-stroke' }));
  svg.append(guide, ...dots);
  const wrap = h('div', { class: 'chart', tabindex: '0', 'aria-label': label + '. Use left and right arrows to read each day.' }, svg);
  const tip = tipBox(wrap);
  let cur = -1;
  const show = (i) => {
    cur = Math.max(0, Math.min(days.length - 1, i));
    guide.setAttribute('x1', x(cur)); guide.setAttribute('x2', x(cur));
    series.forEach((s, si) => { dots[si].setAttribute('cx', x(cur)); dots[si].setAttribute('cy', y(s.values[cur].value)); });
    const r = svg.getBoundingClientRect(); const sx = r.width / W, sy = r.height / H;
    placeTip(tip, wrap, x(cur) * sx, Math.min(...series.map((s) => y(s.values[cur].value))) * sy,
      `<strong>${shortDay(days[cur].day)}</strong>` + series.map((s, si) => `<span><i style="background:${s.color || PALETTE[si % PALETTE.length]}"></i>${s.name}: <b>${nf(s.values[cur].value)}</b></span>`).join(''));
  };
  const hide = () => { tip.classList.remove('show'); guide.setAttribute('x1', -10); guide.setAttribute('x2', -10); dots.forEach((d) => d.setAttribute('cx', -10)); };
  svg.addEventListener('pointermove', (e) => { const r = svg.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; show(Math.round(((px - pl) / (W - pl - pr)) * (days.length - 1))); });
  svg.addEventListener('pointerleave', hide);
  wrap.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); show(cur < 0 ? days.length - 1 : cur + (e.key === 'ArrowRight' ? 1 : -1)); } else if (e.key === 'Escape') hide(); });
  wrap.addEventListener('blur', hide);
  return h('div', { class: 'chart-box' }, legend(series), wrap);
}
function legend(series) {
  return series.length > 1 ? h('div', { class: 'chart-legend' }, ...series.map((s, i) => h('span', null, h('i', { style: { background: s.color || PALETTE[i % PALETTE.length] } }), s.name))) : null;
}

/** Vertical bars. points: [{ label, value, sub? }] */
export function barChart(points, { height = 190, label = 'Chart', emptyText = 'Nothing in this range yet.', color = 'var(--accent)', unit = '' } = {}) {
  if (!points.length || !points.some((p) => p.value > 0)) return empty(emptyText);
  const W = narrow() ? 380 : 440, H = height, pl = 34, pr = 8, pt = 12, pb = 26;
  const max = niceMax(Math.max(...points.map((p) => p.value)));
  const bw = (W - pl - pr) / points.length; const gap = Math.min(10, bw * 0.28);
  const y = (v) => pt + (H - pt - pb) * (1 - v / max);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': `${label}: ` + points.map((p) => `${p.label} ${nf(p.value)}${unit}`).join(', '), preserveAspectRatio: 'none' });
  for (let g = 0; g <= 4; g++) { const v = (max * g) / 4; svg.append(el('line', { x1: pl, x2: W - pr, y1: y(v), y2: y(v), class: 'chart-grid' }), el('text', { x: pl - 6, y: y(v) + 3, class: 'chart-axis', 'text-anchor': 'end' }, document.createTextNode(nf(Math.round(v))))); }
  const wrap = h('div', { class: 'chart' }, svg);
  const tip = tipBox(wrap);
  const step = Math.max(1, Math.ceil(points.length / 7));
  points.forEach((p, i) => {
    const bx = pl + i * bw + gap / 2, bh = Math.max(p.value ? 2 : 0, H - pb - y(p.value));
    const r = el('rect', { x: bx, y: H - pb - bh, width: Math.max(1, bw - gap), height: bh, rx: Math.min(6, (bw - gap) / 3), class: 'chart-bar', fill: color, tabindex: '0', 'aria-label': `${p.label}: ${nf(p.value)}${unit}` });
    const showTip = () => { const sr = svg.getBoundingClientRect(); placeTip(tip, wrap, (bx + (bw - gap) / 2) * (sr.width / W), (H - pb - bh) * (sr.height / H), `<strong>${p.label}</strong><span>${nf(p.value)}${unit}${p.sub ? ' · ' + p.sub : ''}</span>`); };
    r.addEventListener('pointerenter', showTip); r.addEventListener('focus', showTip);
    r.addEventListener('pointerleave', () => tip.classList.remove('show')); r.addEventListener('blur', () => tip.classList.remove('show'));
    svg.append(r);
    if (i % step === 0) svg.append(el('text', { x: bx + (bw - gap) / 2, y: H - 8, class: 'chart-axis', 'text-anchor': 'middle' }, document.createTextNode(String(p.short || p.label).slice(0, 12))));
  });
  return h('div', { class: 'chart-box' }, wrap);
}

/** Donut with a legend. parts: [{ name, value }] */
export function donutChart(parts, { label = 'Breakdown', emptyText = 'No engagement in this range yet.', center = 'total' } = {}) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return empty(emptyText);
  const R = 46, C = 2 * Math.PI * R; let off = 0;
  const svg = el('svg', { viewBox: '0 0 120 120', class: 'donut-svg', role: 'img', 'aria-label': `${label}: ` + parts.map((p) => `${p.name} ${nf(p.value)}`).join(', ') });
  svg.append(el('circle', { cx: 60, cy: 60, r: R, class: 'donut-track' }));
  const wrap = h('div', { class: 'donut' });
  const tip = tipBox(wrap);
  parts.forEach((p, i) => {
    if (!p.value) return;
    const len = (p.value / total) * C;
    const seg = el('circle', { cx: 60, cy: 60, r: R, class: 'donut-seg', stroke: PALETTE[i % PALETTE.length], 'stroke-dasharray': `${Math.max(0, len - 1.5)} ${C}`, 'stroke-dashoffset': -off, transform: 'rotate(-90 60 60)', tabindex: '0', 'aria-label': `${p.name}: ${nf(p.value)}` });
    const showTip = () => placeTip(tip, wrap, wrap.clientWidth / 2, 20, `<strong>${p.name}</strong><span>${nf(p.value)} · ${Math.round((p.value / total) * 100)}%</span>`);
    seg.addEventListener('pointerenter', showTip); seg.addEventListener('focus', showTip);
    seg.addEventListener('pointerleave', () => tip.classList.remove('show')); seg.addEventListener('blur', () => tip.classList.remove('show'));
    svg.append(seg); off += len;
  });
  svg.append(el('text', { x: 60, y: 58, 'text-anchor': 'middle', class: 'donut-n' }, document.createTextNode(nf(total))), el('text', { x: 60, y: 74, 'text-anchor': 'middle', class: 'donut-l' }, document.createTextNode(center)));
  wrap.prepend(svg);
  return h('div', { class: 'donut-box' }, wrap, h('ul', { class: 'donut-legend' }, ...parts.map((p, i) => h('li', null, h('i', { style: { background: PALETTE[i % PALETTE.length] } }), h('span', { class: 'grow' }, p.name), h('b', null, nf(p.value)), h('span', { class: 'tiny muted' }, `${Math.round((p.value / total) * 100)}%`)))));
}
