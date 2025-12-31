PYTHON ?= python3
MCP_HOST ?= 127.0.0.1
MCP_PORT ?= 8000
TMPDIR ?= ./tmp
DSP ?= t1.dsp

.PHONY: help setup clean run-sse run-stdio client-sse client-stdio

help:
	@printf "Targets:\n"
	@printf "  setup        Create tmp/ and install Python deps\n"
	@printf "  clean        Remove tmp/ and server logs\n"
	@printf "  run-sse      Start the MCP server over SSE\n"
	@printf "  run-stdio    Start the MCP server over stdio\n"
	@printf "  client-sse   Call the SSE server using t1.dsp\n"
	@printf "  client-stdio Call the stdio server using t1.dsp\n"
	@printf "\nVars:\n"
	@printf "  MCP_HOST=%s\n" "$(MCP_HOST)"
	@printf "  MCP_PORT=%s\n" "$(MCP_PORT)"
	@printf "  TMPDIR=%s\n" "$(TMPDIR)"
	@printf "  DSP=%s\n" "$(DSP)"

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

client-sse:
	@mkdir -p $(TMPDIR)
	$(PYTHON) sse_client_example.py --url http://$(MCP_HOST):$(MCP_PORT)/sse --dsp $(DSP) --tmpdir $(TMPDIR)

client-stdio:
	@mkdir -p $(TMPDIR)
	$(PYTHON) stdio_client_example.py --dsp $(DSP) --server faust_server.py --tmpdir $(TMPDIR)
