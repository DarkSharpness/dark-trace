// Stable name -> color mapping (Chrome-tracing-like palette), theme aware.

const cache = new Map();

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const HUES = [4, 22, 40, 58, 88, 124, 154, 176, 196, 212, 232, 258, 284, 310, 334];

/**
 * Returns {fill, dim, text} for a slice name under the given mode
 * ('light' | 'dark'). Slices stay legible with dark text in both themes.
 */
export function colorFor(name, mode) {
  const key = mode + '|' + name;
  let c = cache.get(key);
  if (c === undefined) {
    const h = hash(name);
    const hue = HUES[h % HUES.length] + ((h >> 8) % 14) - 7;
    const sat = 50 + ((h >> 16) % 20);
    if (mode === 'light') {
      const lit = 70 + ((h >> 24) % 10);
      c = {
        fill: `hsl(${hue},${sat}%,${lit}%)`,
        dim: `hsl(${hue},${Math.round(sat * .3)}%,92%)`,
        text: '#1d2530',
      };
    } else {
      // Dark: chroma ≈ S × (1 − |2L − 1|), so very high lightness drains color
      // (pale) and mid lightness with moderate saturation reads rich but not neon.
      const dsat = 42 + ((h >> 16) % 14);   // 42–55%
      const lit = 54 + ((h >> 24) % 10);    // 54–63% (mid — where chroma lives)
      c = {
        fill: `hsl(${hue},${dsat}%,${lit}%)`,
        dim: `hsl(${hue},${Math.round(dsat * .5)}%,25%)`,
        text: '#16191f',
      };
    }
    cache.set(key, c);
  }
  return c;
}
