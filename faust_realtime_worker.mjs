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
    this.polyNvoices = 0;
    this.midiEnabled = false;
    this.dspName = null;
    this.fileSourceNode = null;
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
      throw new Error('No running DSP. Call compile_and_start first.');
    }
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
  async compileAndStart({
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
    this.paramsCache = [];
    this.meterUnitsByPath = {};
    this.meterProbesByPath = {};
    this.faustJson = null;
    this.dspName = null;
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
      throw new Error('Faust compilation failed');
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
        throw new Error('Faust poly compilation failed');
      }
      this.faustNode = await polyGenerator.createNode(
        this.audioContext,
        this.polyNvoices,
        name,
      );
    } else {
      this.faustNode = await monoGenerator.createNode(this.audioContext);
    }

    if (!this.faustNode) {
      throw new Error('Failed to create Faust node');
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
        this.fileSourceNode.start();

        console.error(
          `Loaded audio file: ${wrapped.inputFile} ` +
          `(${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.sampleRate}Hz)`,
        );
      } catch (err) {
        throw new Error(`Failed to load audio file: ${err.message}`);
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

    return {
      status: 'started',
      name,
      latency_hint: hint,
      inputs: this.faustJson.inputs ?? null,
      outputs: this.faustJson.outputs ?? null,
      params: this.paramsCache,
      param_paths: this.getParamPaths(),
      faust_json: this.faustJson,
    };
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
    return { status: 'stopped' };
  }

  /**
   * Return RMS/Peak metering plus optional scope/spectrum payloads.
   * @param {object} options
   * @returns {object}
   */
  getAudioMetrics(options) {
    this.ensureRunning();
    return this.metricsCollector.getMetrics(options);
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
    return { status: 'ok', path, value: current };
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
    return { status: 'ok', path, value: current };
  }

  /**
   * Return cached parameter descriptors and paths.
   * @returns {object}
   */
  getParams() {
    this.ensureRunning();
    return { status: 'ok', params: this.paramsCache, param_paths: this.getParamPaths() };
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

    return { status: 'ok', values };
  }


  /**
   * Set multiple parameter values on the running DSP.
   * @param {{values: Array<{path: string, value: number}>}} params
   * @returns {object}
   */
  setParamValues({ values }) {
    this.ensureRunning();
    if (!Array.isArray(values)) {
      throw new Error('values must be an array');
    }
    const updated = [];
    for (const entry of values) {
      if (!entry || typeof entry.path !== 'string') {
        throw new Error('Each entry must include a path string');
      }
      if (typeof entry.value !== 'number') {
        throw new Error('Each entry must include a numeric value');
      }
      this.faustNode.setParamValue(entry.path, entry.value);
      updated.push({
        path: entry.path,
        value: this.faustNode.getParamValue(entry.path),
      });
    }
    return { status: 'ok', values: updated };
  }
}

/**
 * Simple HTTP server for the rt-ui HTML + Faust UI assets.
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
    const uiHtmlPath = path.join(this.mcpRoot, 'ui', 'rt-ui.html');
    this.resolvedUiRoot = this.resolveUiRoot();

    this.server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      if (url.pathname === '/') {
        const html = fs.readFileSync(uiHtmlPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }

      if (url.pathname === '/rt-ui.js') {
        const filePath = path.join(this.mcpRoot, 'ui', 'rt-ui.js');
        if (fs.existsSync(filePath)) {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(fs.readFileSync(filePath));
        } else {
          res.writeHead(404);
          res.end('Not found');
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
      process.stdout.write(JSON.stringify({ id, error: message }) + '\n');
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
      compile_and_start: (params) => this.runtime.compileAndStart(params || {}),
      set_param: (params) => this.runtime.setParam(params || {}),
      get_param: (params) => this.runtime.getParam(params || {}),
      get_params: () => this.runtime.getParams(),
      get_param_values: () => this.runtime.getParamValues(),
      get_audio_metrics: (params) => this.runtime.getAudioMetrics(params || {}),
      get_midi_inputs: () => this.midiManager.listInputs(),
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
