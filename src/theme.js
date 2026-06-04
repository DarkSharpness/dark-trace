// Theme: defaults to the OS prefers-color-scheme, with a persisted manual
// override. Drives both the CSS chrome (via documentElement[data-theme]) and
// the canvas palette below.

const KEY = 'dark-trace-theme';
const mq = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = [];

export function getOverride() {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

/** Effective mode right now: override if set, otherwise the OS preference. */
export function resolveMode() {
  return getOverride() || (mq.matches ? 'dark' : 'light');
}

export function isFollowingSystem() { return getOverride() === null; }

function apply(mode) {
  document.documentElement.dataset.theme = mode;
  listeners.forEach(fn => fn(mode));
}

/** mode: 'light' | 'dark' | null (null = follow the system again). */
export function setOverride(mode) {
  if (mode) localStorage.setItem(KEY, mode); else localStorage.removeItem(KEY);
  apply(resolveMode());
}

/** Flip light<->dark, pinning the result as an explicit override. */
export function toggle() {
  setOverride(resolveMode() === 'dark' ? 'light' : 'dark');
  return resolveMode();
}

export function onChange(fn) { listeners.push(fn); }

// Track OS changes while we're still following the system.
mq.addEventListener('change', () => { if (isFollowingSystem()) apply(resolveMode()); });

// Canvas palettes — kept in sync with the CSS variables in style.css.
export const CANVAS = {
  dark: {
    canvasBg: '#1b1e24', ruler: '#23272f', gutter: '#21252d',
    group: '#2c323d', groupText: '#cdd6e2', trackText: '#9aa5b5',
    grid: 'rgba(255,255,255,0.05)', rowSep: 'rgba(255,255,255,0.07)',
    laneAlt: 'rgba(255,255,255,0.025)', divider: '#10131a',
    tick: '#4a5260', tickText: '#9aa5b5', subText: '#6b7585',
    sel: '#ffffff', sliceBorder: 'rgba(0,0,0,0.13)', merge: '#727b88',
    instant: '#e5c07b', flow: '#e5c07b', badge: '#e0a458',
    mmBg: '#21252d', mmBar: '#5b8def',
    measFill: 'rgba(91,141,239,0.16)', meas: '#5b8def', measText: '#0e1420',
  },
  light: {
    canvasBg: '#ffffff', ruler: '#f3f5f8', gutter: '#f6f7f9',
    group: '#e5e9f0', groupText: '#2a3340', trackText: '#5a6472',
    grid: 'rgba(0,0,0,0.05)', rowSep: 'rgba(0,0,0,0.07)',
    laneAlt: 'rgba(0,0,0,0.022)', divider: '#cdd4dd',
    tick: '#aab2bf', tickText: '#5a6472', subText: '#8a93a1',
    sel: '#16202e', sliceBorder: 'rgba(0,0,0,0.18)', merge: '#a7afba',
    instant: '#c98a16', flow: '#c0641c', badge: '#b9772a',
    mmBg: '#eef1f5', mmBar: '#4c84f0',
    measFill: 'rgba(47,107,216,0.12)', meas: '#2f6bd8', measText: '#ffffff',
  },
};
