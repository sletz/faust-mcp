# JS Refactor Log - `faust_node_worker.mjs`

## Step 1 - Extract metrics runtime into a class

Goal: move analyser nodes + scope/spectrum collection + bargraph parsing into a single object so runtime state is not spread across globals.

Changes:
- Added `MetricsCollector` with analyser lifecycle + metrics assembly.
- Moved analyser defaults + channel analyser creation inside the class.
- Added `setMeterCaches()` to receive bargraph caches (values + metadata).

Generated code (excerpt):

```js
class MetricsCollector {
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

  setMeterCaches({ outputParamsCache, meterUnitsByPath, meterProbesByPath }) {}
  attach(audioContext, faustNode, faustJson) {}
  reset() {}
  syncAnalyserConfig(opts = {}) {}
  ensureChannelAnalysers() {}
  getMetrics(options) {}
}
```

File updated: `faust_node_worker.mjs`

## Step 2 - Wire `compile_and_start` to the new class

Changes:
- After Faust JSON extraction, the worker calls:
  - `metricsCollector.setMeterCaches(...)`
  - `metricsCollector.attach(audioContext, faustNode, faustJson)`
- Ensures the analyser graph is created and connected only once per compile.

File updated: `faust_node_worker.mjs`

## Step 3 - Delegate metrics request handling

Changes:
- `get_audio_metrics` now calls `metricsCollector.getMetrics(...)`.
- `computeAudioMetrics(...)` accepts caches from the collector (no global reads).

File updated: `faust_node_worker.mjs`

## Step 4 - Centralize cleanup in `stop()`

Changes:
- `stop()` now calls `metricsCollector.reset()` to clear analysers and caches.
- Output/meter caches are re-initialized and reattached to the collector.

File updated: `faust_node_worker.mjs`

## Step 5 - Introduce `WorkerRuntime` for compile/stop lifecycle

Goal: move the full DSP lifecycle (compile/start/stop) into a single runtime
class and keep top-level handlers as thin wrappers.

Changes:
- Added `WorkerRuntime` to own state: `audioContext`, `faustNode`, caches, and
  `metricsCollector`.
- Moved the `compile_and_start` body into `WorkerRuntime.compileAndStart(...)`.
- Moved the `stop()` body into `WorkerRuntime.stop()` and reuse `resetState()`.
- Updated top-level handler functions to call the runtime methods.
- Updated the UI server to read params and status from `workerRuntime`.

Generated code (excerpt):

```js
class WorkerRuntime {
  constructor() {
    this.metricsCollector = new MetricsCollector();
    this.resetState();
  }

  async compileAndStart(params) {
    await initFaust();
    if (this.audioContext) await this.stop();
    // ... compile + start logic ...
    return {
      status: 'started',
      name: params.name,
      latency_hint: hint,
      inputs: this.faustJson.inputs ?? null,
      outputs: this.faustJson.outputs ?? null,
      params: this.paramsCache,
      param_paths: this.getParamPaths(),
      faust_json: this.faustJson,
    };
  }

  async stop() {
    if (this.fileSourceNode) this.fileSourceNode.stop();
    if (this.faustNode) this.faustNode.stop();
    if (this.audioContext) await this.audioContext.close();
    this.resetState();
    return { status: 'stopped' };
  }
}
```

File updated: `faust_node_worker.mjs`

## Step 6 - Move parameter APIs into `WorkerRuntime`

Goal: keep top-level handlers thin and keep stateful control logic in the
runtime class.

Changes:
- Added `setParam`, `getParam`, `getParams`, `getParamValues`,
  `setParamValues` to `WorkerRuntime`.
- Simplified top-level handlers to delegate to `workerRuntime`.
- Removed the redundant `ensureRunning()` helper at the module level.

File updated: `faust_node_worker.mjs`

## Step 7 - Extract `UiServer`

Goal: isolate HTTP server routes from the main worker module while keeping
behavior identical.

Changes:
- Added `UiServer` class with `start()` and `stop()` methods.
- Moved the UI routing logic (`/params`, `/param-values`, `/status`, `/json`,
  `/param`, and static `faust-ui` assets) into the class.
- Updated the worker startup to instantiate and start the UI server.

File updated: `faust_node_worker.mjs`

## Step 8 - Extract `ProtocolServer`

Goal: isolate stdin/stdout JSON protocol handling so the main module only wires
handlers and runtime together.

Changes:
- Added `ProtocolServer` with `start()` to read stdin lines.
- Centralized JSON parse + dispatch + response formatting inside the class.
- Main file now constructs `ProtocolServer` with the handlers map and starts it.

File updated: `faust_node_worker.mjs`

## Step 9 - Add `WorkerContext`

Goal: centralize immutable configuration (paths, UI port/root, web-audio root)
and keep startup side effects in one place.

Changes:
- Added `WorkerContext` to capture environment values and resolve paths after
  the `chdir` into the node-web-audio-api checkout.
- Replaced global `WEB_AUDIO_ROOT`, `UI_PORT`, `UI_ROOT`, and path resolution
  constants with context properties.

File updated: `faust_node_worker.mjs`

## Step 10 - Add `FaustCompilerManager`

Goal: encapsulate lazy compiler initialization and WebAudio class loading.

Changes:
- Added `FaustCompilerManager` with `ensureReady()` and `createGenerator()`.
- Moved `check_syntax` compilation flow into the manager.
- `WorkerRuntime` now uses the manager to get `AudioContext`, compiler, and
  generator instances.

File updated: `faust_node_worker.mjs`

## Step 11 - Extract DSP/UI helpers

Goal: move DSP wrapping and Faust JSON parsing helpers into a shared module.

Changes:
- Added `faust_dsp_utils.mjs` with `wrapTestInputs`, `extractParamsFromJson`,
  `extractBargraphUnits`, and `extractBargraphProbes`.
- Removed the helper implementations from `faust_node_worker.mjs` and
  replaced them with imports.

Files updated: `faust_node_worker.mjs`, `faust_dsp_utils.mjs`

## Step 12 - Extract metrics helpers

Goal: centralize audio metrics and analyser payload collection logic.

Changes:
- Added `metrics_utils.mjs` with `computeAudioMetrics`,
  `normalizeAudioMetricsOptions`, `collectScopePayload`, and
  `collectSpectrumPayload` (plus internal helpers).
- Removed the metrics helper implementations from `faust_node_worker.mjs`
  and replaced them with imports.

Files updated: `faust_node_worker.mjs`, `metrics_utils.mjs`

## Step 13 - Add `WorkerApp`

Goal: centralize application wiring (context, compiler manager, runtime, UI,
protocol) and remove the remaining top-level handler functions.

Changes:
- Added `WorkerApp` to instantiate `WorkerContext`, `FaustCompilerManager`,
  `WorkerRuntime`, `UiServer`, and `ProtocolServer`.
- Replaced the handlers map with `WorkerApp.buildHandlers()`.
- Removed the top-level `checkSyntax` / `compileAndStart` / param helper
  functions in favor of runtime and compiler-manager methods.

File updated: `faust_node_worker.mjs`

## Next steps

1) Run a smoke test (`make rt-compile DSP=...` + `python3 sse_client_example.py --tool get_audio_metrics`) before/after each step.
