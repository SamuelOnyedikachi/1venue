/**
 * Hand-rolled one-page landscape PDF certificates. Helvetica only (no extra dependency).
 * Designs: classic, modern, minimal. Accent is a #RRGGBB event colour.
 */
'use strict';

function hexRgb(hex) {
  const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
  const n = m ? parseInt(m[1], 16) : 0x2563eb;
  return { r: (n >> 16) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
function pdfEsc(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function certificatePdf({ name, title, date, host, code, url, accent = '#2563eb', design = 'classic' }) {
  const W = 792, H = 612; // landscape US Letter
  const c = hexRgb(accent);
  const kind = ['classic', 'modern', 'minimal'].includes(design) ? design : 'classic';
  const attendee = pdfEsc(name || 'Participant');
  const eventTitle = pdfEsc(title || 'Event');
  const when = pdfEsc(date || '');
  const hostName = pdfEsc(host || '');
  const verify = pdfEsc(url || '');
  const certCode = pdfEsc(code || '');

  const ops = [];
  const rgb = (x) => `${x.r.toFixed(3)} ${x.g.toFixed(3)} ${x.b.toFixed(3)}`;
  const rect = (x, y, w, h, fill, stroke, sw = 1) => {
    if (fill) ops.push(`${rgb(fill)} rg`);
    if (stroke) ops.push(`${rgb(stroke)} RG ${sw} w`);
    ops.push(`${x} ${y} ${w} ${h} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`);
  };
  const line = (x1, y1, x2, y2, color, sw = 1) => {
    ops.push(`${rgb(color)} RG ${sw} w ${x1} ${y1} m ${x2} ${y2} l S`);
  };
  const text = (str, x, y, { font = 'F1', size = 12, color = { r: 0.12, g: 0.14, b: 0.2 }, align = 'left' } = {}) => {
    const escaped = pdfEsc(str);
    const est = escaped.length * size * 0.5;
    let tx = x;
    if (align === 'center') tx = x - est / 2;
    if (align === 'right') tx = x - est;
    ops.push('BT', `/${font} ${size} Tf`, `${rgb(color)} rg`, `1 0 0 1 ${tx.toFixed(2)} ${y.toFixed(2)} Tm`, `(${escaped}) Tj`, 'ET');
  };

  const ink = { r: 0.12, g: 0.14, b: 0.2 };
  const muted = { r: 0.4, g: 0.44, b: 0.5 };
  const white = { r: 1, g: 1, b: 1 };

  if (kind === 'classic') {
    rect(0, 0, W, H, white);
    rect(24, 24, W - 48, H - 48, null, c, 3);
    rect(36, 36, W - 72, H - 72, null, c, 1);
    text('CERTIFICATE OF ATTENDANCE', W / 2, 500, { font: 'F2', size: 22, color: c, align: 'center' });
    line(W / 2 - 140, 485, W / 2 + 140, 485, c, 1.5);
    text('This is to certify that', W / 2, 440, { size: 12, color: muted, align: 'center' });
    text(attendee, W / 2, 390, { font: 'F2', size: 32, color: ink, align: 'center' });
    text('attended', W / 2, 345, { size: 12, color: muted, align: 'center' });
    text(eventTitle, W / 2, 310, { font: 'F2', size: 18, color: ink, align: 'center' });
    if (when) text(when, W / 2, 270, { size: 12, color: muted, align: 'center' });
    if (hostName) text(`Hosted by ${hostName}`, W / 2, 200, { size: 12, color: ink, align: 'center' });
    text(`Verification code  ${certCode}`, W / 2, 80, { size: 9, color: muted, align: 'center' });
    if (verify) text(verify, W / 2, 64, { size: 8, color: muted, align: 'center' });
  } else if (kind === 'modern') {
    rect(0, 0, W, H, white);
    rect(0, 0, 28, H, c);
    rect(0, H - 18, W, 18, c);
    text('CERTIFICATE', 64, 520, { font: 'F2', size: 14, color: c });
    text('OF ATTENDANCE', 64, 498, { font: 'F2', size: 14, color: muted });
    text(attendee, 64, 400, { font: 'F2', size: 36, color: ink });
    line(64, 380, 360, 380, c, 3);
    text(eventTitle, 64, 340, { font: 'F2', size: 18, color: ink });
    if (when) text(when, 64, 310, { size: 12, color: muted });
    if (hostName) text(`Hosted by ${hostName}`, 64, 200, { size: 12, color: ink });
    text(certCode, 64, 70, { size: 9, color: muted });
    if (verify) text(verify, 64, 54, { size: 8, color: muted });
  } else {
    rect(0, 0, W, H, white);
    text('ATTENDANCE', W / 2, 430, { font: 'F2', size: 11, color: muted, align: 'center' });
    text(attendee, W / 2, 370, { font: 'F2', size: 34, color: ink, align: 'center' });
    line(W / 2 - 80, 350, W / 2 + 80, 350, c, 1);
    text(eventTitle, W / 2, 310, { size: 14, color: ink, align: 'center' });
    if (when) text(when, W / 2, 280, { size: 11, color: muted, align: 'center' });
    if (hostName) text(hostName, W / 2, 200, { size: 11, color: muted, align: 'center' });
    text(certCode, W / 2, 80, { size: 9, color: muted, align: 'center' });
    if (verify) text(verify, W / 2, 64, { size: 8, color: muted, align: 'center' });
  }

  const stream = ops.join('\n') + '\n';
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`);
  add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'binary');
}

module.exports = { certificatePdf };
