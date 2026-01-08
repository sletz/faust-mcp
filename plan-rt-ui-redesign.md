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

1. **Server**
   - Add a WebSocket endpoint in the Node UI server (e.g., `/ws`).
   - Allow a JSON subscription message with toggles:
     - `include_scope`, `include_spectrum`, `per_channel`, `probe_id`.
   - Push `get_audio_metrics()` payloads at a server‑controlled rate (e.g., 5–10 fps).
2. **Client**
   - Add a lightweight WebSocket client in `ui/rt-ui.js`.
   - Fall back to HTTP polling if WS fails.
   - Use the same render paths as polling (no duplication).
3. **Rate limiting**
   - Separate rates for scope vs spectrum (spectrum slower).
   - Optional per‑client rate cap.
4. **Protocol**
   - Keep payload format identical to `get_audio_metrics()`.
   - Add `schema_version` to WS messages if needed for future compatibility.

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
