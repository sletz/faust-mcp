# Faust MCP Server

This repository provides an MCP server that compiles and analyzes Faust DSP code.
The server is implemented in `faust_server.py` and exposes a single tool called
`compile_and_analyze`.

## Structure

- `faust_server.py`: MCP server entrypoint (FastMCP) and tool implementation.
- `analysis_arch.cpp`: Faust C++ architecture used to generate analysis data.
- `t1.dsp` and `t2.dsp`: Example Faust DSP programs.

### Server flow (faust_server.py)

1. Accept a Faust DSP string via the `compile_and_analyze` tool.
2. Write it to a temporary `process.dsp` file.
3. Compile Faust DSP to C++ using `analysis_arch.cpp`.
4. Compile the generated C++ into a native binary (C++11+).
5. Run the binary to produce JSON analysis output.
6. Return the JSON result to the MCP client.

## Requirements

- Python 3.10+
- Faust CLI available in PATH (`faust`)
- C++ compiler (`g++`) with C++11+ support
- Python package `mcp`
- See `requirements.txt` for client dependencies

## Environment variables

The server behavior can be configured with these variables:

- `MCP_HOST` (default: `127.0.0.1`)
- `MCP_PORT` (default: `8000`)
- `MCP_TRANSPORT` (default: `sse`)
 - Supported values: `sse`, `streamable-http`, `stdio`
- `MCP_MOUNT_PATH` (optional, SSE only)
- `TMPDIR` (recommended) temp folder used by the compiler toolchain

## Running the server

### Setup

```bash
make setup
```

### Cleanup

```bash
make clean
```

### SSE (HTTP) transport

```bash
MCP_TRANSPORT=sse MCP_HOST=127.0.0.1 MCP_PORT=8000 \
TMPDIR=/path/to/tmp \
python3 faust_server.py
```

By default the SSE endpoint is:

- `http://127.0.0.1:8000/sse`

### Stdio transport

```bash
MCP_TRANSPORT=stdio python3 faust_server.py
```

## Tool: compile_and_analyze

**Input:**

- `faust_code` (string) - the DSP source code

**Output:**

JSON string with:

- `status`
- `max_amplitude`
- `rms`
- `is_silent`
- `waveform_ascii`
- `channels` (array of per-output metrics)

### How analysis_arch.cpp computes outputs

The analysis is performed by `analysis_arch.cpp` and returns a JSON payload with
the following fields:

- `status`: hard-coded to `"success"` when the binary completes.
- `max_amplitude`: maximum absolute value of the **mono mix** over the full render.
  The mono mix is the average of all output channels per sample.
- `rms`: root-mean-square of the mono mix over the full render.
- `is_silent`: `true` when `max_amplitude < 0.0001`, otherwise `false`.
- `waveform_ascii`: a 60-character ASCII summary of the mono mix. Each character
  represents a chunk of the rendered buffer and is chosen by peak magnitude:
  `_` for near-silence (< 0.01), `#` for > 0.5, `=` for > 0.2, and `-` otherwise.
- `channels`: array of per-output objects with:
  - `index` (0-based output index)
  - `max_amplitude`
  - `rms`
  - `is_silent` (uses the same 0.0001 threshold)
  - `waveform_ascii` (same 60-character encoding per channel)

Render details:

- Sample rate: 44100 Hz
- Duration: 2 seconds (88200 samples)
- Processing block size: 256 frames

Example input (`t1.dsp`):

```faust
import("stdfaust.lib");
process = os.osc(500), os.osc(600);
```

## Client example (SSE)

```bash
python3 sse_client_example.py --url http://127.0.0.1:8000/sse --dsp t1.dsp
```

## Client example (stdio)

```bash
python3 stdio_client_example.py --dsp t1.dsp
```

Both client example scripts accept CLI arguments:

- `sse_client_example.py`: `--url`, `--dsp`
- `stdio_client_example.py`: `--dsp`, `--server`, `--tmpdir`
- `sse_client_example.py`: `--url`, `--dsp`, `--tmpdir` (client-side only)
- `stdio_client_example.py` forces `MCP_TRANSPORT=stdio` for the server process

## Client configuration examples

### Claude Desktop (SSE)

Edit `~/.config/Claude/claude_desktop_config.json` and add:

```json
{
  "mcpServers": {
    "faust": {
      "type": "sse",
      "url": "http://127.0.0.1:8000/sse"
    }
  }
}
```

### Generic MCP config (stdio)

If your MCP client reads a `servers.json` file, add a stdio server entry:

```json
{
  "servers": {
    "faust": {
      "command": "python3",
      "args": ["/Users/letz/Developpements/faust-mcp/faust_server.py"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "TMPDIR": "/Users/letz/Developpements/faust-mcp/tmp"
      }
    }
  }
}
```

## Troubleshooting

- If the compiler cannot create temp files, set `TMPDIR` to a writable location.
- Ensure the `tmp/` directory exists if you use `TMPDIR=./tmp` (create it once with `mkdir -p tmp`).
- If the server cannot bind to `127.0.0.1:8000`, either stop the process using
  that port or change `MCP_PORT` to another value.
