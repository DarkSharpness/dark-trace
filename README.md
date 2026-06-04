# dark-trace

A tiny, fully static trace viewer (Perfetto / magic-trace style) that **never hides
overlapping events**.

**Live:** https://darksharpness.top/dark-trace/ (a.k.a. darksharpness.github.io/dark-trace)

## Why

Perfetto and chrome://tracing drop slices that *partially* overlap an earlier slice on
the same track. GPU traces from the PyTorch profiler (e.g. SGLang `step[...]`
`gpu_user_annotation` markers + kernels on the same CUDA stream) overlap all the time,
so chunks of the stream simply vanish, leaving blanks.

dark-trace lays out every track with greedy first-fit **lane assignment**: a slice that
overlaps an earlier one just opens an extra row inside the same stream track (the track
grows vertically, marked `×N` in the sidebar). Nothing is ever dropped. For well-nested
CPU stacks this degenerates to the classic flame layout.

## Usage

Open the page and drop in:

- `*.trace.tar.gz` — an archive of PyTorch/Kineto Chrome-trace files
  (e.g. `1780505134.056179-TP-0.trace.json.gz`, …). A picker lets you choose which
  rank(s) to load.
- a single `*.trace.json.gz` / `*.json`

Everything runs locally in your browser; nothing is uploaded anywhere.
You can also pass `?url=<trace-url>` to auto-load a trace over HTTP (CORS permitting).

The UI follows the magic-trace / Perfetto layout — dark slate header with an omnibox
search, a collapsible sidebar, and a tabbed bottom drawer (Current Selection / Flows).
The theme follows your OS light/dark setting by default; the ☀/🌙 button in the header
toggles and remembers an explicit choice. On load the view auto-zooms to the busiest
region (press `0` to fit the whole trace).

The swatch button (left of the theme toggle) picks a **slice palette** — *Vivid* (15 hues,
default), *Calm* (10), *Calmer* (7), or *Plain* (one flat color per track/stream) — to dial
down color noise on busy traces. The palette is independent of the theme and is remembered
across sessions.

### Controls

| input | action |
|---|---|
| drag | pan (time + vertical) |
| wheel | vertical scroll · `ctrl`+wheel zoom · `shift`+wheel horizontal pan |
| `W` / `S` | zoom in / out at cursor |
| `A` / `D` | pan left / right |
| `shift`+drag | measure a time range |
| click | select slice (details + flow arrows) |
| double-click / `F` | zoom to slice |
| `,` / `.` | jump to prev / next slice with the **same name** as the selection |
| `0` | reset zoom · `Esc` clear |
| search box | highlight by name; `Enter` / `⇧Enter` or the `‹ ›` buttons cycle matches |

## Notes / non-goals

- Plain ES modules, no build step, no dependencies — so it runs on any static host
  (GitHub Pages here). It doesn't embed the Perfetto UI directly: Perfetto's
  trace_processor also drops overlapping slices at ingestion, and keeping those overlaps
  is the entire point of this viewer — but the UI otherwise follows Perfetto closely.
- Supported Chrome-trace phases: `X`, `B/E`, `M`, flow `s/t/f` (arrows on selection),
  `i` instants. No SQL, no counters, no async (`a/b/n`) slices — intentionally dropped
  for simplicity.
- `tar.gz` / `json.gz` are decompressed in-browser with the native
  `DecompressionStream` (Chrome 80+, Firefox 113+, Safari 16.4+).

## Credits & thanks

dark-trace's design, interaction model, and visual language are modeled directly on
**Perfetto** and **magic-trace** — it would not exist without them. With gratitude to:

- **[Perfetto](https://github.com/google/perfetto)** (Apache License 2.0) — the trace UI this
  project follows: track layout, pan/zoom, selection, flow arrows, the timeline ruler, fonts,
  and the overall look-and-feel ([ui.perfetto.dev](https://ui.perfetto.dev)).
- **[magic-trace](https://github.com/janestreet/magic-trace)** (MIT License) — interaction model
  and inspiration; it popularised this style of viewer ([magic-trace.org](https://magic-trace.org)).
- **Chrome Trace Event Format** (Google) — the JSON trace format this viewer reads, as emitted
  by the **PyTorch / Kineto** profiler.
- **Roboto** and **Roboto Mono** typefaces (Google, Apache License 2.0) — served via
  [Google Fonts](https://fonts.google.com).

These projects are the work of their respective authors and remain under their own licenses
(Apache-2.0 / MIT). Please support and credit them too.

## License

dark-trace itself is released under the **MIT License** — © 2026 DarkSharpness. See
[`LICENSE`](LICENSE).
