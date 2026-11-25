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

function drawClassicFrame(page, accent, ink, paper) {
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: paper });
  const m = 22;
  page.drawRectangle({ x: m, y: m, width: PAGE_W - m * 2, height: PAGE_H - m * 2, borderColor: accent, borderWidth: 2.4 });
  page.drawRectangle({ x: m + 8, y: m + 8, width: PAGE_W - (m + 8) * 2, height: PAGE_H - (m + 8) * 2, borderColor: mix(accent, ink, 0.25), borderWidth: 0.7 });
  // Corner ornaments
  const arms = 18;
  const corners = [
    [m + 8, PAGE_H - m - 8, 1, -1],
    [PAGE_W - m - 8, PAGE_H - m - 8, -1, -1],
    [m + 8, m + 8, 1, 1],
    [PAGE_W - m - 8, m + 8, -1, 1],
  ];
  for (const [x, y, dx, dy] of corners) {
    page.drawLine({ start: { x, y }, end: { x: x + arms * dx, y }, thickness: 1.6, color: accent });
    page.drawLine({ start: { x, y }, end: { x, y: y + arms * dy }, thickness: 1.6, color: accent });
    page.drawLine({ start: { x: x + 4 * dx, y: y + 4 * dy }, end: { x: x + (arms - 4) * dx, y: y + 4 * dy }, thickness: 0.6, color: mix(accent, ink, 0.3) });
    page.drawLine({ start: { x: x + 4 * dx, y: y + 4 * dy }, end: { x: x + 4 * dx, y: y + (arms - 4) * dy }, thickness: 0.6, color: mix(accent, ink, 0.3) });
  }
}

function drawSeal(page, cx, cy, r, accent, ink, fonts, fill) {
  page.drawCircle({ x: cx, y: cy, size: r, borderColor: accent, borderWidth: 1.6, color: fill });
  page.drawCircle({ x: cx, y: cy, size: r - 5, borderColor: mix(accent, ink, 0.2), borderWidth: 0.7 });
  const ticks = 16;
  for (let i = 0; i < ticks; i++) {
    const a = (i / ticks) * Math.PI * 2;
    const inner = r - 9;
    const outer = r - 2.5;
    page.drawLine({
      start: { x: cx + Math.cos(a) * inner, y: cy + Math.sin(a) * inner },
      end: { x: cx + Math.cos(a) * outer, y: cy + Math.sin(a) * outer },
      thickness: 0.9, color: accent,
    });
  }
  const label = '1VENUE';
  const size = 6.2;
  const w = fonts.sansSemi.widthOfTextAtSize(label, size);
  page.drawText(label, { x: cx - w / 2, y: cy - size * 0.32, size, font: fonts.sansSemi, color: accent });
}

function drawModernBand(page, accent, paper) {
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: paper });
  const band = 54;
  const dark = mix(accent, rgb(0, 0, 0), 0.28);
  const light = mix(accent, rgb(1, 1, 1), 0.18);
  const steps = 48;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    page.drawRectangle({
      x: 0, y: (PAGE_H / steps) * i,
      width: band, height: PAGE_H / steps + 0.4,
      color: mix(dark, light, t),
    });
  }
  page.drawRectangle({ x: band, y: 0, width: 3, height: PAGE_H, color: accent });
}

function drawMinimal(page, accent, paper, ink) {
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: paper });
  page.drawRectangle({ x: 56, y: PAGE_H - 36, width: PAGE_W - 112, height: 2.2, color: accent });
  page.drawRectangle({ x: 56, y: 22, width: PAGE_W - 112, height: 0.6, color: mix(ink, paper, 0.75) });
}

function drawElegant(page, gold, cream, bg) {
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: bg });
  const m = 26;
  page.drawRectangle({ x: m, y: m, width: PAGE_W - m * 2, height: PAGE_H - m * 2, borderColor: gold, borderWidth: 1.1 });
  page.drawRectangle({ x: m + 7, y: m + 7, width: PAGE_W - (m + 7) * 2, height: PAGE_H - (m + 7) * 2, borderColor: mix(gold, cream, 0.25), borderWidth: 0.5 });
  // Short gold rules in the corners
  const L = 28;
  const corners = [[m + 7, PAGE_H - m - 7, 1, -1], [PAGE_W - m - 7, PAGE_H - m - 7, -1, -1], [m + 7, m + 7, 1, 1], [PAGE_W - m - 7, m + 7, -1, 1]];
  for (const [x, y, dx, dy] of corners) {
    page.drawLine({ start: { x, y }, end: { x: x + L * dx, y }, thickness: 1.1, color: gold });
    page.drawLine({ start: { x, y }, end: { x, y: y + L * dy }, thickness: 1.1, color: gold });
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
  const body = safeText(opts.body, 'has successfully attended');
  const programme = safeText(opts.programme || opts.title, 'Event');
  const description = safeText(opts.description, '');
  const date = safeText(opts.date, '');
  const issuerName = safeText(opts.issuerName || opts.host, 'Host');
  const code = safeText(opts.code, '');
  const url = safeText(opts.url, 'https://1venue.live');
  const accentHex = opts.accent || '#2563eb';
  const signatories = Array.isArray(opts.signatories) ? opts.signatories.slice(0, 3) : [];

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
  const elegant = design === 'elegant';
  const paper = elegant ? rgb(0.09, 0.08, 0.07) : (design === 'minimal' ? rgb(0.98, 0.98, 0.96) : rgb(0.995, 0.99, 0.98));
  const ink = elegant ? rgb(0.95, 0.92, 0.85) : rgb(0.12, 0.11, 0.1);
  const muted = elegant ? rgb(0.82, 0.77, 0.66) : rgb(0.38, 0.36, 0.34);
  const gold = elegant ? mix(rgb(0.86, 0.71, 0.38), hexRgb(accentHex), 0.16) : accent;

  if (design === 'classic') drawClassicFrame(page, accent, ink, paper);
  else if (design === 'modern') drawModernBand(page, accent, paper);
  else if (design === 'minimal') drawMinimal(page, accent, paper, ink);
  else drawElegant(page, gold, ink, paper);

  const left = design === 'modern' ? 86 : 64;
  const right = PAGE_W - 64;
  const width = right - left;
  const mid = design === 'modern' ? (left + right) / 2 + 8 : PAGE_W / 2;
  const contentW = design === 'modern' ? width - 8 : width;

  const logoBytes = await bytesFromUrl(opts.issuerLogoUrl || opts.logoUrl);
  const logo = logoBytes ? await embedImage(doc, logoBytes) : null;
  const qrDark = elegant ? '#f3ead8' : '#1a1816';
  const qrImg = await embedImage(doc, await makeQr(url, { dark: qrDark }));

  // Content from the top
  let y = design === 'minimal' ? PAGE_H - 70 : PAGE_H - 62;
  if (design === 'classic') y = PAGE_H - 70;

  if (logo) {
    const box = imageBox(logo, 92, 42);
    const lx = design === 'modern' ? left : mid - box.w / 2;
    page.drawImage(logo, { x: lx, y: y - box.h + 8, width: box.w, height: box.h });
    y -= box.h + 10;
  }

  const titleSize = fitSize(fonts.serifBold, title, contentW, design === 'minimal' ? 22 : 24, 13);
  if (design === 'modern') {
    drawLeft(page, title.toUpperCase(), fonts.sansSemi, Math.min(12, titleSize - 4), left, y, accent);
  } else {
    const color = elegant ? gold : accent;
    drawCentered(page, title, fonts.serifBold, titleSize, y, color, mid, contentW);
  }
  y -= design === 'minimal' ? 22 : 20;

  // Decorative rule
  const ruleW = design === 'minimal' ? 64 : 88;
  const ruleColor = elegant ? gold : accent;
  page.drawRectangle({ x: (design === 'modern' ? left : mid - ruleW / 2), y: y + 6, width: ruleW, height: design === 'elegant' ? 0.7 : 1.1, color: ruleColor });
  y -= 16;

  const openerSize = 12;
  if (design === 'modern') drawLeft(page, opener, fonts.serifItalic, openerSize, left, y, muted);
  else drawCentered(page, opener, fonts.serifItalic, openerSize, y, muted, mid, contentW);
  y -= 36;

  const nameSize = fitSize(fonts.serifBold, name, contentW - 8, 42, 16);
  if (design === 'modern') drawLeft(page, name, fonts.serifBold, nameSize, left, y, ink);
  else drawCentered(page, name, fonts.serifBold, nameSize, y, ink, mid, contentW);
  y -= 10;
  // underline under the name
  const nameW = fonts.serifBold.widthOfTextAtSize(name, nameSize);
  const underlineW = Math.min(contentW, Math.max(nameW + 8, 160));
  const ux = design === 'modern' ? left : mid - underlineW / 2;
  page.drawRectangle({ x: ux, y: y + 2, width: underlineW, height: 0.6, color: mix(muted, paper, 0.3) });
  y -= 22;

  const bodyLine = body;
  const bodySize = 12.5;
  if (design === 'modern') drawLeft(page, bodyLine, fonts.serif, bodySize, left, y, muted);
  else drawCentered(page, bodyLine, fonts.serif, bodySize, y, muted, mid, contentW);
  y -= 22;

  const progSize = fitSize(fonts.serifBold, programme, contentW, 18, 11);
  const progLines = wrapLines(fonts.serifBold, programme, progSize, contentW, 3);
  for (const ln of progLines) {
    if (design === 'modern') drawLeft(page, ln, fonts.serifBold, progSize, left, y, ink);
    else drawCentered(page, ln, fonts.serifBold, progSize, y, ink, mid, contentW);
    y -= progSize + 4;
  }
  y -= 4;

  if (description) {
    const dSize = 10.5;
    const dLines = wrapLines(fonts.serifItalic, description, dSize, contentW * 0.92, 3);
    for (const ln of dLines) {
      if (design === 'modern') drawLeft(page, ln, fonts.serifItalic, dSize, left, y, muted);
      else drawCentered(page, ln, fonts.serifItalic, dSize, y, muted, mid, contentW);
      y -= dSize + 3;
    }
    y -= 4;
  }

  if (date) {
    if (design === 'modern') drawLeft(page, date, fonts.sans, 11, left, y, muted);
    else drawCentered(page, date, fonts.sans, 11, y, muted, mid, contentW);
    y -= 20;
  }

  if (issuerName) {
    const issued = `Issued by ${issuerName}`;
    if (design === 'modern') drawLeft(page, issued, fonts.sansSemi, 10, left, y, ink);
    else drawCentered(page, issued, fonts.sansSemi, 10, y, ink, mid, contentW);
    y -= 18;
  }

  // Signatories along a row, above the footer
  const footerY = 52;
  const sigY = Math.max(footerY + 58, Math.min(y - 10, 150));
  if (signatories.length) {
    const slots = signatories.length;
    const usable = contentW;
    const slotW = usable / slots;
    for (let i = 0; i < slots; i++) {
      const s = signatories[i] || {};
      const cx = (design === 'modern' ? left : left) + slotW * i + slotW / 2;
      const sigName = safeText(s.name, 'Signatory');
      const role = safeText(s.role, '');
      let drawn = false;
      if (s.image || s.signatureUrl) {
        const bytesImg = s.image || await bytesFromUrl(s.signatureUrl);
        const img = bytesImg ? await embedImage(doc, bytesImg) : null;
        if (img) {
          const box = imageBox(img, Math.min(124, slotW - 16), 36);
          page.drawImage(img, { x: cx - box.w / 2, y: sigY + 14, width: box.w, height: box.h });
          drawn = true;
        }
      }
      if (!drawn) {
        const scriptSize = fitSize(fonts.script, sigName, slotW - 16, 22, 12);
        const sw = fonts.script.widthOfTextAtSize(sigName, scriptSize);
        page.drawText(sigName, { x: cx - sw / 2, y: sigY + 18, size: scriptSize, font: fonts.script, color: ink });
      }
      const lineW = Math.min(slotW - 20, 130);
      page.drawRectangle({ x: cx - lineW / 2, y: sigY + 10, width: lineW, height: 0.6, color: mix(muted, paper, 0.2) });
      const nSize = 8.5;
      const nw = fonts.sansSemi.widthOfTextAtSize(sigName, nSize);
      page.drawText(sigName, { x: cx - nw / 2, y: sigY - 4, size: nSize, font: fonts.sansSemi, color: ink });
      if (role) {
        const rw = fonts.sans.widthOfTextAtSize(role, 7.5);
        page.drawText(role, { x: cx - rw / 2, y: sigY - 16, size: 7.5, font: fonts.sans, color: muted });
      }
    }
  }

  if (design === 'classic') {
    drawSeal(page, PAGE_W - 92, 108, 28, accent, ink, fonts, paper);
  }

  // Footer: 1venue mark left, QR + code right — kept inside bordered frames
  const framed = design === 'classic' || design === 'elegant';
  const markColor = elegant ? gold : muted;
  const markY = framed ? 42 : (design === 'minimal' ? 44 : 28);
  drawMark(page, fonts, markColor, left, markY);

  if (qrImg) {
    const qs = 42;
    const qx = right - qs;
    const qy = framed ? 40 : (design === 'minimal' ? 42 : 26);
    page.drawImage(qrImg, { x: qx, y: qy, width: qs, height: qs });
    const cap = 'Verify';
    const capW = fonts.sans.widthOfTextAtSize(cap, 6.5);
    page.drawText(cap, { x: qx + (qs - capW) / 2, y: qy - 9, size: 6.5, font: fonts.sans, color: muted });
    if (code) {
      const cw = fonts.sansSemi.widthOfTextAtSize(code, 6.5);
      page.drawText(code, { x: qx - cw - 8, y: qy + qs / 2 - 3, size: 6.5, font: fonts.sansSemi, color: muted });
    }
  } else if (code) {
    const label = `Certificate no. ${code}`;
    const lw = fonts.sans.widthOfTextAtSize(label, 7);
    page.drawText(label, { x: right - lw, y: markY, size: 7, font: fonts.sans, color: muted });
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
