# Plan: Node-Only Faust Real-Time MCP Server

## Goal

Remove `faust_realtime_server.py` and run the real-time MCP server entirely in Node (using the existing `faust_realtime_worker.mjs` runtime + HTTP UI bridge).

## Current Architecture (Summary)

- **Python (FastMCP)** exposes MCP tools over SSE/stdio.
- **Node worker (`faust_realtime_worker.mjs`)** does DSP compile/start, audio, metrics, and UI HTTP endpoints.
- Python bridges MCP requests to Node over JSON lines (stdin/stdout).

## Target Architecture

- **Single Node process** exposes MCP tools (SSE and/or stdio) and owns the runtime.
- **Same UI HTTP server** stays in Node (already implemented).
- **No Python process** needed for real-time server mode.

### Distribution note

Moving to a single Node process could simplify distribution because the runtime
dependencies are JavaScript packages (`@grame/faustwasm`, `@shren/faust-ui`,
`@julusian/midi`) plus a native audio layer (`node-web-audio-api`). This allows
packaging via npm and reduces the dual Python/Node install path. That said, the
`node-web-audio-api` native build still requires a toolchain, so a fully “zero
install” distribution may still need prebuilt binaries or a build step.

## Key Decisions

- Transport choice: implement **SSE** first (parity with current default), then stdio if needed.
- Keep `faust_realtime_worker.mjs` as the runtime module, and add a **Node MCP server entrypoint** that imports it.
- Preserve tool names and payload shapes to avoid breaking clients.

## Step-by-Step Plan

### Phase 1 - Factor Node runtime into a reusable module

1. Export a small **runtime adapter** from `faust_realtime_worker.mjs`:
   - `createRuntime()` -> object with tool handlers (compile, start, get_audio_metrics, etc.).
   - `startUiServer()` remains available for UI bridge.
2. Keep the existing CLI behavior for backward compatibility (stdio JSON line protocol).

### Phase 2 - Implement MCP server in Node

1. Add a new entrypoint (example: `faust_realtime_node_server.mjs`).
2. Implement MCP over SSE:
   - `GET /sse` for event stream.
   - `POST /messages` for client requests (same pattern as Python FastMCP).
3. Map MCP tools to the runtime adapter with the same names:
   - `compile`, `compile_and_start`, `start`, `stop`, `get_audio_metrics`, etc.
4. Add a minimal **schema version** response (mirror existing `schema_version` field).

### Phase 3 - Integrate UI bridge in Node-only server

1. Instantiate `UiServer` from the runtime adapter in the Node entrypoint.
2. Keep env vars identical (`FAUST_UI_PORT`, `FAUST_UI_ROOT`, `WEBAUDIO_ROOT`).
3. Ensure `/ws` (analysis WebSocket) still works.

### Phase 4 - CLI + Makefile parity

1. Add Makefile target(s) to start the Node-only server:
   - `run-rt-node` or replace `run-rt` when ready.
2. Update scripts:
   - `scripts/test_full_api.sh` should support Node-only server.
3. Update README:
   - New command examples.
   - Remove Python real-time server references when fully migrated.

### Phase 5 - Validation

1. Verify tool parity with existing clients:
   - `sse_client_example.py` against Node-only server.
2. Run UI tests:
   - `/status`, `/json`, `/param-values`, `/audio-metrics`, `/ws`.
3. Confirm MIDI behavior:
   - `get_midi_inputs`, `select_midi_input`, active notes display.

## Risks / Open Questions

- **MCP SDK choice**: if a JS MCP SDK is used, confirm SSE behavior matches FastMCP.
- **Transport differences**: ensure JSON error schema matches current Python server.
- **Process lifecycle**: clean shutdown of audio nodes and UI HTTP server on exit.

## Deliverables

- New Node MCP server entrypoint (SSE first).
- Updated runtime adapter exported from `faust_realtime_worker.mjs`.
- Updated Makefile + README + test scripts.
- Optional: deprecate or remove `faust_realtime_server.py` once stable.
