// Chrome Trace Format (as emitted by the PyTorch/Kineto profiler) -> view model.
//
// The one thing this viewer does differently from Perfetto / chrome://tracing:
// slices that overlap on the same thread/stream are NEVER dropped. Every track
// lays its events out with a greedy first-fit lane assignment, so a partially
// overlapping slice simply opens an extra lane (row) inside the track instead
// of disappearing. For well-nested CPU stacks this reproduces the classic
// flame layout exactly; for GPU streams with overlapping kernels/annotations
// the track just grows taller.

import { lowerBound } from './util.js';

const LANE_EPS = 0.001; // µs; overlaps smaller than 1 ns are treated as touching

class Track {
  constructor(group, pid, tid) {
    this.group = group;
    this.pid = pid;
    this.tid = tid;
    this.name = null;
    this.sortIndex = typeof tid === 'number' ? tid : 0;
    this.events = [];     // staging: raw {name, cat, ts, dur, args}
    this.instants = [];
    // finalized:
    this.n = 0;
    this.ts = null; this.dur = null; this.lane = null;
    this.nameId = null; this.catId = null; this.args = null;
    this.lanes = [];      // [{idx: Uint32Array, maxEnd: Float64Array}]
    this.nLanes = 1;
    this.flowOut = new Map(); // event idx -> flow indices
    this.flowIn = new Map();
  }

  finalize(model) {
    const evs = this.events;
    const n = this.n = evs.length;
    // parents (longer slices) first at equal ts -> flame-like nesting
    evs.sort((a, b) => (a.ts - b.ts) || (b.dur - a.dur));
    this.ts = new Float64Array(n);
    this.dur = new Float64Array(n);
    this.lane = new Uint16Array(n);
    this.nameId = new Int32Array(n);
    this.catId = new Int32Array(n);
    this.args = new Array(n);
    const laneEnds = [];
    const laneIdx = [];
    const open = [];   // stack of open-parent end times, for call-tree nesting
    // GPU/device streams run genuinely concurrently, so their event lengths must
    // never be clipped. Such tracks live in a group labelled "GPU<n>" and their
    // events carry CUDA device/stream args — either marks the whole track as a
    // device stream that is exempt from the call-stack clip below.
    const grp = this.group;
    const deviceGroup = /gpu/i.test(grp.label || '') || /gpu/i.test(grp.name || '');
    for (let i = 0; i < n; i++) {
      const e = evs[i];
      const a = e.args;
      const device = deviceGroup || (a && (a.stream !== undefined || a.device !== undefined));
      // A sequential (CPU) call stack is a tree: a child cannot outlive its
      // parent. Some profilers stretch a frame's duration to the capture/stop
      // instant, so it overshoots its parent by up to the whole trace (e.g.
      // pybind11 __exit__ frames all ending at profiler-stop) and renders as a
      // huge bar. Clip such overshoots to the parent's end. Device-stream events
      // are exempt — their overlaps are real and lengths are kept verbatim.
      while (open.length && open[open.length - 1] <= e.ts + LANE_EPS) open.pop();
      let end = e.ts + e.dur;
      if (!device) {
        const parentEnd = open.length ? open[open.length - 1] : Infinity;
        if (end > parentEnd) { end = parentEnd; e.dur = Math.max(0, end - e.ts); }
      }
      open.push(end);

      this.ts[i] = e.ts;
      this.dur[i] = e.dur;
      this.nameId[i] = model.internString(e.name);
      this.catId[i] = model.internString(e.cat || '');
      this.args[i] = e.args || null;
      // greedy first-fit lane assignment
      let lane = -1;
      for (let l = 0; l < laneEnds.length; l++) {
        if (laneEnds[l] <= e.ts + LANE_EPS) { lane = l; break; }
      }
      if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); laneIdx.push([]); }
      laneEnds[lane] = Math.max(laneEnds[lane], e.ts + e.dur);
      laneIdx[lane].push(i);
      this.lane[i] = lane;
    }
    this.nLanes = Math.max(1, laneEnds.length);
    if (!laneIdx.length) laneIdx.push([]); // instants-only track still has one lane
    this.lanes = laneIdx.map(list => {
      const idx = Uint32Array.from(list);
      const maxEnd = new Float64Array(idx.length);
      let m = -Infinity;
      for (let i = 0; i < idx.length; i++) {
        m = Math.max(m, this.ts[idx[i]] + this.dur[idx[i]]);
        maxEnd[i] = m;
      }
      return { idx, maxEnd };
    });
    this.events = null; // release staging objects
    this.instants.sort((a, b) => a.ts - b.ts);
  }

  /**
   * Duration of slice `i` that does NOT overlap the previous slice on the track
   * (the one with the largest start time before it — index i-1, since slices are
   * stored sorted by start):
   *   end   = this slice's end
   *   start = max(previous slice's end, this slice's start)
   *   dur   = max(0, end - start)
   * Defensive by design: when slices are deeply nested/overlapping the result is
   * clamped to 0 rather than going negative. Only the immediate predecessor is
   * considered, which is exact for the common case of at most two overlapping.
   */
  nonOverlapDur(i) {
    const start = this.ts[i], end = start + this.dur[i];
    const prevEnd = i > 0 ? this.ts[i - 1] + this.dur[i - 1] : -Infinity;
    return Math.max(0, end - Math.max(prevEnd, start));
  }

  /** Deepest slice covering time t, or -1. */
  hitTest(t, fromLane = null) {
    const lanes = this.lanes;
    const order = fromLane !== null ? [fromLane] : null;
    for (let li = lanes.length - 1; li >= 0; li--) {
      const l = order ? order[0] : li;
      if (l >= lanes.length) continue;
      const { idx } = lanes[l];
      // last event in lane with ts <= t
      let lo = 0, hi = idx.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.ts[idx[mid]] <= t) lo = mid + 1; else hi = mid;
      }
      const i = lo - 1;
      if (i >= 0) {
        const e = idx[i];
        if (t <= this.ts[e] + Math.max(this.dur[e], 0)) return e;
      }
      if (order) return -1;
    }
    return -1;
  }
}

class ProcessGroup {
  constructor(key, pid, fileTag) {
    this.key = key;
    this.pid = pid;
    this.fileTag = fileTag;
    this.name = null;
    this.label = null;
    this.sortIndex = null; // from process_sort_index metadata; unnamed groups sink
    this.tracks = new Map(); // tid -> Track
    this.collapsed = false;
  }
  track(tid) {
    let t = this.tracks.get(tid);
    if (!t) { t = new Track(this, this.pid, tid); this.tracks.set(tid, t); }
    return t;
  }
  displayName() {
    const parts = [];
    if (this.fileTag) parts.push(this.fileTag);
    if (this.label) parts.push(this.label);
    if (this.name && this.name !== this.label) parts.push(this.name);
    return parts.join(' · ') || `pid ${this.pid}`;
  }
}

export class TraceModel {
  constructor() {
    this.groups = [];          // sorted ProcessGroups with non-empty tracks
    this.t0 = Infinity;        // absolute µs
    this.t1 = -Infinity;
    this.strings = [];
    this._stringIds = new Map();
    this.flows = [];           // {s:{track,idx}, f:{track,idx}, cat}
    this._files = [];
  }

  internString(s) {
    let id = this._stringIds.get(s);
    if (id === undefined) { id = this.strings.length; this.strings.push(s); this._stringIds.set(s, id); }
    return id;
  }

  get span() { return this.t1 - this.t0; }

  /**
   * Ingest one Chrome-trace JSON object. fileTag distinguishes multiple files
   * (e.g. TP ranks) loaded side by side.
   */
  addTraceJson(data, fileTag) {
    const events = Array.isArray(data) ? data : data.traceEvents;
    if (!Array.isArray(events)) throw new Error('no traceEvents found');
    const groups = new Map(); // pid -> ProcessGroup
    const groupOf = (pid) => {
      let g = groups.get(pid);
      if (!g) { g = new ProcessGroup(`${fileTag}/${pid}`, pid, fileTag); groups.set(pid, g); }
      return g;
    };
    const beStacks = new Map(); // pid tid -> stack of pending B events
    const rawFlows = new Map(); // cat id -> {s:[], f:[]}

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const ph = e.ph;
      if (ph === 'X') {
        const dur = +e.dur || 0;
        const ts = +e.ts;
        groupOf(e.pid).track(e.tid).events.push(
          { name: e.name || '?', cat: e.cat, ts, dur, args: e.args });
        if (ts < this.t0) this.t0 = ts;
        if (ts + dur > this.t1) this.t1 = ts + dur;
      } else if (ph === 'B' || ph === 'E') {
        const key = e.pid + ' ' + e.tid;
        if (ph === 'B') {
          let st = beStacks.get(key);
          if (!st) beStacks.set(key, st = []);
          st.push(e);
        } else {
          const st = beStacks.get(key);
          const b = st && st.pop();
          if (b) {
            const ts = +b.ts, dur = Math.max(0, +e.ts - ts);
            groupOf(b.pid).track(b.tid).events.push(
              { name: b.name || '?', cat: b.cat, ts, dur, args: { ...b.args, ...e.args } });
            if (ts < this.t0) this.t0 = ts;
            if (ts + dur > this.t1) this.t1 = ts + dur;
          }
        }
      } else if (ph === 's' || ph === 'f' || ph === 't') {
        const key = (e.cat || '') + ' ' + e.id;
        let fl = rawFlows.get(key);
        if (!fl) rawFlows.set(key, fl = { s: null, f: [] });
        if (ph === 's') fl.s = e; else fl.f.push(e);
      } else if (ph === 'i' || ph === 'I') {
        groupOf(e.pid).track(e.tid).instants.push({ ts: +e.ts, name: e.name || '?' });
      } else if (ph === 'M') {
        const g = groupOf(e.pid);
        const a = e.args || {};
        switch (e.name) {
          case 'process_name': g.name = a.name; break;
          case 'process_labels': g.label = a.labels; break;
          case 'process_sort_index': g.sortIndex = a.sort_index; break;
          case 'thread_name': g.track(e.tid).name = a.name; break;
          case 'thread_sort_index': g.track(e.tid).sortIndex = a.sort_index; break;
        }
      }
      // other phases (C, a/b/n async, …) are ignored
    }

    // finalize tracks; drop empty ones / empty groups
    const kept = [];
    for (const g of groups.values()) {
      const tracks = [...g.tracks.values()].filter(t => t.events.length || t.instants.length);
      if (!tracks.length) continue;
      for (const t of tracks) t.finalize(this);
      tracks.sort((a, b) => (a.sortIndex - b.sortIndex) ||
        String(a.tid).localeCompare(String(b.tid)));
      g.tracks = tracks;
      kept.push(g);
    }
    const groupKey = (g) => g.sortIndex ??
      (typeof g.pid === 'number' && g.name ? g.pid : Number.MAX_SAFE_INTEGER);
    kept.sort((a, b) => (groupKey(a) - groupKey(b)) ||
      String(a.pid).localeCompare(String(b.pid)));
    this.groups.push(...kept);

    // resolve flows: bind each endpoint to the deepest slice covering its ts
    const trackByKey = new Map();
    for (const g of kept) for (const t of g.tracks) trackByKey.set(g.pid + ' ' + t.tid, t);
    for (const fl of rawFlows.values()) {
      if (!fl.s || !fl.f.length) continue;
      const sTrack = trackByKey.get(fl.s.pid + ' ' + fl.s.tid);
      if (!sTrack) continue;
      const sIdx = sTrack.hitTest(+fl.s.ts);
      if (sIdx < 0) continue;
      for (const fe of fl.f) {
        const fTrack = trackByKey.get(fe.pid + ' ' + fe.tid);
        if (!fTrack) continue;
        const fIdx = fTrack.hitTest(+fe.ts);
        if (fIdx < 0) continue;
        const flowId = this.flows.length;
        this.flows.push({ sTrack, sIdx, fTrack, fIdx, cat: fl.s.cat || '' });
        pushMap(sTrack.flowOut, sIdx, flowId);
        pushMap(fTrack.flowIn, fIdx, flowId);
      }
    }
    this._files.push(fileTag);
  }

  /** Total slice count (for the title bar). */
  countSlices() {
    let n = 0;
    for (const g of this.groups) for (const t of g.tracks) n += t.n;
    return n;
  }
}

function pushMap(map, key, val) {
  const a = map.get(key);
  if (a) a.push(val); else map.set(key, [val]);
}

export { lowerBound };
