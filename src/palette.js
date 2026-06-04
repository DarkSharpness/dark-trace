// Slice color palettes. A palette only chooses how many / which hues names map
// to (the discomfort was 15 hues = rainbow); saturation/lightness still come
// from the light/dark theme. Persisted in localStorage, mirrors theme.js.

const KEY = 'dark-trace-palette';
const listeners = [];

export const PALETTES = [
  {
    id: 'vivid', name: 'Vivid', hint: '15 hues', jitter: 7,
    hues: [4, 22, 40, 58, 88, 124, 154, 176, 196, 212, 232, 258, 284, 310, 334],
  },
  {
    id: 'calm', name: 'Calm', hint: '10 hues', jitter: 4,
    hues: [8, 40, 90, 128, 160, 196, 224, 258, 292, 330],
  },
  {
    id: 'calmer', name: 'Calmer', hint: '7 hues', jitter: 2,
    hues: [14, 45, 128, 178, 210, 270, 326],
  },
  {
    // Plain: a single flat color per track/stream (every slice in a track shares
    // it); different tracks may get different colors. Coloured by track, not name.
    id: 'plain', name: 'Plain', hint: 'per track', jitter: 0,
    hues: [10, 40, 70, 100, 140, 170, 200, 225, 255, 285, 315, 340],
  },
  {
    // Tableau 10 — hand-balanced categorical palette; reads well on light & dark.
    id: 'tableau', name: 'Tableau', hint: '10 curated',
    colors: ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
      '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'],
  },
];

export function paletteById(id) {
  return PALETTES.find(p => p.id === id) || PALETTES[0];
}

export function getPalette() {
  const v = localStorage.getItem(KEY);
  return PALETTES.some(p => p.id === v) ? v : 'vivid';
}

export function setPalette(id) {
  if (!PALETTES.some(p => p.id === id)) return;
  localStorage.setItem(KEY, id);
  listeners.forEach(fn => fn(id));
}

export function onChange(fn) { listeners.push(fn); }
