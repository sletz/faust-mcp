# WebSocket Metrics Stream (rt-ui)

This document explains how the real-time UI receives analysis data over WebSocket
and how the server behaves. It is meant for readers who are new to WebSockets or
to this codebase.

## Why WebSockets Here?

The UI needs a steady flow of scope/spectrum/probe data. Polling `/audio-metrics`
works, but WebSockets avoid repeated HTTP requests and let the server push data
at a controlled cadence.

## High-Level Flow

1. The browser connects to `ws://127.0.0.1:8787/ws`.
2. The client sends a **subscribe** message describing what it wants.
3. The server sends **metrics** frames on a timer.
4. The client renders scope/spectrum/probe panels.
5. If WS is unavailable, the UI falls back to HTTP polling.

```
rt-ui.js  ->  /ws (subscribe)
server    ->  get_audio_metrics()
server    ->  /ws (metrics)
rt-ui.js  ->  render scope/spectrum/probe
```

## Where It Lives

- Server: `ws_metrics_server.mjs`
- Client: `ui/rt-ui.js`
- HTTP fallback: `GET /audio-metrics`

## Connection Basics

The WS server is attached to the same HTTP server that serves the UI. It only
accepts upgrades on `/ws`.

When the connection opens, the client sends a JSON subscription. The server
keeps one config per client.

## Messages (JSON over WebSocket)

### Subscribe

```json
{
  "type": "subscribe",
  "include_scope": true,
  "include_spectrum": true,
  "per_channel": false,
  "scope_fps": 8,
  "spectrum_fps": 2,
  "probe_fps": 2,
  "probe_id": 3,
  "fft_size": 1024,
  "smoothing": 0.8,
  "min_db": -90,
  "max_db": 0,
  "edge_threshold": 0.09,
  "log_bins": 32
}
```

Notes:

- `probe_id` is optional. If omitted, the server sends **all** probes.
- Rates are **requests**; the server clamps them to safe limits.
- `fft_size`, `min_db`, etc. are analyser tuning values.

### Metrics

```json
{
  "type": "metrics",
  "schema_version": "faust-mcp-rt/1",
  "timestamp_ms": 1735860123456,
  "payload": { ...getAudioMetrics(...) }
}
```

The `payload` matches the structure returned by `/audio-metrics` (from the
`get_audio_metrics` MCP tool).

### Ping / Pong

```json
{ "type": "ping" }
```

```json
{ "type": "pong", "timestamp_ms": 1735860123456 }
```

Ping/pong is optional and can be used to confirm the connection is alive or to measure round‑trip latency.

## References

- RFC 6455 (WebSocket Protocol): https://www.rfc-editor.org/rfc/rfc6455
- MDN WebSocket API: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
- MDN WebSockets overview: https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API

### Error

```json
{ "type": "error", "timestamp_ms": 1735860123456, "error": "message" }
```

## Cadence & Backpressure

The server maintains a 100ms loop and decides when to send scope/spectrum/probe
frames based on the client’s requested rates. This keeps CPU stable and avoids
unbounded queue growth.

## Testing

Use the helper script to verify the stream:

```bash
scripts/test_ws_metrics.py --url ws://127.0.0.1:8787/ws --include-scope --include-spectrum
```

Or via Makefile:

```bash
make rt-ws-metrics
```

## Troubleshooting

- **No frames:** check `FAUST_UI_PORT` and that the UI server is running.
- **Only one probe:** ensure the client does not request `probe_id` unless you want filtering.
- **High CPU:** reduce `scope_fps` or `spectrum_fps`.
