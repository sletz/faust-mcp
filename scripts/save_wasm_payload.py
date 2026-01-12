#!/usr/bin/env python3
"""Convert a save_wasm_module payload into wasm/json files."""

from __future__ import annotations

import argparse
import ast
import base64
import json
from pathlib import Path


def _load_payload(path: Path) -> dict:
    raw = path.read_text(encoding="utf-8")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = ast.literal_eval(raw)
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except json.JSONDecodeError:
            data = ast.literal_eval(data)
    for _ in range(6):
        if isinstance(data, dict) and "result" in data:
            data = data["result"]
            if isinstance(data, str):
                try:
                    data = json.loads(data)
                except json.JSONDecodeError:
                    data = ast.literal_eval(data)
        else:
            break
    if not isinstance(data, dict):
        raise SystemExit("save_wasm_module: invalid payload format")
    return data


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract wasm/json from save_wasm_module payload.")
    parser.add_argument("--payload", required=True, help="Path to save_wasm_module payload JSON.")
    parser.add_argument("--out-dir", required=True, help="Output directory for wasm/json files.")
    args = parser.parse_args()

    payload_path = Path(args.payload)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    data = _load_payload(payload_path)
    wasm_base64 = data.get("wasm_base64")
    if not wasm_base64:
        raise SystemExit("save_wasm_module: missing wasm_base64 in response")

    (out_dir / "dsp.wasm").write_bytes(base64.b64decode(wasm_base64))
    (out_dir / "dsp.json").write_text(json.dumps(data.get("dsp_json"), indent=2), encoding="utf-8")

    effect_wasm_base64 = data.get("effect_wasm_base64")
    if effect_wasm_base64:
        (out_dir / "effect.wasm").write_bytes(base64.b64decode(effect_wasm_base64))
    effect_dsp_json = data.get("effect_dsp_json")
    if effect_dsp_json is not None:
        if isinstance(effect_dsp_json, str):
            try:
                effect_dsp_json = json.loads(effect_dsp_json)
            except json.JSONDecodeError:
                effect_dsp_json = ast.literal_eval(effect_dsp_json)
        (out_dir / "effect.json").write_text(
            json.dumps(effect_dsp_json, indent=2),
            encoding="utf-8",
        )


if __name__ == "__main__":
    main()
