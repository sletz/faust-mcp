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

# Basic reachability check before running the full tool sequence.
if ! curl -s -S "${HTTP_BASE}/status" >/dev/null; then
  echo "ERROR: MCP server not reachable at ${HTTP_BASE}" >&2
  exit 1
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

echo "== stop =="
python3 sse_client_example.py --url "${URL}" --tool stop

echo "== compile (no start) =="
python3 sse_client_example.py --url "${URL}" --tool compile --dsp "${DSP}" --name "${NAME}"

echo "== start =="
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
