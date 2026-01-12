#!/usr/bin/env bash
# End-to-end sanity check for the browser-only runtime via MCP SSE.
# Requires a browser tab open to the UI and audio unlocked.
set -euo pipefail

URL="${MCP_URL:-http://127.0.0.1:8000/sse}"
UI_HTTP_BASE="${UI_HTTP_BASE:-http://127.0.0.1:8010}"
DSP="${DSP:-t2.dsp}"
NAME="${NAME:-faust-browser}"
GAIN_PATH="${GAIN_PATH:-/gain}"
FREQ1_PATH="${FREQ1_PATH:-/freq1}"
FREQ2_PATH="${FREQ2_PATH:-/freq2}"
REQUIRE_UNLOCK="${REQUIRE_UNLOCK:-1}"
TMPDIR="${TMPDIR:-./tmp}"

if curl -s -S "${UI_HTTP_BASE}/" >/dev/null; then
  echo "UI reachable at ${UI_HTTP_BASE}"
else
  echo "WARN: UI not reachable at ${UI_HTTP_BASE} (start with make run-browser-ui)" >&2
fi

if [[ "${REQUIRE_UNLOCK}" == "1" ]]; then
  echo "Open ${UI_HTTP_BASE} and click Unlock Audio (or Compile & Start) before continuing."
  if [ -t 0 ]; then
    read -r -p "Press Enter to continue..."
  fi
fi

echo "== check_syntax =="
python3 sse_client_example.py --url "${URL}" --tool check_syntax --dsp "${DSP}" --name "${NAME}"

echo "== compile_and_start =="
python3 sse_client_example.py --url "${URL}" --tool compile_and_start --dsp "${DSP}" --name "${NAME}" --latency interactive

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
if "wasm_base64" not in data:
    print("DEBUG save_wasm_module payload:", data)

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

echo "== load_wasm_module =="
extra_args=()
if [[ -f "${TMPDIR}/effect.wasm" && -f "${TMPDIR}/effect.json" ]]; then
  extra_args=(--effect-wasm "${TMPDIR}/effect.wasm" --effect-dsp-json "${TMPDIR}/effect.json")
fi
if [ ${#extra_args[@]} -eq 0 ]; then
  python3 sse_client_example.py --url "${URL}" --tool load_wasm_module \
    --wasm "${TMPDIR}/dsp.wasm" --dsp-json "${TMPDIR}/dsp.json"
else
  python3 sse_client_example.py --url "${URL}" --tool load_wasm_module \
    --wasm "${TMPDIR}/dsp.wasm" --dsp-json "${TMPDIR}/dsp.json" \
    "${extra_args[@]}"
fi

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

echo "== stop =="
python3 sse_client_example.py --url "${URL}" --tool stop

echo "== compile (no start) =="
python3 sse_client_example.py --url "${URL}" --tool compile --dsp "${DSP}" --name "${NAME}"

echo "== start =="
python3 sse_client_example.py --url "${URL}" --tool start

echo "== stop =="
python3 sse_client_example.py --url "${URL}" --tool stop

echo "OK"
