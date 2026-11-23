/** Prompt for a sleek, text-free 16:9 event banner. Category is mood/lighting only. */
const CAT_MOOD = {
  sermon: 'soft volumetric light, serene and reverent atmosphere',
  concert: 'stage lighting and haze, energetic yet elegant glow',
  talk_show: 'warm intimate lighting, conversational cinematic depth',
  seminar: 'bright natural light, clean contemporary atmosphere',
  webinar: 'calm digital glow, soft focus depth',
  workshop: 'hands-on creative warmth, practical daylight',
  presentation: 'minimal modern lighting, quiet focus and depth',
  class: 'airy inviting light, thoughtful calm',
  meeting: 'soft daylight, calm contemporary mood',
  other: 'abstract editorial light, rich depth and subtle gradients',
};
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').replace(/["“”<>]/g, '').trim().slice(0, n);
const colourName = (hex) => (/^#[0-9a-f]{6}$/i.test(String(hex || '')) ? hex : null);

function coverPrompt({ title, description, category, accent, accent2, scene } = {}) {
  const titleBit = clip(title, 120) || 'a community event';
  const about = clip(description, 220);
  const visual = clip(scene, 420) || `a vivid, concrete scene that expresses the idea of ${titleBit}${about ? ` (${about})` : ''}`;
  const mood = CAT_MOOD[category] || CAT_MOOD.other;
  const c1 = colourName(accent), c2 = colourName(accent2);
  return [
    'Premium editorial photograph, 16:9 wide banner composition with calm negative space on the left.',
    `Main subject: ${visual}.`,
    `Mood and lighting only: ${mood}. Do not add unrelated furniture, seating, screens or props just to suggest this type of event.`,
    'Sleek, modern, minimal, cinematic lighting, rich depth, subtle gradients, high-end magazine aesthetic, sharp focus.',
    c1 ? `Colour palette led by ${c1}${c2 ? ` and ${c2}` : ''}, harmonious and tasteful.` : '',
    'Purely visual: no text, no letters, no words, no numbers, no captions, no logos, no watermarks, no signage, no typography.',
    'If any people appear they must have anatomically correct human bodies: exactly one head, two arms, two hands, two legs and two feet, five fingers per hand, natural proportions, no extra or missing or fused limbs, no distorted anatomy.',
  ].filter(Boolean).join(' ');
}

function coverNegative() {
  return 'extra limbs, six legs, three arms, mutated hands, fused fingers, extra fingers, missing limbs, deformed anatomy, poorly drawn hands, poorly drawn faces, extra heads, cloned body, disfigured, mutation, text, letters, typography, watermark, logo, lounge chairs, presentation board, projector screen';
}

function coverInput(model, prompt, { seed } = {}) {
  const m = String(model || '');
  if (/ideogram/i.test(m)) {
    return {
      prompt,
      aspect_ratio: '16:9',
      magic_prompt_option: 'Off',
      style_type: 'Realistic',
      ...(Number.isFinite(seed) ? { seed } : {}),
    };
  }
  const schnell = /schnell/i.test(m);
  const input = { prompt, aspect_ratio: '16:9', num_outputs: 1, output_format: 'webp', output_quality: 90 };
  if (Number.isFinite(seed)) input.seed = seed;
  if (schnell) { input.megapixels = '1'; input.go_fast = true; input.num_inference_steps = 4; }
  else { input.num_inference_steps = 28; input.guidance = 3.5; input.negative_prompt = coverNegative(); }
  return input;
}

const SCENE_SYSTEM = 'You invent one concrete visual scene for a text-free event cover photograph. Reply with 1 to 3 sentences only: subjects, setting, action and mood. No captions, no typography, no camera jargon, no category clichés like lounge chairs, studio seating, presentation boards or projector screens unless the title truly needs them.';

function sceneUserPrompt({ title, description, category } = {}) {
  return [`Event title: ${clip(title, 160) || 'Untitled'}.`, description ? `Description: ${clip(description, 400)}.` : '', category ? `Category (mood only, do not draw its stock furniture): ${category}.` : '', 'Describe the scene.'].filter(Boolean).join(' ');
}

module.exports = { coverPrompt, coverNegative, coverInput, CAT_MOOD, sceneUserPrompt, SCENE_SYSTEM };
