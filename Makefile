PYTHON ?= python3
MCP_HOST ?= 127.0.0.1
MCP_PORT ?= 8000
TMPDIR ?= ./tmp
DSP ?= t1.dsp
WEBAUDIO_ROOT ?= external/node-web-audio-api
RT_NAME ?= faust-rt
RT_PARAM_PATH ?= /freq
RT_PARAM_VALUE ?= 440
FAUST_UI_PORT ?= 8787
FAUST_UI_ROOT ?=
INPUT_SOURCE ?=
INPUT_FREQ ?=
INPUT_FILE ?=
HIDE_METERS ?= 0
RT_MIDI_INDEX ?= 0
DD_SAMPLE_RATE ?= 44100
DD_BLOCK_SIZE ?= 256
DD_RENDER_SECONDS ?= 2.0
DD_FFT_SIZE ?= 2048
DD_FFT_HOP ?= 1024
DD_ROLLOFF ?= 0.85

.PHONY: help setup setup-node setup-ui setup-browser-ui setup-midi clean smoke-test run-sse run-stdio run-daw run-node run-node-ui run-node-stdio run-node-stdio-ui run-node-stdio-session run-browser-ui run-browser-stdio run-browser-static client-sse client-stdio client-daw rt-compile rt-get-params rt-get-param rt-get-param-values rt-get-audio-metrics rt-get-audio-metrics-scope rt-get-audio-metrics-spectrum rt-get-audio-metrics-full rt-get-audio-metrics-full-per-channel rt-set-param rt-save-wasm rt-load-wasm rt-stop rt-midi-list rt-midi-select rt-ws-metrics stop-node test-node-api test-browser-api

help:
	@printf "Targets:\n"
	@printf "  setup        Create tmp/ and install Python deps\n"
	@printf "  setup-node   Install node-web-audio-api deps and build native module\n"
	@printf "  setup-ui     Install @shren/faust-ui in this repo\n"
	@printf "  setup-browser-ui Install browser UI deps (Faust UI + faustwasm)\n"
	@printf "  setup-midi   Init node-midi submodule and install native deps\n"
	@printf "  clean        Remove tmp/ and server logs\n"
	@printf "  smoke-test   Run a basic stdio test against both servers\n"
	@printf "  run-sse      Start the MCP server over SSE\n"
	@printf "  run-stdio    Start the MCP server over stdio\n"
	@printf "  run-daw      Start the DawDreamer MCP server over SSE\n"
	@printf "  run-node     Start the real-time MCP server over SSE\n"
	@printf "  run-node-ui  Start real-time MCP server with UI bridge\n"
	@printf "  run-node-stdio Start real-time MCP server over stdio\n"
	@printf "  run-node-stdio-ui Start real-time MCP server over stdio with UI bridge\n"
	@printf "  run-node-stdio-session Start a persistent stdio session (multi-DSP)\n"
	@printf "  run-browser-ui Start browser-only runtime (SSE + static UI)\n"
	@printf "  run-browser-stdio Start browser-only runtime (stdio + static UI)\n"
	@printf "  run-browser-static Start only a static server (open /rt-browser-ui.html)\n"
	@printf "  test-node-api Run the node-only API test script\n"
	@printf "  test-browser-api Run the browser-only API test script\n"
	@printf "  stop-node    Stop the real-time server (SSE or stdio)\n"
	@printf "  client-sse   Call the SSE server using t1.dsp\n"
	@printf "  client-stdio Call the stdio server using t1.dsp\n"
	@printf "  client-daw   Call the DawDreamer server using t1.dsp\n"
	@printf "\n"
	@printf "Real-time tools:\n"
	@printf "  rt-compile    Compile/start DSP on real-time server\n"
	@printf "  rt-get-params Get params from real-time server\n"
	@printf "  rt-get-param  Get a param value from real-time server\n"
	@printf "  rt-get-param-values Get all param values from real-time server\n"
	@printf "  rt-get-audio-metrics Get RMS/Peak metering from real-time server\n"
	@printf "  rt-get-audio-metrics-scope Get time-domain scope samples\n"
	@printf "  rt-get-audio-metrics-spectrum Get spectrum FFT bins\n"
	@printf "  rt-get-audio-metrics-full Get scope + spectrum metrics\n"
	@printf "  rt-get-audio-metrics-full-per-channel Get scope + spectrum per channel\n"
	@printf "  rt-set-param  Set a param on real-time server (RT_PARAM_PATH/RT_PARAM_VALUE)\n"
	@printf "  rt-save-wasm  Save compiled DSP as wasm/json in tmp/\n"
	@printf "  rt-load-wasm  Load compiled DSP wasm/json from tmp/\n"
	@printf "  rt-midi-list  List MIDI inputs from the UI server\n"
	@printf "  rt-midi-select Select a MIDI input (RT_MIDI_INDEX)\n"
	@printf "  rt-ws-metrics Test WebSocket metrics stream\n"
	@printf "  rt-stop       Stop real-time DSP\n"
	@printf "\nVars:\n"
	@printf "  MCP_HOST=%s\n" "$(MCP_HOST)"
	@printf "  MCP_PORT=%s\n" "$(MCP_PORT)"
	@printf "  MCP_TRANSPORT=%s\n" "$(MCP_TRANSPORT)"
	@printf "  TMPDIR=%s\n" "$(TMPDIR)"
	@printf "  DSP=%s\n" "$(DSP)"
	@printf "  DD_SAMPLE_RATE=%s\n" "$(DD_SAMPLE_RATE)"
	@printf "  DD_BLOCK_SIZE=%s\n" "$(DD_BLOCK_SIZE)"
	@printf "  DD_RENDER_SECONDS=%s\n" "$(DD_RENDER_SECONDS)"
	@printf "  DD_FFT_SIZE=%s\n" "$(DD_FFT_SIZE)"
	@printf "  DD_FFT_HOP=%s\n" "$(DD_FFT_HOP)"
	@printf "  DD_ROLLOFF=%s\n" "$(DD_ROLLOFF)"
	@printf "  WEBAUDIO_ROOT=%s\n" "$(WEBAUDIO_ROOT)"
	@printf "  RT_PARAM_PATH=%s\n" "$(RT_PARAM_PATH)"
	@printf "  RT_PARAM_VALUE=%s\n" "$(RT_PARAM_VALUE)"
	@printf "  RT_NAME=%s\n" "$(RT_NAME)"
	@printf "  FAUST_UI_PORT=%s\n" "$(FAUST_UI_PORT)"
	@printf "  FAUST_UI_ROOT=%s\n" "$(FAUST_UI_ROOT)"
	@printf "  INPUT_SOURCE=%s\n" "$(INPUT_SOURCE)"
	@printf "  INPUT_FREQ=%s\n" "$(INPUT_FREQ)"
	@printf "  INPUT_FILE=%s\n" "$(INPUT_FILE)"
	@printf "  HIDE_METERS=%s\n" "$(HIDE_METERS)"
	@printf "  RT_MIDI_INDEX=%s\n" "$(RT_MIDI_INDEX)"

setup:
	@mkdir -p $(TMPDIR)
	$(PYTHON) -m pip install -r requirements.txt

setup-node:
	git submodule update --init --remote $(WEBAUDIO_ROOT)
	cd $(WEBAUDIO_ROOT) && npm install && npm up && npm run build

setup-ui:
	cd ui && npm install

setup-browser-ui:
	cd ui && npm install && npm install @grame/faustwasm

setup-midi:
	git submodule update --init --recursive external/node-midi
	cd external/node-midi && npm install && npm run build:ts

clean:
	rm -rf $(TMPDIR) faust_server.log faust_server_sse.log __pycache__

run-sse:
	@mkdir -p $(TMPDIR)
	MCP_TRANSPORT=sse MCP_HOST=$(MCP_HOST) MCP_PORT=$(MCP_PORT) TMPDIR=$(TMPDIR) $(PYTHON) faust_server.py

run-stdio:
	@mkdir -p $(TMPDIR)
	MCP_TRANSPORT=stdio TMPDIR=$(TMPDIR) $(PYTHON) faust_server.py

run-daw:
	@mkdir -p $(TMPDIR)
	@$(PYTHON) - <<'PY'\nimport sys\ntry:\n    import dawdreamer  # noqa: F401\nexcept Exception:\n    try:\n        import dawDreamer  # noqa: F401\n    except Exception:\n        print(\"dawDreamer is not installed for this Python. Install with: python3 -m pip install dawDreamer\")\n        sys.exit(1)\nPY
	MCP_TRANSPORT=sse MCP_HOST=$(MCP_HOST) MCP_PORT=$(MCP_PORT) \
	DD_SAMPLE_RATE=$(DD_SAMPLE_RATE) DD_BLOCK_SIZE=$(DD_BLOCK_SIZE) DD_RENDER_SECONDS=$(DD_RENDER_SECONDS) \
	DD_FFT_SIZE=$(DD_FFT_SIZE) DD_FFT_HOP=$(DD_FFT_HOP) DD_ROLLOFF=$(DD_ROLLOFF) \
	$(PYTHON) faust_server_daw.py

client-sse:
	@mkdir -p $(TMPDIR)
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --dsp $(DSP) --tmpdir $(TMPDIR)

client-stdio:
	@mkdir -p $(TMPDIR)
	$(PYTHON) stdio_client_example.py --dsp $(DSP) --server faust_server.py --tmpdir $(TMPDIR)

client-daw:
	@mkdir -p $(TMPDIR)
	DD_SAMPLE_RATE=$(DD_SAMPLE_RATE) DD_BLOCK_SIZE=$(DD_BLOCK_SIZE) DD_RENDER_SECONDS=$(DD_RENDER_SECONDS) \
	DD_FFT_SIZE=$(DD_FFT_SIZE) DD_FFT_HOP=$(DD_FFT_HOP) DD_ROLLOFF=$(DD_ROLLOFF) \
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --dsp $(DSP) --tmpdir $(TMPDIR) \
		$(if $(INPUT_SOURCE),--input-source $(INPUT_SOURCE),) \
		$(if $(INPUT_FREQ),--input-freq $(INPUT_FREQ),) \
		$(if $(INPUT_FILE),--input-file $(INPUT_FILE),)

run-node:
	WEBAUDIO_ROOT=$(WEBAUDIO_ROOT) MCP_TRANSPORT=sse MCP_HOST=$(MCP_HOST) MCP_PORT=$(MCP_PORT) \
	$(PYTHON) faust_node_server.py

run-node-ui:
	WEBAUDIO_ROOT=$(WEBAUDIO_ROOT) FAUST_UI_PORT=$(FAUST_UI_PORT) FAUST_UI_ROOT=$(FAUST_UI_ROOT) \
	MCP_TRANSPORT=sse MCP_HOST=$(MCP_HOST) MCP_PORT=$(MCP_PORT) \
	$(PYTHON) faust_node_server.py

run-node-stdio:
	WEBAUDIO_ROOT=$(WEBAUDIO_ROOT) MCP_TRANSPORT=stdio \
	$(PYTHON) faust_node_server.py

run-node-stdio-ui:
	WEBAUDIO_ROOT=$(WEBAUDIO_ROOT) FAUST_UI_PORT=$(FAUST_UI_PORT) FAUST_UI_ROOT=$(FAUST_UI_ROOT) \
	MCP_TRANSPORT=stdio \
	$(PYTHON) faust_node_server.py

run-rt-stdio-session:
	WEBAUDIO_ROOT=$(WEBAUDIO_ROOT) FAUST_UI_PORT=$(FAUST_UI_PORT) FAUST_UI_ROOT=$(FAUST_UI_ROOT) \
	$(PYTHON) stdio_rt_session.py

run-browser-ui:
	MCP_TRANSPORT=sse MCP_HOST=$(MCP_HOST) MCP_PORT=$(MCP_PORT) \
	$(PYTHON) faust_browser_server.py

run-browser-stdio:
	MCP_TRANSPORT=stdio \
	$(PYTHON) faust_browser_server.py

run-browser-static:
	$(PYTHON) -m http.server 8010 --directory ui

test-node-api:
	./scripts/test_full_api_node.sh

test-browser-api:
	./scripts/test_full_api_browser.sh

rt-compile:
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool compile_and_start --dsp $(DSP) --name $(RT_NAME) --latency interactive \
		$(if $(INPUT_SOURCE),--input-source $(INPUT_SOURCE),) \
		$(if $(INPUT_FREQ),--input-freq $(INPUT_FREQ),) \
		$(if $(INPUT_FILE),--input-file $(INPUT_FILE),) \
		$(if $(filter 1 true yes,$(HIDE_METERS)),--hide-meters,)

rt-get-params:
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool get_params

rt-get-param:
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool get_param --param-path $(RT_PARAM_PATH)

rt-get-param-values:
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool get_param_values

rt-get-audio-metrics:
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool get_audio_metrics

rt-get-audio-metrics-scope:
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool get_audio_metrics --include-scope

rt-get-audio-metrics-spectrum:
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool get_audio_metrics --include-spectrum

rt-get-audio-metrics-full:
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool get_audio_metrics --include-scope --include-spectrum

rt-get-audio-metrics-full-per-channel:
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool get_audio_metrics --include-scope --include-spectrum --per-channel

rt-set-param:
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool set_param --param-path $(RT_PARAM_PATH) --param-value $(RT_PARAM_VALUE)

rt-save-wasm:
	@mkdir -p $(TMPDIR)
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool save_wasm_module > $(TMPDIR)/wasm_payload.json
	$(PYTHON) scripts/save_wasm_payload.py --payload $(TMPDIR)/wasm_payload.json --out-dir $(TMPDIR)

rt-load-wasm:
	@if [ ! -f "$(TMPDIR)/dsp.wasm" ] || [ ! -f "$(TMPDIR)/dsp.json" ]; then \
		echo "Missing $(TMPDIR)/dsp.wasm or $(TMPDIR)/dsp.json. Run make rt-save-wasm first."; \
		exit 1; \
	fi
	@extra_args=""; \
	if [ -f "$(TMPDIR)/effect.wasm" ] && [ -f "$(TMPDIR)/effect.json" ]; then \
		extra_args="--effect-wasm $(TMPDIR)/effect.wasm --effect-dsp-json $(TMPDIR)/effect.json"; \
	fi; \
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool load_wasm_module \
		--wasm $(TMPDIR)/dsp.wasm --dsp-json $(TMPDIR)/dsp.json $$extra_args

rt-midi-list:
	curl -s http://127.0.0.1:$(FAUST_UI_PORT)/midi/inputs

rt-midi-select:
	curl -s -X POST http://127.0.0.1:$(FAUST_UI_PORT)/midi/select \
		-H 'Content-Type: application/json' \
		-d '{"index":$(RT_MIDI_INDEX)}'

rt-ws-metrics:
	./scripts/test_ws_metrics.py --url ws://127.0.0.1:$(FAUST_UI_PORT)/ws --include-scope --include-spectrum

rt-stop:
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool stop

stop-node:
	@if [ "$(MCP_TRANSPORT)" = "stdio" ]; then \
		pkill -f "faust_node_server.py" || true; \
		pkill -f "faust_node_worker.mjs" || true; \
	else \
		$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool stop >/dev/null 2>&1 || true; \
		pkill -f "faust_node_server.py" || true; \
		pkill -f "faust_node_worker.mjs" || true; \
	fi

smoke-test:
	@mkdir -p $(TMPDIR)
	$(PYTHON) smoke_test.py --dsp $(DSP) --tmpdir $(TMPDIR)
