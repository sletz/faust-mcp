# Plan: RT-UI Visual Redesign (HTML/CSS)

## Goals

- Deliver a clean, modern “studio console” aesthetic that still feels lightweight and readable.
- Improve visual hierarchy for DSP name, transport status, meters, MIDI controls, parameters, and debug panels.
- Keep the UI responsive (desktop + mobile) without changing the runtime data flow.
- Preserve existing semantics/IDs to avoid breaking JS bindings.

## Scope

- Files: `ui/rt-ui.html`, `ui/rt-ui.js`, `ui/rt-ui.css` (or a new `ui/rt-ui.css` if styles are inline today).
- JS changes limited to layout hooks (class names, DOM structure) and minor helper functions for UI state.
- No changes to MCP protocol or backend APIs unless explicitly added.

## Visual Direction

- **Typography:** Use a deliberate font pair (e.g., `Space Grotesk` for headings + `IBM Plex Mono` for meters/labels).
- **Color system:** Define CSS variables for background, surface, accent, meter colors, and state colors.
- **Surfaces:** Layered panels with subtle gradients and low-contrast borders.
- **Motion:** Gentle staggered entrance for sections and meter updates (CSS transitions only).
- **Background:** Subtle grain + soft gradient to avoid flatness.

## Information Architecture

1. **Header bar**
   - DSP name, status (running/stopped), build/latency hint (if available).
   - Right side: MIDI selector + active voices (compact).
2. **Left column (Faust UI)**
   - The `faust-ui` component renders meters + parameters.
3. **Right column (Scope/Spectrum + Probe tools)**
   - Scope/Spectrum panel for audio output analysis.
   - Probe panel for inspecting intermediate DSP signals from `[probe:N]` bargraphs.

## Implementation Steps

1. **Audit existing DOM structure**
   - Map IDs/classes referenced in `ui/rt-ui.js`.
   - Identify which elements can be wrapped or moved without breaking selectors.
   - Note which sections are dynamically created (e.g., Faust UI mount).
   - Current bindings (must remain stable):
     - IDs: `status`, `dsp-name`, `faust-ui-root`, `faust-ui-container`, `fallback-ui`,
       `midi-panel`, `midi-select`, `midi-status`, `poly-active`, `compact-toggle`,
       `scope-canvas`, `spectrum-canvas`, `scope-label`, `scope-meta`, `scope-channel`,
       `probe-select`, `probe-canvas`, `probe-label`, `probe-meta`.
     - Classes: `app-shell`, `app-header`, `app-main`, `panel`, `panel-faust`, `panel-scope`,
       `panel-probe`, `right-column`, `scope-tab`, `scope-pane-scope`, `scope-pane-spectrum`.
     - Faust UI mount point: `#faust-ui-root` (created by `/faust-ui/index.js`).
2. **Define the CSS design system**
   - Add `:root` variables:
     - `--bg`, `--bg-2`, `--surface`, `--surface-2`, `--border`.
     - `--text`, `--muted`, `--accent`, `--accent-2`.
     - `--meter-peak`, `--meter-rms`, `--state-ok`, `--state-warn`.
     - `--radius-sm`, `--radius-md`, `--radius-lg`, `--gap-sm`, `--gap-md`, `--gap-lg`.
   - Set base typography scale (12/14/16/20/28) and defaults for `body`, `h1/h2`.
3. **Refactor the HTML layout**
   - Keep header at top, two-column main layout.
   - Left column: `faust-ui` panel.
   - Right column: stack Scope/Spectrum panel then Probe panel.
4. **Style the header and status elements**
   - Compact header with DSP name and MIDI selector on the right.
   - Add a status badge and clean spacing.
5. **Style the `faust-ui` panel**
   - Fit-to-panel scaling for the Faust UI.
   - Improve label contrast and panel shading.
6. **Scope/Spectrum panel**
   - Tabs: Scope / Spectrum / Both with throttled refresh.
   - Per-channel menu for output channels (Mix + Ch N).
7. **Probe panel (new)**
   - Add a new panel below Scope/Spectrum in the right column.
   - Menu listing available probes from `get_audio_metrics().probes`.
   - Display selected probe **scope only** (no spectrum) to keep CPU low.
   - Probe scope is a rolling history buffer of the probe value returned by `get_audio_metrics().probes`.
   - Show the latest probe value next to the scope.
8. **Probe data usage (no new analyser)**
   - Keep using existing `get_audio_metrics()` output and its `probes[]` values.
   - UI builds a short time-series (e.g., last 2–4 seconds) from the sampled probe values.
   - Poll probe values at a low rate (1–2 fps) and append to the history buffer.
9. **Probe UX enhancements**
   - Optional **dB/linear toggle** in the Probe panel (if probes are tagged with `[unit:dB]`).
   - Show inferred probe type (RMS/Peak) when available in the label text.
   - Make probe polling rate configurable (e.g., 1 fps / 2 fps / 4 fps).
10. **UI wiring for probes**
    - Add a probe selector dropdown in the Probe panel.
    - Empty state if no probes are detected.
    - Clear history buffer when the selected probe changes.
11. **Responsive behavior**
    - Stack panels on mobile (Faust UI, Scope, Probe).
    - Reduce probe controls in compact mode.
12. **QA + performance checks**
    - Validate probe selection updates without UI flicker.
    - Ensure probe polling is throttled and does not impact audio.

## WebSocket Support (optional)

Goal: replace high‑rate HTTP polling with a push channel for analysis data.

1. **Server endpoint placement**
   - Prefer adding WS to the same HTTP server that serves `rt-ui` (currently `faust_realtime_server.py`).
   - If a dedicated Node UI server exists in the future, reuse the same WS message format.
2. **Server behavior**
   - Add a `/ws` endpoint, local‑only by default (same origin).
   - Accept a JSON `subscribe` message:
     - `include_scope`, `include_spectrum`, `per_channel`, `probe_id`
     - `scope_fps`, `spectrum_fps`, `probe_fps` (server clamps to safe max)
   - Push analysis frames at server‑controlled rates (e.g., scope 5–10 fps, spectrum 1–2 fps).
   - Include `schema_version`, `timestamp_ms`, and `source` (mix/channel) in each frame.
3. **Client**
   - Add a small WS client in `ui/rt-ui.js` with automatic reconnect.
   - Fall back to HTTP polling if WS is unavailable.
   - Reuse the same render pipeline as polling (single code path).
4. **Rate limiting & backpressure**
   - Separate rates per stream (scope vs spectrum vs probes).
   - Drop frames if the UI is busy (avoid queue buildup).
5. **Protocol shape (example)**
   - Subscribe:
     - `{ "type": "subscribe", "scope_fps": 8, "spectrum_fps": 2, "probe_id": 3 }`
   - Frames:
     - `{ "type": "metrics", "schema_version": 1, "timestamp_ms": 123456, "payload": { ...get_audio_metrics... } }`
6. **Security**
   - Same‑origin by default; optional token if exposed beyond localhost.
7. **Testing**
   - Add a minimal WS test script (e.g., `scripts/test_ws_metrics.py`).
   - Validate fallbacks by disabling WS and confirming polling still works.

### Recommended Defaults

- `scope_fps`: 8 (cap at 12)
- `spectrum_fps`: 2 (cap at 4)
- `probe_fps`: 2 (cap at 4)
- Backpressure policy: drop newest if render queue > 1 (keep UI stable)
- Max payload size: keep FFT bins under 2048 when spectrum enabled

### Sequence Sketch

```
rt-ui.js  ->  /ws (subscribe)
server    ->  get_audio_metrics()
server    ->  /ws (metrics frame)
rt-ui.js  ->  render scope/spectrum/probe
```

## Deliverables

- Updated `ui/rt-ui.html` with new Probe panel block.
- Updated `ui/rt-ui.css` with Probe panel styles.
- Updated `ui/rt-ui.js` to list probe IDs and render probe scope (history buffer).
- Optional WS endpoint + client fallback for smooth analysis.

## Open Questions

- Should probe rendering default to scope for the first probe, or stay empty until user selects one?
- Do you want WS support only for analysis, or also for param changes?

## Rollout Plan

- Phase 1: Add probe UI panel + menu (no data).
- Phase 2: Wire probe history buffer using `get_audio_metrics().probes`.
- Phase 3: UX enhancements (dB/linear toggle, type label, polling rate control).
- Phase 4: Optional WebSocket analysis channel.
