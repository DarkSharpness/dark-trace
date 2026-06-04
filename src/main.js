import { gunzip, isGzip, untar } from './targz.js';
import { TraceModel } from './parse.js';
import { Viewer, trackColorKey } from './render.js';
import { fmtTime, escapeHtml } from './util.js';
import { colorFor } from './color.js';
import * as theme from './theme.js';
import * as palette from './palette.js';

const $ = (id) => document.getElementById(id);
const td = new TextDecoder();

let viewer = null;
let model = null;

// Canvas 2D doesn't trigger webfont loading and silently falls back until the
// font is already loaded, so we preload the timeline faces and redraw once ready.
if (document.fonts && document.fonts.load) {
  Promise.all([
    document.fonts.load('400 12px Roboto'),
    document.fonts.load('500 12px Roboto'),
    document.fonts.load('400 11px "Roboto Mono"'),
  ]).then(() => { if (viewer) viewer.redraw(); }).catch(() => {});
}
let mode = theme.resolveMode();
let pal = palette.getPalette();

// ---------- status ----------
function status(msg, isError = false) {
  const el = $('status');
  el.hidden = !msg;
  el.textContent = msg || '';
  el.classList.toggle('error', isError);
}
const tick = () => new Promise(r => setTimeout(r, 0));

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

// ---------- file loading ----------
async function handleFile(file) {
  try {
    $('picker').hidden = true;
    status(`reading ${file.name}…`);
    await tick();
    const buf = new Uint8Array(await file.arrayBuffer());
    await handleBuffer(buf, file.name);
  } catch (err) {
    console.error(err);
    status(`failed to load: ${err.message}`, true);
  }
}

async function handleBuffer(buf, name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar')) {
    let bytes = buf;
    if (isGzip(bytes)) {
      status(`decompressing ${name}…`);
      await tick();
      bytes = await gunzip(bytes);
    }
    const entries = untar(bytes)
      .map(f => ({ ...f, name: f.name.replace(/^(\.\/)+/, '') }))
      .filter(f => /\.json(\.gz)?$/i.test(f.name) &&
        !/(^|\/)[._]/.test(f.name) && !f.name.includes('__MACOSX'));
    if (!entries.length) throw new Error('no .json / .json.gz files inside the archive');
    showPicker(entries, name);
    return;
  }
  status(`decompressing ${name}…`);
  await tick();
  const text = td.decode(isGzip(buf) ? await gunzip(buf) : buf);
  await buildModel([{ name, text }], name);
}

function shortTag(entryName) {
  const base = entryName.split('/').pop();
  const m = base.match(/TP-?\d+|rank-?\d+|worker-?\d+/i);
  return m ? m[0] : base.replace(/\.trace\.json(\.gz)?$|\.json(\.gz)?$/i, '');
}

function showPicker(entries, archiveName) {
  const list = $('picker-list');
  list.innerHTML = '';
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const isTrace = (e) => /\.trace\.json(\.gz)?$/i.test(e.name);
  const hasTrace = entries.some(isTrace);
  let firstChecked = false;
  for (const e of entries) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    const preferred = hasTrace ? isTrace(e) : true;
    cb.checked = preferred && !firstChecked;
    if (cb.checked) firstChecked = true;
    cb.dataset.name = e.name;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(e.name));
    const sz = document.createElement('span');
    sz.className = 'sz';
    sz.textContent = fmtBytes(e.data.length);
    label.appendChild(sz);
    list.appendChild(label);
  }
  $('picker').hidden = false;
  status(entries.length > 1
    ? 'tip: loading many large traces at once needs a lot of memory — start with one rank'
    : '');
  $('picker-all').onclick = () => list.querySelectorAll('input').forEach(c => c.checked = true);
  $('picker-none').onclick = () => list.querySelectorAll('input').forEach(c => c.checked = false);
  $('picker-load').onclick = async () => {
    const chosen = [...list.querySelectorAll('input')].filter(c => c.checked).map(c => c.dataset.name);
    if (!chosen.length) { status('select at least one file', true); return; }
    const files = [];
    for (const nm of chosen) {
      const entry = entries.find(e => e.name === nm);
      status(`decompressing ${nm}…`);
      await tick();
      const bytes = isGzip(entry.data) ? await gunzip(entry.data) : entry.data;
      files.push({ name: nm, text: td.decode(bytes) });
    }
    await buildModel(files, archiveName);
  };
}

async function buildModel(files, title) {
  model = new TraceModel();
  const multi = files.length > 1;
  for (const f of files) {
    status(`parsing ${f.name} (${fmtBytes(f.text.length)})…`);
    await tick();
    let data;
    try {
      data = JSON.parse(f.text);
    } catch (e) {
      status(`skipping ${f.name}: not valid JSON`, true);
      await new Promise(r => setTimeout(r, 800));
      continue;
    }
    if (!data || (!Array.isArray(data) && !Array.isArray(data.traceEvents))) continue;
    status(`building tracks for ${f.name}…`);
    await tick();
    model.addTraceJson(data, multi ? shortTag(f.name) : '');
    f.text = null;
  }
  if (!model.groups.length) {
    status('no trace events found in the selected file(s)', true);
    return;
  }
  status('');
  $('landing').hidden = true;
  $('viewer').hidden = false;
  document.title = `${title} — dark-trace`;

  // sidebar stats
  let nTracks = 0, nStreams = 0;
  for (const g of model.groups) for (const t of g.tracks) {
    nTracks++;
    if (t.nLanes > 1) nStreams++;
  }
  $('side-trace').hidden = false;
  $('side-stats').innerHTML =
    `<span class="fn">${escapeHtml(title)}</span>` +
    `<b>${model.countSlices().toLocaleString()}</b> slices · <b>${model.groups.length}</b> groups<br>` +
    `<b>${nTracks}</b> tracks · duration <b>${fmtTime(model.span, 1)}</b>` +
    (nStreams ? `<br><b>${nStreams}</b> track(s) with stacked overlaps` : '');

  $('search').disabled = false;
  $('search').value = '';
  runSearch();

  viewer = new Viewer($('timeline'), $('minimap'), model, {
    onSelect: showDetails,
    onHover: showTooltip,
  }, mode, pal);
  viewer.resize();
  $('timeline').focus();
}

// ---------- tooltip ----------
function showTooltip(info) {
  const tt = $('tooltip');
  if (!info || !viewer) { tt.hidden = true; return; }
  const { track, idx } = info;
  const name = model.strings[track.nameId[idx]];
  const cat = model.strings[track.catId[idx]];
  const col = colorFor(pal === 'plain' ? trackColorKey(track) : name, mode, pal).fill;
  tt.innerHTML =
    `<div class="tt-name"><span class="tt-sw" style="background:${col}"></span>${escapeHtml(name)}</div>` +
    `<div class="tt-row"><b>dur</b> ${fmtTime(track.dur[idx])} · <b>start</b> +${fmtTime(track.ts[idx] - model.t0)}` +
    (cat ? ` · <b>cat</b> ${escapeHtml(cat)}` : '') + `</div>`;
  tt.hidden = false;
  // Coords are all in visual px (clientX, innerWidth, getBoundingClientRect under
  // the root `zoom` all report visual). The tooltip lives inside the zoomed root,
  // so its left/top are interpreted in layout px — divide by the scale.
  const pad = 14;
  let x = info.clientX + pad, y = info.clientY + pad;
  const r = tt.getBoundingClientRect();
  if (x + r.width > innerWidth - 8) x = info.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = info.clientY - r.height - pad;
  tt.style.left = (x / UI_SCALE) + 'px';
  tt.style.top = (y / UI_SCALE) + 'px';
}

// ---------- drawer (details + flows) ----------
let currentSel = null;

function showDetails(sel) {
  currentSel = sel;
  const drawer = $('drawer');
  if (sel && drawer.hidden) { drawer.hidden = false; viewer && viewer.resize(); }
  renderSelPane(sel);
  renderFlowsPane(sel);
}

function renderSelPane(sel) {
  const pane = document.querySelector('[data-pane="sel"]');
  if (!sel) { pane.innerHTML = '<div class="empty">No slice selected. Click a slice in the timeline.</div>'; return; }
  const { track, idx } = sel;
  const name = model.strings[track.nameId[idx]];
  const cat = model.strings[track.catId[idx]];
  const col = colorFor(pal === 'plain' ? trackColorKey(track) : name, mode, pal).fill;
  const rows = [
    ['category', cat || '—'],
    ['start', `+${fmtTime(track.ts[idx] - model.t0)}`],
    ['duration', fmtTime(track.dur[idx])],
    ['end', `+${fmtTime(track.ts[idx] + track.dur[idx] - model.t0)}`],
    ['track', `${track.group.displayName()} ▸ ${track.name || 'tid ' + track.tid}`],
    ['lane', `${track.lane[idx]} of ${track.nLanes}`],
  ];
  const args = track.args[idx];
  if (args) for (const [k, v] of Object.entries(args)) {
    rows.push([k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
  }
  pane.innerHTML =
    `<div class="sel-title"><span class="sw" style="background:${col}"></span>${escapeHtml(name)}</div>` +
    '<table class="kv">' + rows.map(([k, v]) =>
      `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('') + '</table>';
}

function renderFlowsPane(sel) {
  const pane = document.querySelector('[data-pane="flows"]');
  if (!sel) { pane.innerHTML = '<div class="empty">No slice selected.</div>'; return; }
  const { track, idx } = sel;
  const out = (track.flowOut.get(idx) || []).map(id => ({ fl: model.flows[id], dir: 'out' }));
  const inn = (track.flowIn.get(idx) || []).map(id => ({ fl: model.flows[id], dir: 'in' }));
  const all = [...inn, ...out];
  if (!all.length) {
    pane.innerHTML = '<div class="empty">No flow events connect to this slice.<br>(Flows link CPU kernel launches to their GPU execution.)</div>';
    return;
  }
  const items = all.map(({ fl, dir }) => {
    const other = dir === 'out'
      ? { track: fl.fTrack, idx: fl.fIdx }
      : { track: fl.sTrack, idx: fl.sIdx };
    const nm = model.strings[other.track.nameId[other.idx]];
    const arrow = dir === 'out' ? '→ to' : '← from';
    return `<li data-pid="${model.groups.indexOf(other.track.group)}">` +
      `<span class="flow-dir">${arrow}</span>` +
      `<span class="flow-name">${escapeHtml(nm)}</span>` +
      `<span class="flow-dir" style="margin-left:auto">${escapeHtml(other.track.name || '')} · +${fmtTime(other.track.ts[other.idx] - model.t0, 1)}</span></li>`;
  });
  pane.innerHTML = `<ul class="flow-list">${items.join('')}</ul>`;
  // wire click-to-navigate
  [...pane.querySelectorAll('li')].forEach((li, i) => {
    li.onclick = () => {
      const { fl, dir } = all[i];
      const other = dir === 'out'
        ? { track: fl.fTrack, idx: fl.fIdx }
        : { track: fl.sTrack, idx: fl.sIdx };
      viewer.select(other.track, other.idx);
      viewer.revealSelection();
    };
  });
}

// drawer tabs
let activeTab = 'sel';
document.querySelectorAll('#drawer-tabs .tab').forEach(tab => {
  tab.onclick = () => {
    activeTab = tab.dataset.tab;
    document.querySelectorAll('#drawer-tabs .tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-pane').forEach(p => p.hidden = p.dataset.pane !== activeTab);
  };
});
$('drawer-close').onclick = () => {
  $('drawer').hidden = true;
  viewer && viewer.select(null, -1);
  viewer && viewer.resize();
};

// overall UI scale (CSS `zoom` on #app); client coords are in visual px, so we
// divide by this when writing layout-space pixel sizes inside the zoomed app.
const UI_SCALE = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1.1;

// drawer resize (vertical)
(() => {
  const handle = $('drawer-resize'), drawer = $('drawer');
  let dragging = false;
  handle.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); document.body.style.cursor = 'ns-resize'; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const cr = $('content').getBoundingClientRect();           // visual px
    const vis = Math.min(Math.max(90, cr.bottom - e.clientY), cr.height - 140);
    drawer.style.height = (vis / UI_SCALE) + 'px';             // layout px (inside zoom)
    viewer && viewer.resize();
  });
  window.addEventListener('mouseup', () => { if (dragging) { dragging = false; document.body.style.cursor = ''; } });
})();

// sidebar resize (horizontal)
(() => {
  const handle = $('sidebar-resize'), sb = $('sidebar');
  const MIN = 160, MAX = 560;
  const applyWidth = (layoutW) => {
    const w = Math.min(Math.max(MIN, layoutW), MAX);
    sb.style.flexBasis = w + 'px';
    sb.style.width = w + 'px';
    document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    return w;
  };
  // restore persisted width (or seed the collapse variable with the default)
  const saved = parseFloat(localStorage.getItem('dark-trace-sidebar-w'));
  applyWidth(Number.isFinite(saved) ? saved : 240);
  let dragging = false;
  handle.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); document.body.style.cursor = 'ew-resize'; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const left = sb.getBoundingClientRect().left;               // visual px
    const w = applyWidth((e.clientX - left) / UI_SCALE);        // layout px
    localStorage.setItem('dark-trace-sidebar-w', String(w));
    viewer && viewer.resize();
  });
  window.addEventListener('mouseup', () => { if (dragging) { dragging = false; document.body.style.cursor = ''; } });
})();

// ---------- search ----------
let searchMatches = [], searchPos = -1, searchTimer = null;
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250); });
$('search').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    clearTimeout(searchTimer);
    if (searchPos < 0 || !searchMatches.length) runSearch();
    stepSearch(ev.shiftKey ? -1 : 1);
  } else if (ev.key === 'Escape') {
    $('search').value = ''; runSearch(); $('timeline').focus();
  }
});
$('search-prev').onclick = () => stepSearch(-1);
$('search-next').onclick = () => stepSearch(1);
$('search-pos').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); jumpToTypedMatch(); }
  else if (ev.key === 'Escape') { $('timeline').focus(); }
});
$('search-pos').addEventListener('focus', (ev) => ev.target.select());

// Move the selection to match index `i` (0-based) and reflect it in the box.
function goToMatch(i) {
  if (!searchMatches.length) return;
  searchPos = (i % searchMatches.length + searchMatches.length) % searchMatches.length;
  const m = searchMatches[searchPos];
  viewer.select(m.track, m.idx);
  viewer.revealSelection();
  $('search-pos').value = searchPos + 1;
  $('search-info').textContent = '/ ' + searchMatches.length.toLocaleString();
}

/** Move to the prev/next search match (dir: +1 next, -1 prev). */
function stepSearch(dir) {
  if (!viewer) return;
  if (!searchMatches.length) runSearch();
  if (!searchMatches.length) return;
  goToMatch(searchPos < 0 ? (dir > 0 ? 0 : -1) : searchPos + dir);
}

// Jump to the user-typed match number (1-based).
function jumpToTypedMatch() {
  if (!viewer) return;
  if (!searchMatches.length) runSearch();
  if (!searchMatches.length) return;
  const k = parseInt($('search-pos').value, 10);
  if (!Number.isFinite(k)) return;
  goToMatch(Math.min(Math.max(1, k), searchMatches.length) - 1);
}

function setSearchNavEnabled(on) {
  $('search-prev').disabled = !on;
  $('search-next').disabled = !on;
  $('search-pos').disabled = !on;
}

function runSearch() {
  searchMatches = []; searchPos = -1;
  $('search-pos').value = '';
  if (!viewer) return;
  const q = $('search').value.trim().toLowerCase();
  if (!q) { viewer.setSearch(null); $('search-info').textContent = ''; setSearchNavEnabled(false); return; }
  const set = new Set();
  model.strings.forEach((s, i) => { if (s.toLowerCase().includes(q)) set.add(i); });
  let count = 0; const CAP = 50000;
  for (const g of model.groups) for (const t of g.tracks) {
    for (let i = 0; i < t.n; i++) if (set.has(t.nameId[i])) {
      count++;
      if (searchMatches.length < CAP) searchMatches.push({ track: t, idx: i, ts: t.ts[i] });
    }
  }
  searchMatches.sort((a, b) => a.ts - b.ts);
  viewer.setSearch(set);
  const n = searchMatches.length;
  $('search-info').textContent = n ? '/ ' + n.toLocaleString() : 'no hits';
  setSearchNavEnabled(n > 0);
}

// ---------- theme ----------
theme.onChange((m) => {
  mode = m;
  if (viewer) { viewer.setTheme(m); if (currentSel) { renderSelPane(currentSel); renderFlowsPane(currentSel); } }
  buildPaletteMenu();   // swatch previews depend on the theme
});
$('theme-toggle').onclick = () => theme.toggle();

// ---------- palette picker ----------
function swatchColor(hue) {
  return mode === 'light' ? `hsl(${hue},60%,74%)` : `hsl(${hue},48%,58%)`;
}
function buildPaletteMenu() {
  const menu = $('palette-menu');
  menu.innerHTML = palette.PALETTES.map(p => {
    const sw = (p.colors
      ? p.colors.slice(0, 8)
      : p.hues.slice(0, 8).map(swatchColor))
      .map(col => `<span class="pal-sw" style="background:${col}"></span>`).join('');
    return `<button class="menu-item" data-pal="${p.id}">` +
      `<span class="check">${p.id === pal ? '✓' : ''}</span>` +
      `<span class="pal-name">${p.name}</span>` +
      `<span class="pal-right"><span class="pal-sws">${sw}</span>` +
      `<span class="pal-hint">${p.hint}</span></span></button>`;
  }).join('');
  menu.querySelectorAll('.menu-item').forEach(it => {
    it.onclick = () => { palette.setPalette(it.dataset.pal); menu.hidden = true; };
  });
}
$('palette-btn').onclick = (e) => {
  e.stopPropagation();
  const m = $('palette-menu');
  if (m.hidden) buildPaletteMenu();
  m.hidden = !m.hidden;
};
document.addEventListener('click', (e) => {
  const m = $('palette-menu');
  if (!m.hidden && !e.target.closest('.menu-anchor')) m.hidden = true;
});
window.addEventListener('keydown', (e) => {
  const m = $('palette-menu');
  if (e.key === 'Escape' && !m.hidden) { e.stopImmediatePropagation(); m.hidden = true; }
}, true);
palette.onChange((id) => {
  pal = id;
  if (viewer) { viewer.setPalette(id); if (currentSel) { renderSelPane(currentSel); renderFlowsPane(currentSel); } }
  buildPaletteMenu();
});

// ---------- sidebar ----------
$('sidebar-toggle').onclick = () => {
  const sb = $('sidebar');
  sb.classList.add('collapsing');
  document.body.classList.toggle('sidebar-collapsed');
  setTimeout(() => { sb.classList.remove('collapsing'); viewer && viewer.resize(); }, 200);
};
$('side-open').onclick = () => $('file-input').click();
$('side-reset').onclick = () => viewer && viewer.resetView();

// ---------- about / credits modal ----------
const aboutModal = $('about-modal');
const closeAbout = () => { aboutModal.hidden = true; };
$('about-btn').onclick = () => { aboutModal.hidden = false; };
$('about-close').onclick = closeAbout;
aboutModal.addEventListener('click', (e) => { if (e.target === aboutModal) closeAbout(); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !aboutModal.hidden) { e.stopImmediatePropagation(); closeAbout(); }
}, true);
$('side-collapse').onclick = () => viewer && viewer.collapseAll(true);
$('side-expand').onclick = () => viewer && viewer.collapseAll(false);

// ---------- wiring ----------
$('open-btn').onclick = () => $('file-input').click();
$('open-btn2').onclick = () => $('file-input').click();
$('file-input').addEventListener('change', (ev) => {
  if (ev.target.files.length) handleFile(ev.target.files[0]);
  ev.target.value = '';
});

let landingShownByDrag = false;
window.addEventListener('dragover', (ev) => {
  ev.preventDefault();
  if ($('landing').hidden) { $('landing').hidden = false; landingShownByDrag = true; }
  $('landing').classList.add('dragging');
});
window.addEventListener('dragleave', (ev) => {
  if (ev.relatedTarget === null) {
    $('landing').classList.remove('dragging');
    if (viewer && landingShownByDrag) { $('landing').hidden = true; landingShownByDrag = false; }
  }
});
window.addEventListener('drop', (ev) => {
  ev.preventDefault();
  $('landing').classList.remove('dragging');
  if (ev.dataTransfer.files.length) { landingShownByDrag = false; handleFile(ev.dataTransfer.files[0]); }
  else if (viewer && landingShownByDrag) { $('landing').hidden = true; landingShownByDrag = false; }
});

async function loadUrl(url) {
  try {
    if (viewer) $('landing').hidden = false; // show status while (re)loading
    status(`fetching ${url}…`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = new Uint8Array(await resp.arrayBuffer());
    await handleBuffer(buf, url.split('/').pop() || url);
  } catch (err) {
    console.error(err);
    status(`failed to fetch trace: ${err.message}`, true);
  }
}

// debug/test hook
Object.defineProperty(window, '__darktrace', { get: () => ({ model, viewer, mode }) });

const urlParam = new URLSearchParams(location.search).get('url');
if (urlParam) loadUrl(urlParam);
