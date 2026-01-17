#!/usr/bin/env bash
# End-to-end sanity check for the SSE API + optional UI HTTP endpoints.
set -euo pipefail

URL="${MCP_URL:-http://127.0.0.1:8000/sse}"
HTTP_BASE="${MCP_HTTP_BASE:-http://127.0.0.1:8000}"
UI_HTTP_BASE="${UI_HTTP_BASE:-http://127.0.0.1:8787}"
DSP="${DSP:-t2.dsp}"
NAME="${NAME:-faust-rt}"
GAIN_PATH="${GAIN_PATH:-/faust-rt/gain}"
FREQ1_PATH="${FREQ1_PATH:-/faust-rt/freq1}"
FREQ2_PATH="${FREQ2_PATH:-/faust-rt/freq2}"
SKIP_UI="${SKIP_UI:-0}"
TMPDIR="${TMPDIR:-./tmp}"

# Basic reachability check before running the full tool sequence.
if ! curl -s -S "${HTTP_BASE}/status" >/dev/null; then
  echo "ERROR: MCP server not reachable at ${HTTP_BASE}" >&2
  exit 1
fi

echo "== check_syntax =="
python3 sse_client_example.py --url "${URL}" --tool check_syntax --dsp "${DSP}" --name "${NAME}"

echo "== compile_and_start (interactive) =="
python3 sse_client_example.py --url "${URL}" --tool compile_and_start --dsp "${DSP}" --name "${NAME}" --latency interactive
echo "== stop (interactive) =="
python3 sse_client_example.py --url "${URL}" --tool stop
echo "== compile_and_start (playback) =="
python3 sse_client_example.py --url "${URL}" --tool compile_and_start --dsp "${DSP}" --name "${NAME}" --latency playback

echo "== get_params =="
python3 sse_client_example.py --url "${URL}" --tool get_params

echo "== get_status =="
python3 sse_client_example.py --url "${URL}" --tool get_status

echo "== get_midi_inputs =="
python3 sse_client_example.py --url "${URL}" --tool get_midi_inputs

echo "== get_midi_status =="
python3 sse_client_example.py --url "${URL}" --tool get_midi_status

echo "== get_dsp_json =="
python3 sse_client_example.py --url "${URL}" --tool get_dsp_json

echo "== save_wasm_module =="
mkdir -p "${TMPDIR}"
python3 sse_client_example.py --url "${URL}" --tool save_wasm_module > "${TMPDIR}/wasm_payload.json"
python3 - <<PY
import base64
import json
import ast
from pathlib import Path

tmpdir = Path(r"${TMPDIR}")
payload_path = tmpdir / "wasm_payload.json"
with payload_path.open("r", encoding="utf-8") as f:
    raw = f.read()
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

if data.get("error"):
    raise SystemExit(f"save_wasm_module error: {data['error']}")
wasm_base64 = data.get("wasm_base64")
if not wasm_base64:
    raise SystemExit(f"save_wasm_module: missing wasm_base64 in response (keys: {sorted(data.keys())})")

(tmpdir / "dsp.wasm").write_bytes(base64.b64decode(wasm_base64))
with (tmpdir / "dsp.json").open("w", encoding="utf-8") as f:
    json.dump(data.get("dsp_json"), f, indent=2)

if data.get("effect_wasm_base64") and data.get("effect_dsp_json"):
    (tmpdir / "effect.wasm").write_bytes(base64.b64decode(data["effect_wasm_base64"]))
    with (tmpdir / "effect.json").open("w", encoding="utf-8") as f:
        json.dump(data.get("effect_dsp_json"), f, indent=2)
PY

echo "== stop =="
python3 sse_client_example.py --url "${URL}" --tool stop

echo "== load_wasm_module (interactive) =="
extra_args=()
if [[ -f "${TMPDIR}/effect.wasm" && -f "${TMPDIR}/effect.json" ]]; then
  extra_args=(--effect-wasm "${TMPDIR}/effect.wasm" --effect-dsp-json "${TMPDIR}/effect.json")
fi
if [ ${#extra_args[@]} -eq 0 ]; then
  python3 sse_client_example.py --url "${URL}" --tool load_wasm_module \
    --wasm "${TMPDIR}/dsp.wasm" --dsp-json "${TMPDIR}/dsp.json" --latency interactive
else
  python3 sse_client_example.py --url "${URL}" --tool load_wasm_module \
    --wasm "${TMPDIR}/dsp.wasm" --dsp-json "${TMPDIR}/dsp.json" \
    "${extra_args[@]}" --latency interactive
fi
echo "== start (interactive) =="
python3 sse_client_example.py --url "${URL}" --tool start
echo "== stop (interactive) =="
python3 sse_client_example.py --url "${URL}" --tool stop
echo "== load_wasm_module (path, interactive) =="
python3 - <<PY
import os
import anyio
from mcp.client.sse import sse_client
from mcp.client.session import ClientSession

url = "${URL}"
wasm_path = "${TMPDIR}/dsp.wasm"
dsp_json_path = "${TMPDIR}/dsp.json"
effect_wasm_path = "${TMPDIR}/effect.wasm"
effect_json_path = "${TMPDIR}/effect.json"

async def main():
    async with sse_client(url) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            args = {"wasm_path": wasm_path, "dsp_json_path": dsp_json_path, "latency_hint": "interactive"}
            if os.path.isfile(effect_wasm_path) and os.path.isfile(effect_json_path):
                args["effect_wasm_path"] = effect_wasm_path
                args["effect_dsp_json_path"] = effect_json_path
            result = await session.call_tool("load_wasm_module", args)
            print(result.structuredContent or result.content[0].text)

anyio.run(main)
PY
echo "== start (interactive, path) =="
python3 sse_client_example.py --url "${URL}" --tool start
echo "== stop (interactive, path) =="
python3 sse_client_example.py --url "${URL}" --tool stop
echo "== load_wasm_module (playback) =="
if [ ${#extra_args[@]} -eq 0 ]; then
  python3 sse_client_example.py --url "${URL}" --tool load_wasm_module \
    --wasm "${TMPDIR}/dsp.wasm" --dsp-json "${TMPDIR}/dsp.json" --latency playback
else
  python3 sse_client_example.py --url "${URL}" --tool load_wasm_module \
    --wasm "${TMPDIR}/dsp.wasm" --dsp-json "${TMPDIR}/dsp.json" \
    "${extra_args[@]}" --latency playback
fi
echo "== start (playback) =="
python3 sse_client_example.py --url "${URL}" --tool start
echo "== stop (playback) =="
python3 sse_client_example.py --url "${URL}" --tool stop
echo "== load_wasm_module (path, playback) =="
python3 - <<PY
import os
import anyio
from mcp.client.sse import sse_client
from mcp.client.session import ClientSession

url = "${URL}"
wasm_path = "${TMPDIR}/dsp.wasm"
dsp_json_path = "${TMPDIR}/dsp.json"
effect_wasm_path = "${TMPDIR}/effect.wasm"
effect_json_path = "${TMPDIR}/effect.json"

async def main():
    async with sse_client(url) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            args = {"wasm_path": wasm_path, "dsp_json_path": dsp_json_path, "latency_hint": "playback"}
            if os.path.isfile(effect_wasm_path) and os.path.isfile(effect_json_path):
                args["effect_wasm_path"] = effect_wasm_path
                args["effect_dsp_json_path"] = effect_json_path
            result = await session.call_tool("load_wasm_module", args)
            print(result.structuredContent or result.content[0].text)

anyio.run(main)
PY
echo "== start (playback, path) =="
python3 sse_client_example.py --url "${URL}" --tool start

echo "== get_param (gain) =="
python3 sse_client_example.py --url "${URL}" --tool get_param --param-path "${GAIN_PATH}"

echo "== set_param (gain) =="
python3 sse_client_example.py --url "${URL}" --tool set_param --param-path "${GAIN_PATH}" --param-value -3

echo "== set_param_values (freq1/freq2) =="
python3 sse_client_example.py --url "${URL}" --tool set_param_values \
  --param-values "${FREQ1_PATH}=1000" \
  --param-values "${FREQ2_PATH}=1200"

echo "== get_param_values =="
python3 sse_client_example.py --url "${URL}" --tool get_param_values

echo "== get_audio_metrics =="
python3 sse_client_example.py --url "${URL}" --tool get_audio_metrics

echo "== get_audio_metrics (scope+spectrum, per-channel) =="
python3 sse_client_example.py --url "${URL}" --tool get_audio_metrics \
  --include-scope --include-spectrum --per-channel --fft-size 2048 --smoothing 0.8 --min-db -90 --max-db 0 --edge-threshold 0.1 --log-bins 48

echo "== stop (playback, path) =="
python3 sse_client_example.py --url "${URL}" --tool stop

echo "== compile (no start, interactive) =="
python3 sse_client_example.py --url "${URL}" --tool compile --dsp "${DSP}" --name "${NAME}" --latency interactive
echo "== start (interactive) =="
python3 sse_client_example.py --url "${URL}" --tool start
echo "== stop (interactive) =="
python3 sse_client_example.py --url "${URL}" --tool stop
echo "== compile (no start, playback) =="
python3 sse_client_example.py --url "${URL}" --tool compile --dsp "${DSP}" --name "${NAME}" --latency playback
echo "== start (playback) =="
python3 sse_client_example.py --url "${URL}" --tool start

# Optional UI endpoint checks (skip with SKIP_UI=1).
if [[ "${SKIP_UI}" != "1" ]]; then
  if curl -s -S "${UI_HTTP_BASE}/" >/dev/null; then
    echo "== ui http (root) =="
    curl -s -S "${UI_HTTP_BASE}/" >/dev/null && echo "UI root ok"
    echo "== ui http (status/json/params/param-values) =="
    curl -s -S "${UI_HTTP_BASE}/status" && echo
    curl -s -S "${UI_HTTP_BASE}/json" && echo
    curl -s -S "${UI_HTTP_BASE}/params" && echo
    curl -s -S "${UI_HTTP_BASE}/param-values" && echo
  else
    echo "WARN: UI server not reachable at ${UI_HTTP_BASE} (set SKIP_UI=1 to skip)" >&2
  fi
fi

echo "== stop =="
python3 sse_client_example.py --url "${URL}" --tool stop

echo "OK"
