"""
Real-time Faust MCP server using node-web-audio-api + @grame/faustwasm.

This server exposes tools to compile Faust DSP code on the fly, start playback,
and control parameters. It delegates audio + DSP work to a Node worker process
(`faust_node_worker.mjs`) and communicates via a JSON-over-stdin protocol.

Tools:
  - compile_and_start(faust_code, name?, latency_hint?, input_source?, input_freq?, input_file?, hide_meters?)
  - compile(faust_code, name?, input_source?, input_freq?, input_file?, hide_meters?)
  - load_wasm_module(wasm_base64, dsp_json, effect_wasm_base64?, effect_dsp_json?, name?, latency_hint?)
  - start()
  - check_syntax(faust_code, name?)
  - get_audio_metrics(include_scope?, include_spectrum?, per_channel?, fft_size?, smoothing?, min_db?, max_db?, edge_threshold?, log_bins?)
  - get_status()
  - get_midi_inputs()
  - get_midi_status()
  - get_dsp_json()
  - save_wasm_module()
  - get_params()
  - get_param(path)
  - get_param_values()
  - select_midi_input(index?, name?)
  - set_param(path, value)
  - stop()

Runtime notes:
  - Requires Node.js and the node-web-audio-api checkout with @grame/faustwasm installed.
  - Set WEBAUDIO_ROOT to that checkout path.
  - The worker keeps a single running DSP instance; compile_and_start replaces it.
"""

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
import errno
import json
import os
import subprocess
import sys
import threading


MCP_HOST = os.environ.get("MCP_HOST", "127.0.0.1")
MCP_PORT = int(os.environ.get("MCP_PORT", "8000"))
WEBAUDIO_ROOT = os.environ.get(
    "WEBAUDIO_ROOT",
    os.path.abspath(
        os.path.join(os.path.dirname(__file__), "external", "node-web-audio-api")
    ),
)

WORKER_PATH = os.environ.get(
    "FAUST_WORKER_PATH", os.path.abspath("faust_node_worker.mjs")
)

mcp = FastMCP(
    "Faust-RT-Runner",
    host=MCP_HOST,
    port=MCP_PORT,
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


class NodeWorker:
    """Manages the Node worker lifecycle and request/response I/O."""

    def __init__(self) -> None:
        self._proc: subprocess.Popen[str] | None = None
        self._next_id = 1
        self._lock = threading.Lock()
        self._stderr_thread: threading.Thread | None = None

    def _start(self) -> None:
        """Start the worker if needed."""
        if self._proc and self._proc.poll() is None:
            return

        env = os.environ.copy()
        env["WEBAUDIO_ROOT"] = WEBAUDIO_ROOT
        env.setdefault("FAUST_MCP_ROOT", os.path.abspath(os.path.dirname(__file__)))

        self._proc = subprocess.Popen(
            ["node", WORKER_PATH],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env,
        )

        def _drain_stderr(proc: subprocess.Popen[str]) -> None:
            """Forward worker stderr to this process stderr."""
            if proc.stderr is None:
                return
            for line in proc.stderr:
                print(line.rstrip(), file=sys.stderr)

        self._stderr_thread = threading.Thread(
            target=_drain_stderr, args=(self._proc,), daemon=True
        )
        self._stderr_thread.start()

    def request(self, method: str, params: dict | None = None) -> dict:
        """Send a request and wait for the matching response."""
        with self._lock:
            self._start()
            assert self._proc is not None
            if self._proc.stdin is None or self._proc.stdout is None:
                raise RuntimeError("Worker process pipes not available")

            req_id = self._next_id
            self._next_id += 1
            payload = {"id": req_id, "method": method, "params": params or {}}
            self._proc.stdin.write(json.dumps(payload) + "\n")
            self._proc.stdin.flush()

            while True:
                line = self._proc.stdout.readline()
                if not line:
                    raise RuntimeError("Worker process terminated")
                try:
                    response = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if response.get("id") != req_id:
                    continue
                if "error" in response:
                    return {"error": response["error"]}
                return response.get("result", {})

    def stop(self) -> None:
        """Stop the running DSP and terminate the worker if possible."""
        if not self._proc:
            return
        try:
            self.request("stop")
        except Exception:
            pass


worker = NodeWorker()


@mcp.tool()
def check_syntax(faust_code: str, name: str = "faust-check") -> str:
    """
    Validate Faust DSP syntax using the Faust WASM compiler (no audio started).
    """

    result = worker.request(
        "check_syntax",
        {"dsp_code": faust_code, "name": name},
    )
    return json.dumps(result, indent=2)


@mcp.tool()
def compile_and_start(
    faust_code: str,
    name: str = "faust-rt",
    latency_hint: str = "interactive",
    input_source: str = "none",
    input_freq: float | None = None,
    input_file: str | None = None,
    hide_meters: bool = False,
) -> str:
    """
    Compile Faust DSP code, start real-time audio, and return parameter metadata.

    input_source: "none" (default), "sine", "noise", or "file". When set, the
    DSP is wrapped with test inputs (sine uses input_freq, file uses input_file).
    """

    result = worker.request(
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
    name: str = "faust-rt",
    input_source: str = "none",
    input_freq: float | None = None,
    input_file: str | None = None,
    hide_meters: bool = False,
) -> str:
    """
    Compile Faust DSP code without starting audio.
    """

    result = worker.request(
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
def load_wasm_module(
    wasm_base64: str,
    dsp_json: dict | str,
    effect_wasm_base64: str | None = None,
    effect_dsp_json: dict | str | None = None,
    name: str | None = None,
    latency_hint: str = "interactive",
) -> str:
    """Load a pre-compiled WebAssembly module (base64) for the running DSP."""

    result = worker.request(
        "load_wasm_module",
        {
            "wasm_base64": wasm_base64,
            "dsp_json": dsp_json,
            "effect_wasm_base64": effect_wasm_base64,
            "effect_dsp_json": effect_dsp_json,
            "name": name,
            "latency_hint": latency_hint,
        },
    )
    return json.dumps(result, indent=2)


@mcp.tool()
def start() -> str:
    """Start audio rendering for the compiled DSP."""

    result = worker.request("start")
    return json.dumps(result, indent=2)

@mcp.tool()
def get_params() -> str:
    """Return cached parameter metadata for the running DSP."""

    result = worker.request("get_params")
    return json.dumps(result, indent=2)


@mcp.tool()
def set_param(path: str, value: float) -> str:
    """Set a parameter value on the running DSP."""

    result = worker.request("set_param", {"path": path, "value": value})
    return json.dumps(result, indent=2)


@mcp.tool()
def get_param(path: str) -> str:
    """Get the current value of a parameter on the running DSP."""

    result = worker.request("get_param", {"path": path})
    return json.dumps(result, indent=2)


@mcp.tool()
def get_param_values() -> str:
    """Get current values for all parameters on the running DSP."""

    result = worker.request("get_param_values")
    return json.dumps(result, indent=2)


@mcp.tool()
def get_audio_metrics(
    include_scope: bool = False,
    include_spectrum: bool = False,
    per_channel: bool = False,
    fft_size: int | None = None,
    smoothing: float | None = None,
    min_db: float | None = None,
    max_db: float | None = None,
    edge_threshold: float | None = None,
    log_bins: int | None = None,
) -> str:
    """Get RMS/Peak metering for the running DSP (with optional scope/spectrum)."""

    params = {
        "include_scope": include_scope,
        "include_spectrum": include_spectrum,
        "per_channel": per_channel,
        "fft_size": fft_size,
        "smoothing": smoothing,
        "min_db": min_db,
        "max_db": max_db,
        "edge_threshold": edge_threshold,
        "log_bins": log_bins,
    }
    result = worker.request("get_audio_metrics", params)
    return json.dumps(result, indent=2)


@mcp.tool()
def get_status() -> str:
    """Return the current real-time DSP status."""

    result = worker.request("get_status")
    return json.dumps(result, indent=2)


@mcp.tool()
def get_dsp_json() -> str:
    """Return the full Faust JSON for the running DSP."""

    result = worker.request("get_dsp_json")
    return json.dumps(result, indent=2)


@mcp.tool()
def save_wasm_module() -> str:
    """Return the compiled WebAssembly module for the running DSP (base64)."""

    result = worker.request("save_wasm_module")
    return json.dumps(result, indent=2)


@mcp.tool()
def get_midi_inputs() -> str:
    """List available MIDI input devices (Node backend)."""

    result = worker.request("get_midi_inputs")
    return json.dumps(result, indent=2)


@mcp.tool()
def get_midi_status() -> str:
    """Return MIDI backend status for the current session."""

    result = worker.request("get_midi_status")
    return json.dumps(result, indent=2)


@mcp.tool()
def select_midi_input(index: int | None = None, name: str | None = None) -> str:
    """Select a MIDI input device by index or name (Node backend)."""

    result = worker.request("select_midi_input", {"index": index, "name": name})
    return json.dumps(result, indent=2)


@mcp.tool()
def set_param_values(values: list[dict]) -> str:
    """Set multiple parameter values on the running DSP."""

    result = worker.request("set_param_values", {"values": values})
    return json.dumps(result, indent=2)


@mcp.tool()
def stop() -> str:
    """Stop the running DSP and close the audio context."""

    worker.stop()
    return json.dumps({"status": "stopped"}, indent=2)


if __name__ == "__main__":
    transport = os.environ.get("MCP_TRANSPORT", "sse")
    mount_path = os.environ.get("MCP_MOUNT_PATH")
    print(f"Faust realtime MCP server starting (transport={transport})")
    try:
        mcp.run(transport=transport, mount_path=mount_path)
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE:
            print(
                f"ERROR: MCP port {MCP_PORT} is already in use. "
                "Stop the other server or set MCP_PORT.",
                file=sys.stderr,
            )
            sys.exit(1)
        raise
