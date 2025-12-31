from mcp.server.fastmcp import FastMCP
import json
import math
import os
import importlib.metadata

try:
    import dawDreamer as dd
except ImportError:  # pragma: no cover
    try:
        import dawdreamer as dd
    except ImportError:  # pragma: no cover
        dd = None

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None

# Server initialization
MCP_HOST = os.environ.get("MCP_HOST", "127.0.0.1")
MCP_PORT = int(os.environ.get("MCP_PORT", "8000"))
mcp = FastMCP("Faust-DSP-Runner-DawDreamer", host=MCP_HOST, port=MCP_PORT)

SAMPLE_RATE = int(os.environ.get("DD_SAMPLE_RATE", "44100"))
BLOCK_SIZE = int(os.environ.get("DD_BLOCK_SIZE", "256"))
RENDER_SECONDS = float(os.environ.get("DD_RENDER_SECONDS", "2.0"))


def _create_faust_processor(engine, name, faust_code, sample_rate):
    if dd is None:
        raise RuntimeError("dawDreamer is not installed")

    if hasattr(engine, "make_faust_processor"):
        processor = engine.make_faust_processor(name)
        if not processor.set_dsp_string(faust_code):
            raise RuntimeError("Failed to set Faust DSP string")
        if not processor.compile():
            raise RuntimeError("Failed to compile Faust DSP")
        return processor

    if hasattr(engine, "makeFaustProcessor"):
        processor = engine.makeFaustProcessor(name)
        if not processor.set_dsp_string(faust_code):
            raise RuntimeError("Failed to set Faust DSP string")
        if not processor.compile():
            raise RuntimeError("Failed to compile Faust DSP")
        return processor

    if hasattr(dd, "make_faust_processor"):
        processor = dd.make_faust_processor(name, faust_code, sample_rate)
        return processor

    if hasattr(dd, "makeFaustProcessor"):
        processor = dd.makeFaustProcessor(name, faust_code, sample_rate)
        return processor

    raise RuntimeError("No Faust processor factory found in dawDreamer")


def _load_graph(engine, processor):
    graph = [(processor, [])]
    if hasattr(engine, "load_graph"):
        engine.load_graph(graph)
        return
    if hasattr(engine, "loadGraph"):
        engine.loadGraph(graph)
        return
    raise RuntimeError("No graph loader found in dawDreamer RenderEngine")


def _ascii_waveform(buffer, width=60):
    if buffer is None:
        return ""
    if np is not None and isinstance(buffer, np.ndarray):
        buf = buffer.tolist()
    else:
        buf = list(buffer)

    if not buf:
        return ""

    step = max(1, int(len(buf) / width))
    out = []
    for i in range(width):
        start = i * step
        chunk = buf[start : start + step]
        if not chunk:
            out.append("_")
            continue
        max_val = max(chunk)
        min_val = min(chunk)
        if max_val < 0.01 and min_val > -0.01:
            out.append("_")
        elif max_val > 0.5:
            out.append("#")
        elif max_val > 0.2:
            out.append("=")
        else:
            out.append("-")
    return "".join(out)


def _metrics_from_buffer(buffer):
    if np is not None and isinstance(buffer, np.ndarray):
        max_amp = float(np.max(np.abs(buffer))) if buffer.size else 0.0
        rms = float(np.sqrt(np.mean(np.square(buffer)))) if buffer.size else 0.0
    else:
        buf = list(buffer)
        if not buf:
            return 0.0, 0.0, True, ""
        max_amp = max(abs(v) for v in buf)
        rms = math.sqrt(sum(v * v for v in buf) / len(buf))

    is_silent = max_amp < 0.0001
    waveform = _ascii_waveform(buffer)
    return max_amp, rms, is_silent, waveform


def _to_channels(audio):
    if audio is None:
        return []
    if np is not None and isinstance(audio, np.ndarray):
        if audio.ndim == 1:
            return [audio]
        if audio.ndim == 2:
            return [audio[i, :] for i in range(audio.shape[0])]
    if isinstance(audio, list):
        if not audio:
            return []
        if isinstance(audio[0], list):
            return [row for row in audio]
        return [audio]
    return []


@mcp.tool()
def compile_and_analyze(faust_code: str) -> str:
    """
    Compile Faust code with DawDreamer, render offline audio, and analyze signal.
    Returns global and per-channel metrics as JSON.
    """

    if dd is None:
        return "Error: dawDreamer is not installed. See README for install instructions."

    try:
        engine = dd.RenderEngine(SAMPLE_RATE, BLOCK_SIZE)
        processor = _create_faust_processor(engine, "faust", faust_code, SAMPLE_RATE)
        _load_graph(engine, processor)
        engine.render(RENDER_SECONDS)
        audio = engine.get_audio()

        channels = _to_channels(audio)
        if channels:
            if np is not None and all(isinstance(c, np.ndarray) for c in channels):
                mono = np.mean(np.vstack(channels), axis=0)
            else:
                length = min(len(c) for c in channels)
                mono = [sum(c[i] for c in channels) / len(channels) for i in range(length)]
        else:
            mono = []

        max_amp, rms, is_silent, waveform = _metrics_from_buffer(mono)

        channel_results = []
        for idx, cbuf in enumerate(channels):
            cmax, crms, csilent, cwf = _metrics_from_buffer(cbuf)
            channel_results.append(
                {
                    "index": idx,
                    "max_amplitude": cmax,
                    "rms": crms,
                    "is_silent": csilent,
                    "waveform_ascii": cwf,
                }
            )

        data = {
            "status": "success",
            "max_amplitude": max_amp,
            "rms": rms,
            "is_silent": is_silent,
            "waveform_ascii": waveform,
            "channels": channel_results,
            "dawdreamer": {
                "version": getattr(dd, "__version__", None)
                or importlib.metadata.version("dawdreamer"),
                "sample_rate": SAMPLE_RATE,
                "block_size": BLOCK_SIZE,
                "render_seconds": RENDER_SECONDS,
                "num_channels": len(channels),
            },
        }

        return json.dumps(data, indent=2)
    except Exception as e:
        return f"System Error: {str(e)}"


if __name__ == "__main__":
    transport = os.environ.get("MCP_TRANSPORT", "sse")
    mount_path = os.environ.get("MCP_MOUNT_PATH")
    mcp.run(transport=transport, mount_path=mount_path)
