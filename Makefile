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
DD_SAMPLE_RATE ?= 44100
DD_BLOCK_SIZE ?= 256
DD_RENDER_SECONDS ?= 2.0
DD_FFT_SIZE ?= 2048
DD_FFT_HOP ?= 1024
DD_ROLLOFF ?= 0.85

.PHONY: help setup setup-rt setup-ui clean smoke-test run-sse run-stdio run-daw run-rt run-rt-ui client-sse client-stdio client-daw client-rt rt-compile rt-get-params rt-get-param rt-get-param-values rt-set-param rt-stop

help:
	@printf "Targets:\n"
	@printf "  setup        Create tmp/ and install Python deps\n"
	@printf "  setup-rt     Install node-web-audio-api deps and build native module\n"
	@printf "  setup-ui     Install @shren/faust-ui in this repo\n"
	@printf "  clean        Remove tmp/ and server logs\n"
	@printf "  smoke-test   Run a basic stdio test against both servers\n"
	@printf "  run-sse      Start the MCP server over SSE\n"
	@printf "  run-stdio    Start the MCP server over stdio\n"
	@printf "  run-daw      Start the DawDreamer MCP server over SSE\n"
	@printf "  run-rt       Start the real-time MCP server over SSE\n"
	@printf "  run-rt-ui    Start real-time MCP server with UI bridge\n"
	@printf "  client-sse   Call the SSE server using t1.dsp\n"
	@printf "  client-stdio Call the stdio server using t1.dsp\n"
	@printf "  client-daw   Call the DawDreamer server using t1.dsp\n"
	@printf "  client-rt    Call the real-time server using t1.dsp\n"
	@printf "\n"
	@printf "Real-time tools:\n"
	@printf "  rt-compile    Compile/start DSP on real-time server\n"
	@printf "  rt-get-params Get params from real-time server\n"
	@printf "  rt-get-param  Get a param value from real-time server\n"
	@printf "  rt-get-param-values Get all param values from real-time server\n"
	@printf "  rt-set-param  Set a param on real-time server (RT_PARAM_PATH/RT_PARAM_VALUE)\n"
	@printf "  rt-stop       Stop real-time DSP\n"
	@printf "\nVars:\n"
	@printf "  MCP_HOST=%s\n" "$(MCP_HOST)"
	@printf "  MCP_PORT=%s\n" "$(MCP_PORT)"
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

setup:
	@mkdir -p $(TMPDIR)
	$(PYTHON) -m pip install -r requirements.txt

setup-rt:
	cd $(WEBAUDIO_ROOT) && npm install && npm run build

setup-ui:
	cd ui && npm install

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

run-rt:
	WEBAUDIO_ROOT=$(WEBAUDIO_ROOT) MCP_TRANSPORT=sse MCP_HOST=$(MCP_HOST) MCP_PORT=$(MCP_PORT) \
	$(PYTHON) faust_realtime_server.py

run-rt-ui:
	WEBAUDIO_ROOT=$(WEBAUDIO_ROOT) FAUST_UI_PORT=$(FAUST_UI_PORT) FAUST_UI_ROOT=$(FAUST_UI_ROOT) \
	MCP_TRANSPORT=sse MCP_HOST=$(MCP_HOST) MCP_PORT=$(MCP_PORT) \
	$(PYTHON) faust_realtime_server.py

client-rt:
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool compile_and_start --dsp $(DSP) --name $(RT_NAME) --latency interactive \
		$(if $(INPUT_SOURCE),--input-source $(INPUT_SOURCE),) \
		$(if $(INPUT_FREQ),--input-freq $(INPUT_FREQ),) \
		$(if $(INPUT_FILE),--input-file $(INPUT_FILE),)

rt-compile:
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool compile_and_start --dsp $(DSP) --name $(RT_NAME) --latency interactive \
		$(if $(INPUT_SOURCE),--input-source $(INPUT_SOURCE),) \
		$(if $(INPUT_FREQ),--input-freq $(INPUT_FREQ),) \
		$(if $(INPUT_FILE),--input-file $(INPUT_FILE),)

rt-get-params:
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool get_params

rt-get-param:
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool get_param --param-path $(RT_PARAM_PATH)

rt-get-param-values:
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool get_param_values

rt-set-param:
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool set_param --param-path $(RT_PARAM_PATH) --param-value $(RT_PARAM_VALUE)

rt-stop:
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --tool stop

smoke-test:
	@mkdir -p $(TMPDIR)
	$(PYTHON) smoke_test.py --dsp $(DSP) --tmpdir $(TMPDIR)
