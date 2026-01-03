"""Persistent stdio session for the real-time Faust MCP server."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import anyio
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client


def _inherit_env() -> dict[str, str]:
    env = {"MCP_TRANSPORT": "stdio"}
    for key in ("FAUST_UI_PORT", "FAUST_UI_ROOT", "WEBAUDIO_ROOT", "TMPDIR"):
        value = os.environ.get(key)
        if value:
            env[key] = value
    return env


async def _compile_path(
    session: ClientSession, dsp_path: str, latency_hint: str, name: str | None
) -> None:
    path = Path(dsp_path)
    if not path.exists():
        raise FileNotFoundError(dsp_path)
    with path.open("r", encoding="utf-8") as f:
        dsp = f.read()
    args = {
        "faust_code": dsp,
        "name": name or path.stem,
        "latency_hint": latency_hint,
    }
    result = await session.call_tool("compile_and_start", args)
    print(result.structuredContent or result.content[0].text)


async def main(server_path: str, dsp_paths: list[str], latency_hint: str, name: str | None) -> None:
    server = StdioServerParameters(
        command="python3",
        args=[server_path],
        cwd=".",
        env=_inherit_env(),
    )
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            if dsp_paths:
                for dsp_path in dsp_paths:
                    await _compile_path(session, dsp_path, latency_hint, name)
                return

            while True:
                dsp_path = await anyio.to_thread.run_sync(
                    input, "DSP path (empty to quit): "
                )
                dsp_path = dsp_path.strip()
                if not dsp_path:
                    break
                try:
                    await _compile_path(session, dsp_path, latency_hint, name)
                except Exception as exc:
                    print(f"Error: {exc}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Persistent stdio session for the real-time Faust MCP server."
    )
    parser.add_argument(
        "--server",
        default="faust_realtime_server.py",
        help="Path to the real-time MCP server entrypoint.",
    )
    parser.add_argument(
        "--dsp",
        action="append",
        help="DSP file to compile (repeatable). If omitted, enter paths interactively.",
    )
    parser.add_argument(
        "--latency",
        default="interactive",
        help="Latency hint for compile_and_start (interactive or playback).",
    )
    parser.add_argument(
        "--name",
        default=None,
        help="DSP instance name (defaults to file stem).",
    )
    args = parser.parse_args()
    anyio.run(
        main,
        args.server,
        args.dsp or [],
        args.latency,
        args.name,
    )
