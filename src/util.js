// Small shared helpers.

/** Format a duration / time offset given in microseconds. */
export function fmtTime(us, digits = 3) {
  const a = Math.abs(us);
  if (a < 1e-3) return (us * 1e6).toFixed(0) + ' ps';
  if (a < 1) return (us * 1e3).toFixed(digits) + ' ns';
  if (a < 1e3) return us.toFixed(digits) + ' µs';
  if (a < 1e6) return (us / 1e3).toFixed(digits) + ' ms';
  return (us / 1e6).toFixed(digits) + ' s';
}

/** First index i in sorted Float64Array/array `arr` with arr[i] >= v. */
export function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
