/**
 * 1venue whiteboard files (.mwb). Written by public/js/wbcore.js toMwb():
 *   v2  gzip(JSON { format: 'mwb', version: 2, app: '1venue', title, pages: [...] })   MIME application/x-mwb
 *   v1  plain JSON { strokes | boards | pages, ... }                                      (older exports)
 * Browsers send these with an empty MIME type, so uploads are recognised by name and then sniffed:
 * a file called .mwb must really be a board, and its stored MIME becomes application/x-mwb.
 */
const zlib = require('node:zlib');

const MWB_MIME = 'application/x-mwb';
const isMwbName = (name) => /\.mwb$/i.test(String(name || ''));
const looksMwb = ({ name, mime } = {}) => isMwbName(name) || String(mime || '').toLowerCase() === MWB_MIME;

/** Parse an .mwb buffer. Returns { title, pages } or null when it is not a 1venue board. */
function sniffMwb(buf, { maxBytes = 80 * 1048576 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) return null;
  let raw = buf;
  try {
    if (buf[0] === 0x1f && buf[1] === 0x8b) raw = zlib.gunzipSync(buf, { maxOutputLength: maxBytes });
  } catch { return null; }
  const head = raw.subarray(0, 64).toString('utf8').trimStart();
  if (!head.startsWith('{')) return null;
  let d; try { d = JSON.parse(raw.toString('utf8')); } catch { return null; }
  if (!d || typeof d !== 'object' || (d.format && d.format !== 'mwb')) return null;
  const pages = Array.isArray(d.pages) ? d.pages.length : Array.isArray(d.boards) ? d.boards.length : Array.isArray(d.strokes) ? 1 : 0;
  if (!pages) return null;
  return { title: typeof d.title === 'string' ? d.title.slice(0, 120) : null, pages: Math.min(pages, 50), version: Number(d.version) || 1 };
}

module.exports = { MWB_MIME, isMwbName, looksMwb, sniffMwb };
