/**
 * Faust real-time worker for node-web-audio-api.
 *
 * Responsibilities:
 * - Create an AudioContext + AudioWorkletNode (node-web-audio-api).
 * - Compile Faust DSP from code using @grame/faustwasm.
 * - Start playback and expose parameter metadata + JSON.
 * - Accept JSON-over-stdin requests and reply with JSON results.
 *
 * Request/response format:
 *   { "id": 1, "method": "compile_and_start", "params": {...} }
 *   { "id": 1, "result": {...} } or { "id": 1, "error": "..." }
 */

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { Blob } from 'node:buffer';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import {
  extractBargraphProbes,
  extractBargraphUnits,
  extractMidiAndNvoices,
  extractParamsFromJson,
  wrapTestInputs,
} from './faust_dsp_utils.mjs';
import {
  applyAnalyserConfig,
  collectScopePayload,
  collectSpectrumPayload,
  computeAudioMetrics,
  normalizeAudioMetricsOptions,
} from './metrics_utils.mjs';
import { WebSocketMetricsServer } from './ws_metrics_server.mjs';

const MCP_SCHEMA_VERSION = 'faust-mcp-rt/1';

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
 * Immutable startup context (paths + env-configured settings).
 */
class WorkerContext {
  /**
   * @param {NodeJS.ProcessEnv} env
   */
  constructor(env = process.env) {
    const initialCwd = process.cwd();
    this.mcpRoot = env.FAUST_MCP_ROOT || initialCwd;
    this.webAudioRoot = env.WEBAUDIO_ROOT || 'external/node-web-audio-api';
    this.uiPort = Number(env.FAUST_UI_PORT || 0);
    this.uiRoot = env.FAUST_UI_ROOT || '';
    this.midiDebug = String(env.FAUST_MIDI_DEBUG || '').toLowerCase() === '1'
      || String(env.FAUST_MIDI_DEBUG || '').toLowerCase() === 'true';

    if (!globalThis.Blob) {
      globalThis.Blob = Blob;
    }

    // Ensure native bindings are resolved relative to the node-web-audio-api checkout.
    // The native .node bindings are loaded by CJS and expect process.cwd() to match.
    try {
      process.chdir(this.webAudioRoot);
    } catch (err) {
      throw new Error(`Failed to chdir to WEBAUDIO_ROOT: ${this.webAudioRoot} (${err})`);
    }

    // Resolve all paths after chdir so relative roots work from anywhere.
    this.resolvedRoot = path.resolve(process.cwd());
    this.webAudioIndex = pathToFileURL(path.join(this.resolvedRoot, 'index.mjs')).href;
    this.faustModuleEntry = pathToFileURL(
      path.join(this.resolvedRoot, 'node_modules/@grame/faustwasm/dist/esm/index.js'),
    ).href;
    this.faustWasmRoot = path.join(this.resolvedRoot, 'node_modules/@grame/faustwasm');
  }
}

/**
 * Lazy loader for the Faust compiler + WebAudio classes.
 */
class FaustCompilerManager {
  /**
   * @param {WorkerContext} context
   */
  constructor(context) {
    this.context = context;
    this.compiler = null;
    this.AudioContext = null;
    this.AudioWorkletNode = null;
    this.FaustMonoDspGenerator = null;
    this.FaustPolyDspGenerator = null;
  }

  /**
   * Load compiler + WebAudio classes once and cache them.
   * @returns {Promise<object>}
   */
  async ensureReady() {
    if (this.compiler) return this.compiler;
    ({ AudioContext: this.AudioContext, AudioWorkletNode: this.AudioWorkletNode } =
      await import(this.context.webAudioIndex));
    if (typeof globalThis.AudioWorkletNode === 'undefined') {
      globalThis.AudioWorkletNode = this.AudioWorkletNode;
    }

    const {
      instantiateFaustModuleFromFile,
      LibFaust,
      FaustCompiler,
      FaustMonoDspGenerator,
      FaustPolyDspGenerator,
    } = await import(this.context.faustModuleEntry);

    this.FaustMonoDspGenerator = FaustMonoDspGenerator;
    this.FaustPolyDspGenerator = FaustPolyDspGenerator;

    const faustModule = await instantiateFaustModuleFromFile(
      path.join(this.context.faustWasmRoot, 'libfaust-wasm/libfaust-wasm.js'),
      path.join(this.context.faustWasmRoot, 'libfaust-wasm/libfaust-wasm.data'),
      path.join(this.context.faustWasmRoot, 'libfaust-wasm/libfaust-wasm.wasm'),
    );

    const libFaust = new LibFaust(faustModule);
    this.compiler = new FaustCompiler(libFaust);
    return this.compiler;
  }

  /**
   * Create a Faust DSP generator for the current compiler.
   * @returns {object}
   */
  createGenerator() {
    if (!this.FaustMonoDspGenerator) {
      throw new Error('Faust compiler is not initialized yet');
    }
    return new this.FaustMonoDspGenerator();
  }

  /**
   * Create a Faust polyphonic DSP generator for the current compiler.
   * @returns {object}
   */
  createPolyGenerator() {
    if (!this.FaustPolyDspGenerator) {
      throw new Error('Faust compiler is not initialized yet');
    }
    return new this.FaustPolyDspGenerator();
  }

  /**
   * Compile DSP code to validate syntax without starting audio.
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
 * Collects bargraph metrics plus optional scope/spectrum payloads.
 */
class MetricsCollector {
  /**
   * Initialize analyser state + caches.
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
   * Bind bargraph caches for metrics conversion.
   * @param {object} params
   */
  setMeterCaches({ outputParamsCache, meterUnitsByPath, meterProbesByPath }) {
    this.outputParamsCache = outputParamsCache;
    this.meterUnitsByPath = meterUnitsByPath;
    this.meterProbesByPath = meterProbesByPath;
  }

  /**
   * Attach to the current audio graph and JSON metadata.
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
   * Disconnect analysers and clear cached references.
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
   * Apply analyser settings to all active analysers.
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
   * Create per-channel analysers when needed.
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
   * Collect meters plus optional scope/spectrum payloads.
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
 * Owns DSP lifecycle and runtime state for a single active graph.
 */
class WorkerRuntime {
  /**
   * @param {{compilerManager: FaustCompilerManager}} params
   */
  constructor({ compilerManager }) {
    this.compilerManager = compilerManager;
    this.metricsCollector = new MetricsCollector();
    this.resetState();
  }

  /**
   * Reset runtime state and clear cached metering data.
   */
  resetState() {
    this.audioContext = null;
    this.faustNode = null;
    this.faustJson = null;
    this.paramsCache = [];
    this.inputParamsCache = {};
    this.outputParamsCache = {};
    this.meterUnitsByPath = {};
    this.meterProbesByPath = {};
    this.wasmFactory = null;
    this.wasmEffectFactory = null;
    this.polyNvoices = 0;
    this.midiEnabled = false;
    this.dspName = null;
    this.fileSourceNode = null;
    this.started = false;
    this.fileSourceNodeStarted = false;
    this.metricsCollector.reset();
    this.metricsCollector.setMeterCaches({
      outputParamsCache: this.outputParamsCache,
      meterUnitsByPath: this.meterUnitsByPath,
      meterProbesByPath: this.meterProbesByPath,
    });
  }

  /**
   * Guard to ensure a DSP is running before control operations.
   */
  ensureRunning() {
    if (!this.faustNode) {
      throw new ToolError(
        'no_dsp',
        'No running DSP. Call compile_and_start first.',
      );
    }
  }

  /**
   * Attach the MCP schema version to a response payload.
   * @param {object} payload
   * @returns {object}
   */
  withSchema(payload) {
    return { schema_version: MCP_SCHEMA_VERSION, ...payload };
  }

  /**
   * Return parameter paths for the current DSP.
   * @returns {string[]}
   */
  getParamPaths() {
    return this.faustNode.getParams?.() ?? this.paramsCache.map((p) => p.path);
  }

  /**
   * Compile DSP code and start audio rendering.
   * @param {object} params
   * @returns {Promise<object>}
   */
  async compileDSP({
    dsp_code,
    name,
    latency_hint,
    input_source,
    input_freq,
    input_file,
    hide_meters,
  }) {
    await this.compilerManager.ensureReady();

    if (this.audioContext) {
      await this.stop();
    }
    this.started = false;
    this.paramsCache = [];
    this.meterUnitsByPath = {};
    this.meterProbesByPath = {};
    this.faustJson = null;
    this.dspName = null;
    this.wasmFactory = null;
    this.wasmEffectFactory = null;
    this.polyNvoices = 0;
    this.midiEnabled = false;

    const hint = latency_hint === 'playback' ? 'playback' : 'interactive';
    const AudioContext = this.compilerManager.AudioContext;
    this.audioContext = new AudioContext({ latencyHint: hint });

    const monoGenerator = this.compilerManager.createGenerator();
    const wrapped = wrapTestInputs(
      dsp_code,
      input_source,
      input_freq,
      input_file,
      hide_meters,
    );
    const compiledMono = await monoGenerator.compile(
      this.compilerManager.compiler,
      name,
      wrapped.code,
      '-ftz 2',
    );
    if (!compiledMono) {
      throw new ToolError('compile_failed', 'Faust compilation failed', {
        stage: 'mono',
      });
    }

    let metaJson = null;
    try {
      metaJson = JSON.parse(monoGenerator.factory?.json || '{}');
    } catch (_) {
      metaJson = null;
    }
    const { midiEnabled, nvoices } = extractMidiAndNvoices(metaJson?.meta);
    this.midiEnabled = midiEnabled;
    this.polyNvoices = nvoices > 0 ? nvoices : 0;

    if (this.polyNvoices > 0) {
      const polyGenerator = this.compilerManager.createPolyGenerator();
      const compiledPoly = await polyGenerator.compile(
        this.compilerManager.compiler,
        name,
        wrapped.code,
        '-ftz 2',
      );
      if (!compiledPoly) {
        throw new ToolError('compile_failed', 'Faust poly compilation failed', {
          stage: 'poly',
        });
      }
      this.wasmFactory = polyGenerator.voiceFactory || null;
      this.wasmEffectFactory = polyGenerator.effectFactory || null;
      this.faustNode = await polyGenerator.createNode(
        this.audioContext,
        this.polyNvoices,
        name,
      );
    } else {
      this.wasmFactory = monoGenerator.factory || null;
      this.wasmEffectFactory = null;
      this.faustNode = await monoGenerator.createNode(this.audioContext);
    }

    if (!this.faustNode) {
      throw new ToolError('node_create_failed', 'Failed to create Faust node');
    }

    // Register handler for output parameters (bargraphs).
    this.outputParamsCache = {};
    this.inputParamsCache = {};
    this.metricsCollector.setMeterCaches({
      outputParamsCache: this.outputParamsCache,
      meterUnitsByPath: this.meterUnitsByPath,
      meterProbesByPath: this.meterProbesByPath,
    });
    if (typeof this.faustNode.setOutputParamHandler === 'function') {
      this.faustNode.setOutputParamHandler((path, value) => {
        this.outputParamsCache[path] = value;
      });
    }

    if (typeof this.faustNode.setInputParamHandler === 'function') {
      this.faustNode.setInputParamHandler((path, value) => {
        this.inputParamsCache[path] = value;
      });
    }

    // Handle file input: load audio file and connect to FAUST input.
    if (wrapped.useExternalInput && wrapped.inputFile) {
      try {
        const fileBuffer = fs.readFileSync(wrapped.inputFile);
        const arrayBuffer = fileBuffer.buffer.slice(
          fileBuffer.byteOffset,
          fileBuffer.byteOffset + fileBuffer.byteLength,
        );

        const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

        this.fileSourceNode = this.audioContext.createBufferSource();
        this.fileSourceNode.buffer = audioBuffer;
        this.fileSourceNode.loop = true;

        this.fileSourceNode.connect(this.faustNode);
        this.fileSourceNodeStarted = false;

        console.error(
          `Loaded audio file: ${wrapped.inputFile} ` +
          `(${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.sampleRate}Hz)`,
        );
      } catch (err) {
        throw new ToolError(
          'input_file_error',
          `Failed to load audio file: ${err.message}`,
          { input_file: wrapped.inputFile },
        );
      }
    }

    this.faustNode.start();

    const jsonStr = this.faustNode.getJSON();
    this.faustJson = JSON.parse(jsonStr);
    this.dspName = this.faustJson?.name || name || null;
    this.paramsCache = extractParamsFromJson(this.faustJson);
    this.meterUnitsByPath = extractBargraphUnits(this.faustJson);
    this.meterProbesByPath = extractBargraphProbes(this.faustJson);
    this.metricsCollector.setMeterCaches({
      outputParamsCache: this.outputParamsCache,
      meterUnitsByPath: this.meterUnitsByPath,
      meterProbesByPath: this.meterProbesByPath,
    });
    this.metricsCollector.attach(this.audioContext, this.faustNode, this.faustJson);

    return this.withSchema({
      status: 'compiled',
      name,
      latency_hint: hint,
      inputs: this.faustJson.inputs ?? null,
      outputs: this.faustJson.outputs ?? null,
      params: this.paramsCache,
      param_paths: this.getParamPaths(),
      faust_json: this.faustJson,
    });
  }

  /**
   * Start audio rendering for the compiled DSP.
   * @returns {Promise<object>}
   */
  async startDSP() {
    this.ensureRunning();
    if (this.started) {
      return this.withSchema({ status: 'started', already_started: true });
    }
    if (this.fileSourceNode && !this.fileSourceNodeStarted) {
      try {
        this.fileSourceNode.start();
      } catch (_) {}
      this.fileSourceNodeStarted = true;
    }
    this.faustNode.start();
    this.started = true;
    return this.withSchema({ status: 'started', name: this.dspName });
  }

  /**
   * Compile DSP code and start audio rendering.
   * @param {object} params
   * @returns {Promise<object>}
   */
  async compileAndStart(params) {
    const compiled = await this.compileDSP(params);
    await this.startDSP();
    return compiled;
  }

  /**
   * Stop playback and reset the DSP state.
   * @returns {Promise<object>}
   */
  async stop() {
    if (this.fileSourceNode) {
      try {
        this.fileSourceNode.stop();
      } catch (_) {}
      this.fileSourceNode = null;
    }
    if (this.faustNode) {
      try {
        this.faustNode.stop();
      } catch (_) {}
    }
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch (_) {}
    }
    this.resetState();
    return this.withSchema({ status: 'stopped' });
  }

  /**
   * Return RMS/Peak metering plus optional scope/spectrum payloads.
   * @param {object} options
   * @returns {object}
   */
  getAudioMetrics(options) {
    this.ensureRunning();
    return this.withSchema(this.metricsCollector.getMetrics(options));
  }

  /**
   * Return the compiled WebAssembly module for the current DSP (base64).
   * @returns {object}
   */
  saveWasmModule() {
    if (!this.wasmFactory) {
      throw new ToolError(
        'no_dsp',
        'No compiled DSP. Call compile or compile_and_start first.',
      );
    }
    const wasmCode = this.wasmFactory.code;
    if (!wasmCode) {
      throw new ToolError('wasm_unavailable', 'WASM module is not available.');
    }
    let dspJson = this.faustJson || null;
    if (this.wasmFactory?.json) {
      try {
        dspJson = JSON.parse(this.wasmFactory.json);
      } catch (_) {
        dspJson = this.faustJson || null;
      }
    }
    const payload = {
      status: 'ok',
      poly: this.polyNvoices > 0,
      sha_key: this.wasmFactory.shaKey || null,
      wasm_base64: Buffer.from(wasmCode).toString('base64'),
      bytes: wasmCode.length,
      dsp_json: dspJson,
    };
    if (this.wasmEffectFactory?.code) {
      let effectJson = this.wasmEffectFactory?.json ?? this.faustJson?.effect ?? null;
      if (typeof effectJson === 'string') {
        try {
          effectJson = JSON.parse(effectJson);
        } catch (_) {}
      }
      payload.effect_sha_key = this.wasmEffectFactory.shaKey || null;
      payload.effect_wasm_base64 = Buffer.from(this.wasmEffectFactory.code).toString('base64');
      payload.effect_bytes = this.wasmEffectFactory.code.length;
      payload.effect_dsp_json = effectJson;
    }
    return this.withSchema(payload);
  }

  /**
   * Load a pre-compiled WebAssembly module and create the DSP node.
   * @param {object} params
   * @returns {Promise<object>}
   */
  async loadWasmModule({
    wasm_base64,
    dsp_json,
    effect_wasm_base64,
    effect_dsp_json,
    name,
    latency_hint,
  }) {
    await this.compilerManager.ensureReady();
    if (!wasm_base64) {
      throw new ToolError('invalid_params', 'Missing wasm_base64');
    }
    if (!dsp_json) {
      throw new ToolError('invalid_params', 'Missing dsp_json');
    }

    if (this.audioContext) {
      await this.stop();
    }
    this.started = false;
    this.paramsCache = [];
    this.meterUnitsByPath = {};
    this.meterProbesByPath = {};
    this.faustJson = null;
    this.dspName = null;
    this.wasmFactory = null;
    this.wasmEffectFactory = null;
    this.polyNvoices = 0;
    this.midiEnabled = false;

    const parsedJson = typeof dsp_json === 'string' ? JSON.parse(dsp_json) : dsp_json;
    const jsonStr = typeof dsp_json === 'string' ? dsp_json : JSON.stringify(dsp_json);
    const { midiEnabled, nvoices } = extractMidiAndNvoices(parsedJson?.meta);
    this.midiEnabled = midiEnabled;
    this.polyNvoices = nvoices > 0 ? nvoices : 0;

    const hint = latency_hint === 'playback' ? 'playback' : 'interactive';
    const AudioContext = this.compilerManager.AudioContext;
    this.audioContext = new AudioContext({ latencyHint: hint });

    const wasmBytes = Buffer.from(wasm_base64, 'base64');
    const wasmModule = await WebAssembly.compile(wasmBytes);
    const wasmFactory = {
      cfactory: 0,
      code: new Uint8Array(wasmBytes),
      module: wasmModule,
      json: jsonStr,
      poly: this.polyNvoices > 0,
    };

    let effectFactory = null;
    if (effect_wasm_base64 && effect_dsp_json) {
      const effectJsonStr = typeof effect_dsp_json === 'string'
        ? effect_dsp_json
        : JSON.stringify(effect_dsp_json);
      const effectBytes = Buffer.from(effect_wasm_base64, 'base64');
      const effectModule = await WebAssembly.compile(effectBytes);
      effectFactory = {
        cfactory: 0,
        code: new Uint8Array(effectBytes),
        module: effectModule,
        json: effectJsonStr,
        poly: true,
      };
    }

    if (this.polyNvoices > 0) {
      const polyGenerator = this.compilerManager.createPolyGenerator();
      const isDouble = parsedJson?.compile_options?.includes('-double');
      const { mixerModule } = await this.compilerManager.compiler.getAsyncInternalMixerModule(
        !!isDouble,
      );
      this.faustNode = await polyGenerator.createNode(
        this.audioContext,
        this.polyNvoices,
        name || parsedJson?.name || 'faust-rt',
        wasmFactory,
        mixerModule,
        effectFactory || undefined,
      );
    } else {
      const monoGenerator = this.compilerManager.createGenerator();
      this.faustNode = await monoGenerator.createNode(
        this.audioContext,
        name || parsedJson?.name || 'faust-rt',
        wasmFactory,
      );
    }

    if (!this.faustNode) {
      throw new ToolError('node_create_failed', 'Failed to create Faust node');
    }

    this.wasmFactory = wasmFactory;
    this.wasmEffectFactory = effectFactory;

    this.outputParamsCache = {};
    this.inputParamsCache = {};
    this.metricsCollector.setMeterCaches({
      outputParamsCache: this.outputParamsCache,
      meterUnitsByPath: this.meterUnitsByPath,
      meterProbesByPath: this.meterProbesByPath,
    });
    if (typeof this.faustNode.setOutputParamHandler === 'function') {
      this.faustNode.setOutputParamHandler((path, value) => {
        this.outputParamsCache[path] = value;
      });
    }
    if (typeof this.faustNode.setInputParamHandler === 'function') {
      this.faustNode.setInputParamHandler((path, value) => {
        this.inputParamsCache[path] = value;
      });
    }

    try {
      this.faustNode.start();
    } catch (_) {}

    let resolvedJson = parsedJson;
    try {
      const runtimeJson = this.faustNode.getJSON();
      if (runtimeJson) {
        resolvedJson = JSON.parse(runtimeJson);
      }
    } catch (_) {}
    this.faustJson = resolvedJson;
    this.dspName = this.faustJson?.name || name || null;
    this.paramsCache = extractParamsFromJson(this.faustJson);
    this.meterUnitsByPath = extractBargraphUnits(this.faustJson);
    this.meterProbesByPath = extractBargraphProbes(this.faustJson);
    this.metricsCollector.setMeterCaches({
      outputParamsCache: this.outputParamsCache,
      meterUnitsByPath: this.meterUnitsByPath,
      meterProbesByPath: this.meterProbesByPath,
    });
    this.metricsCollector.attach(this.audioContext, this.faustNode, this.faustJson);

    return this.withSchema({
      status: 'compiled',
      name: this.dspName,
      latency_hint: hint,
      inputs: this.faustJson?.inputs ?? null,
      outputs: this.faustJson?.outputs ?? null,
      params: this.paramsCache,
      param_paths: this.getParamPaths(),
      faust_json: this.faustJson,
    });
  }

  /**
   * Set a parameter value on the running DSP.
   * @param {{path: string, value: number}} params
   * @returns {object}
   */
  setParam({ path, value }) {
    this.ensureRunning();
    this.faustNode.setParamValue(path, value);
    const current = this.faustNode.getParamValue(path);
    return this.withSchema({ status: 'ok', path, value: current });
  }

  /**
   * Get the current value of a parameter on the running DSP.
   * @param {{path: string}} params
   * @returns {object}
   */
  getParam({ path }) {
    this.ensureRunning();
    const current = Object.prototype.hasOwnProperty.call(this.inputParamsCache, path)
      ? this.inputParamsCache[path]
      : this.faustNode.getParamValue(path);
    return this.withSchema({ status: 'ok', path, value: current });
  }

  /**
   * Return cached parameter descriptors and paths.
   * @returns {object}
   */
  getParams() {
    this.ensureRunning();
    return this.withSchema({
      status: 'ok',
      params: this.paramsCache,
      param_paths: this.getParamPaths(),
    });
  }

  /**
   * Return the full Faust JSON for the current DSP.
   * @returns {object}
   */
  getDspJson() {
    this.ensureRunning();
    return this.withSchema({ status: 'ok', faust_json: this.faustJson });
  }

  /**
   * Return current values for all known parameters (inputs + outputs).
   * @returns {object}
   */
  getParamValues() {
    this.ensureRunning();
    const paramPaths = this.getParamPaths();
    const values = paramPaths.map((path) => ({
      path,
      value: Object.prototype.hasOwnProperty.call(this.inputParamsCache, path)
        ? this.inputParamsCache[path]
        : this.faustNode.getParamValue(path),
    }));

    for (const [path, value] of Object.entries(this.outputParamsCache)) {
      const existing = values.find((v) => v.path === path);
      if (existing) {
        existing.value = value;
      } else {
        values.push({ path, value });
      }
    }

    for (const [path, value] of Object.entries(this.inputParamsCache)) {
      const existing = values.find((v) => v.path === path);
      if (existing) {
        existing.value = value;
      } else {
        values.push({ path, value });
      }
    }

    return this.withSchema({ status: 'ok', values });
  }


  /**
   * Set multiple parameter values on the running DSP.
   * @param {{values: Array<{path: string, value: number}>}} params
   * @returns {object}
   */
  setParamValues({ values }) {
    this.ensureRunning();
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
      this.faustNode.setParamValue(entry.path, entry.value);
      updated.push({
        path: entry.path,
        value: this.faustNode.getParamValue(entry.path),
      });
    }
    return this.withSchema({ status: 'ok', values: updated });
  }
}

/**
 * Simple HTTP server for the rt-node-ui HTML + Faust UI assets.
 */
class UiServer {
  /**
   * @param {{uiPort: number, uiRoot: string, mcpRoot: string, runtime: WorkerRuntime}} params
   */
  constructor({ uiPort, uiRoot, mcpRoot, runtime }) {
    this.uiPort = uiPort;
    this.uiRoot = uiRoot;
    this.mcpRoot = mcpRoot;
    this.runtime = runtime;
    this.midiManager = null;
    this.server = null;
    this.resolvedUiRoot = '';
    this.wsServer = new WebSocketMetricsServer({
      runtime,
      schemaVersion: MCP_SCHEMA_VERSION,
    });
  }

  /**
   * Resolve the faust-ui bundle root directory.
   * @returns {string}
   */
  resolveUiRoot() {
    if (this.uiRoot) return this.uiRoot;
    try {
      const require = createRequire(path.join(this.mcpRoot, 'ui', 'package.json'));
      const uiFile = require.resolve('@shren/faust-ui/dist/esm/index.js');
      return path.dirname(uiFile);
    } catch (_) {
      return '';
    }
  }

  /**
   * Start the UI HTTP server if enabled.
   */
  start() {
    if (!this.uiPort || this.server) return;
    const uiHtmlPath = path.join(this.mcpRoot, 'ui', 'rt-node-ui.html');
    this.resolvedUiRoot = this.resolveUiRoot();

    this.server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      if (url.pathname === '/') {
        const html = fs.readFileSync(uiHtmlPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }

      if (url.pathname === '/rt-node-ui.js') {
        const filePath = path.join(this.mcpRoot, 'ui', 'rt-node-ui.js');
        if (fs.existsSync(filePath)) {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(fs.readFileSync(filePath));
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
        return;
      }

      if (url.pathname === '/rt-node-ui.css') {
        const filePath = path.join(this.mcpRoot, 'ui', 'rt-node-ui.css');
        if (fs.existsSync(filePath)) {
          res.writeHead(200, { 'Content-Type': 'text/css' });
          res.end(fs.readFileSync(filePath));
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
        return;
      }

      if (url.pathname.startsWith('/assets/')) {
        const rel = url.pathname.replace('/assets/', '');
        const filePath = path.join(this.mcpRoot, 'ui', 'assets', rel);
        if (fs.existsSync(filePath)) {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(fs.readFileSync(filePath));
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
        return;
      }

      if (url.pathname === '/audio-metrics') {
        const parseBool = (value) => value === 'true' || value === '1';
        const opts = {
          include_scope: parseBool(url.searchParams.get('include_scope')),
          include_spectrum: parseBool(url.searchParams.get('include_spectrum')),
          per_channel: parseBool(url.searchParams.get('per_channel')),
          fft_size: url.searchParams.get('fft_size') ? Number(url.searchParams.get('fft_size')) : undefined,
          smoothing: url.searchParams.get('smoothing') ? Number(url.searchParams.get('smoothing')) : undefined,
          min_db: url.searchParams.get('min_db') ? Number(url.searchParams.get('min_db')) : undefined,
          max_db: url.searchParams.get('max_db') ? Number(url.searchParams.get('max_db')) : undefined,
          edge_threshold: url.searchParams.get('edge_threshold')
            ? Number(url.searchParams.get('edge_threshold'))
            : undefined,
          log_bins: url.searchParams.get('log_bins') ? Number(url.searchParams.get('log_bins')) : undefined,
        };
        try {
          const payload = this.runtime.getAudioMetrics(opts);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
        return;
      }

      if (url.pathname === '/params') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ params: this.runtime.paramsCache }));
        return;
      }

      if (url.pathname === '/param-values') {
        if (!this.runtime.faustNode) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ values: [] }));
          return;
        }
        const values = this.runtime.getParamValues().values;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ values }));
        return;
      }

      if (url.pathname === '/midi/inputs') {
        if (!this.midiManager) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: 'MIDI backend not configured' }));
          return;
        }
        this.midiManager.listInputs()
          .then((payload) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
          })
          .catch((err) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', error: String(err) }));
          });
        return;
      }

      if (url.pathname === '/midi/select' && req.method === 'POST') {
        if (!this.midiManager) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: 'MIDI backend not configured' }));
          return;
        }
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');
            this.midiManager.selectInput(data)
              .then((payload) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(payload));
              })
              .catch((err) => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', error: String(err) }));
              });
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', error: String(err) }));
          }
        });
        return;
      }

      if (url.pathname === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          name: this.runtime.dspName,
          running: !!this.runtime.faustNode,
          midi_enabled: this.runtime.midiEnabled,
          poly_nvoices: this.runtime.polyNvoices,
          midi_active_notes: this.midiManager ? this.midiManager.getActiveNoteCount() : 0,
        }));
        return;
      }

      if (url.pathname === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.runtime.faustJson || {}));
        return;
      }

      if (url.pathname === '/param' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');
            if (!data.path) throw new Error('Missing path');
            if (typeof data.value !== 'number') throw new Error('Missing value');
            this.runtime.setParam({ path: data.path, value: data.value });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
        return;
      }

      if (url.pathname.startsWith('/faust-ui/') && this.resolvedUiRoot) {
        const rel = url.pathname.replace('/faust-ui/', '');
        const filePath = path.join(this.resolvedUiRoot, rel);
        if (fs.existsSync(filePath)) {
          const contentType = filePath.endsWith('.css')
            ? 'text/css'
            : 'application/javascript';
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(fs.readFileSync(filePath));
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    this.wsServer.attach(this.server);

    this.server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.error(`UI port ${this.uiPort} already in use; UI server disabled.`);
        this.server = null;
        return;
      }
      console.error('UI server error:', err);
    });

    this.server.listen(this.uiPort, () => {
      const uiMode = this.resolvedUiRoot ? 'faust-ui' : 'fallback';
      console.log(`UI server listening on http://127.0.0.1:${this.uiPort}/ (${uiMode})`);
    });
  }

  /**
   * Stop the UI HTTP server if running.
   */
  stop() {
    if (!this.server) return;
    this.wsServer.stop();
    this.server.close();
    this.server = null;
  }
}

/**
 * Optional Node-side MIDI input manager (bypasses browser/HTTP latency).
 */
class MidiInputManager {
  /**
   * @param {{runtime: WorkerRuntime, debug: boolean}} params
   */
  constructor({ runtime, debug }) {
    this.runtime = runtime;
    this.debug = !!debug;
    this.backend = null;
    this.input = null;
    this.selectedIndex = null;
    this.selectedName = null;
    this.lastError = null;
    this.noteOnCount = 0;
    this.noteOffCount = 0;
    this.activeNotes = new Set();
    this.lastMessage = null;
  }

  /**
   * Load a MIDI backend (prefers @julusian/midi, falls back to midi).
   * @returns {Promise<boolean>}
   */
  async ensureBackend() {
    if (this.backend) return true;
    const load = async (name) => {
      try {
        const mod = await import(name);
        return mod.default ?? mod;
      } catch (_) {
        return null;
      }
    };
    const require = createRequire(import.meta.url);
    const localNodeMidi = path.join(
      this.runtime?.compilerManager?.context?.mcpRoot || process.cwd(),
      'external',
      'node-midi',
    );
    let mod = await load('@julusian/midi');
    if (!mod) {
      try {
        mod = require('@julusian/midi');
      } catch (_) {}
    }
    if (!mod) {
      mod = await load('midi');
    }
    if (!mod) {
      try {
        mod = require('midi');
      } catch (_) {}
    }
    if (!mod) {
      try {
        mod = require(localNodeMidi);
      } catch (_) {}
    }
    if (!mod || !mod.Input) {
      this.lastError = 'MIDI backend not available (install @julusian/midi)';
      return false;
    }
    this.backend = mod;
    return true;
  }

  /**
   * List available MIDI inputs.
   * @returns {Promise<object>}
   */
  async listInputs() {
    const ok = await this.ensureBackend();
    if (!ok) {
      return { status: 'error', available: false, error: this.lastError, inputs: [] };
    }
    const input = new this.backend.Input();
    const count = input.getPortCount();
    const inputs = [];
    for (let i = 0; i < count; i++) {
      inputs.push({ index: i, name: input.getPortName(i) });
    }
    return {
      status: 'ok',
      available: true,
      inputs,
      selected: this.selectedIndex === null
        ? null
        : { index: this.selectedIndex, name: this.selectedName },
    };
  }

  /**
   * Select and open a MIDI input by index or name.
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
    const selected = result.inputs.find((input) => input.index === selectedIndex);
    if (!selected) {
      return { status: 'error', error: 'MIDI input not found' };
    }
    try {
      await this.openInput(selected.index, selected.name);
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
    return { status: 'ok', selected: { index: this.selectedIndex, name: this.selectedName } };
  }

  /**
   * Return the current count of active notes (note-on without note-off).
   * @returns {number}
   */
  getActiveNoteCount() {
    return this.activeNotes.size;
  }

  /**
   * Open the selected MIDI input and bind to MIDI events.
   * @param {number} index
   * @param {string} name
   */
  async openInput(index, name) {
    const ok = await this.ensureBackend();
    if (!ok) {
      throw new Error(this.lastError || 'MIDI backend not available');
    }
    if (this.input) {
      try {
        this.input.closePort();
      } catch (_) {}
    }
    const input = new this.backend.Input();
    if (typeof input.ignoreTypes === 'function') {
      input.ignoreTypes(false, false, false);
    }
    input.on('message', (_, message) => this.handleMessage(message));
    input.openPort(index);
    this.input = input;
    this.selectedIndex = index;
    this.selectedName = name ?? input.getPortName(index);
  }

  /**
   * Forward a MIDI message to the current Faust node.
   * @param {number[]|Uint8Array} message
   */
  handleMessage(message) {
    const node = this.runtime?.faustNode;
    if (!node || typeof node.midiMessage !== 'function') return;
    const data = message instanceof Uint8Array ? message : Uint8Array.from(message);
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
    if (this.debug) {
      if (type === 0x90 && velocity > 0) {
        this.noteOnCount += 1;
      } else if (type === 0x80 || (type === 0x90 && velocity === 0)) {
        this.noteOffCount += 1;
      }
      console.error(
        `MIDI debug: [${Array.from(data).join(', ')}] noteOn=${this.noteOnCount} noteOff=${this.noteOffCount}`
      );
    }
    try {
      node.midiMessage(data);
    } catch (_) {}
  }

  /**
   * Return MIDI backend status for the current session.
   * @returns {Promise<object>}
   */
  async getStatus() {
    const ok = await this.ensureBackend();
    if (!ok) {
      return {
        status: 'error',
        available: false,
        error: this.lastError,
        selected: null,
        last_message: this.lastMessage,
      };
    }
    return {
      status: 'ok',
      available: true,
      selected: this.selectedIndex === null
        ? null
        : { index: this.selectedIndex, name: this.selectedName },
      last_message: this.lastMessage,
    };
  }
}

/**
 * Minimal JSON-over-stdin protocol wrapper for the Python MCP server.
 */
class ProtocolServer {
  /**
   * @param {{handlers: Record<string, Function>}} params
   */
  constructor({ handlers }) {
    this.handlers = handlers;
    this.rl = null;
  }

  /**
   * Start reading stdin for JSON requests.
   */
  start() {
    if (this.rl) return;
    this.rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.handleLine(line));
  }

  /**
   * Parse and dispatch a single JSON line.
   * @param {string} line
   * @returns {Promise<void>}
   */
  async handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      process.stdout.write(JSON.stringify({ id: null, error: 'Invalid JSON' }) + '\n');
      return;
    }

    const { id, method, params } = msg;
    const handler = this.handlers[method];
    if (!handler) {
      process.stdout.write(JSON.stringify({ id, error: `Unknown method: ${method}` }) + '\n');
      return;
    }

    try {
      const result = await handler(params || {});
      process.stdout.write(JSON.stringify({ id, result }) + '\n');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err && typeof err === 'object' && err.code ? err.code : 'runtime_error';
      const details = err && typeof err === 'object' ? err.details : undefined;
      process.stdout.write(JSON.stringify({
        id,
        error: {
          schema_version: MCP_SCHEMA_VERSION,
          code,
          message,
          details: details ?? null,
        },
      }) + '\n');
    }
  }
}

/**
 * Top-level app that wires context, runtime, UI, and protocol servers.
 */
class WorkerApp {
  /**
   * Construct the app and its dependencies.
   */
  constructor() {
    this.context = new WorkerContext();
    this.compilerManager = new FaustCompilerManager(this.context);
    this.runtime = new WorkerRuntime({ compilerManager: this.compilerManager });
    this.uiServer = new UiServer({
      uiPort: this.context.uiPort,
      uiRoot: this.context.uiRoot,
      mcpRoot: this.context.mcpRoot,
      runtime: this.runtime,
    });
    this.midiManager = new MidiInputManager({
      runtime: this.runtime,
      debug: this.context.midiDebug,
    });
    this.uiServer.midiManager = this.midiManager;
    this.handlers = this.buildHandlers();
    this.protocolServer = new ProtocolServer({ handlers: this.handlers });
  }

  /**
   * Build the method map exposed to the protocol server.
   * @returns {Record<string, Function>}
   */
  buildHandlers() {
    return {
      check_syntax: (params) => this.compilerManager.checkSyntax(params || {}),
      compile: (params) => this.runtime.compileDSP(params || {}),
      start: () => this.runtime.startDSP(),
      compile_and_start: (params) => this.runtime.compileAndStart(params || {}),
      set_param: (params) => this.runtime.setParam(params || {}),
      get_param: (params) => this.runtime.getParam(params || {}),
      get_params: () => this.runtime.getParams(),
      get_dsp_json: () => this.runtime.getDspJson(),
      get_param_values: () => this.runtime.getParamValues(),
      get_audio_metrics: (params) => this.runtime.getAudioMetrics(params || {}),
      load_wasm_module: (params) => this.runtime.loadWasmModule(params || {}),
      save_wasm_module: () => this.runtime.saveWasmModule(),
      get_status: () => ({
        schema_version: MCP_SCHEMA_VERSION,
        running: !!this.runtime.faustNode,
        name: this.runtime.dspName,
        poly_nvoices: this.runtime.polyNvoices,
        midi_enabled: this.runtime.midiEnabled,
        midi_active_notes: this.midiManager ? this.midiManager.getActiveNoteCount() : 0,
      }),
      get_midi_inputs: () => this.midiManager.listInputs(),
      get_midi_status: () => this.midiManager.getStatus(),
      select_midi_input: (params) => this.midiManager.selectInput(params || {}),
      set_param_values: (params) => this.runtime.setParamValues(params || {}),
      stop: () => this.runtime.stop(),
    };
  }

  /**
   * Start the UI + protocol servers.
   */
  start() {
    console.log('Faust realtime worker starting');
    this.uiServer.start();
    this.protocolServer.start();
  }
}

// Start the worker app.
const workerApp = new WorkerApp();
workerApp.start();
