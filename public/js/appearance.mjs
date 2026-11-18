function parseHex(color) {
  const match = /^#([\da-f]{6})$/i.exec(color || '');
  if (!match) return null;
  return [0, 2, 4].map((i) => Number.parseInt(match[1].slice(i, i + 2), 16));
}

function luminance(rgb) {
  const linear = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(a, b) {
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

export function accentInk(accent, accent2) {
  const primary = parseHex(accent);
  const secondary = parseHex(accent2);
  if (!primary || !secondary) return '#fff';

  const darkInk = luminance([15, 23, 42]);
  const backgrounds = [
    luminance(primary),
    luminance(secondary),
    luminance(primary.map((channel, i) => (channel * 60 + secondary[i] * 40) / 100)),
  ];
  const whiteContrast = Math.min(...backgrounds.map((background) => contrast(1, background)));
  const darkContrast = Math.min(...backgrounds.map((background) => contrast(darkInk, background)));
  return darkContrast > whiteContrast ? '#0f172a' : '#fff';
}
