// Stable name -> color mapping (Chrome-tracing-like palette), theme + palette aware.

import { paletteById } from './palette.js';

const cache = new Map();

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// --- helpers for curated (fixed hex) palettes ---
function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(hex) {
  const [r, g, b] = hexRgb(hex).map(v => {
    v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function mix(hex, bg, t) { // t toward bg, 0..1
  const a = hexRgb(hex), b = hexRgb(bg);
  const c = a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/**
 * Returns {fill, dim, text} for a slice name under the given theme mode
 * ('light' | 'dark') and palette id ('vivid' | 'calm' | 'calmer'). The palette
 * sets the hue set (how many colors); the theme sets saturation/lightness.
 */
export function colorFor(name, mode, paletteId = 'vivid') {
  const key = paletteId + '|' + mode + '|' + name;
  let c = cache.get(key);
  if (c === undefined) {
    const pal = paletteById(paletteId);
    const h = hash(name);
    if (pal.colors) {                       // curated fixed-color palette
      const fill = pal.colors[h % pal.colors.length];
      const bg = mode === 'light' ? '#ffffff' : '#1b1e24';
      c = {
        fill,
        dim: mix(fill, bg, 0.8),
        text: luminance(fill) > 0.45 ? '#1d2530' : '#ffffff',
      };
      cache.set(key, c);
      return c;
    }
    const HUES = pal.hues, J = pal.jitter;
    const hue = HUES[h % HUES.length] + ((h >> 8) % (2 * J + 1)) - J;
    const sat = 50 + ((h >> 16) % 20);
    if (mode === 'light') {
      const lit = 70 + ((h >> 24) % 10);
      c = {
        fill: `hsl(${hue},${sat}%,${lit}%)`,
        dim: `hsl(${hue},${Math.round(sat * .3)}%,92%)`,
        text: '#1d2530',
      };
    } else {
      // Dark: white slice text. Keep fills rich (chroma ≈ S × (1 − |2L − 1|) peaks
      // near L=50) but a touch darker than the background-pop maximum so white text
      // stays legible across hues.
      const dsat = 44 + ((h >> 16) % 14);   // 44–57%
      const lit = 47 + ((h >> 24) % 9);     // 47–55% (deep enough for white text)
      c = {
        fill: `hsl(${hue},${dsat}%,${lit}%)`,
        dim: `hsl(${hue},${Math.round(dsat * .5)}%,24%)`,
        text: '#ffffff',
      };
    }
    cache.set(key, c);
  }
  return c;
}
