"""Example SSE client for calling the Faust MCP server.

Runs a single tool invocation against the SSE endpoint and prints the result.
"""

import argparse
import os

import anyio
from mcp.client.sse import sse_client
from mcp.client.session import ClientSession


async def main(
    url: str,
    tool: str,
    dsp_path: str | None,
    name: str | None,
    latency_hint: str | None,
    input_source: str | None,
    input_freq: float | None,
    input_file: str | None,
    hide_meters: bool,
    include_scope: bool,
    include_spectrum: bool,
    per_channel: bool,
    fft_size: int | None,
    smoothing: float | None,
    min_db: float | None,
    max_db: float | None,
    edge_threshold: float | None,
    log_bins: int | None,
    param_path: str | None,
    param_value: float | None,
    param_values: list[str] | None,
) -> None:
    """Call the requested MCP tool over SSE with the provided arguments.

    Raises:
        ValueError: If required CLI arguments are missing for the selected tool.
    """
    async with sse_client(url) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            args = None
            if tool in ("compile_and_analyze", "compile_and_start", "check_syntax"):
                if not dsp_path:
                    raise ValueError("--dsp is required for compile tools")
                with open(dsp_path, "r", encoding="utf-8") as f:
                    dsp = f.read()
                args = {"faust_code": dsp}
                if tool in ("compile_and_analyze", "compile_and_start"):
                    if input_source is not None:
                        args["input_source"] = input_source
                    if input_freq is not None:
                        args["input_freq"] = input_freq
                    if input_file is not None:
                        args["input_file"] = input_file
                if tool == "compile_and_start":
                    if name:
                        args["name"] = name
                    if latency_hint:
                        args["latency_hint"] = latency_hint
                    if hide_meters:
                        args["hide_meters"] = True
                elif tool == "check_syntax" and name:
                    args["name"] = name
            elif tool == "get_param":
                if not param_path:
                    raise ValueError("--param-path is required for get_param")
                args = {"path": param_path}
            elif tool == "get_param_values":
                args = {}
            elif tool == "set_param_values":
                if not param_values:
                    raise ValueError("--param-values is required for set_param_values")
                values = []
                for entry in param_values:
                    if "=" not in entry:
                        raise ValueError("param entry must be PATH=VALUE")
                    path, value = entry.split("=", 1)
                    values.append({"path": path, "value": float(value)})
                args = {"values": values}
            elif tool == "set_param":
                if not param_path or param_value is None:
                    raise ValueError("--param-path and --param-value are required for set_param")
                args = {"path": param_path, "value": param_value}
            elif tool in ("get_params", "get_audio_metrics", "stop"):
                args = {}
                if tool == "get_audio_metrics":
                    if include_scope:
                        args["include_scope"] = True
                    if include_spectrum:
                        args["include_spectrum"] = True
                    if per_channel:
                        args["per_channel"] = True
                    if fft_size is not None:
                        args["fft_size"] = fft_size
                    if smoothing is not None:
                        args["smoothing"] = smoothing
                    if min_db is not None:
                        args["min_db"] = min_db
                    if max_db is not None:
                        args["max_db"] = max_db
                    if edge_threshold is not None:
                        args["edge_threshold"] = edge_threshold
                    if log_bins is not None:
                        args["log_bins"] = log_bins
            else:
                raise ValueError(f"Unsupported tool: {tool}")

            result = await session.call_tool(tool, args)
            print(result.structuredContent or result.content[0].text)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Call the Faust MCP server over SSE.")
    parser.add_argument(
        "--url",
        default="http://127.0.0.1:8000/sse",
        help="SSE endpoint URL.",
    )
    parser.add_argument(
        "--dsp",
        default="t1.dsp",
        help="Path to a Faust DSP file.",
    )
    parser.add_argument(
        "--tool",
        default="compile_and_analyze",
        help="Tool name (compile_and_analyze, compile_and_start, check_syntax, get_params, get_param, get_param_values, get_audio_metrics, set_param_values, set_param, stop).",
    )
    parser.add_argument(
        "--name",
        default=None,
        help="DSP instance name for compile_and_start.",
    )
    parser.add_argument(
        "--latency",
        default=None,
        help="Latency hint for compile_and_start (interactive or playback).",
    )
    parser.add_argument(
        "--input-source",
        default=None,
        help="Input source for compile_and_analyze/compile_and_start (none, sine, noise, file). DawDreamer/RT servers only.",
    )
    parser.add_argument(
        "--input-freq",
        default=None,
        type=float,
        help="Input frequency in Hz for sine test input (DawDreamer/RT only).",
    )
    parser.add_argument(
        "--input-file",
        default=None,
        help="Input file path for file test input (DawDreamer/RT only).",
    )
    parser.add_argument(
        "--hide-meters",
        action="store_true",
        help="Hide meter bargraphs with [hidden:1] (RT only).",
    )
    parser.add_argument(
        "--include-scope",
        action="store_true",
        help="Include time-domain scope samples in get_audio_metrics.",
    )
    parser.add_argument(
        "--include-spectrum",
        action="store_true",
        help="Include spectrum FFT bins in get_audio_metrics.",
    )
    parser.add_argument(
        "--per-channel",
        action="store_true",
        help="Return per-channel scope/spectrum in get_audio_metrics.",
    )
    parser.add_argument(
        "--fft-size",
        type=int,
        default=None,
        help="FFT size for scope/spectrum (get_audio_metrics).",
    )
    parser.add_argument(
        "--smoothing",
        type=float,
        default=None,
        help="Smoothing constant for spectrum (get_audio_metrics).",
    )
    parser.add_argument(
        "--min-db",
        type=float,
        default=None,
        help="Minimum decibels for spectrum (get_audio_metrics).",
    )
    parser.add_argument(
        "--max-db",
        type=float,
        default=None,
        help="Maximum decibels for spectrum (get_audio_metrics).",
    )
    parser.add_argument(
        "--edge-threshold",
        type=float,
        default=None,
        help="Rising-edge threshold for scope alignment (get_audio_metrics).",
    )
    parser.add_argument(
        "--log-bins",
        type=int,
        default=None,
        help="Number of log-spaced spectrum bins to return (get_audio_metrics).",
    )
    parser.add_argument(
        "--param-path",
        default=None,
        help="Parameter path for get_param/set_param.",
    )
    parser.add_argument(
        "--param-value",
        default=None,
        type=float,
        help="Parameter value for set_param.",
    )
    parser.add_argument(
        "--param-values",
        action="append",
        help="Repeated PATH=VALUE pairs for set_param_values.",
    )
    parser.add_argument(
        "--tmpdir",
        default=None,
        help="Local TMPDIR override (client-side only).",
    )
    args = parser.parse_args()
    if args.tmpdir:
        os.environ["TMPDIR"] = args.tmpdir
    anyio.run(
        main,
        args.url,
        args.tool,
        args.dsp,
        args.name,
        args.latency,
        args.input_source,
        args.input_freq,
        args.input_file,
        args.hide_meters,
        args.include_scope,
        args.include_spectrum,
        args.per_channel,
        args.fft_size,
        args.smoothing,
        args.min_db,
        args.max_db,
        args.edge_threshold,
        args.log_bins,
        args.param_path,
        args.param_value,
        args.param_values,
    )
