import argparse
import json
import os
from typing import Any, Dict

import anyio
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client


def _extract_result(call_result) -> Dict[str, Any]:
    """Unwrap a tool call result into a decoded JSON payload."""
    if call_result.structuredContent is not None:
        payload = call_result.structuredContent
        if isinstance(payload, dict) and isinstance(payload.get("result"), str):
            return json.loads(payload["result"])
        return payload
    if call_result.content and hasattr(call_result.content[0], "text"):
        payload = json.loads(call_result.content[0].text)
        if isinstance(payload, dict) and isinstance(payload.get("result"), str):
            return json.loads(payload["result"])
        return payload
    raise RuntimeError("Unexpected tool result format")


def _validate_features(features: Dict[str, Any]) -> None:
    """Validate the presence and types of feature metrics."""
    for key in [
        "dc_offset",
        "zero_crossing_rate",
        "crest_factor",
        "clipping_ratio",
        "spectral_centroid",
        "spectral_bandwidth",
        "spectral_rolloff",
        "spectral_flatness",
        "spectral_flux",
        "spectral_frame_size",
        "spectral_hop_size",
        "spectral_rolloff_ratio",
        "spectral_available",
    ]:
        if key not in features:
            raise RuntimeError(f"Missing features key: {key}")
        if key == "spectral_available":
            if not isinstance(features[key], bool):
                raise RuntimeError("spectral_available must be a boolean")
            continue
        if features[key] is None:
            continue
        try:
            float(features[key])
        except Exception as exc:
            raise RuntimeError(f"Feature {key} is not numeric") from exc


def _validate_payload(payload: Dict[str, Any], require_dawdreamer: bool) -> None:
    """Validate the shape and basic ranges of an analysis response."""
    for key in ["status", "max_amplitude", "rms", "is_silent", "waveform_ascii", "num_outputs", "channels"]:
        if key not in payload:
            raise RuntimeError(f"Missing key: {key}")

    max_amp = float(payload["max_amplitude"])
    rms = float(payload["rms"])
    if max_amp < 0.0:
        raise RuntimeError("max_amplitude should be non-negative")
    if rms < 0.0 or rms > max_amp + 1e-6:
        raise RuntimeError("rms should be within [0, max_amplitude]")

    if not isinstance(payload["channels"], list):
        raise RuntimeError("channels must be a list")

    if require_dawdreamer:
        if "features" not in payload:
            raise RuntimeError("Missing features block")
        _validate_features(payload["features"])
    elif "features" in payload:
        _validate_features(payload["features"])

    for chan in payload["channels"]:
        for key in ["index", "max_amplitude", "rms", "is_silent", "waveform_ascii"]:
            if key not in chan:
                raise RuntimeError(f"Missing channel key: {key}")
        cmax = float(chan["max_amplitude"])
        crms = float(chan["rms"])
        if cmax < 0.0:
            raise RuntimeError("channel max_amplitude should be non-negative")
        if crms < 0.0 or crms > cmax + 1e-6:
            raise RuntimeError("channel rms should be within [0, max_amplitude]")
        if "features" in chan:
            _validate_features(chan["features"])

    if require_dawdreamer and "dawdreamer" not in payload:
        raise RuntimeError("Missing dawdreamer block")


async def _call_server(server_path: str, dsp_path: str, tmpdir: str, require_dawdreamer: bool) -> None:
    """Run a stdio server and validate compile_and_analyze output."""
    env = {"MCP_TRANSPORT": "stdio", "TMPDIR": tmpdir}
    server = StdioServerParameters(command="python3", args=[server_path], cwd=".", env=env)
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            with open(dsp_path, "r", encoding="utf-8") as f:
                dsp = f.read()
            result = await session.call_tool("compile_and_analyze", {"faust_code": dsp})
            payload = _extract_result(result)
            _validate_payload(payload, require_dawdreamer=require_dawdreamer)


async def main() -> None:
    """Run smoke tests against the available MCP servers."""
    parser = argparse.ArgumentParser(description="Basic smoke test for MCP servers.")
    parser.add_argument("--dsp", default="t1.dsp", help="Path to a Faust DSP file.")
    parser.add_argument("--tmpdir", default="./tmp", help="TMPDIR for server processes.")
    parser.add_argument(
        "--skip-daw",
        action="store_true",
        help="Skip the DawDreamer server test.",
    )
    args = parser.parse_args()

    os.makedirs(args.tmpdir, exist_ok=True)

    await _call_server("faust_server.py", args.dsp, args.tmpdir, require_dawdreamer=False)

    if args.skip_daw:
        return

    try:
        import dawdreamer  # noqa: F401
    except Exception:
        try:
            import dawDreamer  # noqa: F401
        except Exception:
            print("Skipping DawDreamer test: module not installed")
            return

    await _call_server("faust_server_daw.py", args.dsp, args.tmpdir, require_dawdreamer=True)


if __name__ == "__main__":
    anyio.run(main)
