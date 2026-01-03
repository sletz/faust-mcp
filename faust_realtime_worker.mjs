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
import { createRequire } from 'node:module';
import { Blob } from 'node:buffer';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';

// Base path to the node-web-audio-api checkout (default: submodule).
const WEB_AUDIO_ROOT = process.env.WEBAUDIO_ROOT || 'external/node-web-audio-api';
const UI_PORT = Number(process.env.FAUST_UI_PORT || 0);
const UI_ROOT = process.env.FAUST_UI_ROOT || '';

if (!globalThis.Blob) {
  globalThis.Blob = Blob;
}
const MCP_ROOT = process.env.FAUST_MCP_ROOT || process.cwd();

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
let uiServer = null;
let dspName = null;
let fileSourceNode = null;  // For file input playback

/**
 * Wrap DSP code with a generated test input signal when requested.
 * @param {string} dspCode
 * @param {string} inputSource
 * @param {number|undefined|null} inputFreq
 * @param {string|undefined|null} inputFile
 * @returns {string}
 */
function wrapTestInputs(dspCode, inputSource, inputFreq, inputFile) {
  const source = (inputSource || 'none').trim().toLowerCase();
  if (source === 'none') {
    return { code: dspCode, useExternalInput: false };
  }
  if (source !== 'sine' && source !== 'noise' && source !== 'file') {
    throw new Error(`Unsupported input_source: ${inputSource}`);
  }

  // For file input, check if it's HTTP URL or local file
  if (source === 'file') {
    if (!inputFile) {
      throw new Error('input_file is required for input_source=file');
    }

    // HTTP/HTTPS URLs: use FAUST soundfile (works with fetch)
    if (inputFile.startsWith('http://') || inputFile.startsWith('https://')) {
      const escaped = String(inputFile).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const indented = String(dspCode)
        .split('\n')
        .map((line) => (line.trim() ? `  ${line}` : line))
        .join('\n');

      const wrappedCode = [
        'import("stdfaust.lib");',
        'mcp_so = library("soundfiles.lib");',
        `mcp_sf = soundfile("sound[url:{'${escaped}'}]", 1);`,
        'mcp_loop_test = mcp_so.loop(mcp_sf, 0);',
        'mcp_addTestInputs(FX, sig) = par(i, inputs(FX), sig) : FX;',
        'mcp_dsp = environment {',
        indented,
        '};',
        'process = mcp_addTestInputs(mcp_dsp.process, mcp_loop_test);',
      ].join('\n');

      return { code: wrappedCode, useExternalInput: false };
    }

    // Local files: use AudioBufferSourceNode (fetch doesn't support file://)
    return { code: dspCode, useExternalInput: true, inputFile };
  }

  // For sine/noise, wrap the DSP with test signal generator
  let signal;
  if (source === 'sine') {
    const freq = Number.isFinite(inputFreq) ? inputFreq : 1000;
    signal = `library("oscillators.lib").osc(${freq})`;
  } else {
    signal = 'library("noises.lib").noise';
  }

  const indented = String(dspCode)
    .split('\n')
    .map((line) => (line.trim() ? `  ${line}` : line))
    .join('\n');

  const wrappedCode = [
    'import("stdfaust.lib");',
    'mcp_addTestInputs(FX, sig) = par(i, inputs(FX), sig) : FX;',
    'mcp_dsp = environment {',
    indented,
    '};',
    `process = mcp_addTestInputs(mcp_dsp.process, ${signal});`,
  ].join('\n');

  return { code: wrappedCode, useExternalInput: false };
}

/**
 * Initialize the Faust compiler and WebAudio classes.
 * @returns {Promise<object>}
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
 * Normalize Faust metadata array into a flat key/value map.
 * @param {Array<object>|undefined|null} meta
 * @returns {Record<string, string>}
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
 * Walk the Faust UI tree and append parameter descriptors.
 * @param {Array<object>|undefined|null} items
 * @param {Array<object>} acc
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
      shortname: item.shortname,
      label: item.label,
      type,
      init: item.init,
      min: item.min,
      max: item.max,
      step: item.step,
      unit: meta.unit ?? null,
      meta,
    });
  }
}

/**
 * Extract parameter descriptors from a Faust JSON object.
 * @param {object|undefined|null} jsonObj
 * @returns {Array<object>}
 */
function extractParamsFromJson(jsonObj) {
  const params = [];
  collectParams(jsonObj?.ui || [], params);
  return params;
}

/**
 * Compile DSP code to validate syntax without starting audio.
 * @param {{dsp_code: string, name?: string, args?: string}} params
 * @returns {Promise<object>}
 */
async function checkSyntax({ dsp_code, name, args }) {
  // Compile DSP to validate syntax without starting audio.
  await initFaust();
  if (!dsp_code) {
    return { status: 'error', error: 'Missing dsp_code' };
  }
  const dspName = name || 'faust-check';
  const compilerArgs = args || '-ftz 2';
  try {
    const factory = await compiler.createMonoDSPFactory(
      dspName,
      dsp_code,
      compilerArgs,
    );
    const json = factory?.json ? JSON.parse(factory.json) : null;
    return { status: 'ok', name: json?.name || dspName, json };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = compiler?.getErrorMessage?.() || '';
    const error = detail && detail !== message ? `${message}\n${detail}` : message;
    return { status: 'error', error };
  }
}

/**
 * Compile DSP code, start playback, and return UI/param metadata.
 * @param {object} params
 * @returns {Promise<object>}
 */
async function compileAndStart({
  dsp_code,
  name,
  latency_hint,
  input_source,
  input_freq,
  input_file,
}) {
  // Compile DSP, create AudioWorklet node, connect, and start.
  await initFaust();

  if (audioContext) {
    // Replace the running DSP.
    try {
      if (fileSourceNode) {
        fileSourceNode.stop();
        fileSourceNode = null;
      }
    } catch (_) {}
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
  const wrapped = wrapTestInputs(dsp_code, input_source, input_freq, input_file);
  const compiled = await generator.compile(compiler, name, wrapped.code, '-ftz 2');
  if (!compiled) {
    throw new Error('Faust compilation failed');
  }

  faustNode = await generator.createNode(audioContext);
  if (!faustNode) {
    throw new Error('Failed to create Faust node');
  }

  faustNode.connect(audioContext.destination);

  // Handle file input: load audio file and connect to FAUST input
  if (wrapped.useExternalInput && wrapped.inputFile) {
    try {
      // Read audio file
      const fileBuffer = fs.readFileSync(wrapped.inputFile);
      const arrayBuffer = fileBuffer.buffer.slice(
        fileBuffer.byteOffset,
        fileBuffer.byteOffset + fileBuffer.byteLength
      );

      // Decode audio data
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

      // Create looping source node
      fileSourceNode = audioContext.createBufferSource();
      fileSourceNode.buffer = audioBuffer;
      fileSourceNode.loop = true;

      // Connect file source -> FAUST effect -> destination
      fileSourceNode.connect(faustNode);
      fileSourceNode.start();

      console.error(`Loaded audio file: ${wrapped.inputFile} (${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.sampleRate}Hz)`);
    } catch (err) {
      throw new Error(`Failed to load audio file: ${err.message}`);
    }
  }

  faustNode.start();

  // Extract UI metadata and parameter paths from Faust JSON.
  const jsonStr = faustNode.getJSON();
  faustJson = JSON.parse(jsonStr);
  dspName = faustJson?.name || name || null;
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
 * Guard helper to ensure a DSP is running before control operations.
 */
function ensureRunning() {
  // Guard to ensure a DSP is started before control operations.
  if (!faustNode) {
    throw new Error('No running DSP. Call compile_and_start first.');
  }
}

/**
 * Set a parameter value on the running DSP.
 * @param {{path: string, value: number}} params
 * @returns {Promise<object>}
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
 * @param {{path: string}} params
 * @returns {Promise<object>}
 */
async function getParam({ path }) {
  ensureRunning();
  const current = faustNode.getParamValue(path);
  return { status: 'ok', path, value: current };
}

/**
 * Return cached parameter descriptors and paths.
 * @returns {Promise<object>}
 */
async function getParams() {
  // Return cached parameter metadata for the running DSP.
  ensureRunning();
  const paramPaths = faustNode.getParams?.() ?? paramsCache.map((p) => p.path);
  return { status: 'ok', params: paramsCache, param_paths: paramPaths };
}

/**
 * Return current values for all known parameters.
 * @returns {Promise<object>}
 */
async function getParamValues() {
  ensureRunning();
  const paramPaths = faustNode.getParams?.() ?? paramsCache.map((p) => p.path);
  const values = paramPaths.map((path) => ({
    path,
    value: faustNode.getParamValue(path),
  }));
  return { status: 'ok', values };
}

/**
 * Set multiple parameter values on the running DSP.
 * @param {{values: Array<{path: string, value: number}>}} params
 * @returns {Promise<object>}
 */
async function setParamValues({ values }) {
  ensureRunning();
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
    faustNode.setParamValue(entry.path, entry.value);
    updated.push({
      path: entry.path,
      value: faustNode.getParamValue(entry.path),
    });
  }
  return { status: 'ok', values: updated };
}

/**
 * Stop playback and reset the DSP state.
 * @returns {Promise<object>}
 */
async function stop() {
  // Stop audio and reset state.
  if (fileSourceNode) {
    try {
      fileSourceNode.stop();
    } catch (_) {}
    fileSourceNode = null;
  }
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

/**
 * Resolve the faust-ui bundle root directory.
 * @returns {string}
 */
function resolveUiRoot() {
  if (UI_ROOT) return UI_ROOT;
  try {
    const require = createRequire(path.join(MCP_ROOT, 'ui', 'package.json'));
    const uiFile = require.resolve('@shren/faust-ui/dist/esm/index.js');
    return path.dirname(uiFile);
  } catch (_) {
    return '';
  }
}

/**
 * Start the UI HTTP server if enabled.
 */
function startUiServer() {
  if (!UI_PORT || uiServer) return;
  const uiHtmlPath = path.join(MCP_ROOT, 'ui', 'rt-ui.html');
  const resolvedUiRoot = resolveUiRoot();

  uiServer = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (url.pathname === '/') {
      const html = fs.readFileSync(uiHtmlPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    if (url.pathname === '/params') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ params: paramsCache }));
      return;
    }

    if (url.pathname === '/param-values') {
      if (!faustNode) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ values: [] }));
        return;
      }
      const paramPaths = faustNode.getParams?.() ?? paramsCache.map((p) => p.path);
      const values = paramPaths.map((path) => ({
        path,
        value: faustNode.getParamValue(path),
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ values }));
      return;
    }

    if (url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: dspName, running: !!faustNode }));
      return;
    }

    if (url.pathname === '/json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(faustJson || {}));
      return;
    }

    if (url.pathname === '/param' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        try {
          const data = JSON.parse(body || '{}');
          if (!data.path) throw new Error('Missing path');
          if (typeof data.value !== 'number') throw new Error('Missing value');
          await setParam({ path: data.path, value: data.value });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    if (url.pathname.startsWith('/faust-ui/') && resolvedUiRoot) {
      const rel = url.pathname.replace('/faust-ui/', '');
      const filePath = path.join(resolvedUiRoot, rel);
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

  uiServer.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`UI port ${UI_PORT} already in use; UI server disabled.`);
      uiServer = null;
      return;
    }
    console.error('UI server error:', err);
  });

  uiServer.listen(UI_PORT, () => {
    const uiMode = resolvedUiRoot ? 'faust-ui' : 'fallback';
    console.log(`UI server listening on http://127.0.0.1:${UI_PORT}/ (${uiMode})`);
  });
}

const handlers = {
  check_syntax: checkSyntax,
  compile_and_start: compileAndStart,
  set_param: setParam,
  get_param: getParam,
  get_params: getParams,
  get_param_values: getParamValues,
  set_param_values: setParamValues,
  stop,
};

console.log('Faust realtime worker starting');
startUiServer();

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
