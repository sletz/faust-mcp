PYTHON ?= python3
MCP_HOST ?= 127.0.0.1
MCP_PORT ?= 8000
TMPDIR ?= ./tmp
DSP ?= t1.dsp
DD_SAMPLE_RATE ?= 44100
DD_BLOCK_SIZE ?= 256
DD_RENDER_SECONDS ?= 2.0

.PHONY: help setup clean smoke-test run-sse run-stdio run-daw client-sse client-stdio client-daw

help:
	@printf "Targets:\n"
	@printf "  setup        Create tmp/ and install Python deps\n"
	@printf "  clean        Remove tmp/ and server logs\n"
	@printf "  smoke-test   Run a basic stdio test against both servers\n"
	@printf "  run-sse      Start the MCP server over SSE\n"
	@printf "  run-stdio    Start the MCP server over stdio\n"
	@printf "  run-daw      Start the DawDreamer MCP server over SSE\n"
	@printf "  client-sse   Call the SSE server using t1.dsp\n"
	@printf "  client-stdio Call the stdio server using t1.dsp\n"
	@printf "  client-daw   Call the DawDreamer server using t1.dsp\n"
	@printf "\nVars:\n"
	@printf "  MCP_HOST=%s\n" "$(MCP_HOST)"
	@printf "  MCP_PORT=%s\n" "$(MCP_PORT)"
	@printf "  TMPDIR=%s\n" "$(TMPDIR)"
	@printf "  DSP=%s\n" "$(DSP)"
	@printf "  DD_SAMPLE_RATE=%s\n" "$(DD_SAMPLE_RATE)"
	@printf "  DD_BLOCK_SIZE=%s\n" "$(DD_BLOCK_SIZE)"
	@printf "  DD_RENDER_SECONDS=%s\n" "$(DD_RENDER_SECONDS)"

setup:
	@mkdir -p $(TMPDIR)
	$(PYTHON) -m pip install -r requirements.txt

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
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --dsp $(DSP) --tmpdir $(TMPDIR)

smoke-test:
	@mkdir -p $(TMPDIR)
	$(PYTHON) smoke_test.py --dsp $(DSP) --tmpdir $(TMPDIR)
