# Plan: Browser-Only Faust Runtime (No Node Worker)

## Goals

- Run Faust compile + WebAudio + UI entirely in the browser.
- Keep existing runtimes untouched and cohabitating (new files only).
- Preserve MCP tool surface so clients can switch runtimes without changes.
- Document every implementation step clearly and explicitly.

## Non-Goals

- No changes to `faust_node_server.py`, `faust_node_worker.mjs`, or `ui/rt-node-ui.*`.
- No Node process for DSP/runtime in this architecture.
- No attempt to run WebAudio headlessly.

## Coexistence Contract (New Files Only)

The browser-only runtime lives beside the existing runtimes. It does not replace
or modify them. All new files are separate and can be run independently.

### New file set (this plan creates scaffolding now)

- `faust_browser_server.py`: Python entrypoint for static hosting and MCP proxying.
- `faust_browser_runtime.mjs`: Browser runtime module (compile/start/stop + metrics).
- `ui/rt-browser-ui.html`: Browser-only UI entrypoint.
- `ui/rt-browser-ui.js`: Browser-only UI logic (no HTTP polling).
- `ui/rt-browser-ui.css`: Browser-only CSS (can import `rt-node-ui.css`).

## Target Architecture (Browser Runtime + Optional Proxy)

### Core idea

The browser is the *only* DSP runtime. It compiles Faust to WASM, runs audio via
AudioWorklet, and renders UI locally. The Python process is optional and only
used to expose MCP tools to external clients.

### Variant A: Browser-only (no MCP)

- User opens `rt-browser-ui.html` in a real browser.
- UI and runtime are self-contained; tools are only callable from the page.
- Good for manual use or when the LLM is embedded in the same page.

### Variant B: Python MCP proxy (recommended for MCP clients)

- Python FastMCP server exposes tools over SSE/stdio.
- The browser page connects *outbound* to the proxy (WebSocket or HTTP polling).
- The proxy forwards tool calls to the browser and returns results.
- This is the only way to let external MCP clients reach a browser runtime
  because browsers cannot accept inbound HTTP/SSE connections.

## Runtime API Contract (In-Browser)

The browser runtime mirrors the tool surface from `faust_node_server.py` and
`faust_node_worker.mjs` so MCP clients can switch between runtimes.

Required runtime methods:

- `check_syntax(faust_code, name)`
- `compile(faust_code, name, input_source, input_freq, input_file, hide_meters)`
- `compile_and_start(...)`
- `start()` / `stop()`
- `get_status()`
- `get_dsp_json()`
- `get_params()` / `get_param(path)` / `get_param_values()`
- `set_param(path, value)` / `set_param_values(values)`
- `get_audio_metrics(...)`
- `get_midi_inputs()` / `get_midi_status()` / `select_midi_input(...)`
- `get_svg_diagrams(name?, args?)`

All methods must return the same shape as the Node runtime so the UI and MCP
clients remain compatible.

## Implementation Steps

### Phase 0 - Scaffold the new architecture files

1. Create the new Python, JS, and web files listed in the Coexistence Contract.
2. Add clear TODO blocks and documented interfaces in each file.
3. Keep filenames and structure parallel to existing runtimes.

### Phase 1 - Browser runtime module (`faust_browser_runtime.mjs`)

1. **Initialize Faust WASM**
   - Load `@grame/faustwasm` and create a shared compiler instance.
   - Cache the wasm module to avoid repeated network loads.
2. **Compile DSP**
   - Implement `check_syntax` using the Faust compiler without starting audio.
   - Implement `compile` to generate DSP JSON + wasm factory.
   - Store `dsp_json`, `params`, and `ui_json` in runtime state.
3. **Audio graph setup**
   - Create `AudioContext` with `latencyHint` support.
   - Install an AudioWorklet module for Faust DSP.
   - Create an AudioWorklet node and connect it to the destination.
4. **Parameter control**
   - Maintain an in-memory param map (path -> value).
   - Implement `set_param` and `set_param_values` to update DSP params.
5. **Metrics capture**
   - Add `AnalyserNode` for scope/spectrum.
   - Implement `get_audio_metrics` using time-domain + FFT data.
   - Provide the same JSON shape as the Node runtime.
6. **MIDI**
   - Use Web MIDI API for device enumeration and selection.
   - Implement `get_midi_inputs`, `get_midi_status`, `select_midi_input`.
7. **Lifecycle**
   - Implement `start`/`stop` to start/close `AudioContext` and DSP node.
   - Ensure stop releases worklet + MIDI references.
8. **SVG diagram rendering**
   - Use `FaustSvgDiagrams` from `@grame/faustwasm` (browser example in faustwasm README).
   - Call `svgDiagrams.from(name, code, argv.join(" "))` after compilation.
   - Return the SVG map (`{ "process.svg": "<svg ...>", ... }`) via `get_svg_diagrams`.
   - Cache SVG results per compiled DSP to avoid re-running the compiler.

### Phase 2 - Browser UI (`ui/rt-browser-ui.*`)

1. **HTML**
   - Copy the structure of `ui/rt-node-ui.html` (same IDs/classes).
   - Update the title and script link to `rt-browser-ui.js`.
2. **CSS**
   - Import `rt-node-ui.css` or clone it to allow runtime-specific tweaks.
3. **JS wiring**
   - Replace HTTP polling with calls into `faust_browser_runtime.mjs`.
   - Use the same UI rendering flow for params, scope, spectrum, and probes.
   - Add a clear empty state when no DSP is loaded.
4. **DSP load flow**
   - Define a single entry point: `compile_and_start`.
   - Optional: accept `?dsp=` query param or a local file picker.
5. **SVG UI render (left column)**
   - Add a collapsible "DSP Diagram" panel below the Faust UI panel (left column).
   - Use `get_svg_diagrams` from the runtime and inject `process.svg` into the panel.
   - Provide a toggle to show/hide SVG to keep the UI lightweight.

### Phase 3 - Static file server (`faust_browser_server.py`)

1. Serve `ui/rt-browser-ui.html`, JS modules, CSS, and wasm assets.
2. Map `/` to `rt-browser-ui.html` for convenience.
3. Provide CLI flags/env vars:
   - `BROWSER_UI_PORT`, `BROWSER_UI_HOST`, `BROWSER_UI_ROOT`.
4. Ensure MIME types are correct for `*.mjs` and `*.wasm`.

### Phase 4 - MCP proxy (Python -> Browser)

1. **Transport choice**
   - HTTP long-polling is acceptable for a first version because the proxy only
     forwards control-plane tool calls (scope/spectrum stay in the browser UI).
   - WebSocket remains the recommended upgrade path if streaming or lower
     latency is needed later.
2. **Browser connection**
   - Browser registers on load and maintains a long-polling loop.
   - The proxy tracks the active browser session(s).
3. **Request/response protocol**
   - JSON messages with `id`, `method`, and `params` (mirrors Node worker).
   - Browser responds with `{ id, result }` or `{ id, error }`.
   - Suggested endpoints (first version):
     - `POST /bridge/register` -> `{ session_id }`
     - `GET /bridge/poll?session_id=...` -> pending requests (blocks with timeout)
     - `POST /bridge/reply` -> `{ id, result|error }`
4. **Tool mapping**
   - MCP tools call `BrowserBridge.request(method, params)`.
   - Results are returned verbatim to the MCP client.
5. **Resilience**
   - Reject tool calls if no browser session is connected.
   - Add timeouts for browser responses.

### Phase 5 - Validation

1. UI loads and runs a DSP in a real browser.
2. `compile_and_start` returns params and DSP JSON.
3. Param changes update audio in real time.
4. Scope/spectrum/probe rendering works without HTTP polling.
5. MCP proxy path works end-to-end:
   - MCP client -> Python proxy -> Browser runtime -> MCP client.

## Deliverables

- New browser-only runtime files listed in Coexistence Contract.
- Updated plan with explicit implementation steps and responsibilities.

## Open Questions

- Should the Python proxy also serve static files, or should it be separate?
- Is WebSocket acceptable as the browser <-> proxy transport, or do you prefer
  HTTP long-polling for simpler dependencies?
- Should the UI accept DSP code via query param, file upload, or both?
