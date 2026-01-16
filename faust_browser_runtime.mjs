/**
 * Browser-only Faust runtime.
 *
 * Responsibilities:
 * - Compile Faust DSP with @grame/faustwasm in the browser.
 * - Create AudioContext + Faust AudioWorklet nodes.
 * - Expose tool methods matching the RT MCP server.
 * - Provide scope/spectrum metrics and MIDI input handling.
 */
import {
  extractBargraphProbes,
  extractBargraphUnits,
  extractMidiAndNvoices,
  extractParamsFromJson,
  wrapDSPCode,
} from './faust_dsp_utils.mjs';
import {
  applyAnalyserConfig,
  collectScopePayload,
  collectSpectrumPayload,
  computeAudioMetrics,
  normalizeAudioMetricsOptions,
} from './metrics_utils.mjs';

const MCP_SCHEMA_VERSION = 'faust-mcp-rt/1';

const DEFAULT_OPTIONS = {
  name: 'faust-browser',
  latency_hint: 'interactive',
  input_source: 'none',
  input_freq: null,
  input_file: null,
  hide_meters: false,
  faustModuleUrl: '/node_modules/@grame/faustwasm/dist/esm/index.js',
  faustWasmRoot: '/node_modules/@grame/faustwasm',
};

class ToolError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {object} [details]
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/**
 * Return the browser AudioContext class.
 * @returns {typeof AudioContext|undefined}
 */
function getAudioContextClass() {
  return window.AudioContext || window.webkitAudioContext;
}

/**
 * Normalize a relative URL to an absolute URL.
 * @param {string} pathOrUrl
 * @returns {string}
 */
function toAbsoluteUrl(pathOrUrl) {
  try {
    return new URL(pathOrUrl, window.location.origin).toString();
  } catch (_) {
    return pathOrUrl;
  }
}

/**
 * Join a base URL with a relative path.
 * @param {string} root
 * @param {string} path
 * @returns {string}
 */
function joinUrl(root, path) {
  const base = root.endsWith('/') ? root : `${root}/`;
  return new URL(path, base).toString();
}

/**
 * Convert a Uint8Array into a base64 string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64(bytes) {
  if (!bytes || !bytes.length) return '';
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/**
 * Convert a base64 string into a Uint8Array.
 * @param {string} base64
 * @returns {Uint8Array}
 */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Loader for Faust WASM + compiler classes in the browser.
 */
class FaustBrowserCompilerManager {
  /**
   * @param {object} options
   */
  constructor(options) {
    this.options = options;
    this.compiler = null;
    this.FaustCompiler = null;
    this.FaustMonoDspGenerator = null;
    this.FaustPolyDspGenerator = null;
    this.FaustSvgDiagrams = null;
  }

  /**
   * Lazy-load compiler and wasm bindings.
   * @returns {Promise<object>}
   */
  async ensureReady() {
    if (this.compiler) return this.compiler;
    const moduleUrl = toAbsoluteUrl(this.options.faustModuleUrl);
    const faustModule = await import(moduleUrl);
    const {
      instantiateFaustModule,
      instantiateFaustModuleFromFile,
      LibFaust,
      FaustCompiler,
      FaustMonoDspGenerator,
      FaustPolyDspGenerator,
      FaustSvgDiagrams,
    } = faustModule;

    const rootUrl = toAbsoluteUrl(this.options.faustWasmRoot);
    const jsUrl = joinUrl(rootUrl, 'libfaust-wasm/libfaust-wasm.js');
    const dataUrl = joinUrl(rootUrl, 'libfaust-wasm/libfaust-wasm.data');
    const wasmUrl = joinUrl(rootUrl, 'libfaust-wasm/libfaust-wasm.wasm');

    let wasmModule = null;
    if (typeof instantiateFaustModule === 'function') {
      wasmModule = await instantiateFaustModule(jsUrl, dataUrl, wasmUrl);
    } else if (typeof instantiateFaustModuleFromFile === 'function') {
      wasmModule = await instantiateFaustModuleFromFile(jsUrl, dataUrl, wasmUrl);
    } else {
      throw new Error('Faust WASM loader not available');
    }

    const libFaust = new LibFaust(wasmModule);
    this.FaustCompiler = FaustCompiler;
    this.FaustMonoDspGenerator = FaustMonoDspGenerator;
    this.FaustPolyDspGenerator = FaustPolyDspGenerator;
    this.FaustSvgDiagrams = FaustSvgDiagrams;
    this.compiler = new FaustCompiler(libFaust);
    return this.compiler;
  }

  /**
   * Create the mono DSP generator.
   * @returns {object}
   */
  createGenerator() {
    if (!this.FaustMonoDspGenerator) {
      throw new Error('Faust compiler not initialized');
    }
    return new this.FaustMonoDspGenerator();
  }

  /**
   * Create the poly generator for polyphonic DSPs.
   * @returns {object}
   */
  createPolyGenerator() {
    if (!this.FaustPolyDspGenerator) {
      throw new Error('Faust compiler not initialized');
    }
    return new this.FaustPolyDspGenerator();
  }

  /**
   * Create an SVG diagram generator bound to the compiler.
   * @returns {object}
   */
  createSvgDiagrams() {
    if (!this.FaustSvgDiagrams) {
      throw new Error('Faust SVG generator not available');
    }
    return new this.FaustSvgDiagrams(this.compiler);
  }

  /**
   * Validate DSP syntax without starting audio.
   * @param {{dsp_code: string, name?: string, args?: string}} params
   * @returns {Promise<object>}
   */
  async checkSyntax({ dsp_code, name, args }) {
    await this.ensureReady();
    if (!dsp_code) {
      return { status: 'error', error: 'Missing dsp_code' };
    }
    const dspName = name || 'faust-check';
    const compilerArgs = args || '-ftz 2';
    try {
      const factory = await this.compiler.createMonoDSPFactory(
        dspName,
        dsp_code,
        compilerArgs,
      );
      const json = factory?.json ? JSON.parse(factory.json) : null;
      return { status: 'ok', name: json?.name || dspName, json };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const detail = this.compiler?.getErrorMessage?.() || '';
      const error = detail && detail !== message ? `${message}\n${detail}` : message;
      return { status: 'error', error };
    }
  }
}

/**
 * Collect metering + analyser payloads.
 */
class MetricsCollector {
  /**
   * Initialize analyser state and caches.
   */
  constructor() {
    this.audioContext = null;
    this.faustNode = null;
    this.faustJson = null;
    this.outputParamsCache = null;
    this.meterUnitsByPath = null;
    this.meterProbesByPath = null;
    this.analyserNode = null;
    this.channelSplitter = null;
    this.channelAnalysers = [];
    this.analyserDefaults = {
      fft_size: Math.pow(2, 11),
      min_db: -96,
      max_db: 0,
      smoothing: 0.85,
    };
  }

  /**
   * Store bargraph caches for conversion to meters/probes.
   * @param {object} params
   */
  setMeterCaches({ outputParamsCache, meterUnitsByPath, meterProbesByPath }) {
    this.outputParamsCache = outputParamsCache;
    this.meterUnitsByPath = meterUnitsByPath;
    this.meterProbesByPath = meterProbesByPath;
  }

  /**
   * Attach analysers to the current audio graph.
   * @param {AudioContext} audioContext
   * @param {object} faustNode
   * @param {object} faustJson
   */
  attach(audioContext, faustNode, faustJson) {
    this.audioContext = audioContext;
    this.faustNode = faustNode;
    this.faustJson = faustJson;
    this.analyserNode = this.createAnalyserWithDefaults();
    this.faustNode.connect(this.analyserNode);
    this.analyserNode.connect(this.audioContext.destination);
  }

  /**
   * Disconnect analysers and clear state.
   */
  reset() {
    this.audioContext = null;
    this.faustNode = null;
    this.faustJson = null;
    this.outputParamsCache = null;
    this.meterUnitsByPath = null;
    this.meterProbesByPath = null;
    if (this.analyserNode) {
      try {
        this.analyserNode.disconnect();
      } catch (_) {}
    }
    if (this.channelSplitter) {
      try {
        this.channelSplitter.disconnect();
      } catch (_) {}
    }
    this.channelAnalysers.forEach((analyser) => {
      try {
        analyser.disconnect();
      } catch (_) {}
    });
    this.analyserNode = null;
    this.channelSplitter = null;
    this.channelAnalysers = [];
  }

  /**
   * Create a configured analyser node.
   * @returns {AnalyserNode}
   */
  createAnalyserWithDefaults() {
    const analyser = this.audioContext.createAnalyser();
    applyAnalyserConfig(analyser, this.analyserDefaults);
    return analyser;
  }

  /**
   * Apply analyser tuning options to all analysers.
   * @param {object} opts
   */
  syncAnalyserConfig(opts = {}) {
    if (this.analyserNode) {
      applyAnalyserConfig(this.analyserNode, opts);
    }
    this.channelAnalysers.forEach((analyser) => applyAnalyserConfig(analyser, opts));
    this.analyserDefaults = {
      fft_size: opts.fft_size ?? this.analyserDefaults.fft_size,
      min_db: opts.min_db ?? this.analyserDefaults.min_db,
      max_db: opts.max_db ?? this.analyserDefaults.max_db,
      smoothing: opts.smoothing ?? this.analyserDefaults.smoothing,
    };
  }

  /**
   * Lazily create per-channel analysers when requested.
   */
  ensureChannelAnalysers() {
    if (!this.audioContext || !this.faustNode || this.channelAnalysers.length > 0) return;
    const outputChannels = this.faustJson?.outputs ?? this.faustNode.numberOfOutputs ?? 0;
    const channelCount = Math.max(1, outputChannels);
    this.channelSplitter = this.audioContext.createChannelSplitter(channelCount);
    this.faustNode.connect(this.channelSplitter);
    this.channelAnalysers = Array.from({ length: channelCount }, () => {
      const analyser = this.createAnalyserWithDefaults();
      applyAnalyserConfig(analyser, this.analyserDefaults);
      return analyser;
    });
    this.channelAnalysers.forEach((analyser, idx) => {
      this.channelSplitter.connect(analyser, idx);
    });
  }

  /**
   * Return meter/scope/spectrum payloads.
   * @param {object} options
   * @returns {object}
   */
  getMetrics(options) {
    const {
      include_scope,
      include_spectrum,
      per_channel,
      fft_size,
      smoothing,
      min_db,
      max_db,
      edge_threshold,
      log_bins,
    } = normalizeAudioMetricsOptions(options);

    this.syncAnalyserConfig({
      fft_size,
      smoothing,
      min_db,
      max_db,
    });

    const metrics = computeAudioMetrics(
      this.outputParamsCache ?? {},
      this.meterUnitsByPath ?? {},
      this.meterProbesByPath ?? {},
    );

    if (include_scope && this.analyserNode) {
      metrics.scope = collectScopePayload(this.analyserNode, {
        edge_threshold,
        sample_rate: this.audioContext?.sampleRate ?? null,
      });
    }
    if (include_spectrum && this.analyserNode) {
      metrics.spectrum = collectSpectrumPayload(this.analyserNode, this.audioContext, {
        log_bins,
      });
    }

    if ((include_scope || include_spectrum) && per_channel) {
      this.ensureChannelAnalysers();
      if (this.channelAnalysers.length > 0) {
        if (include_scope && metrics.scope) {
          metrics.scope.channels = this.channelAnalysers.map((analyser, idx) => {
            return {
              index: idx,
              ...collectScopePayload(analyser, {
                edge_threshold,
                sample_rate: this.audioContext?.sampleRate ?? null,
              }),
            };
          });
        }
        if (include_spectrum && metrics.spectrum) {
          metrics.spectrum.channels = this.channelAnalysers.map((analyser, idx) => {
            return {
              index: idx,
              ...collectSpectrumPayload(analyser, this.audioContext, {
                log_bins,
              }),
            };
          });
        }
      }
    }

    return metrics;
  }
}

/**
 * Browser MIDI manager using Web MIDI API.
 */
class MidiManager {
  /**
   * @param {object} runtime
   */
  constructor(runtime) {
    this.runtime = runtime;
    this.midiAccess = null;
    this.inputs = [];
    this.selectedId = null;
    this.selectedName = null;
    this.lastMessage = null;
    this.activeNotes = new Set();
    this.lastError = null;
  }

  /**
   * Request Web MIDI access if needed.
   * @returns {Promise<boolean>}
   */
  async ensureAccess() {
    if (!navigator?.requestMIDIAccess) {
      this.lastError = 'Web MIDI not supported';
      return false;
    }
    if (this.midiAccess) return true;
    try {
      this.midiAccess = await navigator.requestMIDIAccess();
      this.refreshInputs();
      this.midiAccess.onstatechange = () => this.refreshInputs();
      return true;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /**
   * Refresh the cached list of MIDI inputs.
   */
  refreshInputs() {
    if (!this.midiAccess) return;
    const inputs = Array.from(this.midiAccess.inputs.values());
    this.inputs = inputs.map((input, index) => ({
      id: input.id,
      index,
      name: input.name || `Input ${index + 1}`,
      manufacturer: input.manufacturer || null,
    }));
  }

  /**
   * Return available MIDI input devices.
   * @returns {Promise<object>}
   */
  async listInputs() {
    const ok = await this.ensureAccess();
    if (!ok) {
      return { status: 'error', available: false, error: this.lastError, inputs: [] };
    }
    this.refreshInputs();
    const selectedIndex = this.selectedId
      ? this.inputs.findIndex((entry) => entry.id === this.selectedId)
      : -1;
    return {
      status: 'ok',
      available: true,
      inputs: this.inputs.map(({ index, name }) => ({ index, name })),
      selected: selectedIndex >= 0
        ? { index: selectedIndex, name: this.selectedName }
        : null,
    };
  }

  /**
   * Select a MIDI input by index or name.
   * @param {{index?: number, name?: string}} params
   * @returns {Promise<object>}
   */
  async selectInput({ index, name }) {
    const result = await this.listInputs();
    if (!result.available) return result;
    let selectedIndex = Number.isFinite(index) ? Number(index) : null;
    if (selectedIndex === null && name) {
      const match = result.inputs.find((input) => input.name === name);
      if (match) selectedIndex = match.index;
    }
    if (selectedIndex === null) {
      return { status: 'error', error: 'Missing MIDI input index or name' };
    }
    const selectedInfo = this.inputs[selectedIndex];
    if (!selectedInfo) {
      return { status: 'error', error: 'MIDI input not found' };
    }

    const input = Array.from(this.midiAccess.inputs.values())[selectedIndex];
    if (!input) {
      return { status: 'error', error: 'MIDI input not found' };
    }
    this.detachInput();
    input.onmidimessage = (event) => this.handleMessage(event);
    this.selectedId = input.id;
    this.selectedName = input.name || selectedInfo.name;
    return { status: 'ok', selected: { index: selectedIndex, name: this.selectedName } };
  }

  /**
   * Detach the current MIDI input listener.
   */
  detachInput() {
    if (!this.midiAccess || !this.selectedId) return;
    const input = this.midiAccess.inputs.get(this.selectedId);
    if (input) input.onmidimessage = null;
    this.selectedId = null;
    this.selectedName = null;
  }

  /**
   * Forward MIDI events to the Faust node and track activity.
   * @param {MIDIMessageEvent} event
   */
  handleMessage(event) {
    const data = event.data instanceof Uint8Array ? event.data : new Uint8Array(event.data);
    const status = data[0] ?? 0;
    const type = status & 0xf0;
    const channel = status & 0x0f;
    const note = data[1] ?? 0;
    const velocity = data[2] ?? 0;
    const noteKey = `${channel}:${note}`;
    if (type === 0x90 && velocity > 0) {
      this.activeNotes.add(noteKey);
    } else if (type === 0x80 || (type === 0x90 && velocity === 0)) {
      this.activeNotes.delete(noteKey);
    } else if (type === 0xb0 && (data[1] === 120 || data[1] === 123)) {
      for (const key of this.activeNotes) {
        if (key.startsWith(`${channel}:`)) {
          this.activeNotes.delete(key);
        }
      }
    }
    this.lastMessage = {
      data: Array.from(data),
      timestamp: Date.now(),
    };
    try {
      const node = this.runtime?.faust_node;
      if (node && typeof node.midiMessage === 'function') {
        node.midiMessage(data);
      }
    } catch (_) {}
  }

  /**
   * Return count of active notes (note-on without note-off).
   * @returns {number}
   */
  getActiveNoteCount() {
    return this.activeNotes.size;
  }

  /**
   * Return MIDI availability and last message state.
   * @returns {Promise<object>}
   */
  async getStatus() {
    const ok = await this.ensureAccess();
    if (!ok) {
      return {
        status: 'error',
        available: false,
        error: this.lastError,
        selected: null,
        last_message: this.lastMessage,
      };
    }
    const selectedIndex = this.selectedId
      ? this.inputs.findIndex((entry) => entry.id === this.selectedId)
      : -1;
    return {
      status: 'ok',
      available: true,
      selected: selectedIndex >= 0
        ? { index: selectedIndex, name: this.selectedName }
        : null,
      last_message: this.lastMessage,
    };
  }
}

export function createBrowserRuntime(options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const compilerManager = new FaustBrowserCompilerManager(config);
  const metricsCollector = new MetricsCollector();
  const midiManager = new MidiManager(null);

  const state = {
    status: 'idle',
    name: config.name,
    latency_hint: config.latency_hint,
    input_source: config.input_source,
    input_freq: config.input_freq,
    input_file: config.input_file,
    hide_meters: config.hide_meters,
    dsp_code: null,
    dsp_json: null,
    params: [],
    param_values: new Map(),
    audio_context: null,
    faust_node: null,
    output_params_cache: {},
    input_params_cache: {},
    meter_units_by_path: {},
    meter_probes_by_path: {},
    poly_nvoices: 0,
    midi_enabled: false,
    started: false,
    wasm_factory: null,
    wasm_effect_factory: null,
    svg_diagrams: null,
    svg_key: null,
    file_source_node: null,
    file_source_node_started: false,
    file_source_url: null,
  };

  midiManager.runtime = state;

  /**
   * Attach schema version to a response payload.
   * @param {object} payload
   * @returns {object}
   */
  function withSchema(payload) {
    return { schema_version: MCP_SCHEMA_VERSION, ...payload };
  }

  /**
   * Guard to ensure a DSP exists before invoking runtime controls.
   */
  function ensureRunning() {
    if (!state.faust_node) {
      throw new ToolError('no_dsp', 'No running DSP. Call compile_and_start first.');
    }
  }

  /**
   * Reset in-memory runtime state and analyser caches.
   */
  function resetState({ keepAudioContext = false } = {}) {
    if (!keepAudioContext) {
      state.audio_context = null;
    }
    state.faust_node = null;
    state.dsp_json = null;
    state.params = [];
    state.output_params_cache = {};
    state.input_params_cache = {};
    state.meter_units_by_path = {};
    state.meter_probes_by_path = {};
    state.poly_nvoices = 0;
    state.midi_enabled = false;
    state.started = false;
    state.wasm_factory = null;
    state.wasm_effect_factory = null;
    state.svg_diagrams = null;
    state.svg_key = null;
    state.file_source_node = null;
    state.file_source_node_started = false;
    state.file_source_url = null;
    metricsCollector.reset();
    metricsCollector.setMeterCaches({
      outputParamsCache: state.output_params_cache,
      meterUnitsByPath: state.meter_units_by_path,
      meterProbesByPath: state.meter_probes_by_path,
    });
  }

  /**
   * Initialize the Faust compiler runtime.
   * @returns {Promise<object>}
   */
  async function init() {
    await compilerManager.ensureReady();
    state.status = 'initialized';
    return { status: state.status };
  }

  /**
   * Run a syntax check on the provided DSP code.
   * @param {string} faust_code
   * @param {string} [name]
   * @returns {Promise<object>}
   */
  async function check_syntax(faust_code, name = 'faust-check') {
    return compilerManager.checkSyntax({ dsp_code: faust_code, name });
  }

  /**
   * Compile a DSP and return metadata without starting audio.
   */
  async function compile(
    faust_code,
    name = config.name,
    latency_hint = config.latency_hint,
    input_source = config.input_source,
    input_freq = config.input_freq,
    input_file = config.input_file,
    hide_meters = config.hide_meters,
  ) {
    return compileDSP({
      dsp_code: faust_code,
      name,
      latency_hint,
      input_source,
      input_freq,
      input_file,
      hide_meters,
    });
  }

  /**
   * Compile a DSP and start audio rendering.
   */
  async function compile_and_start(
    faust_code,
    name = config.name,
    latency_hint = config.latency_hint,
    input_source = config.input_source,
    input_freq = config.input_freq,
    input_file = config.input_file,
    hide_meters = config.hide_meters,
  ) {
    const compiled = await compileDSP({
      dsp_code: faust_code,
      name,
      latency_hint,
      input_source,
      input_freq,
      input_file,
      hide_meters,
    });
    await start();
    return compiled;
  }

  /**
   * Reset and stop the current graph before rebuilding.
   * @returns {Promise<void>}
   */
  async function prepareForNewGraph() {
    if (state.faust_node) {
      await stop();
      return;
    }
    resetState({ keepAudioContext: !!state.audio_context });
  }

  /**
   * Initialize the AudioContext for the runtime.
   * @param {string} latency_hint
   * @returns {string}
   */
  function initAudioContext(latency_hint) {
    const hint = latency_hint === 'playback' ? 'playback' : 'interactive';
    const AudioContextClass = getAudioContextClass();
    if (!AudioContextClass) {
      throw new ToolError('audio_context_missing', 'WebAudio is not available');
    }
    if (!state.audio_context || state.audio_context.state === 'closed') {
      state.audio_context = new AudioContextClass({ latencyHint: hint });
    }
    return hint;
  }

  /**
   * Create a Faust node for mono or poly graphs.
   * @param {object} params
   * @returns {Promise<object>}
   */
  async function createFaustNode({ wasmFactory, effectFactory, parsedJson, name }) {
    if (state.poly_nvoices > 0) {
      const polyGenerator = compilerManager.createPolyGenerator();
      const isDouble = parsedJson?.compile_options?.includes('-double');
      const { mixerModule } = await compilerManager.compiler.getAsyncInternalMixerModule(
        !!isDouble,
      );
      return polyGenerator.createNode(
        state.audio_context,
        state.poly_nvoices,
        name || parsedJson?.name || 'faust-browser',
        wasmFactory,
        mixerModule,
        effectFactory || undefined,
      );
    }
    const monoGenerator = compilerManager.createGenerator();
    return monoGenerator.createNode(
      state.audio_context,
      name || parsedJson?.name || 'faust-browser',
      wasmFactory,
    );
  }

  /**
   * Attach input/output param handlers to the Faust node.
   */
  function attachParamHandlers() {
    state.output_params_cache = {};
    state.input_params_cache = {};
    metricsCollector.setMeterCaches({
      outputParamsCache: state.output_params_cache,
      meterUnitsByPath: state.meter_units_by_path,
      meterProbesByPath: state.meter_probes_by_path,
    });

    if (typeof state.faust_node.setOutputParamHandler === 'function') {
      state.faust_node.setOutputParamHandler((path, value) => {
        state.output_params_cache[path] = value;
      });
    }

    if (typeof state.faust_node.setInputParamHandler === 'function') {
      state.faust_node.setInputParamHandler((path, value) => {
        state.input_params_cache[path] = value;
      });
    }
  }

  /**
   * Start the Faust node if supported.
   */
  function tryStartNode() {
    if (typeof state.faust_node.start === 'function') {
      try {
        state.faust_node.start();
      } catch (_) {}
    }
  }

  /**
   * Read Faust JSON from the node and handle fallbacks.
   * @param {object} params
   * @returns {object}
   */
  function resolveRuntimeJson({ fallback, allowFallback }) {
    try {
      const runtimeJson = state.faust_node.getJSON();
      if (runtimeJson) {
        return JSON.parse(runtimeJson);
      }
    } catch (err) {
      if (!allowFallback) {
        throw err;
      }
    }
    if (!allowFallback) {
      throw new Error('Failed to read Faust JSON from runtime');
    }
    return fallback;
  }

  /**
   * Populate caches and return a compiled response payload.
   * @param {object} params
   * @returns {object}
   */
  function finalizeRuntimeState({ hint, name, fallbackJson, allowFallback }) {
    const resolvedJson = resolveRuntimeJson({ fallback: fallbackJson, allowFallback });
    state.dsp_json = resolvedJson;
    state.name = state.dsp_json?.name || name || null;
    state.params = extractParamsFromJson(state.dsp_json);
    state.meter_units_by_path = extractBargraphUnits(state.dsp_json);
    state.meter_probes_by_path = extractBargraphProbes(state.dsp_json);
    metricsCollector.setMeterCaches({
      outputParamsCache: state.output_params_cache,
      meterUnitsByPath: state.meter_units_by_path,
      meterProbesByPath: state.meter_probes_by_path,
    });
    metricsCollector.attach(state.audio_context, state.faust_node, state.dsp_json);

    state.status = 'compiled';

    return buildRuntimeResponse({ hint, name });
  }

  /**
   * Build the standard compiled response payload.
   * @param {object} params
   * @returns {object}
   */
  function buildRuntimeResponse({ hint, name }) {
    return withSchema({
      status: 'compiled',
      name: state.name || name,
      latency_hint: hint,
      inputs: state.dsp_json?.inputs ?? null,
      outputs: state.dsp_json?.outputs ?? null,
      params: state.params,
      param_paths: getParamPaths(),
      faust_json: state.dsp_json,
    });
  }

  /**
   * Internal compile pipeline (shared by compile and compile_and_start).
   */
  async function compileDSP({
    dsp_code,
    name,
    latency_hint,
    input_source,
    input_freq,
    input_file,
    hide_meters,
  }) {
    await compilerManager.ensureReady();
    if (!dsp_code) {
      throw new ToolError('invalid_params', 'Missing dsp_code');
    }

    await prepareForNewGraph();
    const hint = initAudioContext(latency_hint);

    const monoGenerator = compilerManager.createGenerator();
    let wrapped = null;
    try {
      wrapped = wrapDSPCode(
        dsp_code,
        input_source,
        input_freq,
        input_file,
        hide_meters,
      );
    } catch (err) {
      throw new ToolError('wrap_failed', err instanceof Error ? err.message : String(err));
    }
    const compiledMono = await monoGenerator.compile(
      compilerManager.compiler,
      name,
      wrapped.code,
      '-ftz 2',
    );
    if (!compiledMono) {
      throw new ToolError('compile_failed', 'Faust compilation failed', { stage: 'mono' });
    }

    let metaJson = null;
    try {
      metaJson = JSON.parse(monoGenerator.factory?.json || '{}');
    } catch (_) {
      metaJson = null;
    }
    const { midiEnabled, nvoices } = extractMidiAndNvoices(metaJson?.meta);
    state.midi_enabled = midiEnabled;
    state.poly_nvoices = nvoices > 0 ? nvoices : 0;

    if (state.poly_nvoices > 0) {
      const polyGenerator = compilerManager.createPolyGenerator();
      const compiledPoly = await polyGenerator.compile(
        compilerManager.compiler,
        name,
        wrapped.code,
        '-ftz 2',
      );
      if (!compiledPoly) {
        throw new ToolError('compile_failed', 'Faust poly compilation failed', {
          stage: 'poly',
        });
      }
      state.wasm_factory = polyGenerator.voiceFactory || null;
      state.wasm_effect_factory = polyGenerator.effectFactory || null;
      state.faust_node = await createFaustNode({
        wasmFactory: state.wasm_factory,
        effectFactory: state.wasm_effect_factory,
        parsedJson: metaJson,
        name,
      });
    } else {
      state.wasm_factory = monoGenerator.factory || null;
      state.wasm_effect_factory = null;
      state.faust_node = await createFaustNode({
        wasmFactory: state.wasm_factory,
        effectFactory: null,
        parsedJson: metaJson,
        name,
      });
    }

    if (!state.faust_node) {
      throw new ToolError('node_create_failed', 'Failed to create Faust node');
    }

    attachParamHandlers();

    if (wrapped.useExternalInput && wrapped.inputFile) {
      const inputUrl = toAbsoluteUrl(wrapped.inputFile);
      try {
        const response = await fetch(inputUrl);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await state.audio_context.decodeAudioData(arrayBuffer);

        const source = state.audio_context.createBufferSource();
        source.buffer = audioBuffer;
        source.loop = true;
        source.connect(state.faust_node);

        state.file_source_node = source;
        state.file_source_node_started = false;
        state.file_source_url = inputUrl;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ToolError(
          'input_file_error',
          `Failed to load audio file: ${message}`,
          { input_file: wrapped.inputFile },
        );
      }
    }

    tryStartNode();

    state.dsp_code = dsp_code;

    return finalizeRuntimeState({
      hint,
      name,
      fallbackJson: null,
      allowFallback: false,
    });
  }

  /**
   * Start the AudioContext and DSP processing.
   */
  async function start() {
    ensureRunning();
    if (state.started) {
      return withSchema({ status: 'started', already_started: true });
    }
    if (state.audio_context?.state === 'suspended') {
      const resumePromise = state.audio_context.resume();
      const timeoutMs = 1500;
      const timeoutPromise = new Promise((_, reject) => {
        window.setTimeout(
          () => reject(new ToolError('needs_user_gesture', 'Audio unlock required')),
          timeoutMs,
        );
      });
      await Promise.race([resumePromise, timeoutPromise]);
    }
    if (state.file_source_node && !state.file_source_node_started) {
      try {
        state.file_source_node.start();
      } catch (_) {}
      state.file_source_node_started = true;
    }
    if (typeof state.faust_node?.start === 'function') {
      try {
        state.faust_node.start();
      } catch (_) {}
    }
    state.started = true;
    return withSchema({ status: 'started', name: state.name });
  }

  /**
   * Unlock the AudioContext without requiring a running DSP.
   */
  async function unlock_audio(latency_hint = config.latency_hint) {
    const hint = initAudioContext(latency_hint);
    if (state.audio_context?.state === 'suspended') {
      await state.audio_context.resume();
    }
    return withSchema({
      status: 'unlocked',
      latency_hint: hint,
      audio_state: state.audio_context?.state || 'unknown',
    });
  }

  /**
   * Stop audio and reset runtime state.
   */
  async function stop() {
    if (state.file_source_node) {
      try {
        state.file_source_node.stop();
      } catch (_) {}
      try {
        state.file_source_node.disconnect();
      } catch (_) {}
    }
    if (state.faust_node) {
      try {
        state.faust_node.stop();
      } catch (_) {}
    }
    if (state.audio_context) {
      try {
        await state.audio_context.close();
      } catch (_) {}
    }
    resetState();
    state.status = 'stopped';
    return withSchema({ status: 'stopped' });
  }

  /**
   * Return current parameter paths.
   * @returns {string[]}
   */
  function getParamPaths() {
    return state.faust_node?.getParams?.() ?? state.params.map((p) => p.path);
  }

  /**
   * Return runtime status for the MCP client.
   */
  async function get_status() {
    return {
      schema_version: MCP_SCHEMA_VERSION,
      running: !!state.faust_node,
      name: state.name,
      poly_nvoices: state.poly_nvoices,
      midi_enabled: state.midi_enabled,
      midi_active_notes: midiManager.getActiveNoteCount(),
    };
  }

  /**
   * Return the current Faust JSON description.
   */
  async function get_dsp_json() {
    ensureRunning();
    return withSchema({ status: 'ok', faust_json: state.dsp_json });
  }

  /**
   * Return the compiled WebAssembly module for the current DSP (base64).
   */
  async function save_wasm_module() {
    if (!state.wasm_factory) {
      throw new ToolError('no_dsp', 'No compiled DSP. Call compile or compile_and_start first.');
    }
    const wasmCode = state.wasm_factory.code;
    if (!wasmCode) {
      throw new ToolError('wasm_unavailable', 'WASM module is not available.');
    }
    let dspJson = state.dsp_json || null;
    if (state.wasm_factory?.json) {
      try {
        dspJson = JSON.parse(state.wasm_factory.json);
      } catch (_) {
        dspJson = state.dsp_json || null;
      }
    }
    const payload = {
      status: 'ok',
      poly: state.poly_nvoices > 0,
      sha_key: state.wasm_factory.shaKey || null,
      wasm_base64: bytesToBase64(wasmCode),
      bytes: wasmCode.length,
      dsp_json: dspJson,
    };
    if (state.wasm_effect_factory?.code) {
      let effectJson = state.wasm_effect_factory?.json ?? state.dsp_json?.effect ?? null;
      if (typeof effectJson === 'string') {
        try {
          effectJson = JSON.parse(effectJson);
        } catch (_) {}
      }
      payload.effect_sha_key = state.wasm_effect_factory.shaKey || null;
      payload.effect_wasm_base64 = bytesToBase64(state.wasm_effect_factory.code);
      payload.effect_bytes = state.wasm_effect_factory.code.length;
      payload.effect_dsp_json = effectJson;
    }
    return withSchema(payload);
  }

  /**
   * Load a pre-compiled WebAssembly module and create the DSP node.
   */
  async function load_wasm_module({
    wasm_base64,
    dsp_json,
    effect_wasm_base64,
    effect_dsp_json,
    name = state.name,
    latency_hint = state.latency_hint,
  } = {}) {
    await compilerManager.ensureReady();
    if (!wasm_base64) {
      throw new ToolError('invalid_params', 'Missing wasm_base64');
    }
    if (!dsp_json) {
      throw new ToolError('invalid_params', 'Missing dsp_json');
    }

    await prepareForNewGraph();

    const parsedJson = typeof dsp_json === 'string' ? JSON.parse(dsp_json) : dsp_json;
    const jsonStr = typeof dsp_json === 'string' ? dsp_json : JSON.stringify(dsp_json);
    const { midiEnabled, nvoices } = extractMidiAndNvoices(parsedJson?.meta);
    state.midi_enabled = midiEnabled;
    state.poly_nvoices = nvoices > 0 ? nvoices : 0;

    const hint = initAudioContext(latency_hint);

    const wasmBytes = base64ToBytes(wasm_base64);
    const wasmModule = await WebAssembly.compile(wasmBytes);
    const wasmFactory = {
      cfactory: 0,
      code: wasmBytes,
      module: wasmModule,
      json: jsonStr,
      poly: state.poly_nvoices > 0,
    };

    let effectFactory = null;
    if (effect_wasm_base64 && effect_dsp_json) {
      const effectJsonStr = typeof effect_dsp_json === 'string'
        ? effect_dsp_json
        : JSON.stringify(effect_dsp_json);
      const effectBytes = base64ToBytes(effect_wasm_base64);
      const effectModule = await WebAssembly.compile(effectBytes);
      effectFactory = {
        cfactory: 0,
        code: effectBytes,
        module: effectModule,
        json: effectJsonStr,
        poly: true,
      };
    }

    if (state.poly_nvoices > 0) {
      state.faust_node = await createFaustNode({
        wasmFactory,
        effectFactory,
        parsedJson,
        name,
      });
    } else {
      state.faust_node = await createFaustNode({
        wasmFactory,
        effectFactory: null,
        parsedJson,
        name,
      });
    }

    if (!state.faust_node) {
      throw new ToolError('node_create_failed', 'Failed to create Faust node');
    }

    state.wasm_factory = wasmFactory;
    state.wasm_effect_factory = effectFactory;

    attachParamHandlers();
    tryStartNode();

    return finalizeRuntimeState({
      hint,
      name,
      fallbackJson: parsedJson,
      allowFallback: true,
    });
  }

  /**
   * Return parameter descriptors and paths.
   */
  async function get_params() {
    ensureRunning();
    return withSchema({
      status: 'ok',
      params: state.params,
      param_paths: getParamPaths(),
    });
  }

  /**
   * Return the current value of a single parameter.
   */
  async function get_param(path) {
    ensureRunning();
    const current = Object.prototype.hasOwnProperty.call(state.input_params_cache, path)
      ? state.input_params_cache[path]
      : state.faust_node.getParamValue(path);
    return withSchema({ status: 'ok', path, value: current });
  }

  /**
   * Return current values for all parameters.
   */
  async function get_param_values() {
    ensureRunning();
    const paramPaths = getParamPaths();
    const values = paramPaths.map((path) => ({
      path,
      value: Object.prototype.hasOwnProperty.call(state.input_params_cache, path)
        ? state.input_params_cache[path]
        : state.faust_node.getParamValue(path),
    }));

    for (const [path, value] of Object.entries(state.output_params_cache)) {
      const existing = values.find((entry) => entry.path === path);
      if (existing) {
        existing.value = value;
      } else {
        values.push({ path, value });
      }
    }

    for (const [path, value] of Object.entries(state.input_params_cache)) {
      const existing = values.find((entry) => entry.path === path);
      if (existing) {
        existing.value = value;
      } else {
        values.push({ path, value });
      }
    }

    return withSchema({ status: 'ok', values });
  }

  /**
   * Set a single parameter value.
   */
  async function set_param(path, value) {
    ensureRunning();
    if (typeof path !== 'string') {
      throw new ToolError('invalid_params', 'path must be a string');
    }
    if (typeof value !== 'number') {
      throw new ToolError('invalid_params', 'value must be a number');
    }
    state.faust_node.setParamValue(path, value);
    const current = state.faust_node.getParamValue(path);
    return withSchema({ status: 'ok', path, value: current });
  }

  /**
   * Set multiple parameter values in a single call.
   */
  async function set_param_values(values) {
    ensureRunning();
    if (!Array.isArray(values)) {
      throw new ToolError('invalid_params', 'values must be an array');
    }
    const updated = [];
    for (const entry of values) {
      if (!entry || typeof entry.path !== 'string') {
        throw new ToolError('invalid_params', 'Each entry must include a path string');
      }
      if (typeof entry.value !== 'number') {
        throw new ToolError('invalid_params', 'Each entry must include a numeric value');
      }
      state.faust_node.setParamValue(entry.path, entry.value);
      updated.push({
        path: entry.path,
        value: state.faust_node.getParamValue(entry.path),
      });
    }
    return withSchema({ status: 'ok', values: updated });
  }

  /**
   * Return meters/scope/spectrum payloads.
   */
  async function get_audio_metrics(
    include_scope = true,
    include_spectrum = true,
    per_channel = false,
    fft_size = null,
    smoothing = null,
    min_db = null,
    max_db = null,
    edge_threshold = null,
    log_bins = null,
  ) {
    ensureRunning();
    return withSchema(
      metricsCollector.getMetrics({
        include_scope,
        include_spectrum,
        per_channel,
        fft_size,
        smoothing,
        min_db,
        max_db,
        edge_threshold,
        log_bins,
      }),
    );
  }

  /**
   * Generate or return cached SVG diagrams for the current DSP.
   * @param {string|null} [name]
   * @param {string|null} [args]
   */
  async function get_svg_diagrams(name = null, args = null) {
    if (!state.dsp_code) {
      throw new ToolError('no_dsp', 'No DSP available for SVG rendering');
    }
    await compilerManager.ensureReady();
    const svgName = name || state.name || 'faust-dsp';
    const svgArgs = args || '';
    const cacheKey = `${svgName}:${svgArgs}:${state.dsp_code}`;
    if (state.svg_diagrams && state.svg_key === cacheKey) {
      return withSchema({ status: 'ok', svgs: state.svg_diagrams });
    }
    const svgDiagrams = compilerManager.createSvgDiagrams();
    const svgs = svgDiagrams.from(svgName, state.dsp_code, svgArgs);
    state.svg_diagrams = svgs;
    state.svg_key = cacheKey;
    return withSchema({ status: 'ok', svgs });
  }

  /**
   * List MIDI inputs in the browser.
   */
  async function get_midi_inputs() {
    return midiManager.listInputs();
  }

  /**
   * Return MIDI status and last message info.
   */
  async function get_midi_status() {
    return midiManager.getStatus();
  }

  /**
   * Select a MIDI input device by index or name.
   */
  async function select_midi_input(index = null, name = null) {
    return midiManager.selectInput({ index, name });
  }

  return {
    init,
    check_syntax,
    compile,
    compile_and_start,
    load_wasm_module,
    start,
    unlock_audio,
    stop,
    get_status,
    get_dsp_json,
    save_wasm_module,
    get_params,
    get_param,
    get_param_values,
    set_param,
    set_param_values,
    get_audio_metrics,
    get_svg_diagrams,
    get_midi_inputs,
    get_midi_status,
    select_midi_input,
  };
}
