from mcp.server.fastmcp import FastMCP
import json
import math
import os
import importlib.metadata
import wave

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
FFT_SIZE = int(os.environ.get("DD_FFT_SIZE", "2048"))
FFT_HOP = int(os.environ.get("DD_FFT_HOP", str(max(1, FFT_SIZE // 2))))
ROLLOFF_RATIO = float(os.environ.get("DD_ROLLOFF", "0.85"))


def _wrap_test_inputs(faust_code, input_source, input_freq, input_file):
    """Wrap DSP code with a test input signal when requested."""
    source = (input_source or "none").strip().lower()
    if source == "none":
        return faust_code
    if source not in ("sine", "noise", "file"):
        raise ValueError(f"Unsupported input_source: {input_source}")

    extra_lines = []
    if source == "sine":
        freq = 1000.0 if input_freq is None else float(input_freq)
        signal = f'library("oscillators.lib").osc({freq:g})'
    elif source == "file":
        if not input_file:
            raise ValueError("input_file is required for input_source=file")
        escaped = str(input_file).replace("\\", "\\\\").replace("'", "\\'")
        extra_lines = [
            'mcp_so = library("soundfiles.lib");',
            f'mcp_sf = soundfile("sound[url:{{\'{escaped}\'}}]", 1);',
            "mcp_loop_test = mcp_so.loop(mcp_sf, 0);",
        ]
        signal = "mcp_loop_test"
    else:
        signal = 'library("noises.lib").noise'

    indented = "\n".join(
        f"  {line}" if line.strip() else line for line in faust_code.splitlines()
    )
    return "\n".join(
        [
            'import("stdfaust.lib");',
            "mcp_addTestInputs(FX, sig) = par(i, inputs(FX), sig) : FX;",
            *extra_lines,
            "mcp_dsp = environment {",
            indented,
            "};",
            f"process = mcp_addTestInputs(mcp_dsp.process, {signal});",
        ]
    )


def _create_faust_processor(engine, name, faust_code, sample_rate):
    """Create a Faust processor compatible with the current DawDreamer API."""
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
    """Load a single-node graph into the DawDreamer render engine."""
    graph = [(processor, [])]
    if hasattr(engine, "load_graph"):
        engine.load_graph(graph)
        return
    if hasattr(engine, "loadGraph"):
        engine.loadGraph(graph)
        return
    raise RuntimeError("No graph loader found in dawDreamer RenderEngine")


def _ascii_waveform(buffer, width=60):
    """Generate a compact ASCII waveform preview for a mono buffer."""
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


def _spectral_features(arr, sample_rate):
    """Compute spectral summary features for a mono signal buffer."""
    if np is None or arr is None:
        return {
            "spectral_centroid": None,
            "spectral_bandwidth": None,
            "spectral_rolloff": None,
            "spectral_flatness": None,
            "spectral_flux": None,
            "spectral_frame_size": FFT_SIZE,
            "spectral_hop_size": FFT_HOP,
            "spectral_rolloff_ratio": ROLLOFF_RATIO,
            "spectral_available": False,
        }

    if arr.size == 0:
        return {
            "spectral_centroid": None,
            "spectral_bandwidth": None,
            "spectral_rolloff": None,
            "spectral_flatness": None,
            "spectral_flux": None,
            "spectral_frame_size": FFT_SIZE,
            "spectral_hop_size": FFT_HOP,
            "spectral_rolloff_ratio": ROLLOFF_RATIO,
            "spectral_available": False,
        }

    frame_size = max(1, int(FFT_SIZE))
    hop_size = max(1, int(FFT_HOP))
    rolloff_ratio = float(ROLLOFF_RATIO)
    window = np.hanning(frame_size)
    freqs = np.fft.rfftfreq(frame_size, 1.0 / sample_rate)
    eps = 1e-12

    if arr.size < frame_size:
        pad = frame_size - arr.size
        arr = np.pad(arr, (0, pad))

    centroids = []
    bandwidths = []
    rolloffs = []
    flatnesses = []
    fluxes = []
    prev_mag = None

    for start in range(0, arr.size - frame_size + 1, hop_size):
        frame = arr[start : start + frame_size] * window
        mag = np.abs(np.fft.rfft(frame))
        mag_sum = float(np.sum(mag)) + eps

        centroid = float(np.sum(freqs * mag) / mag_sum)
        centroids.append(centroid)

        bandwidth = float(np.sqrt(np.sum(((freqs - centroid) ** 2) * mag) / mag_sum))
        bandwidths.append(bandwidth)

        cumsum = np.cumsum(mag)
        target = rolloff_ratio * mag_sum
        idx = int(np.searchsorted(cumsum, target))
        if idx >= len(freqs):
            idx = len(freqs) - 1
        rolloffs.append(float(freqs[idx]))

        flatness = float(np.exp(np.mean(np.log(mag + eps))) / (np.mean(mag) + eps))
        flatnesses.append(flatness)

        if prev_mag is not None:
            diff = mag - prev_mag
            flux = float(np.sum(np.maximum(diff, 0.0)) / (np.sum(prev_mag) + eps))
            fluxes.append(flux)
        prev_mag = mag

    return {
        "spectral_centroid": float(np.mean(centroids)) if centroids else 0.0,
        "spectral_bandwidth": float(np.mean(bandwidths)) if bandwidths else 0.0,
        "spectral_rolloff": float(np.mean(rolloffs)) if rolloffs else 0.0,
        "spectral_flatness": float(np.mean(flatnesses)) if flatnesses else 0.0,
        "spectral_flux": float(np.mean(fluxes)) if fluxes else 0.0,
        "spectral_frame_size": frame_size,
        "spectral_hop_size": hop_size,
        "spectral_rolloff_ratio": rolloff_ratio,
        "spectral_available": True,
    }


def _compute_features(buffer, sample_rate):
    """Compute time-domain and spectral features for a mono buffer."""
    if np is not None:
        arr = buffer if isinstance(buffer, np.ndarray) else np.asarray(buffer, dtype=float)
        if arr.size == 0:
            max_amp = 0.0
            rms = 0.0
            dc_offset = 0.0
            zcr = 0.0
            clipping_ratio = 0.0
        else:
            max_amp = float(np.max(np.abs(arr)))
            rms = float(np.sqrt(np.mean(np.square(arr))))
            dc_offset = float(np.mean(arr))
            sign = np.sign(arr)
            sign[sign == 0] = 1
            zcr = float(np.mean(sign[1:] != sign[:-1])) if arr.size > 1 else 0.0
            clipping_ratio = float(np.mean(np.abs(arr) >= 0.999))
        crest = float(max_amp / (rms + 1e-12)) if rms > 0.0 else 0.0
        features = {
            "dc_offset": dc_offset,
            "zero_crossing_rate": zcr,
            "crest_factor": crest,
            "clipping_ratio": clipping_ratio,
        }
        features.update(_spectral_features(arr, sample_rate))
        return features

    buf = list(buffer)
    if not buf:
        features = {
            "dc_offset": 0.0,
            "zero_crossing_rate": 0.0,
            "crest_factor": 0.0,
            "clipping_ratio": 0.0,
        }
        features.update(_spectral_features(None, sample_rate))
        return features

    max_amp = max(abs(v) for v in buf)
    rms = math.sqrt(sum(v * v for v in buf) / len(buf))
    dc_offset = sum(buf) / len(buf)
    zcr = sum(1 for i in range(1, len(buf)) if (buf[i - 1] >= 0) != (buf[i] >= 0)) / max(1, len(buf) - 1)
    clipping_ratio = sum(1 for v in buf if abs(v) >= 0.999) / len(buf)
    crest = max_amp / (rms + 1e-12) if rms > 0.0 else 0.0
    features = {
        "dc_offset": dc_offset,
        "zero_crossing_rate": zcr,
        "crest_factor": crest,
        "clipping_ratio": clipping_ratio,
    }
    features.update(_spectral_features(None, sample_rate))
    return features


def _load_wav_audio(path):
    """Load a WAV file into a channel-first numpy array."""
    if np is None:
        raise RuntimeError("numpy is required for input_source=file")

    with wave.open(path, "rb") as wf:
        channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        frames = wf.readframes(wf.getnframes())

    if sampwidth == 1:
        dtype = np.uint8
        data = np.frombuffer(frames, dtype=dtype).astype(np.float32)
        data = (data - 128.0) / 128.0
    elif sampwidth == 2:
        dtype = np.int16
        data = np.frombuffer(frames, dtype=dtype).astype(np.float32) / 32768.0
    elif sampwidth == 4:
        dtype = np.int32
        data = np.frombuffer(frames, dtype=dtype).astype(np.float32) / 2147483648.0
    else:
        raise RuntimeError(f"Unsupported WAV sample width: {sampwidth}")

    if channels > 1:
        data = data.reshape(-1, channels).T
    else:
        data = data.reshape(1, -1)
    return data


def _metrics_from_buffer(buffer):
    """Compute max amplitude, RMS, silence flag, and ASCII waveform."""
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
    """Normalize audio buffers to a list of per-channel arrays."""
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
def compile_and_analyze(
    faust_code: str,
    input_source: str = "none",
    input_freq: float | None = None,
    input_file: str | None = None,
) -> str:
    """
    Compile Faust code with DawDreamer, render offline audio, and analyze signal.
    Returns global and per-channel metrics as JSON.

    input_source: "none" (default), "sine", "noise", or "file". When set, the
    DSP is wrapped with test inputs (sine uses input_freq, file uses input_file).
    """

    if dd is None:
        return "Error: dawDreamer is not installed. See README for install instructions."

    try:
        engine = dd.RenderEngine(SAMPLE_RATE, BLOCK_SIZE)
        wrapped_code = _wrap_test_inputs(faust_code, input_source, input_freq, input_file)
        if input_source == "file":
            if not input_file:
                raise RuntimeError("input_file is required for input_source=file")
            if str(input_file).startswith(("http://", "https://")):
                raise RuntimeError(
                    "DawDreamer requires a local file path for input_source=file."
                )
            audio = _load_wav_audio(input_file)
            if hasattr(engine, "make_faust_processor"):
                processor = engine.make_faust_processor("faust")
                if not processor.set_dsp_string(wrapped_code):
                    raise RuntimeError("Failed to set Faust DSP string")
                processor.set_soundfiles({"sound": [audio]})
                if not processor.compile():
                    raise RuntimeError("Failed to compile Faust DSP")
            elif hasattr(engine, "makeFaustProcessor"):
                processor = engine.makeFaustProcessor("faust")
                if not processor.set_dsp_string(wrapped_code):
                    raise RuntimeError("Failed to set Faust DSP string")
                processor.set_soundfiles({"sound": [audio]})
                if not processor.compile():
                    raise RuntimeError("Failed to compile Faust DSP")
            else:
                raise RuntimeError("No Faust processor factory found in dawDreamer")
        else:
            processor = _create_faust_processor(engine, "faust", wrapped_code, SAMPLE_RATE)
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
        global_features = _compute_features(mono, SAMPLE_RATE)

        channel_results = []
        for idx, cbuf in enumerate(channels):
            cmax, crms, csilent, cwf = _metrics_from_buffer(cbuf)
            cfeatures = _compute_features(cbuf, SAMPLE_RATE)
            channel_results.append(
                {
                    "index": idx,
                    "max_amplitude": cmax,
                    "rms": crms,
                    "is_silent": csilent,
                    "waveform_ascii": cwf,
                    "features": cfeatures,
                }
            )

        data = {
            "status": "success",
            "max_amplitude": max_amp,
            "rms": rms,
            "is_silent": is_silent,
            "waveform_ascii": waveform,
            "num_outputs": len(channels),
            "features": global_features,
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
