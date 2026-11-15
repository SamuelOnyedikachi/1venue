/** Prompt for a sleek, text-free 16:9 event banner. Pure function (unit tested). */
const CAT_SCENES = {
  sermon: 'soft volumetric light through tall arched windows, serene sanctuary atmosphere',
  concert: 'stage lights and haze, glowing bokeh, energetic yet elegant',
  talk_show: 'warm modern studio set, lounge chairs, cinematic depth of field',
  seminar: 'bright contemporary conference space, clean architecture, natural light',
  webinar: 'abstract glowing network of light, calm digital depth',
  workshop: 'hands-on creative workspace, tools and materials arranged beautifully',
  presentation: 'minimal modern auditorium, large soft-lit screen glow, depth',
  class: 'airy modern classroom or library, warm light, inviting',
  meeting: 'calm contemporary meeting space, soft daylight, glass and wood',
  other: 'abstract editorial composition with depth and soft light',
};
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').replace(/["“”<>]/g, '').trim().slice(0, n);
const colourName = (hex) => (/^#[0-9a-f]{6}$/i.test(String(hex || '')) ? hex : null);

function coverPrompt({ title, description, category, accent, accent2 } = {}) {
  const subject = clip(title, 120) || 'a community event';
  const about = clip(description, 220);
  const scene = CAT_SCENES[category] || CAT_SCENES.other;
  const c1 = colourName(accent), c2 = colourName(accent2);
  return [
    `Premium editorial banner photograph for an event about ${subject}.`,
    about ? `Theme: ${about}.` : '',
    `${scene}.`,
    'Sleek, modern, minimal, cinematic lighting, rich depth, subtle gradients, high-end magazine aesthetic, sharp focus, 16:9 wide composition with calm negative space on the left side.',
    c1 ? `Colour palette led by ${c1}${c2 ? ` and ${c2}` : ''}, harmonious and tasteful.` : '',
    'Purely visual: no text, no letters, no words, no numbers, no captions, no logos, no watermarks, no signage, no typography.',
  ].filter(Boolean).join(' ');
}

module.exports = { coverPrompt };
