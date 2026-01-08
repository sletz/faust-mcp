#!/usr/bin/env python3
"""Batch DSP validation script for CI-style audio checks.

Compiles DSPs over MCP, grabs audio metrics, and flags silence/clipping/NaN.
Use --require-probes to ensure probes are wired in the DSP library.
"""

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List

import anyio
from mcp.client.sse import sse_client
from mcp.client.session import ClientSession


def load_dsp_files(globs: List[str], root: Path) -> List[Path]:
    files: List[Path] = []
    for pattern in globs:
        files.extend(sorted(root.glob(pattern)))
    seen = set()
    unique: List[Path] = []
    for path in files:
        if path in seen:
            continue
        seen.add(path)
        if path.is_file():
            unique.append(path)
    return unique


async def call_tool(session: ClientSession, tool: str, args: Dict[str, Any]) -> Dict[str, Any]:
    result = await session.call_tool(tool, args)
    payload = result.structuredContent or result.content[0].text
    if isinstance(payload, str):
        return json.loads(payload)
    return payload


def classify_metrics(
    metrics: Dict[str, Any],
    silence_threshold: float,
    clip_threshold: float,
    require_probes: bool,
) -> List[str]:
    """Classify audio metrics into QA issues."""
    issues: List[str] = []
    output = metrics.get("output", {}) if isinstance(metrics, dict) else {}
    mix = output.get("mix", {}) if isinstance(output, dict) else {}
    rms = mix.get("rms")
    peak = mix.get("peak")
    has_nan = mix.get("hasNaN")
    if has_nan:
        issues.append("nan_detected")
    if isinstance(rms, (int, float)) and isinstance(peak, (int, float)):
        if rms < silence_threshold and peak < silence_threshold:
            issues.append("silence_detected")
        if peak > clip_threshold:
            issues.append("clip_detected")
    else:
        issues.append("metrics_missing")
    probes = metrics.get("probes", []) if isinstance(metrics, dict) else []
    if require_probes and not probes:
        issues.append("probes_missing")
    for probe in probes or []:
        value = probe.get("value") if isinstance(probe, dict) else None
        if isinstance(value, float) and value != value:
            issues.append("probe_nan")
    return issues


async def run_batch(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    dsp_files = load_dsp_files(args.glob, root)
    if not dsp_files:
        print("No DSP files matched.")
        return 1

    failures: List[str] = []
    async with sse_client(args.url) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            for dsp_path in dsp_files:
                dsp_code = dsp_path.read_text(encoding="utf-8")
                name = dsp_path.stem
                # Compile and start each DSP with the chosen test input.
                compile_args: Dict[str, Any] = {
                    "faust_code": dsp_code,
                    "name": name,
                    "latency_hint": args.latency,
                }
                if args.input_source and args.input_source != "none":
                    compile_args["input_source"] = args.input_source
                if args.input_freq is not None:
                    compile_args["input_freq"] = args.input_freq
                if args.input_file:
                    compile_args["input_file"] = args.input_file

                print(f"== {dsp_path} ==")
                try:
                    compile_resp = await call_tool(session, "compile_and_start", compile_args)
                except Exception as exc:  # noqa: BLE001
                    failures.append(f"{dsp_path}: compile_failed ({exc})")
                    await call_tool(session, "stop", {})
                    continue

                if compile_resp.get("status") != "started":
                    failures.append(f"{dsp_path}: compile_failed ({compile_resp})")
                    await call_tool(session, "stop", {})
                    continue

                # Allow the DSP to reach steady state before sampling metrics.
                await anyio.sleep(args.warmup_ms / 1000)

                # Pull metrics and classify for silence/clipping/probe issues.
                metrics = await call_tool(session, "get_audio_metrics", {})
                issues = classify_metrics(
                    metrics,
                    args.silence_threshold,
                    args.clip_threshold,
                    args.require_probes,
                )
                probes = metrics.get("probes", []) if isinstance(metrics, dict) else []
                if probes:
                    formatted = ", ".join(
                        f"{probe.get('id')}: {probe.get('value'):.4f}"
                        for probe in probes
                        if isinstance(probe, dict) and isinstance(probe.get("value"), (int, float))
                    )
                    if formatted:
                        print(f"  probes: {formatted}")
                if issues:
                    failures.append(f"{dsp_path}: {', '.join(issues)}")
                    print(f"  issues: {', '.join(issues)}")
                else:
                    print("  ok")

                await call_tool(session, "stop", {})

    if failures:
        print("\nFailures:")
        for entry in failures:
            print(f"- {entry}")
        return 1

    print("\nAll DSPs passed.")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Batch validate DSPs via Faust MCP (compile, meter, detect silence/clipping)."
    )
    parser.add_argument("--url", default="http://127.0.0.1:8000/sse", help="SSE endpoint URL.")
    parser.add_argument("--root", default=".", help="Root directory for DSP globbing.")
    parser.add_argument(
        "--glob",
        action="append",
        default=["*.dsp"],
        help="Glob pattern for DSP files (repeatable).",
    )
    parser.add_argument("--latency", default="interactive", help="Latency hint.")
    parser.add_argument("--input-source", default="sine", help="Input source (sine/noise/file/none).")
    parser.add_argument("--input-freq", type=float, default=1000, help="Sine frequency for input source.")
    parser.add_argument("--input-file", default=None, help="Input file URL/path if input_source=file.")
    parser.add_argument("--warmup-ms", type=int, default=400, help="Warmup time before metrics.")
    parser.add_argument("--silence-threshold", type=float, default=1e-3, help="Silence threshold.")
    parser.add_argument("--clip-threshold", type=float, default=1.0, help="Clipping threshold.")
    parser.add_argument(
        "--require-probes",
        action="store_true",
        help="Fail if no probes are reported by get_audio_metrics.",
    )
    args = parser.parse_args()

    raise SystemExit(anyio.run(run_batch, args))


if __name__ == "__main__":
    main()
