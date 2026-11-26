/**
 * Render a landscape certificate PDF with pdf-lib, embedded OFL fonts, QR, logo and signatures.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const QRCode = require('qrcode');

const FONT_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'fonts');
const PAGE_W = 792;
const PAGE_H = 612;

const FONT_FILES = {
  serif: 'EBGaramond-Regular.ttf',
  serifBold: 'EBGaramond-Bold.ttf',
  serifItalic: 'EBGaramond-Italic.ttf',
  sans: 'SourceSans3-Regular.ttf',
  sansSemi: 'SourceSans3-Semibold.ttf',
  script: 'GreatVibes-Regular.ttf',
};

let fontBytes = null;
function loadFontBytes() {
  if (fontBytes) return fontBytes;
  fontBytes = {};
  for (const [k, file] of Object.entries(FONT_FILES)) {
    fontBytes[k] = fs.readFileSync(path.join(FONT_DIR, file));
  }
  return fontBytes;
}

function hexRgb(hex, fallback = [0x25, 0x63, 0xeb]) {
  const m = String(hex || '').trim().match(/^#?([0-9a-f]{6})$/i);
  const n = m ? parseInt(m[1], 16) : (fallback[0] << 16) + (fallback[1] << 8) + fallback[2];
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
function mix(a, b, t) {
  return rgb(a.red + (b.red - a.red) * t, a.green + (b.green - a.green) * t, a.blue + (b.blue - a.blue) * t);
}
function luma(c) { return 0.2126 * c.red + 0.7152 * c.green + 0.0722 * c.blue; }

function safeText(s, fallback = '') {
  return String(s == null ? fallback : s).replace(/\s+/g, ' ').trim();
}

function fitSize(font, text, maxWidth, maxSize, minSize = 9) {
  let s = maxSize;
  const t = String(text || '');
  if (!t) return maxSize;
  while (s > minSize && font.widthOfTextAtSize(t, s) > maxWidth) s -= 0.4;
  return s;
}

function wrapLines(font, text, size, maxWidth, maxLines = 3) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) line = next;
    else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  let cut = last;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}…`, size) > maxWidth) cut = cut.slice(0, -1);
  kept[maxLines - 1] = `${cut}…`;
  return kept;
}

function drawCentered(page, text, font, size, y, color, xMid, maxWidth) {
  const t = String(text || '');
  if (!t) return 0;
  const w = font.widthOfTextAtSize(t, size);
  const x = xMid - Math.min(w, maxWidth || w) / 2;
  page.drawText(t, { x: Math.max(0, x), y, size, font, color });
  return w;
}

function drawLeft(page, text, font, size, x, y, color) {
  const t = String(text || '');
  if (!t) return 0;
  page.drawText(t, { x, y, size, font, color });
  return font.widthOfTextAtSize(t, size);
}

async function embedImage(doc, bytes) {
  if (!bytes || !bytes.length) return null;
  let buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const head = buf.slice(0, 16).toString('utf8');
  if (head.includes('<svg') || head.trim().startsWith('<?xml') || (buf[0] === 0x3c && head.toLowerCase().includes('svg'))) {
    try { buf = await require('sharp')(buf).png().toBuffer(); } catch { return null; }
  }
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) return await doc.embedPng(buf);
    if (buf[0] === 0xff && buf[1] === 0xd8) return await doc.embedJpg(buf);
    buf = await require('sharp')(buf).png().toBuffer();
    return await doc.embedPng(buf);
  } catch {
    try { return await doc.embedPng(await require('sharp')(buf).png().toBuffer()); } catch { return null; }
  }
}

async function bytesFromUrl(url) {
  if (!url) return null;
  const s = String(url);
  const data = s.match(/^data:([^;]+);base64,(.+)$/);
  if (data) return Buffer.from(data[2], 'base64');
  if (s.startsWith('/') && !s.startsWith('//')) {
    const rel = path.join(__dirname, '..', '..', '..', 'public', s.replace(/^\/+/, ''));
    try { return await fs.promises.readFile(rel); } catch { /* fetch below */ }
  }
  try {
    const r = await fetch(s, { redirect: 'follow' });
    if (r.ok) return Buffer.from(await r.arrayBuffer());
  } catch { /* ignore */ }
  return null;
}

async function makeQr(url, { dark = '#111111', light = '#00000000', width = 240 } = {}) {
  return QRCode.toBuffer(String(url || 'https://1venue.live'), {
    type: 'png', margin: 0, width, errorCorrectionLevel: 'M',
    color: { dark, light },
  });
}

const { composeBodySentence } = require('./wording');

function fillVGradient(page, x, y, w, h, bottom, top, steps = 36) {
  const sh = h / steps;
  for (let i = 0; i < steps; i++) {
    page.drawRectangle({
      x, y: y + sh * i, width: w, height: sh + 0.5,
      color: mix(bottom, top, steps === 1 ? 1 : i / (steps - 1)),
    });
  }
}

function diamond(page, cx, cy, r, color) {
  page.drawSvgPath(`M ${cx} ${cy + r} L ${cx + r} ${cy} L ${cx} ${cy - r} L ${cx - r} ${cy} Z`, {
    color, borderColor: color, borderWidth: 0.4,
  });
}

function drawClassicFrame(page, accent, ink, paper) {
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: paper });
  // faint inner wash
  page.drawRectangle({ x: 18, y: 18, width: PAGE_W - 36, height: PAGE_H - 36, color: mix(paper, accent, 0.03) });
  const m = 24;
  page.drawRectangle({ x: m, y: m, width: PAGE_W - m * 2, height: PAGE_H - m * 2, borderColor: accent, borderWidth: 2.2 });
  page.drawRectangle({ x: m + 7, y: m + 7, width: PAGE_W - (m + 7) * 2, height: PAGE_H - (m + 7) * 2, borderColor: mix(accent, ink, 0.2), borderWidth: 0.65 });
  const arms = 20;
  const corners = [
    [m + 7, PAGE_H - m - 7, 1, -1],
    [PAGE_W - m - 7, PAGE_H - m - 7, -1, -1],
    [m + 7, m + 7, 1, 1],
    [PAGE_W - m - 7, m + 7, -1, 1],
  ];
  for (const [x, y, dx, dy] of corners) {
    page.drawLine({ start: { x, y }, end: { x: x + arms * dx, y }, thickness: 1.5, color: accent });
    page.drawLine({ start: { x, y }, end: { x, y: y + arms * dy }, thickness: 1.5, color: accent });
    page.drawLine({ start: { x: x + 5 * dx, y: y + 5 * dy }, end: { x: x + (arms - 3) * dx, y: y + 5 * dy }, thickness: 0.55, color: mix(accent, ink, 0.25) });
    page.drawLine({ start: { x: x + 5 * dx, y: y + 5 * dy }, end: { x: x + 5 * dx, y: y + (arms - 3) * dy }, thickness: 0.55, color: mix(accent, ink, 0.25) });
    diamond(page, x + 11 * dx, y + 11 * dy, 3.2, accent);
  }
}

function drawModernFrame(page, accent, paper) {
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: paper });
  const dark = mix(accent, rgb(0, 0, 0), 0.22);
  const light = mix(accent, rgb(1, 1, 1), 0.35);
  fillVGradient(page, 0, PAGE_H - 28, PAGE_W, 28, light, dark, 16);
  page.drawRectangle({ x: 0, y: PAGE_H - 30, width: PAGE_W, height: 2.2, color: accent });
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: 10, color: mix(accent, paper, 0.15) });
  page.drawRectangle({ x: 0, y: 10, width: PAGE_W, height: 2, color: accent });
  // soft accent bloom, top-right
  page.drawCircle({ x: PAGE_W - 30, y: PAGE_H - 10, size: 160, color: accent, opacity: 0.08 });
  page.drawCircle({ x: 40, y: 20, size: 90, color: accent, opacity: 0.05 });
}

function drawMinimal(page, accent, paper, ink) {
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: paper });
  page.drawRectangle({ x: 72, y: PAGE_H - 32, width: PAGE_W - 144, height: 1.6, color: accent });
}

function drawElegant(page, accent, gold, cream) {
  const top = mix(cream, accent, 0.05);
  const bottom = mix(cream, accent, 0.22);
  fillVGradient(page, 0, 0, PAGE_W, PAGE_H, bottom, top, 48);
  const m = 26;
  page.drawRectangle({ x: m, y: m, width: PAGE_W - m * 2, height: PAGE_H - m * 2, borderColor: gold, borderWidth: 1.15 });
  page.drawRectangle({ x: m + 6, y: m + 6, width: PAGE_W - (m + 6) * 2, height: PAGE_H - (m + 6) * 2, borderColor: mix(gold, accent, 0.25), borderWidth: 0.45 });
  const L = 26;
  const corners = [[m + 6, PAGE_H - m - 6, 1, -1], [PAGE_W - m - 6, PAGE_H - m - 6, -1, -1], [m + 6, m + 6, 1, 1], [PAGE_W - m - 6, m + 6, -1, 1]];
  for (const [x, y, dx, dy] of corners) {
    page.drawLine({ start: { x, y }, end: { x: x + L * dx, y }, thickness: 1.05, color: gold });
    page.drawLine({ start: { x, y }, end: { x, y: y + L * dy }, thickness: 1.05, color: gold });
    diamond(page, x + 9 * dx, y + 9 * dy, 2.6, gold);
  }
}

function imageBox(img, maxW, maxH) {
  const scale = Math.min(maxW / img.width, maxH / img.height);
  return { w: img.width * scale, h: img.height * scale };
}

function drawMark(page, fonts, color, x, y) {
  const t = '1venue';
  const size = 8;
  page.drawText(t, { x, y, size, font: fonts.sans, color });
  return fonts.sans.widthOfTextAtSize(t, size);
}

async function certificatePdf(opts = {}) {
  const design = ['classic', 'modern', 'minimal', 'elegant'].includes(opts.design) ? opts.design : 'classic';
  const name = safeText(opts.name, 'Participant');
  const title = safeText(opts.certTitle || opts.heading || opts.kindTitle, 'Certificate of Attendance');
  const opener = safeText(opts.opener, 'This is to certify that');
  const programme = safeText(opts.programme || opts.title, 'Event');
  const description = safeText(opts.description, '');
  const date = safeText(opts.date, '');
  const issuerName = safeText(opts.issuerName || opts.host, 'Host');
  const code = safeText(opts.code, '');
  const url = safeText(opts.url, 'https://1venue.live');
  const accentHex = opts.accent || '#2563eb';
  const signatories = (Array.isArray(opts.signatories) ? opts.signatories : []).filter((s) => s && safeText(s.name)).slice(0, 3);
  const sentence = composeBodySentence({
    body: opts.body, bodyId: opts.bodyId, programme, issuerName, date, description,
  });

  const bytes = loadFontBytes();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fonts = {
    serif: await doc.embedFont(bytes.serif, { subset: true }),
    serifBold: await doc.embedFont(bytes.serifBold, { subset: true }),
    serifItalic: await doc.embedFont(bytes.serifItalic, { subset: true }),
    sans: await doc.embedFont(bytes.sans, { subset: true }),
    sansSemi: await doc.embedFont(bytes.sansSemi, { subset: true }),
    script: await doc.embedFont(bytes.script, { subset: true }),
  };
  const page = doc.addPage([PAGE_W, PAGE_H]);

  const accent = hexRgb(accentHex);
  const cream = rgb(0.99, 0.98, 0.955);
  const paper = design === 'minimal' ? rgb(0.985, 0.985, 0.975)
    : design === 'elegant' ? cream
    : design === 'modern' ? rgb(0.997, 0.996, 0.992)
    : rgb(0.995, 0.99, 0.975);
  const ink = rgb(0.14, 0.12, 0.11);
  const muted = rgb(0.32, 0.3, 0.28);
  const gold = mix(rgb(0.78, 0.62, 0.3), accent, 0.22);

  if (design === 'classic') drawClassicFrame(page, accent, ink, paper);
  else if (design === 'modern') drawModernFrame(page, accent, paper);
  else if (design === 'minimal') drawMinimal(page, accent, paper, ink);
  else drawElegant(page, accent, gold, cream);

  const mid = PAGE_W / 2;
  const left = 72;
  const right = PAGE_W - 72;
  const contentW = right - left;
  const titleColor = design === 'elegant' ? mix(accent, gold, 0.45) : accent;

  const logoBytes = await bytesFromUrl(opts.issuerLogoUrl || opts.logoUrl);
  const logo = logoBytes ? await embedImage(doc, logoBytes) : null;
  const qrImg = await embedImage(doc, await makeQr(url, { dark: '#1a1816' }));

  const titleSize = fitSize(fonts.serifBold, title, contentW, 26, 14);
  const openerSize = 13;
  const nameSize = fitSize(fonts.serifBold, name, contentW - 8, 44, 16);
  const bodySize = 13;
  const sentLines = wrapLines(fonts.sans, sentence, bodySize, contentW * 0.92, 4);
  const logoBox = logo ? imageBox(logo, 108, 44) : null;
  const showOrg = !logoBox && !!issuerName;

  let blockH = 0;
  if (logoBox) blockH += logoBox.h + 24;
  else if (showOrg) blockH += 12 + 24;
  else blockH += 6;
  blockH += titleSize + 10 + 14 + openerSize + 16 + nameSize + 22;
  blockH += sentLines.length * (bodySize + 5) + 6;
  if (signatories.length) blockH += 36 + 40;

  const framed = design === 'classic' || design === 'elegant';
  const topSafe = design === 'modern' ? 58 : (design === 'minimal' ? 52 : 62);
  const botSafe = 86;
  const availTop = PAGE_H - topSafe;
  const availBot = botSafe;
  let contentTop = (availTop + availBot + blockH) / 2;
  if (contentTop > availTop) contentTop = availTop;
  let y = contentTop;

  if (logoBox) {
    y -= logoBox.h;
    page.drawImage(logo, { x: mid - logoBox.w / 2, y, width: logoBox.w, height: logoBox.h });
    y -= 24;
  } else if (showOrg) {
    y -= 11;
    drawCentered(page, issuerName, fonts.sansSemi, 10, y, muted, mid, contentW);
    y -= 24;
  } else {
    y -= 6;
  }

  y -= titleSize;
  drawCentered(page, title, fonts.serifBold, titleSize, y, titleColor, mid, contentW);
  y -= 10;
  const ruleW = design === 'minimal' ? 56 : 84;
  page.drawRectangle({ x: mid - ruleW / 2, y, width: ruleW, height: design === 'elegant' ? 0.7 : 1.15, color: titleColor });
  y -= 16;

  y -= openerSize;
  drawCentered(page, opener, fonts.serifItalic, openerSize, y, muted, mid, contentW);
  y -= 16;

  y -= nameSize;
  drawCentered(page, name, fonts.serifBold, nameSize, y, ink, mid, contentW);
  y -= 8;
  const nameW = fonts.serifBold.widthOfTextAtSize(name, nameSize);
  const underlineW = Math.min(contentW * 0.55, Math.max(nameW * 0.55, 72));
  page.drawRectangle({ x: mid - underlineW / 2, y: y + 2, width: underlineW, height: 0.55, color: mix(titleColor, paper, 0.35) });
  y -= 18;

  for (const ln of sentLines) {
    y -= bodySize;
    drawCentered(page, ln, fonts.sans, bodySize, y, muted, mid, contentW);
    y -= 5;
  }

  if (signatories.length) {
    y -= 36;
    const slotW = contentW / signatories.length;
    const sigBase = y;
    for (let i = 0; i < signatories.length; i++) {
      const s = signatories[i];
      const cx = left + slotW * i + slotW / 2;
      const sigName = safeText(s.name, 'Signatory');
      const role = safeText(s.role, '');
      const scriptSize = fitSize(fonts.script, sigName, slotW - 16, 26, 14);
      const sw = fonts.script.widthOfTextAtSize(sigName, scriptSize);
      page.drawText(sigName, { x: cx - sw / 2, y: sigBase, size: scriptSize, font: fonts.script, color: ink });
      if (role) {
        const rSize = 9.5;
        const rw = fonts.sansSemi.widthOfTextAtSize(role, rSize);
        page.drawText(role, { x: cx - rw / 2, y: sigBase - 16, size: rSize, font: fonts.sansSemi, color: ink });
      }
    }
  }

  // Footer: 1venue + certificate ID on the left, QR alone on the right
  const markY = framed ? 40 : (design === 'minimal' ? 28 : 26);
  const markColor = muted;
  const markW = drawMark(page, fonts, markColor, left, markY);
  if (code) {
    const gap = 8;
    const cSize = 8;
    const label = code;
    page.drawText(label, { x: left + markW + gap, y: markY, size: cSize, font: fonts.sansSemi, color: muted });
  }
  if (qrImg) {
    const qs = 40;
    const qx = right - qs;
    const qy = framed ? 36 : (design === 'minimal' ? 24 : 22);
    page.drawImage(qrImg, { x: qx, y: qy, width: qs, height: qs });
  }

  doc.setTitle(`${title} — ${name}`);
  doc.setAuthor(issuerName || '1venue');
  doc.setSubject(programme);
  doc.setProducer('1venue');
  doc.setCreator('1venue');
  const out = await doc.save();
  return Buffer.from(out);
}

async function pdfToPng(pdfBuffer, { dpi = 140 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
  const pdfPath = path.join(dir, 'c.pdf');
  const prefix = path.join(dir, 'c');
  fs.writeFileSync(pdfPath, pdfBuffer);
  try {
    const r = spawnSync('pdftoppm', ['-png', '-singlefile', '-r', String(dpi), pdfPath, prefix], { encoding: 'buffer' });
    if (r.status !== 0) {
      const err = (r.stderr && r.stderr.toString()) || 'pdftoppm failed';
      throw Object.assign(new Error(err), { status: 500 });
    }
    return fs.readFileSync(`${prefix}.png`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { certificatePdf, pdfToPng, PAGE_W, PAGE_H };
