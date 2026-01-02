#!/usr/bin/env python3
"""Minimal SSE verification helper for faust-mcp servers."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time


def _run(cmd: list[str]) -> None:
    """Run a command and raise if it fails."""
    subprocess.run(cmd, check=True)


def _wait_ready(seconds: float) -> None:
    """Sleep briefly to allow servers to start."""
    time.sleep(seconds)


def _start_server(cmd: list[str], env: dict[str, str] | None = None) -> subprocess.Popen[str]:
    """Start a subprocess server and return the process handle."""
    return subprocess.Popen(
        cmd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _stop_server(proc: subprocess.Popen[str]) -> None:
    """Terminate a server process and clean up pipes."""
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    if proc.stdout:
        proc.stdout.close()
    if proc.stderr:
        proc.stderr.close()


def main() -> int:
    """Run a basic SSE verification loop across available servers."""
    parser = argparse.ArgumentParser(description="Verify SSE server/client combos.")
    parser.add_argument("--dsp", default="t1.dsp", help="Path to a Faust DSP file.")
    parser.add_argument("--tmpdir", default="/tmp/faust-mcp-test", help="TMPDIR for faust_server.py.")
    parser.add_argument(
        "--input-file",
        default="tests/assets/sine.wav",
        help="Local WAV path for DawDreamer file input.",
    )
    parser.add_argument(
        "--http-port",
        type=int,
        default=9000,
        help="Port for local HTTP server when testing RT file inputs.",
    )
    parser.add_argument(
        "--skip-rt",
        action="store_true",
        help="Skip real-time server test.",
    )
    args = parser.parse_args()

    # Server 1: faust_server.py
    if shutil.which("faust") is None:
        print("Skipping faust_server.py: `faust` not found in PATH.")
    else:
        env = {
            "MCP_TRANSPORT": "sse",
            "MCP_HOST": "127.0.0.1",
            "MCP_PORT": "8000",
            "TMPDIR": args.tmpdir,
        }
        s1 = _start_server([sys.executable, "faust_server.py"], env=env)
        try:
            _wait_ready(2)
            _run([
                sys.executable,
                "sse_client_example.py",
                "--url",
                "http://127.0.0.1:8000/sse",
                "--tool",
                "compile_and_analyze",
                "--dsp",
                args.dsp,
                "--tmpdir",
                args.tmpdir,
            ])
        finally:
            _stop_server(s1)

    # Server 2: faust_server_daw.py
    env = {
        "MCP_TRANSPORT": "sse",
        "MCP_HOST": "127.0.0.1",
        "MCP_PORT": "8001",
    }
    s2 = _start_server([sys.executable, "faust_server_daw.py"], env=env)
    try:
        _wait_ready(2)
        _run([
            sys.executable,
            "sse_client_example.py",
            "--url",
            "http://127.0.0.1:8001/sse",
            "--tool",
            "compile_and_analyze",
            "--dsp",
            args.dsp,
            "--input-source",
            "file",
            "--input-file",
            args.input_file,
        ])
    finally:
        _stop_server(s2)

    if args.skip_rt:
        return 0

    # Server 3: faust_realtime_server.py
    if shutil.which("node") is None:
        print("Skipping faust_realtime_server.py: `node` not found in PATH.")
        return 0

    env = {
        "WEBAUDIO_ROOT": "external/node-web-audio-api",
        "MCP_TRANSPORT": "sse",
        "MCP_HOST": "127.0.0.1",
        "MCP_PORT": "8002",
    }
    s3 = _start_server([sys.executable, "faust_realtime_server.py"], env=env)
    try:
        _wait_ready(2)
        _run([
            sys.executable,
            "sse_client_example.py",
            "--url",
            "http://127.0.0.1:8002/sse",
            "--tool",
            "compile_and_start",
            "--dsp",
            args.dsp,
            "--name",
            "fx",
            "--latency",
            "interactive",
            "--input-source",
            "noise",
        ])
    finally:
        _stop_server(s3)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
