# Plan: Browser-Only Faust Runtime (No Node Worker)

## Goal

Run Faust compile + WebAudio + UI entirely in the browser, served by a local
static HTTP server. No Node process for DSP/runtime.

## What Changes

- **Faust compile** happens in the browser via `@grame/faustwasm` (WASM).
- **Audio** runs on the browser WebAudio AudioWorklet.
- **MIDI** uses Web MIDI API (browser permissions + device access).
- **UI** is local HTML/JS (same `rt-ui.html` layout).
- **Local HTTP server** only serves static files (no DSP runtime).

## MCP Implications

There is no Node runtime to expose MCP tools. Options:

1. **Browser MCP server (HTTP/SSE)**
   - Implement MCP endpoints in the browser (fetch + SSE stream).
   - Needs CORS considerations if accessed from a local LLM client:
     - The browser MCP server must allow cross‑origin requests from the LLM UI
       (set `Access-Control-Allow-Origin` to the client origin).
     - SSE requires `Access-Control-Allow-Origin` + `Access-Control-Allow-Credentials`
       if cookies/auth are used.
     - Preflight (`OPTIONS`) handling is required for `POST /messages`.
2. **Thin MCP proxy (Python)**
   - Keep a minimal Python MCP server.
   - It forwards tool calls to the browser over WebSocket or HTTP.
   - Browser sends back results to the MCP proxy.

## Pros

- No Node native bindings or `node-web-audio-api` required.
- Matches the "pure Web" behavior (closer to `faustwasm` demos).
- Simpler deployment for users (just a browser + static server).

### Distribution note

This model simplifies distribution because everything ships as static assets
and npm-managed JavaScript packages. There are no native builds for audio
backends on the server side. However, it still depends on a real browser for
WebAudio/MIDI, so automated headless deployment is limited.

## Cons / Constraints

- Requires a **real browser** with WebAudio + Web MIDI (no headless audio).
- MCP transport must be re-implemented or proxied.
- LLM clients must reach the browser runtime (CORS + auth).
- Offline/batch workflows (DAW-style analysis) are harder without a server.

## Step-by-Step

1. **Static server**
   - Serve `rt-ui.html`, `rt-ui.js`, Faust assets, and compiled WASM bundles.
2. **Browser runtime**
   - Move compile/start/stop logic into client-side JS.
   - Replace current `/status`, `/json`, `/param-values` HTTP calls with
     local in-memory state.
3. **MCP transport**
   - Implement MCP SSE/HTTP in browser OR add a minimal Python proxy.
4. **UI update**
   - Keep `rt-ui.js` logic but swap HTTP calls for local runtime API.
5. **Validation**
   - Compile/run DSPs in browser, verify meters/probes, Web MIDI input,
     scope/spectrum rendering, and MCP tool parity.
