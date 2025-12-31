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
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// Base path to the node-web-audio-api checkout (default: submodule).
const WEB_AUDIO_ROOT = process.env.WEBAUDIO_ROOT || 'external/node-web-audio-api';

// Ensure native bindings are resolved relative to the node-web-audio-api checkout.
// The native .node bindings are loaded by CJS and expect process.cwd() to match.
try {
  process.chdir(WEB_AUDIO_ROOT);
} catch (err) {
  throw new Error(`Failed to chdir to WEBAUDIO_ROOT: ${WEB_AUDIO_ROOT} (${err})`);
}

// Resolve all paths after chdir so relative roots work from anywhere.
const resolvedRoot = path.resolve(process.cwd());
const webAudioIndex = pathToFileURL(path.join(resolvedRoot, 'index.mjs')).href;
const faustModuleEntry = pathToFileURL(
  path.join(resolvedRoot, 'node_modules/@grame/faustwasm/dist/esm/index.js'),
).href;
const faustWasmRoot = path.join(resolvedRoot, 'node_modules/@grame/faustwasm');

let AudioContext;
let AudioWorkletNode;
let instantiateFaustModuleFromFile;
let LibFaust;
let FaustCompiler;
let FaustMonoDspGenerator;

// Runtime state for the currently running DSP.
let compiler = null;
let audioContext = null;
let faustNode = null;
let faustJson = null;
let paramsCache = [];

/**
 * Initialize libfaust compiler and WebAudio classes (lazy).
 */
async function initFaust() {
  // Lazy init for libfaust + compiler.
  if (compiler) return compiler;
  ({ AudioContext, AudioWorkletNode } = await import(webAudioIndex));
  if (typeof globalThis.AudioWorkletNode === 'undefined') {
    globalThis.AudioWorkletNode = AudioWorkletNode;
  }

  ({
    instantiateFaustModuleFromFile,
    LibFaust,
    FaustCompiler,
    FaustMonoDspGenerator,
  } = await import(faustModuleEntry));

  // Load the Faust compiler wasm bundle from @grame/faustwasm.
  const faustModule = await instantiateFaustModuleFromFile(
    path.join(faustWasmRoot, 'libfaust-wasm/libfaust-wasm.js'),
    path.join(faustWasmRoot, 'libfaust-wasm/libfaust-wasm.data'),
    path.join(faustWasmRoot, 'libfaust-wasm/libfaust-wasm.wasm'),
  );

  const libFaust = new LibFaust(faustModule);
  compiler = new FaustCompiler(libFaust);
  return compiler;
}

/**
 * Convert Faust JSON meta array into a flat object.
 */
function metaToObject(meta) {
  // Convert Faust meta array into a flat object.
  const out = {};
  if (!Array.isArray(meta)) return out;
  for (const entry of meta) {
    if (entry && typeof entry === 'object') {
      for (const [key, value] of Object.entries(entry)) {
        out[key] = value;
      }
    }
  }
  return out;
}

/**
 * Walk Faust UI tree and collect controllable parameters.
 */
function collectParams(items, acc) {
  // Recursively traverse UI items and collect control descriptors.
  for (const item of items || []) {
    if (!item || typeof item !== 'object') continue;
    if (item.items) {
      collectParams(item.items, acc);
      continue;
    }

    const type = item.type;
    const isControl = [
      'hslider',
      'vslider',
      'nentry',
      'button',
      'checkbox',
    ].includes(type);
    if (!isControl) continue;

    const meta = metaToObject(item.meta);
    acc.push({
      path: item.address,
      label: item.label,
      type,
      init: item.init ?? null,
      min: item.min ?? null,
      max: item.max ?? null,
      step: item.step ?? null,
      unit: meta.unit ?? null,
      meta,
    });
  }
}

/**
 * Extract parameter descriptors from Faust JSON object.
 */
function extractParamsFromJson(jsonObj) {
  const params = [];
  collectParams(jsonObj?.ui || [], params);
  return params;
}

/**
 * Compile DSP code, start playback, and return JSON + param metadata.
 */
async function compileAndStart({ dsp_code, name, latency_hint }) {
  // Compile DSP, create AudioWorklet node, connect, and start.
  await initFaust();

  if (audioContext) {
    // Replace the running DSP.
    try {
      if (faustNode) {
        faustNode.stop();
      }
    } catch (_) {}
    try {
      await audioContext.close();
    } catch (_) {}
    audioContext = null;
    faustNode = null;
  }

  const hint = latency_hint === 'playback' ? 'playback' : 'interactive';
  audioContext = new AudioContext({ latencyHint: hint });

  const generator = new FaustMonoDspGenerator();
  const compiled = await generator.compile(compiler, name, dsp_code, '-ftz 2');
  if (!compiled) {
    throw new Error('Faust compilation failed');
  }

  faustNode = await generator.createNode(audioContext);
  if (!faustNode) {
    throw new Error('Failed to create Faust node');
  }

  faustNode.connect(audioContext.destination);
  faustNode.start();

  // Extract UI metadata and parameter paths from Faust JSON.
  const jsonStr = faustNode.getJSON();
  faustJson = JSON.parse(jsonStr);
  paramsCache = extractParamsFromJson(faustJson);

  const paramPaths = faustNode.getParams?.() ?? paramsCache.map((p) => p.path);

  return {
    status: 'started',
    name,
    latency_hint: hint,
    inputs: faustJson.inputs ?? null,
    outputs: faustJson.outputs ?? null,
    params: paramsCache,
    param_paths: paramPaths,
    faust_json: faustJson,
  };
}

/**
 * Ensure a DSP is currently running.
 */
function ensureRunning() {
  // Guard to ensure a DSP is started before control operations.
  if (!faustNode) {
    throw new Error('No running DSP. Call compile_and_start first.');
  }
}

/**
 * Set a parameter value on the running DSP.
 */
async function setParam({ path, value }) {
  // Update a parameter on the running DSP.
  ensureRunning();
  faustNode.setParamValue(path, value);
  const current = faustNode.getParamValue(path);
  return { status: 'ok', path, value: current };
}

/**
 * Get the current value of a parameter on the running DSP.
 */
async function getParam({ path }) {
  ensureRunning();
  const current = faustNode.getParamValue(path);
  return { status: 'ok', path, value: current };
}

/**
 * Return cached parameter descriptors and paths.
 */
async function getParams() {
  // Return cached parameter metadata for the running DSP.
  ensureRunning();
  const paramPaths = faustNode.getParams?.() ?? paramsCache.map((p) => p.path);
  return { status: 'ok', params: paramsCache, param_paths: paramPaths };
}

/**
 * Stop playback and reset state.
 */
async function stop() {
  // Stop audio and reset state.
  if (faustNode) {
    try {
      faustNode.stop();
    } catch (_) {}
  }
  if (audioContext) {
    try {
      await audioContext.close();
    } catch (_) {}
  }
  faustNode = null;
  audioContext = null;
  faustJson = null;
  paramsCache = [];
  return { status: 'stopped' };
}

const handlers = {
  compile_and_start: compileAndStart,
  set_param: setParam,
  get_param: getParam,
  get_params: getParams,
  stop,
};

// Minimal JSON-over-stdin protocol for the Python MCP server.
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    process.stdout.write(JSON.stringify({ id: null, error: 'Invalid JSON' }) + '\n');
    return;
  }

  const { id, method, params } = msg;
  const handler = handlers[method];
  if (!handler) {
    process.stdout.write(JSON.stringify({ id, error: `Unknown method: ${method}` }) + '\n');
    return;
  }

  try {
    const result = await handler(params || {});
    process.stdout.write(JSON.stringify({ id, result }) + '\n');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stdout.write(JSON.stringify({ id, error: message }) + '\n');
  }
});
