/**
 * Whiteboard "Refine page": a visual AI (Replicate, FLUX Kontext by default) redraws one page.
 * The default preset only cleans up: same composition, same layout, the exact board colours.
 * It only goes further (style, extra content) when the person's own prompt asks for it.
 * Mock (AI_MOCK=true or no REPLICATE_API_TOKEN): the page comes back unchanged, so the UI and
 * the points flow can be tested without a token.
 */
const config = require('../../config');
const { cleanText } = require('../../lib/safe-text');

const KEEP = 'Keep the exact same composition, layout, positions, proportions and content. Do not add, remove or move anything. Keep the same plain background.';
const PRESETS = {
  clean: { label: 'Clean line art', prompt: `Redraw this whiteboard sketch as clean, smooth, confident line art. ${KEEP} Only tidy the strokes: steady, even line weight, closed shapes, no smudges or stray marks.`, colours: true },
  math: { label: 'Neat handwriting / math', prompt: `Rewrite all handwriting and maths in this whiteboard image as neat, clearly legible text and properly typeset mathematical notation, exactly as written (same symbols, numbers and words, same order). ${KEEP} Do not solve, correct or change anything.`, colours: true },
  diagram: { label: 'Diagram cleanup', prompt: `Turn this whiteboard drawing into a clean, professional diagram / flowchart: straight lines and arrows, aligned neat boxes and circles, tidy legible labels. ${KEEP}`, colours: true },
  illustration: { label: 'Sketch to illustration', prompt: 'Turn this sketch into a polished, friendly digital illustration with clean outlines and soft shading. Keep the same subject, composition and pose, and base the colours on the original strokes.', colours: true },
  watercolor: { label: 'Watercolour', prompt: 'Repaint this sketch as a delicate watercolour painting on white paper, soft washes and gentle bleeding edges. Keep the same subject, composition and layout.', colours: false },
  marker: { label: 'Marker poster', prompt: 'Redraw this as a bold, colourful marker poster: thick confident marker outlines, flat vivid fills, high contrast. Keep the same subject, composition and layout.', colours: false },
  custom: { label: 'Custom', prompt: 'Edit this whiteboard image as described.', colours: false },
};
const HEX = /^#[0-9a-f]{6}$/i;

/** The prompt sent to the model (exported for tests). */
function refinePrompt(preset, extra, palette) {
  const p = PRESETS[preset] || PRESETS.clean;
  const ask = cleanText(extra, { max: 500 });
  const cols = (Array.isArray(palette) ? palette : []).filter((c) => HEX.test(String(c))).slice(0, 12);
  const parts = [p.prompt];
  if (cols.length && p.colours) parts.push(`Use exactly these colours from the original and no others: ${cols.join(', ')}.`);
  if (ask) parts.push(preset === 'custom' ? ask : `Additionally: ${ask}`);
  return parts.join(' ');
}

function dataUrl(s) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  return buf.length > 64 && buf.length <= 8 * 1048576 ? { type: m[1], buf } : null;
}

const firstUrl = (o) => (typeof o === 'string' ? o : Array.isArray(o) ? firstUrl(o[0]) : o && typeof o === 'object' ? firstUrl(o.url || o.image || o.output) : null);

async function refine(user, body, { httpError, rateLimit }) {
  const img = dataUrl(body.image);
  if (!img) throw httpError(400, 'Send the page as a PNG or JPEG image (max 8 MB)');
  const preset = PRESETS[body.preset] ? body.preset : 'clean';
  if (preset === 'custom' && !cleanText(body.prompt)) throw httpError(400, 'Describe what you want for a custom refine');
  if (!rateLimit(`wb-ai:${user.id}`, 6)) throw httpError(429, 'Please wait a minute before refining again');
  const prompt = refinePrompt(preset, body.prompt, body.palette);
  const plans = require('../../lib/plans');
  const t = await plans.takeAi({ kind: 'whiteboard_ai', ownerId: user.id });
  plans.throwIfAiDenied(t);
  const mock = config.AI.mock || !config.STT.replicate.token;
  const model = config.WHITEBOARD_AI.model;
  let out, mime = 'image/png';
  try {
    if (mock) { out = img.buf; mime = `image/${img.type}`; }
    else {
      const { run } = require('../../lib/replicate');
      const r = await run({
        token: config.STT.replicate.token, apiBase: config.STT.replicate.apiBase, model, tag: 'whiteboard-ai', wait: 60, timeoutMs: config.WHITEBOARD_AI.timeoutMs,
        input: { prompt, input_image: `data:image/${img.type};base64,${img.buf.toString('base64')}`, output_format: 'png', aspect_ratio: 'match_input_image', safety_tolerance: 2 },
      });
      const url = firstUrl(r.output);
      if (!url || !/^https:\/\//.test(url)) throw httpError(502, 'The AI did not return an image. Try again.');
      const res = await fetch(url);
      if (!res.ok) throw httpError(502, 'Could not download the refined image');
      out = Buffer.from(await res.arrayBuffer());
      if (out.length > 20 * 1048576) throw httpError(502, 'The refined image is too large');
      mime = res.headers.get('content-type') || 'image/png';
    }
    const saved = await require('../../venue/storage').save(out, { filename: `refined-${preset}.${mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png'}`, mime, ownerUserId: user.id, purpose: 'whiteboard', maxBytes: 25 * 1048576 });
    // Always the app's /files/ URL: boards only accept those (wbcore okUrl), whatever the storage driver.
    return { url: `/files/${saved.id}/${encodeURIComponent(saved.filename)}`, preset, model: mock ? 'mock' : model, mock, cost: t.cost, left: t.left };
  } catch (e) { await t.refund(); throw e; }
}

const presetList = () => Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, keepsColours: p.colours }));
module.exports = { PRESETS, refinePrompt, refine, presetList };
