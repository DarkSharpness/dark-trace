// Canvas timeline renderer: virtualized, pan/zoom, lane-stacked tracks, themed.

import { fmtTime, lowerBound, clamp } from './util.js';
import { colorFor } from './color.js';
import { CANVAS } from './theme.js';

// Overall UI scale — must match --ui-scale in style.css. The CSS chrome is
// enlarged via `zoom`; the canvas cancels that out (it recomputes its backing
// store from the zoomed rect), so we re-apply the same factor to our own
// constants and chrome fonts to keep the timeline in step with the chrome.
const S = 1.2;
const px = (v) => Math.round(v * S);

const G0 = px(244);        // default left label gutter width
const GUTTER_MIN = px(90);
const GUTTER_MAX = px(560);
const GUTTER_GRAB = 4;     // px grab zone around the divider
const RULER_H = px(28);
const GROUP_H = px(26);
const ROW_H = px(20);      // one lane
const TRACK_PAD = px(4);
const COLLAPSED_H = px(22); // height of a collapsed track row
const MIN_CONTENT = px(120); // min timeline width kept to the right of the gutter
const MIN_SPAN = 0.005;    // µs
// Roboto everywhere (matches the chrome and Perfetto's primary font). Roboto has
// normal proportions; Google's separate "Roboto Condensed" family reads as
// vertically stretched next to it, so we don't use it here.
const SANS = 'Roboto, "Segoe UI", system-ui, sans-serif';
const MONO = '"Roboto Mono", ui-monospace, Menlo, Consolas, monospace';
const FONT = px(12) + 'px ' + SANS;
const FONT_BOLD = '500 ' + px(12) + 'px ' + SANS;
const FONT_GROUP = '500 ' + px(12.5) + 'px ' + SANS;
const FONT_MONO = px(11) + 'px ' + MONO;
// Slice labels are deliberately small (and not scaled up with the UI) so kernel
// names stay compact inside the rows.
const SLICE_FONT = '11px ' + SANS;
const SLICE_CHAR_W = 6.0;    // approx px/char for the slice font (truncation estimate)

/** Stable color key for a track — used by the 'plain' palette (one color/track). */
export function trackColorKey(track) {
  const g = track.group ? track.group.displayName() : '';
  return g + '¦' + (track.name != null ? track.name : track.tid);
}

export class Viewer {
  constructor(canvas, minimap, model, callbacks, mode = 'light', palette = 'vivid') {
    this.canvas = canvas;
    this.minimap = minimap;
    this.model = model;
    this.cb = callbacks; // {onSelect(sel|null), onHover(info|null)}
    this.mode = mode;
    this.palette = palette;
    this.th = CANVAS[mode] || CANVAS.light;
    this.ctx = canvas.getContext('2d');
    this.mmCtx = minimap.getContext('2d');

    const savedG = parseFloat(localStorage.getItem('dark-trace-gutter'));
    // gutterPref is the user's chosen width; this.gutter is the effective width,
    // re-clamped against the canvas width in resize() so a narrow window can't
    // make the gutter swallow the whole timeline (which would invert tToX).
    this.gutterPref = Number.isFinite(savedG) ? clamp(savedG, GUTTER_MIN, GUTTER_MAX) : G0;
    this.gutter = this.gutterPref;

    this.viewT0 = model.t0;
    this.viewT1 = model.t1;
    this.scrollY = 0;
    this.selection = null;   // {track, idx}
    this.hover = null;
    this.measure = null;     // {tA, tB}
    this.searchSet = null;   // Set<nameId> | null
    this.dirty = true;
    this.mouseX = this.gutter + 100;
    this.W = 0; this.H = 0;
    this.rows = [];          // visual layout rows
    this.totalH = 0;
    this.trackY = new Map();
    this._labelCache = new Map();
    this._density = null;
    this._trackOrd = null;   // track -> global ordinal, built lazily for same-name nav

    this._computeDensity();
    this._initialView();
    this._bindEvents();
    this.resize();
    const loop = () => {
      if (this.dirty) { this.dirty = false; this._draw(); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  setTheme(mode) {
    this.mode = mode;
    this.th = CANVAS[mode] || CANVAS.light;
    this.redraw();
  }

  setPalette(palette) {
    this.palette = palette;       // color cache is keyed by palette, no clear needed
    this.redraw();
  }

  redraw() { this.dirty = true; }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.canvas, this.minimap]) {
      const r = c.getBoundingClientRect();
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.W = this.canvas.getBoundingClientRect().width;
    this.H = this.canvas.getBoundingClientRect().height;
    this._clampGutter();
    if (this.selection) this._scrollTrackIntoView(this.selection.track);
    this.redraw();
  }

  /**
   * Effective gutter = the user's preferred width, but never so wide that the
   * timeline to its right shrinks below MIN_CONTENT (or goes negative on a very
   * narrow canvas, which would flip the time axis). The preference is preserved,
   * so widening the window restores the chosen width.
   */
  _clampGutter() {
    let g = clamp(this.gutterPref, GUTTER_MIN, GUTTER_MAX);
    const maxG = Math.max(0, this.W - MIN_CONTENT);
    this.gutter = Math.max(0, Math.min(g, maxG));
  }

  /** Default view: zoom to the densest region so the trace opens with detail. */
  _initialView() {
    const d = this._density, span = this.model.span;
    if (!d || !span) { this.viewT0 = this.model.t0; this.viewT1 = this.model.t1; return; }
    const N = d.length;
    const frac = 0.18;                       // ~5.5x zoom from full
    const win = Math.max(1, Math.round(N * frac));
    let sum = 0;
    for (let i = 0; i < win && i < N; i++) sum += d[i];
    let best = sum, bestStart = 0;
    for (let i = win; i < N; i++) {
      sum += d[i] - d[i - win];
      if (sum > best) { best = sum; bestStart = i - win + 1; }
    }
    const a = this.model.t0 + bestStart / N * span;
    const b = a + frac * span;
    const pad = (b - a) * 0.04;
    this.viewT0 = a - pad;
    this.viewT1 = b + pad;
  }

  // ---- coordinate helpers ----
  tToX(t) { return this.gutter + (t - this.viewT0) / (this.viewT1 - this.viewT0) * (this.W - this.gutter); }
  xToT(x) { return this.viewT0 + (x - this.gutter) / (this.W - this.gutter) * (this.viewT1 - this.viewT0); }

  // ---- vertical layout ----
  _layout() {
    this.rows = [];
    this.trackY = new Map();
    this.groupY = new Map();
    let y = 0;
    for (const g of this.model.groups) {
      this.rows.push({ type: 'group', group: g, y, h: GROUP_H });
      this.groupY.set(g, y);
      y += GROUP_H;
      if (!g.collapsed) {
        for (const t of g.tracks) {
          const h = t.collapsed ? COLLAPSED_H : t.nLanes * ROW_H + TRACK_PAD * 2;
          this.rows.push({ type: 'track', track: t, y, h });
          this.trackY.set(t, y);
          y += h;
        }
      }
    }
    this.totalH = y;
    const maxScroll = Math.max(0, this.totalH - (this.H - RULER_H));
    this.scrollY = clamp(this.scrollY, 0, maxScroll);
  }

  // ---- navigation API ----
  zoomAt(factor, xPx) {
    const t = this.xToT(clamp(xPx, this.gutter, this.W));
    let span = (this.viewT1 - this.viewT0) * factor;
    span = clamp(span, MIN_SPAN, this.model.span * 4 + 1);
    const frac = (t - this.viewT0) / (this.viewT1 - this.viewT0);
    this.viewT0 = t - frac * span;
    this.viewT1 = this.viewT0 + span;
    this._clampPan();
    this.redraw();
  }

  panBy(dt) {
    this.viewT0 += dt; this.viewT1 += dt;
    this._clampPan();
    this.redraw();
  }

  _clampPan() {
    const span = this.viewT1 - this.viewT0;
    const lo = this.model.t0 - span * 0.9;
    const hi = this.model.t1 + span * 0.9;
    if (this.viewT0 < lo) { this.viewT0 = lo; this.viewT1 = lo + span; }
    if (this.viewT1 > hi) { this.viewT1 = hi; this.viewT0 = hi - span; }
  }

  resetView() {
    const pad = this.model.span * 0.02;
    this.viewT0 = this.model.t0 - pad;
    this.viewT1 = this.model.t1 + pad;
    this.redraw();
  }

  collapseAll(state) {
    for (const g of this.model.groups) g.collapsed = state;
    this.redraw();
  }

  select(track, idx, focus = false) {
    this.selection = idx >= 0 && track ? { track, idx } : null;
    if (this.selection && focus) this.focusSelection();
    this.cb.onSelect(this.selection);
    this.redraw();
  }

  focusSelection() {
    if (!this.selection) return;
    const { track, idx } = this.selection;
    const ts = track.ts[idx], dur = Math.max(track.dur[idx], MIN_SPAN);
    const span = Math.max(dur * 3, MIN_SPAN);
    this.viewT0 = ts + dur / 2 - span / 2;
    this.viewT1 = this.viewT0 + span;
    this._scrollTrackIntoView(track);
    this.redraw();
  }

  /**
   * Select the previous/next slice with the SAME name as the current selection,
   * ordered globally by start time (then track, then index). Wraps around.
   * Returns true if it moved. dir: +1 next, -1 prev.
   */
  selectSiblingByName(dir) {
    if (!this.selection) return false;
    if (!this._trackOrd) {
      this._trackOrd = new Map();
      let o = 0;
      for (const g of this.model.groups) for (const t of g.tracks) this._trackOrd.set(t, o++);
    }
    const sel = this.selection;
    const nameId = sel.track.nameId[sel.idx];
    const cT = sel.track.ts[sel.idx], cO = this._trackOrd.get(sel.track), cI = sel.idx;
    const cmp = (ts, o, i, b) => (ts - b.ts) || (o - b.ord) || (i - b.i);
    let nb = null, gmin = null, gmax = null;
    for (const g of this.model.groups) {
      for (const t of g.tracks) {
        const ord = this._trackOrd.get(t), ts = t.ts, nm = t.nameId, n = t.n;
        for (let i = 0; i < n; i++) {
          if (nm[i] !== nameId) continue;
          if (t === sel.track && i === cI) continue;
          const cand = { ts: ts[i], ord, i, t };
          if (!gmin || cmp(ts[i], ord, i, gmin) < 0) gmin = cand;
          if (!gmax || cmp(ts[i], ord, i, gmax) > 0) gmax = cand;
          const rel = (ts[i] - cT) || (ord - cO) || (i - cI);   // vs current
          if (dir > 0) {
            if (rel > 0 && (!nb || cmp(ts[i], ord, i, nb) < 0)) nb = cand;
          } else {
            if (rel < 0 && (!nb || cmp(ts[i], ord, i, nb) > 0)) nb = cand;
          }
        }
      }
    }
    const target = nb || (dir > 0 ? gmin : gmax);   // wrap around if at an end
    if (!target) return false;
    this.select(target.t, target.i);
    this.revealSelection();
    return true;
  }

  revealSelection() { // keep zoom, center time + scroll
    if (!this.selection) return;
    const { track, idx } = this.selection;
    const span = this.viewT1 - this.viewT0;
    const mid = track.ts[idx] + track.dur[idx] / 2;
    if (track.ts[idx] < this.viewT0 || track.ts[idx] + track.dur[idx] > this.viewT1) {
      this.viewT0 = mid - span / 2; this.viewT1 = mid + span / 2;
    }
    this._scrollTrackIntoView(track);
    this.redraw();
  }

  _scrollTrackIntoView(track) {
    this._layout();
    if (track.group.collapsed || track.collapsed) {
      track.group.collapsed = false; track.collapsed = false; this._layout();
    }
    const y = this.trackY.get(track);
    if (y === undefined) return;
    const lane = this.selection && this.selection.track === track
      ? track.lane[this.selection.idx] : 0;
    const top = y + TRACK_PAD + lane * ROW_H;
    const viewH = this.H - RULER_H;
    if (top < this.scrollY + 10) this.scrollY = Math.max(0, top - 60);
    else if (top + ROW_H > this.scrollY + viewH - 10) this.scrollY = top + ROW_H - viewH + 60;
  }

  setSearch(set) { this.searchSet = set; this.redraw(); }

  // ---- hit testing ----
  pick(x, y) {
    if (y < RULER_H) return null;
    const cy = y - RULER_H + this.scrollY;
    for (const row of this.rows) {
      if (cy >= row.y && cy < row.y + row.h) {
        if (row.type === 'group') return { type: 'group', group: row.group };
        const track = row.track;
        // collapse caret (gutter, left), or anywhere on a collapsed row, toggles
        if (track.collapsed || (x < this.gutter && x <= 18)) return { type: 'track-toggle', track };
        if (x < this.gutter) return { type: 'label', track };
        const lane = Math.floor((cy - row.y - TRACK_PAD) / ROW_H);
        if (lane < 0 || lane >= track.nLanes) return { type: 'track', track };
        const t = this.xToT(x);
        const idx = track.hitTest(t, lane);
        return { type: 'slice', track, idx, lane };
      }
    }
    return null;
  }

  // ---- drawing ----
  _draw() {
    this._layout();
    const ctx = this.ctx, W = this.W, H = this.H, th = this.th;
    ctx.save();
    ctx.fillStyle = th.canvasBg;
    ctx.fillRect(0, 0, W, H);

    const { step, t0: tick0 } = this._ticks();

    // content clip region
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.gutter, RULER_H, W - this.gutter, H - RULER_H);
    ctx.clip();

    // grid lines
    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = tick0; t <= this.viewT1; t += step) {
      const x = Math.round(this.tToX(t)) + 0.5;
      ctx.moveTo(x, RULER_H); ctx.lineTo(x, H);
    }
    ctx.stroke();

    // rows
    const yOff = RULER_H - this.scrollY;
    for (const row of this.rows) {
      const top = row.y + yOff;
      if (top + row.h < RULER_H || top > H) continue;
      if (row.type === 'group') {
        ctx.fillStyle = th.group;
        ctx.fillRect(this.gutter, top, W - this.gutter, row.h);
      } else {
        this._drawTrack(row.track, top);
        ctx.strokeStyle = th.rowSep;
        ctx.beginPath();
        ctx.moveTo(this.gutter, top + row.h - 0.5); ctx.lineTo(W, top + row.h - 0.5);
        ctx.stroke();
      }
    }

    this._drawSelection(yOff);
    this._drawFlows(yOff);
    ctx.restore();

    this._drawGutter(yOff);
    this._drawRuler(step, tick0);
    this._drawMeasure();
    ctx.restore();
    this._drawMinimap();
  }

  _drawTrack(track, top) {
    if (track.collapsed) return;   // collapsed: gutter shows the label, no slices
    const ctx = this.ctx, W = this.W, th = this.th;
    const scale = (W - this.gutter) / (this.viewT1 - this.viewT0);
    const search = this.searchSet;
    ctx.textBaseline = 'middle';
    ctx.font = SLICE_FONT;
    ctx.textAlign = 'center';
    // 'plain' palette: one color for the whole track, computed once.
    const plain = this.palette === 'plain';
    const trackCol = plain ? colorFor(trackColorKey(track), this.mode, this.palette) : null;

    for (let l = 0; l < track.nLanes; l++) {
      const yTop = top + TRACK_PAD + l * ROW_H;
      // subtle alternating lane shading so stacked overlap lanes read clearly
      if (track.nLanes > 1 && (l & 1)) {
        ctx.fillStyle = th.laneAlt;
        ctx.fillRect(this.gutter, yTop, W - this.gutter, ROW_H);
      }
      const { idx, maxEnd } = track.lanes[l];
      const hPx = ROW_H - 2;
      let i = lowerBound(maxEnd, this.viewT0);
      let mergeX0 = -1, mergeX1 = -1;
      const flushMerge = () => {
        if (mergeX0 >= 0) {
          ctx.fillStyle = th.merge;
          ctx.fillRect(mergeX0, yTop + 2, Math.max(mergeX1 - mergeX0, 0.6), hPx - 4);
          mergeX0 = -1;
        }
      };
      for (; i < idx.length; i++) {
        const e = idx[i];
        const ts = track.ts[e];
        if (ts > this.viewT1) break;
        const dur = track.dur[e];
        if (ts + dur < this.viewT0) continue;
        let x0 = this.gutter + (ts - this.viewT0) * scale;
        let x1 = this.gutter + (ts + dur - this.viewT0) * scale;
        if (x1 - x0 < 1) {                    // sub-pixel: merge into runs
          if (mergeX0 < 0) { mergeX0 = x0; mergeX1 = x0 + 1; }
          else if (x0 - mergeX1 < 1) { mergeX1 = Math.max(mergeX1, x0 + 1); }
          else { flushMerge(); mergeX0 = x0; mergeX1 = x0 + 1; }
          continue;
        }
        flushMerge();
        x0 = Math.max(x0, this.gutter - 4);
        x1 = Math.min(x1, W + 4);
        const w = x1 - x0;
        const name = this.model.strings[track.nameId[e]];
        const col = plain ? trackCol : colorFor(name, this.mode, this.palette);
        // While searching, keep non-matches visible (real color + label) but
        // faded, so the matches pop yet surrounding events stay inspectable.
        const dimmed = search && !search.has(track.nameId[e]);
        ctx.globalAlpha = dimmed ? 0.32 : 1;
        ctx.fillStyle = col.fill;
        ctx.fillRect(x0, yTop + 1, w, hPx - 2);
        if (w > 4) {
          ctx.strokeStyle = th.sliceBorder;
          ctx.lineWidth = 1;
          ctx.strokeRect(x0 + 0.5, yTop + 1.5, w - 1, hPx - 3);
        }
        if (w > 22) {
          ctx.fillStyle = col.text;
          const label = this._fitLabel(track.nameId[e], name, w - 6);
          if (label) ctx.fillText(label, (x0 + x1) / 2, yTop + ROW_H / 2 - 0.5);
        }
        if (dimmed) ctx.globalAlpha = 1;
      }
      ctx.globalAlpha = 1;
      flushMerge();
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';

    // instant events: small vertical ticks
    if (track.instants.length) {
      ctx.fillStyle = th.instant;
      for (const inst of track.instants) {
        if (inst.ts < this.viewT0 || inst.ts > this.viewT1) continue;
        const x = this.tToX(inst.ts);
        ctx.fillRect(x - 1, top + 1, 2, track.nLanes * ROW_H + TRACK_PAD);
      }
    }
  }

  _fitLabel(nameId, name, wPx) {
    const maxChars = Math.floor(wPx / SLICE_CHAR_W);
    if (maxChars < 3) return null;
    if (name.length <= maxChars) return name;
    const key = nameId * 4096 + Math.min(maxChars, 4095);
    let s = this._labelCache.get(key);
    if (s === undefined) {
      s = name.slice(0, maxChars - 1) + '…';
      if (this._labelCache.size > 20000) this._labelCache.clear();
      this._labelCache.set(key, s);
    }
    return s;
  }

  _drawSelection(yOff) {
    if (!this.selection) return;
    const { track, idx } = this.selection;
    const ts = track.ts[idx], dur = track.dur[idx];
    const x0 = this.tToX(ts), x1 = this.tToX(ts + dur);
    if (x1 < this.gutter || x0 > this.W) return;
    // Frame the box from the TOP of the row that represents the slice, matching
    // exactly how the slice/row is painted — the slice fills its lane from the
    // row top (not vertically centered), so centering the frame on the row would
    // leave an asymmetric inner margin.
    let top;
    if (track.group.collapsed) {
      const gy = this.groupY.get(track.group);
      if (gy === undefined) return;
      top = gy + yOff;
    } else {
      const y = this.trackY.get(track);
      if (y === undefined) return;
      top = track.collapsed ? y + yOff : y + yOff + TRACK_PAD + track.lane[idx] * ROW_H;
    }
    const ctx = this.ctx;
    ctx.strokeStyle = this.th.sel;
    ctx.lineWidth = 2;
    // Draw at the slice's true extent and let the content clip (active here) cut
    // off any off-screen parts, so the frame never overshoots the viewport and
    // off-screen edges simply aren't drawn.
    ctx.strokeRect(x0, top + 0.5, Math.max(x1 - x0, 2), ROW_H - 3);
    ctx.lineWidth = 1;
  }

  /**
   * Vertical center (canvas coords) of where slice `i` of `track` is drawn,
   * honoring collapse state. When the track's group is collapsed the track has
   * no row of its own, so the slice is represented by the group header row;
   * when the track itself is collapsed its row is COLLAPSED_H tall with no lanes.
   * Returns null if the slot maps to nothing visible.
   */
  _slotY(track, i, yOff) {
    if (track.group.collapsed) {
      const gy = this.groupY.get(track.group);
      return gy === undefined ? null : gy + yOff + GROUP_H / 2;
    }
    const y = this.trackY.get(track);
    if (y === undefined) return null;
    if (track.collapsed) return y + yOff + COLLAPSED_H / 2;
    return y + yOff + TRACK_PAD + track.lane[i] * ROW_H + ROW_H / 2;
  }

  _drawFlows(yOff) {
    if (!this.selection) return;
    const { track, idx } = this.selection;
    const out = track.flowOut.get(idx) || [];
    const inn = track.flowIn.get(idx) || [];
    if (!out.length && !inn.length) return;
    const ctx = this.ctx;
    ctx.strokeStyle = this.th.flow;
    ctx.fillStyle = this.th.flow;
    ctx.lineWidth = 1.5;
    const endpoint = (tr, i, atEnd) => {
      const cy = this._slotY(tr, i, yOff);
      if (cy === null) return null;
      const t = atEnd ? tr.ts[i] + tr.dur[i] : tr.ts[i];
      return { x: clamp(this.tToX(t), this.gutter, this.W), y: cy };
    };
    for (const flowId of [...out, ...inn]) {
      const fl = this.model.flows[flowId];
      const a = endpoint(fl.sTrack, fl.sIdx, true);
      const b = endpoint(fl.fTrack, fl.fIdx, false);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      const mx = (a.x + b.x) / 2;
      ctx.bezierCurveTo(mx, a.y, mx, b.y, b.x, b.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - 6, b.y - 3.5);
      ctx.lineTo(b.x - 6, b.y + 3.5);
      ctx.fill();
    }
  }

  _drawGutter(yOff) {
    const ctx = this.ctx, th = this.th;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_H, this.gutter, this.H - RULER_H);
    ctx.clip();
    ctx.fillStyle = th.gutter;
    ctx.fillRect(0, RULER_H, this.gutter, this.H - RULER_H);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const row of this.rows) {
      const top = row.y + yOff;
      if (top + row.h < RULER_H || top > this.H) continue;
      if (row.type === 'group') {
        ctx.fillStyle = th.group;
        ctx.fillRect(0, top, this.gutter, row.h);
        ctx.fillStyle = th.groupText;
        ctx.font = FONT_GROUP;
        const arrow = row.group.collapsed ? '▸' : '▾';
        // truncate with an ellipsis rather than letting fillText squeeze the font
        ctx.fillText(this._ellipsize(`${arrow}  ${row.group.displayName()}`, this.gutter - 8 - 10), 8, top + row.h / 2);
      } else {
        const t = row.track;
        // sticky: keep the label visible while a tall track spans the viewport
        let ly = top + Math.min(row.h / 2, TRACK_PAD + ROW_H / 2);
        ly = clamp(ly, Math.max(top + 9, RULER_H + 11), top + row.h - 9);
        let reserve = 14;
        if (t.nLanes > 1) {
          ctx.fillStyle = th.badge;
          ctx.font = FONT_MONO;
          const badge = `▤×${t.nLanes}`;
          reserve = ctx.measureText(badge).width + 18;
          ctx.textAlign = 'right';
          ctx.fillText(badge, this.gutter - 10, ly);
          ctx.textAlign = 'left';
        }
        ctx.fillStyle = th.trackText;
        ctx.font = FONT;
        ctx.fillText(t.collapsed ? '▸' : '▾', 6, ly);   // per-track collapse caret
        ctx.fillText(this._ellipsize(t.name || `tid ${t.tid}`, this.gutter - 26 - reserve), 22, ly);
      }
      ctx.strokeStyle = th.rowSep;
      ctx.beginPath();
      ctx.moveTo(0, top + row.h - 0.5); ctx.lineTo(this.gutter, top + row.h - 0.5);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = th.divider;
    ctx.beginPath();
    ctx.moveTo(this.gutter + 0.5, 0); ctx.lineTo(this.gutter + 0.5, this.H);
    ctx.stroke();
  }

  /** Truncate text with an ellipsis to fit maxPx using the current ctx.font. */
  _ellipsize(text, maxPx) {
    const ctx = this.ctx;
    if (maxPx <= 0) return '';
    if (ctx.measureText(text).width <= maxPx) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(text.slice(0, mid) + '…').width <= maxPx) lo = mid; else hi = mid - 1;
    }
    return lo > 0 ? text.slice(0, lo) + '…' : '';
  }

  _ticks() {
    const span = this.viewT1 - this.viewT0;
    const target = span * 110 / Math.max(this.W - this.gutter, 100);
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    let step = pow;
    for (const m of [1, 2, 5, 10]) { if (pow * m >= target) { step = pow * m; break; } }
    const rel0 = this.viewT0 - this.model.t0;
    const t0 = this.model.t0 + Math.ceil(rel0 / step) * step;
    return { step, t0 };
  }

  _drawRuler(step, tick0) {
    const ctx = this.ctx, th = this.th;
    ctx.fillStyle = th.ruler;
    ctx.fillRect(0, 0, this.W, RULER_H);
    ctx.strokeStyle = th.divider;
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 0.5); ctx.lineTo(this.W, RULER_H - 0.5);
    ctx.stroke();
    ctx.font = FONT_MONO;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.gutter, 0, this.W - this.gutter, RULER_H);
    ctx.clip();
    for (let t = tick0; t <= this.viewT1; t += step) {
      const x = Math.round(this.tToX(t)) + 0.5;
      ctx.strokeStyle = th.tick;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 7); ctx.lineTo(x, RULER_H);
      ctx.stroke();
      const d = t - this.model.t0;
      const label = Math.abs(d) < 1e-9 ? '0' : (d < 0 ? '−' : '+') + fmtTime(Math.abs(d), 2);
      ctx.fillStyle = th.tickText;
      ctx.fillText(label, x + 3, RULER_H / 2);
    }
    ctx.restore();
    ctx.fillStyle = th.subText;
    ctx.font = FONT_MONO;
    ctx.fillText('span ' + fmtTime(this.viewT1 - this.viewT0, 2), 8, RULER_H / 2);
  }

  _drawMeasure() {
    if (!this.measure) return;
    const { tA, tB } = this.measure;
    const x0 = this.tToX(Math.min(tA, tB)), x1 = this.tToX(Math.max(tA, tB));
    const ctx = this.ctx, th = this.th;
    ctx.fillStyle = th.measFill;
    ctx.fillRect(x0, RULER_H, x1 - x0, this.H - RULER_H);
    ctx.strokeStyle = th.meas;
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, RULER_H); ctx.lineTo(x0 + 0.5, this.H);
    ctx.moveTo(x1 - 0.5, RULER_H); ctx.lineTo(x1 - 0.5, this.H);
    ctx.stroke();
    const label = fmtTime(Math.abs(tB - tA), 3);
    ctx.font = FONT_BOLD;
    const w = ctx.measureText(label).width + 14;
    ctx.fillStyle = th.meas;
    ctx.fillRect((x0 + x1) / 2 - w / 2, RULER_H + 6, w, 19);
    ctx.fillStyle = th.measText;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(label, (x0 + x1) / 2 - w / 2 + 7, RULER_H + 15.5);
  }

  // ---- minimap ----
  _computeDensity() {
    const N = 1600;
    const d = new Float32Array(N);
    const span = this.model.span || 1;
    for (const g of this.model.groups) {
      for (const t of g.tracks) {
        for (let i = 0; i < t.n; i++) {
          const a = (t.ts[i] - this.model.t0) / span * N;
          const b = (t.ts[i] + t.dur[i] - this.model.t0) / span * N;
          const i0 = clamp(Math.floor(a), 0, N - 1);
          const i1 = clamp(Math.floor(b), 0, N - 1);
          if (i0 === i1) { d[i0] += (b - a); continue; }
          d[i0] += i0 + 1 - a;
          for (let k = i0 + 1; k < i1; k++) d[k] += 1;
          d[i1] += b - i1;
        }
      }
    }
    let max = 0;
    for (let i = 0; i < N; i++) max = Math.max(max, d[i]);
    if (max > 0) for (let i = 0; i < N; i++) d[i] = Math.pow(d[i] / max, 0.4);
    this._density = d;
  }

  _drawMinimap() {
    const ctx = this.mmCtx, th = this.th;
    const r = this.minimap.getBoundingClientRect();
    const W = r.width, H = r.height;
    ctx.fillStyle = th.mmBg;
    ctx.fillRect(0, 0, W, H);
    const d = this._density;
    if (d) {
      ctx.fillStyle = th.mmBar;
      const N = d.length;
      for (let x = 0; x < W; x++) {
        const v = d[Math.floor(x / W * N)];
        if (v > 0) {
          const h = Math.max(1, v * (H - 8));
          ctx.fillRect(x, H - 4 - h, 1, h);
        }
      }
    }
    const span = this.model.span || 1;
    const x0 = (this.viewT0 - this.model.t0) / span * W;
    const x1 = (this.viewT1 - this.model.t0) / span * W;
    ctx.fillStyle = th.measFill;
    ctx.fillRect(x0, 0, Math.max(x1 - x0, 2), H);
    ctx.strokeStyle = th.meas;
    ctx.strokeRect(x0 + 0.5, 0.5, Math.max(x1 - x0, 2) - 1, H - 1);
    ctx.strokeStyle = th.divider;
    ctx.beginPath();
    ctx.moveTo(0, H - 0.5); ctx.lineTo(W, H - 0.5);
    ctx.stroke();
  }

  // ---- events ----
  _bindEvents() {
    const cv = this.canvas;
    let drag = null;
    let gutterDrag = false;
    const nearGutter = (x) => Math.abs(x - this.gutter) <= GUTTER_GRAB;

    cv.addEventListener('mousedown', (ev) => {
      cv.focus();
      const { x, y } = this._rel(ev);
      if (nearGutter(x)) {            // grab the gutter divider to resize it
        gutterDrag = true; ev.preventDefault(); return;
      }
      drag = {
        x, y, moved: false, shift: ev.shiftKey,
        t0: this.viewT0, t1: this.viewT1, scrollY: this.scrollY,
        tStart: this.xToT(x),
      };
      if (drag.shift) this.measure = { tA: drag.tStart, tB: drag.tStart };
    });

    window.addEventListener('mousemove', (ev) => {
      const { x, y } = this._rel(ev);
      this.mouseX = x;
      if (gutterDrag) {
        this.gutterPref = clamp(Math.round(x), GUTTER_MIN, GUTTER_MAX);
        localStorage.setItem('dark-trace-gutter', String(this.gutterPref));
        this._clampGutter();
        if (this.hover) { this.hover = null; this.cb.onHover(null); }
        cv.style.cursor = 'ew-resize';
        this.redraw();
        return;
      }
      if (drag) {
        const dx = x - drag.x, dy = y - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.shift) {
          this.measure.tB = this.xToT(x);
        } else {
          const scale = (drag.t1 - drag.t0) / (this.W - this.gutter);
          this.viewT0 = drag.t0 - dx * scale;
          this.viewT1 = drag.t1 - dx * scale;
          this._clampPan();
          this.scrollY = drag.scrollY - dy;
        }
        this.redraw();
        return;
      }
      if (ev.target !== cv) { if (this.hover) { this.hover = null; this.cb.onHover(null); } return; }
      if (nearGutter(x)) {            // hovering the divider
        if (this.hover) { this.hover = null; this.cb.onHover(null); }
        cv.style.cursor = 'ew-resize';
        return;
      }
      const hit = this.pick(x, y);
      if (hit && hit.type === 'slice' && hit.idx >= 0) {
        this.hover = hit;
        this.cb.onHover({ ...hit, clientX: ev.clientX, clientY: ev.clientY });
        cv.style.cursor = 'pointer';
      } else {
        this.hover = null;
        this.cb.onHover(null);
        cv.style.cursor = hit && (hit.type === 'group' || hit.type === 'track-toggle') ? 'pointer' : 'default';
      }
    });

    window.addEventListener('mouseup', (ev) => {
      if (gutterDrag) { gutterDrag = false; this.redraw(); return; }
      if (!drag) return;
      const wasDrag = drag.moved, wasShift = drag.shift;
      drag = null;
      if (wasShift) { this.redraw(); return; }
      if (wasDrag) return;
      const { x, y } = this._rel(ev);
      this.measure = null;
      const hit = this.pick(x, y);
      if (!hit) { this.select(null, -1); return; }
      if (hit.type === 'group') { hit.group.collapsed = !hit.group.collapsed; this.redraw(); return; }
      if (hit.type === 'track-toggle') { hit.track.collapsed = !hit.track.collapsed; this.redraw(); return; }
      if (hit.type === 'slice' && hit.idx >= 0) this.select(hit.track, hit.idx);
      else this.select(null, -1);
    });

    cv.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      if (ev.ctrlKey || ev.metaKey) {
        this.zoomAt(Math.exp(ev.deltaY * 0.002), this._rel(ev).x);
      } else if (ev.shiftKey) {
        this.panBy((ev.deltaY + ev.deltaX) * (this.viewT1 - this.viewT0) / (this.W - this.gutter) * 1.5);
      } else {
        if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
          this.panBy(ev.deltaX * (this.viewT1 - this.viewT0) / (this.W - this.gutter) * 1.5);
        } else {
          this.scrollY += ev.deltaY;
          this.redraw();
        }
      }
    }, { passive: false });

    cv.addEventListener('dblclick', (ev) => {
      const hit = this.pick(this._rel(ev).x, this._rel(ev).y);
      if (hit && hit.type === 'slice' && hit.idx >= 0) {
        this.select(hit.track, hit.idx);
        this.focusSelection();
      }
    });

    window.addEventListener('keydown', (ev) => {
      if (ev.target instanceof HTMLInputElement) return;
      const span = this.viewT1 - this.viewT0;
      switch (ev.key.toLowerCase()) {
        case 'w': this.zoomAt(0.7, this.mouseX); break;
        case 's': this.zoomAt(1 / 0.7, this.mouseX); break;
        case 'a': this.panBy(-span * 0.15); break;
        case 'd': this.panBy(span * 0.15); break;
        case 'f': this.focusSelection(); break;
        case ',': case '<': this.selectSiblingByName(-1); break;
        case '.': case '>': this.selectSiblingByName(1); break;
        case '0': case 'home': this.resetView(); break;
        case 'escape': this.measure = null; this.select(null, -1); break;
        default: return;
      }
      ev.preventDefault();
    });

    // minimap interaction
    const mmNav = (ev) => {
      const r = this.minimap.getBoundingClientRect();
      const frac = clamp((ev.clientX - r.left) / r.width, 0, 1);
      const span = this.viewT1 - this.viewT0;
      const mid = this.model.t0 + frac * this.model.span;
      this.viewT0 = mid - span / 2;
      this.viewT1 = mid + span / 2;
      this._clampPan();
      this.redraw();
    };
    let mmDrag = false;
    this.minimap.addEventListener('mousedown', (ev) => { mmDrag = true; mmNav(ev); });
    window.addEventListener('mousemove', (ev) => { if (mmDrag) mmNav(ev); });
    window.addEventListener('mouseup', () => { mmDrag = false; });
    this.minimap.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const r = this.minimap.getBoundingClientRect();
      const frac = clamp((ev.clientX - r.left) / r.width, 0, 1);
      this.zoomAt(Math.exp(ev.deltaY * 0.002), this.gutter + frac * (this.W - this.gutter));
    }, { passive: false });

    window.addEventListener('resize', () => this.resize());
  }

  _rel(ev) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
}
