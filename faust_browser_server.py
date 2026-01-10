"""
Browser-only Faust MCP proxy + static server.

This entrypoint mirrors the real-time MCP tool surface but delegates all DSP
work to a browser runtime. The browser is the authoritative runtime; this
Python process only serves static assets and forwards MCP tool calls over a
long-polling bridge.

Runtime model:
  - Browser connects to /bridge/register and long-polls /bridge/poll.
  - MCP tools enqueue requests for the browser via BrowserBridge.
  - Browser replies via /bridge/reply with result or error.
"""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial
import argparse
import json
import os
import threading
import time
import uuid
from urllib.parse import parse_qs, urlparse
import posixpath

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings


# MCP server configuration (SSE/stdio endpoint for clients).
MCP_HOST = os.environ.get("MCP_HOST", "127.0.0.1")
MCP_PORT = int(os.environ.get("MCP_PORT", "8000"))

# Static UI server configuration for the browser runtime.
BROWSER_UI_HOST = os.environ.get("BROWSER_UI_HOST", "127.0.0.1")
BROWSER_UI_PORT = int(os.environ.get("BROWSER_UI_PORT", "8010"))
BROWSER_UI_ROOT = os.environ.get("BROWSER_UI_ROOT", os.path.abspath("."))
BROWSER_UI_INDEX = os.environ.get("BROWSER_UI_INDEX", "ui/rt-browser-ui.html")

mcp = FastMCP(
    "Faust-Browser-Runner",
    host=MCP_HOST,
    port=MCP_PORT,
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


class BrowserBridge:
    """
    Bridge MCP tool calls to the browser runtime.

    HTTP long-polling transport for the browser runtime.
    The browser polls for pending requests and posts replies.
    """

    def __init__(self) -> None:
        """Initialize in-memory session and reply tracking state."""
        self._lock = threading.Lock()
        self._sessions: dict[str, dict] = {}
        self._active_session_id: str | None = None
        self._next_id = 1
        self._reply_cond = threading.Condition(self._lock)
        self._replies: dict[int, dict] = {}

    def register(self) -> str:
        """Register a new browser session and return its session_id."""
        with self._lock:
            session_id = uuid.uuid4().hex
            session = {
                "queue": [],
                "cond": threading.Condition(self._lock),
                "last_seen": time.time(),
            }
            self._sessions[session_id] = session
            self._active_session_id = session_id
            return session_id

    def poll(self, session_id: str, timeout: float = 20.0) -> list[dict]:
        """Return queued requests for a session, blocking up to timeout."""
        with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                return []
            session["last_seen"] = time.time()
            queue = session["queue"]
            if not queue:
                session["cond"].wait(timeout=timeout)
            items = list(queue)
            queue.clear()
            return items

    def reply(self, req_id: int, result: dict | None = None, error: dict | None = None) -> None:
        """Store a browser reply and wake any waiting MCP request."""
        with self._lock:
            payload = {"id": req_id}
            if error is not None:
                payload["error"] = error
            else:
                payload["result"] = result or {}
            self._replies[req_id] = payload
            self._reply_cond.notify_all()

    def request(self, method: str, params: dict | None = None) -> dict:
        """Enqueue a request to the active browser session and await reply."""
        with self._lock:
            if not self._active_session_id or self._active_session_id not in self._sessions:
                raise RuntimeError("No browser session connected")  # noqa: TRY003
            req_id = self._next_id
            self._next_id += 1
            session = self._sessions[self._active_session_id]
            session["queue"].append(
                {"id": req_id, "method": method, "params": params or {}}
            )
            session["cond"].notify_all()

            timeout = 30.0
            deadline = time.time() + timeout
            while req_id not in self._replies:
                remaining = deadline - time.time()
                if remaining <= 0:
                    raise RuntimeError("Browser reply timeout")  # noqa: TRY003
                self._reply_cond.wait(timeout=remaining)
            return self._replies.pop(req_id)


bridge = BrowserBridge()


def _call_bridge(method: str, params: dict | None = None) -> dict:
    """Helper to call the bridge and normalize exceptions to error dicts."""
    try:
        return bridge.request(method, params)
    except Exception as exc:  # pragma: no cover - scaffold error path
        return {"error": str(exc)}


@mcp.tool()
def check_syntax(faust_code: str, name: str = "faust-check") -> str:
    """Validate Faust syntax in the browser runtime without starting audio."""
    result = _call_bridge("check_syntax", {"dsp_code": faust_code, "name": name})
    return json.dumps(result, indent=2)


@mcp.tool()
def compile_and_start(
    faust_code: str,
    name: str = "faust-browser",
    latency_hint: str = "interactive",
    input_source: str = "none",
    input_freq: float | None = None,
    input_file: str | None = None,
    hide_meters: bool = False,
) -> str:
    """Compile DSP in the browser and start audio."""
    result = _call_bridge(
        "compile_and_start",
        {
            "dsp_code": faust_code,
            "name": name,
            "latency_hint": latency_hint,
            "input_source": input_source,
            "input_freq": input_freq,
            "input_file": input_file,
            "hide_meters": hide_meters,
        },
    )
    return json.dumps(result, indent=2)


@mcp.tool()
def compile(
    faust_code: str,
    name: str = "faust-browser",
    input_source: str = "none",
    input_freq: float | None = None,
    input_file: str | None = None,
    hide_meters: bool = False,
) -> str:
    """Compile DSP in the browser without starting audio."""
    result = _call_bridge(
        "compile",
        {
            "dsp_code": faust_code,
            "name": name,
            "input_source": input_source,
            "input_freq": input_freq,
            "input_file": input_file,
            "hide_meters": hide_meters,
        },
    )
    return json.dumps(result, indent=2)


@mcp.tool()
def start() -> str:
    """Start audio on the browser runtime."""
    result = _call_bridge("start")
    return json.dumps(result, indent=2)


@mcp.tool()
def stop() -> str:
    """Stop audio and clear browser runtime state."""
    result = _call_bridge("stop")
    return json.dumps(result, indent=2)


@mcp.tool()
def get_status() -> str:
    """Return status info from the browser runtime."""
    result = _call_bridge("get_status")
    return json.dumps(result, indent=2)


@mcp.tool()
def get_dsp_json() -> str:
    """Return the current Faust JSON from the browser runtime."""
    result = _call_bridge("get_dsp_json")
    return json.dumps(result, indent=2)


@mcp.tool()
def get_params() -> str:
    """Return parameter descriptors from the browser runtime."""
    result = _call_bridge("get_params")
    return json.dumps(result, indent=2)


@mcp.tool()
def get_param(path: str) -> str:
    """Return a single parameter value from the browser runtime."""
    result = _call_bridge("get_param", {"path": path})
    return json.dumps(result, indent=2)


@mcp.tool()
def get_param_values() -> str:
    """Return all parameter values from the browser runtime."""
    result = _call_bridge("get_param_values")
    return json.dumps(result, indent=2)


@mcp.tool()
def set_param(path: str, value: float) -> str:
    """Set a parameter value on the browser runtime."""
    result = _call_bridge("set_param", {"path": path, "value": value})
    return json.dumps(result, indent=2)


@mcp.tool()
def set_param_values(values: list[dict]) -> str:
    """Set multiple parameter values on the browser runtime."""
    result = _call_bridge("set_param_values", {"values": values})
    return json.dumps(result, indent=2)


@mcp.tool()
def get_audio_metrics(
    include_scope: bool = True,
    include_spectrum: bool = True,
    per_channel: bool = False,
    fft_size: int | None = None,
    smoothing: float | None = None,
    min_db: float | None = None,
    max_db: float | None = None,
    edge_threshold: float | None = None,
    log_bins: bool | None = None,
) -> str:
    """Return scope/spectrum/metrics payloads from the browser runtime."""
    result = _call_bridge(
        "get_audio_metrics",
        {
            "include_scope": include_scope,
            "include_spectrum": include_spectrum,
            "per_channel": per_channel,
            "fft_size": fft_size,
            "smoothing": smoothing,
            "min_db": min_db,
            "max_db": max_db,
            "edge_threshold": edge_threshold,
            "log_bins": log_bins,
        },
    )
    return json.dumps(result, indent=2)


@mcp.tool()
def get_svg_diagrams(name: str | None = None, args: str | None = None) -> str:
    """Return SVG diagram strings for the current DSP."""
    result = _call_bridge("get_svg_diagrams", {"name": name, "args": args})
    return json.dumps(result, indent=2)


@mcp.tool()
def get_midi_inputs() -> str:
    """List MIDI inputs from the browser runtime."""
    result = _call_bridge("get_midi_inputs")
    return json.dumps(result, indent=2)


@mcp.tool()
def get_midi_status() -> str:
    """Return MIDI status from the browser runtime."""
    result = _call_bridge("get_midi_status")
    return json.dumps(result, indent=2)


@mcp.tool()
def select_midi_input(index: int | None = None, name: str | None = None) -> str:
    """Select a MIDI input on the browser runtime."""
    result = _call_bridge("select_midi_input", {"index": index, "name": name})
    return json.dumps(result, indent=2)


def _make_handler(ui_index: str, directory: str, ui_root: str):
    """Create the static HTTP handler with bridge endpoints and path routing."""
    class BrowserUiHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=directory, **kwargs)

        def translate_path(self, path: str) -> str:
            """Map request paths to filesystem locations."""
            if path.startswith("/node_modules/"):
                rel = path[len("/node_modules/"):]
                rel = rel.split("?", 1)[0].split("#", 1)[0]
                rel = posixpath.normpath(rel).lstrip("/")
                ui_node_modules = os.path.join(ui_root, "node_modules")
                return os.path.join(ui_node_modules, rel)
            if path.startswith("/faust-ui/"):
                rel = path[len("/faust-ui/"):]
                rel = rel.split("?", 1)[0].split("#", 1)[0]
                rel = posixpath.normpath(rel).lstrip("/")
                ui_faust_root = os.path.join(ui_root, "node_modules", "@shren", "faust-ui", "dist", "esm")
                return os.path.join(ui_faust_root, rel)
            if path.startswith("/assets/"):
                rel = path[len("/assets/"):]
                rel = rel.split("?", 1)[0].split("#", 1)[0]
                rel = posixpath.normpath(rel).lstrip("/")
                return os.path.join(ui_root, "assets", rel)
            if path in ("/rt-browser-ui.js", "/rt-browser-ui.css", "/rt-browser-ui.html", "/rt-ui.css"):
                rel = path.lstrip("/")
                return os.path.join(ui_root, rel)
            return super().translate_path(path)

        def do_GET(self):
            """Serve bridge GET endpoints or static assets."""
            if self.path.startswith("/bridge/"):
                self._handle_bridge_get()
                return
            if self.path in ("/", "/index.html"):
                self.path = "/" + ui_index.lstrip("/")
            super().do_GET()

        def do_POST(self):
            """Serve bridge POST endpoints."""
            if self.path.startswith("/bridge/"):
                self._handle_bridge_post()
                return
            self.send_error(404, "Not Found")

        def _handle_bridge_get(self):
            """Handle /bridge/poll long-polling requests."""
            parsed = urlparse(self.path)
            if parsed.path != "/bridge/poll":
                self.send_error(404, "Not Found")
                return
            params = parse_qs(parsed.query or "")
            session_id = params.get("session_id", [None])[0]
            timeout_ms = params.get("timeout_ms", [None])[0]
            if not session_id:
                self._send_json({"error": "missing session_id"}, status=400)
                return
            timeout = float(timeout_ms) / 1000.0 if timeout_ms else 20.0
            items = bridge.poll(session_id, timeout=timeout)
            self._send_json({"requests": items})

        def _handle_bridge_post(self):
            """Handle /bridge/register and /bridge/reply."""
            parsed = urlparse(self.path)
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length > 0 else b"{}"
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                self._send_json({"error": "invalid json"}, status=400)
                return

            if parsed.path == "/bridge/register":
                session_id = bridge.register()
                self._send_json({"session_id": session_id})
                return

            if parsed.path == "/bridge/reply":
                req_id = payload.get("id")
                if req_id is None:
                    self._send_json({"error": "missing id"}, status=400)
                    return
                bridge.reply(req_id, result=payload.get("result"), error=payload.get("error"))
                self._send_json({"status": "ok"})
                return

            self.send_error(404, "Not Found")

        def _send_json(self, payload: dict, status: int = 200):
            """Serialize a JSON response."""
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return BrowserUiHandler


def start_static_server(
    host: str,
    port: int,
    root: str,
    ui_index: str,
    ui_root: str,
) -> ThreadingHTTPServer:
    """Start the static HTTP server in a background thread."""
    handler = _make_handler(ui_index, root, ui_root)
    httpd = ThreadingHTTPServer((host, port), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


def main() -> None:
    """CLI entrypoint for the browser proxy + static server."""
    parser = argparse.ArgumentParser(description="Browser-only Faust MCP proxy")
    parser.add_argument(
        "--no-static",
        action="store_true",
        help="Do not run the static UI server",
    )
    parser.add_argument(
        "--static-root",
        default=BROWSER_UI_ROOT,
        help="Static server root directory",
    )
    parser.add_argument(
        "--static-index",
        default=BROWSER_UI_INDEX,
        help="Static server index path relative to root",
    )
    parser.add_argument("--static-host", default=BROWSER_UI_HOST)
    parser.add_argument("--static-port", type=int, default=BROWSER_UI_PORT)
    args = parser.parse_args()

    if not args.no_static:
        ui_root = args.static_root
        if os.path.isdir(os.path.join(args.static_root, "ui", "node_modules")):
            ui_root = os.path.join(args.static_root, "ui")
        start_static_server(
            host=args.static_host,
            port=args.static_port,
            root=args.static_root,
            ui_index=args.static_index,
            ui_root=ui_root,
        )
        print(
            "Browser UI server running at "
            f"http://{args.static_host}:{args.static_port}/"
        )

    transport = os.environ.get("MCP_TRANSPORT", "sse")
    mount_path = os.environ.get("MCP_MOUNT_PATH")
    print(f"Faust browser MCP proxy starting (transport={transport})")
    mcp.run(transport=transport, mount_path=mount_path)


if __name__ == "__main__":
    main()
