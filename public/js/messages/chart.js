// Charts from CSV / Excel data, drawn as plain SVG in the browser (no chart library).
// Bar and line charts plot one or more numeric columns against a label column; pie shows shares of
// one numeric column. Repeated labels are summed so "Region, Sales" style sheets read naturally.
import { h, esc, sheet, download } from '../ui.js';

const PALETTE = ['var(--accent)', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#84cc16'];
const toNum = (v) => { const n = Number(String(v ?? '').replace(/[₦$€£,%\s]/g, '')); return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : null; };
const short = (s, n = 12) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const fmt = (n) => (Math.abs(n) >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : Math.abs(n) >= 1e3 ? `${Math.round(n / 100) / 10}k` : String(Math.round(n * 100) / 100));

/** Which columns are numeric (by content), whatever the server said. */
export function numericColumns(data) {
  return data.header.map((_, i) => i).filter((i) => { const vals = data.rows.map((r) => r[i]).filter((v) => String(v ?? '').trim() !== ''); return vals.length && vals.filter((v) => toNum(v) != null).length / vals.length >= 0.8; });
}
/** [{ label, values: [n per series] }], grouped by label (sum) when labels repeat. */
export function series(data, x, ys, max = 40) {
  const by = new Map();
  for (const r of data.rows) {
    const label = String(r[x] ?? '').trim() || '(blank)';
    if (!by.has(label)) { if (by.size >= 500) continue; by.set(label, ys.map(() => 0)); }
    const acc = by.get(label); ys.forEach((y, i) => { acc[i] += toNum(r[y]) || 0; });
  }
  return [...by].slice(0, max).map(([label, values]) => ({ label, values }));
}
/** SVG markup for a chart. */
export function chartSvg(data, { type = 'bar', x = 0, ys = [1] } = {}) {
  const W = 640, H = 340, L = 56, R = 16, T = 18, B = 64;
  const pts = series(data, x, ys, type === 'line' ? 200 : type === 'pie' ? 500 : 40);
  if (!pts.length) return '<svg viewBox="0 0 640 120" class="chart-svg"><text x="320" y="64" text-anchor="middle" class="chart-muted">No data to chart</text></svg>';
  if (type === 'pie') {
    const sorted = pts.map((p) => ({ label: p.label, v: Math.max(0, p.values[0]) })).sort((a, b) => b.v - a.v);
    const top = sorted.slice(0, 7); const rest = sorted.slice(7).reduce((s, p) => s + p.v, 0); if (rest > 0) top.push({ label: 'Other', v: rest });
    const total = top.reduce((s, p) => s + p.v, 0) || 1; let a0 = -Math.PI / 2; const cx = 170, cy = 170, r = 140;
    const arcs = top.map((p, i) => {
      const a1 = a0 + (p.v / total) * Math.PI * 2; const large = a1 - a0 > Math.PI ? 1 : 0;
      const d = top.length === 1 ? `M${cx - r},${cy}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0` : `M${cx},${cy}L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)}A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)}Z`;
      a0 = a1; return `<path d="${d}" fill="${PALETTE[i % PALETTE.length]}" stroke="var(--s1)" stroke-width="2"><title>${esc(p.label)}: ${fmt(p.v)}</title></path>`;
    }).join('');
    const legend = top.map((p, i) => `<g transform="translate(350,${40 + i * 30})"><rect width="14" height="14" rx="4" fill="${PALETTE[i % PALETTE.length]}"/><text x="22" y="12" class="chart-txt">${esc(short(p.label, 22))} · ${Math.round((p.v / total) * 100)}%</text></g>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Pie chart">${arcs}${legend}</svg>`;
  }
  const all = pts.flatMap((p) => p.values); const maxV = Math.max(0, ...all), minV = Math.min(0, ...all);
  const span = maxV - minV || 1; const pw = W - L - R, ph = H - T - B;
  const yOf = (v) => T + ph - ((v - minV) / span) * ph;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => { const v = minV + span * f; const y = yOf(v); return `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="chart-grid"/><text x="${L - 8}" y="${y + 4}" text-anchor="end" class="chart-muted">${fmt(v)}</text>`; }).join('');
  const step = pw / pts.length; const every = Math.max(1, Math.ceil(pts.length / 12));
  const labels = pts.map((p, i) => (i % every ? '' : `<text transform="translate(${L + step * i + step / 2},${H - B + 14}) rotate(30)" class="chart-muted">${esc(short(p.label))}</text>`)).join('');
  let body = '';
  if (type === 'line') {
    body = ys.map((_, s) => { const d = pts.map((p, i) => `${i ? 'L' : 'M'}${L + step * i + step / 2},${yOf(p.values[s])}`).join(''); return `<path d="${d}" fill="none" stroke="${PALETTE[s % PALETTE.length]}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>` + (pts.length <= 60 ? pts.map((p, i) => `<circle cx="${L + step * i + step / 2}" cy="${yOf(p.values[s])}" r="3.5" fill="${PALETTE[s % PALETTE.length]}"><title>${esc(p.label)}: ${fmt(p.values[s])}</title></circle>`).join('') : ''); }).join('');
  } else {
    const bw = Math.max(2, (step * 0.78) / ys.length);
    body = pts.map((p, i) => p.values.map((v, s) => { const y0 = yOf(Math.max(0, v)), y1 = yOf(Math.min(0, v)); return `<rect x="${L + step * i + step * 0.11 + bw * s}" y="${y0}" width="${bw - 1}" height="${Math.max(1, y1 - y0)}" rx="3" fill="${PALETTE[s % PALETTE.length]}"><title>${esc(p.label)}: ${fmt(v)}</title></rect>`; }).join('')).join('');
  }
  const legend = ys.length > 1 ? ys.map((y, s) => `<g transform="translate(${L + s * 140},${H - 12})"><rect width="12" height="12" rx="3" fill="${PALETTE[s % PALETTE.length]}"/><text x="18" y="10" class="chart-txt">${esc(short(data.header[y], 16))}</text></g>`).join('') : '';
  return `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="${type} chart">${grid}<line x1="${L}" x2="${W - R}" y1="${yOf(0)}" y2="${yOf(0)}" class="chart-axis"/>${body}${labels}${legend}</svg>`;
}
/** Sheet with chart type, label column and value columns. */
export function chartSheet(data, title = 'Chart') {
  const s = sheet({ title, icon: 'chart', wide: true });
  const nums = numericColumns(data);
  if (!nums.length) { s.body.append(h('p', { class: 'muted' }, 'This file has no numeric columns to chart.')); return s; }
  const textCols = data.header.map((_, i) => i).filter((i) => !nums.includes(i));
  const st = { type: 'bar', x: textCols[0] ?? 0, ys: [nums.find((i) => i !== (textCols[0] ?? 0)) ?? nums[0]] };
  const box = h('div', { class: 'chart-box' });
  const sel = (opts, val, on) => h('select', { class: 'input sm', onchange: (e) => on(e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(val) }, l)));
  const typeSel = h('div', { class: 'seg chart-types', role: 'radiogroup' }, [['bar', 'Bar'], ['line', 'Line'], ['pie', 'Pie']].map(([v, l]) => h('button', { type: 'button', class: `seg-b${st.type === v ? ' on' : ''}`, 'data-v': v, onclick: (e) => { st.type = v; typeSel.querySelectorAll('.seg-b').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); paint(); } }, l)));
  const ysBox = h('div', { class: 'chart-ys' });
  const paintYs = () => ysBox.replaceChildren(...nums.map((i) => { const cb = h('input', { type: 'checkbox', checked: st.ys.includes(i), onchange: () => { st.ys = cb.checked ? [...new Set([...st.ys, i])] : st.ys.filter((y) => y !== i); if (!st.ys.length) st.ys = [i]; paintYs(); paint(); } }); return h('label', { class: 'chart-y' }, cb, short(data.header[i], 20)); }));
  function paint() { box.innerHTML = chartSvg(data, { type: st.type, x: st.x, ys: st.type === 'pie' ? st.ys.slice(0, 1) : st.ys }); }
  s.body.append(h('div', { class: 'chart-controls' }, typeSel,
    h('label', { class: 'field inline' }, h('span', { class: 'lbl' }, 'Labels'), sel(data.header.map((x, i) => [i, x]), st.x, (v) => { st.x = Number(v); paint(); }))),
  h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Values'), ysBox), box,
  h('div', { class: 'row gap' }, h('span', { class: 'tiny muted grow' }, `${data.totalRows.toLocaleString()} rows${data.totalRows > data.rows.length ? ` (first ${data.rows.length.toLocaleString()} charted)` : ''}`),
    h('button', { class: 'btn sm', type: 'button', onclick: () => download(`${title.replace(/[^\w.-]+/g, '_')}.svg`, box.innerHTML.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" style="font-family:sans-serif;--accent:#6d5efc;--s1:#fff" '), 'image/svg+xml') }, 'Download SVG')));
  paintYs(); paint();
  return s;
}
