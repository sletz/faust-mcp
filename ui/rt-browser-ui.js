// Browser-only RT UI controller.
// - Bootstraps the Faust browser runtime and UI wiring.
// - Handles DSP loading (textarea/file/query params).
// - Manages long-polling bridge requests from the MCP proxy.
// - Renders scope/spectrum/probe views from runtime metrics.
// - Mounts the Faust UI bundle with param sync and fallback sliders.
import { createBrowserRuntime } from '/faust_browser_runtime.mjs';

class RtBrowserUiApp {
  /**
   * Construct the browser UI controller and initial state.
   */
  constructor() {
    this.runtime = createBrowserRuntime();
    this.bridge = {
      sessionId: null,
      pollTimer: null,
      pollDelayMs: 200,
      isPolling: false,
    };
    this.scopeMode = 'scope';
    this.scopeChannel = 'mix';
    this.scopeChannelCount = 0;
    this.scopePollMs = 200;
    this.spectrumPollMs = 400;
    this.lastSpectrumFetch = 0;
    this.probeSeries = [];
    this.probeMaxPoints = 200;
    this.probePollMs = 400;
    this.probeIdsSignature = '';
    this.paramPollMs = 200;
    this.faustUiInstance = null;
    this.fallbackControls = new Map();
    this.diagramVisible = false;
    this.diagramLoaded = false;
    this.diagramSvgs = null;
    this.diagramHistory = [];
    this.diagramCurrent = null;
    this.loader = {
      textarea: null,
      compileBtn: null,
      fileInput: null,
      fileBtn: null,
      status: null,
    };
    this.dom = {
      appShell: document.querySelector('.app-shell'),
      status: document.getElementById('status'),
      dspName: document.getElementById('dsp-name'),
      faustRoot: document.getElementById('faust-ui-root'),
      fallback: document.getElementById('fallback-ui'),
      compactToggle: document.getElementById('compact-toggle'),
      midiSelect: document.getElementById('midi-select'),
      midiStatus: document.getElementById('midi-status'),
      polyActive: document.getElementById('poly-active'),
      scopeTabs: Array.from(document.querySelectorAll('.scope-tab')),
      scopeCanvas: document.getElementById('scope-canvas'),
      spectrumCanvas: document.getElementById('spectrum-canvas'),
      scopeLabel: document.getElementById('scope-label'),
      scopeMeta: document.getElementById('scope-meta'),
      scopeChannel: document.getElementById('scope-channel'),
      scopePaneScope: document.querySelector('.scope-pane-scope'),
      scopePaneSpectrum: document.querySelector('.scope-pane-spectrum'),
      probeSelect: document.getElementById('probe-select'),
      probeCanvas: document.getElementById('probe-canvas'),
      probeLabel: document.getElementById('probe-label'),
      probeMeta: document.getElementById('probe-meta'),
      diagramToggle: document.getElementById('diagram-toggle'),
      diagramHome: document.getElementById('diagram-home'),
      diagramBack: document.getElementById('diagram-back'),
      diagramBody: document.getElementById('diagram-body'),
      diagramContainer: document.getElementById('diagram-container'),
    };
  }

  setStatus(message) {
    if (!this.dom.status) return;
    this.dom.status.textContent = message;
  }

  /**
   * Format a DSP label for the header.
   * @param {object} statusJson
   * @returns {string}
   */
  formatDspLabel(statusJson) {
    const name = statusJson?.name;
    if (!name) return 'DSP: (none)';
    if (typeof statusJson?.poly_nvoices === 'number' && statusJson.poly_nvoices > 0) {
      return `DSP: ${name} (Poly ${statusJson.poly_nvoices})`;
    }
    return `DSP: ${name} (Mono)`;
  }

  /**
   * Update the polyphonic voice activity text.
   * @param {object} statusJson
   */
  updatePolyActivity(statusJson) {
    const display = this.dom.polyActive;
    if (!display) return;
    const nvoices = statusJson?.poly_nvoices;
    const active = statusJson?.midi_active_notes;
    if (typeof nvoices === 'number' && nvoices > 0) {
      const safeActive = Number.isFinite(active) ? active : 0;
      display.textContent = `Active voices: ${safeActive}`;
      display.style.display = '';
    } else {
      display.textContent = '';
      display.style.display = 'none';
    }
  }

  /**
   * Toggle compact mode and persist the choice.
   * @param {boolean} enabled
   */
  setCompactMode(enabled) {
    if (!this.dom.appShell) return;
    this.dom.appShell.classList.toggle('is-compact', enabled);
    if (this.dom.compactToggle) {
      this.dom.compactToggle.classList.toggle('is-active', enabled);
      this.dom.compactToggle.setAttribute(
        'aria-pressed',
        enabled ? 'true' : 'false'
      );
    }
    try {
      localStorage.setItem('rt-browser-compact', enabled ? '1' : '0');
    } catch (_) {}
  }

  /**
   * Restore compact mode from localStorage.
   */
  restoreCompactMode() {
    try {
      const value = localStorage.getItem('rt-browser-compact');
      this.setCompactMode(value === '1');
    } catch (_) {
      this.setCompactMode(false);
    }
  }

  /**
   * Wire top-level UI events.
   */
  bindEvents() {
    if (this.dom.compactToggle) {
      this.dom.compactToggle.addEventListener('click', () => {
        const enabled = !this.dom.appShell.classList.contains('is-compact');
        this.setCompactMode(enabled);
      });
    }
  }

  /**
   * Reset the UI to the empty (no DSP) state.
   */
  renderEmptyState() {
    if (this.dom.dspName) this.dom.dspName.textContent = 'DSP: (none)';
    if (this.dom.fallback) {
      this.dom.fallback.textContent = '';
      this.renderLoaderUi();
    }
    if (this.dom.faustRoot) {
      this.dom.faustRoot.innerHTML = '';
    }
    this.faustUiInstance = null;
    this.fallbackControls.clear();
    this.resetDiagram();
    if (this.dom.scopeLabel) {
      this.dom.scopeLabel.textContent = 'Waiting for analyser data...';
    }
    if (this.dom.probeLabel) {
      this.dom.probeLabel.textContent = 'No probe selected';
    }
    if (this.dom.probeMeta) {
      this.dom.probeMeta.textContent = 'Value: --';
    }
  }

  /**
   * Reset the SVG diagram panel to its empty state.
   */
  resetDiagram() {
    this.diagramLoaded = false;
    this.diagramSvgs = null;
    this.diagramHistory = [];
    this.diagramCurrent = null;
    if (this.dom.diagramContainer) {
      this.dom.diagramContainer.innerHTML = '<div class="diagram-empty">No diagram yet.</div>';
    }
    this.updateDiagramControls();
    this.setDiagramVisibility(false);
  }

  /**
   * Render an SVG string and attach internal navigation handlers.
   * @param {string} svgString
   * @param {string} [fileName]
   */
  setDiagramSvg(svgString, fileName = 'process.svg') {
    if (!this.dom.diagramContainer) return;
    this.dom.diagramContainer.innerHTML = svgString;
    this.diagramCurrent = fileName;
    this.updateDiagramControls();
    this.wireDiagramLinks();
  }

  /**
   * Attach click handlers to SVG links for navigation.
   */
  wireDiagramLinks() {
    if (!this.dom.diagramContainer || !this.diagramSvgs) return;
    const links = Array.from(this.dom.diagramContainer.querySelectorAll('a'));
    links.forEach((anchor) => {
      anchor.addEventListener('click', (event) => {
        event.preventDefault();
        const hrefAttr = anchor.getAttribute('href')
          || anchor.getAttribute('xlink:href');
        const svgHref = hrefAttr
          || anchor.href?.baseVal
          || anchor.getAttribute('xlink:href');
        if (!svgHref) return;
        const fileName = svgHref.split('/').pop();
        if (!fileName) return;
        const svgString = this.diagramSvgs[fileName];
        if (svgString) {
          if (this.diagramCurrent) {
            this.diagramHistory.push(this.diagramCurrent);
          }
          this.setDiagramSvg(svgString, fileName);
        }
      });
    });
  }

  /**
   * Fetch and render the SVG diagram for the current DSP.
   */
  async loadSvgDiagram() {
    if (!this.dom.diagramContainer) return;
    try {
      const payload = await this.runtime.get_svg_diagrams();
      const svgs = payload?.svgs || {};
      this.diagramSvgs = svgs;
      const svg = svgs['process.svg'];
      if (!svg) {
        this.dom.diagramContainer.innerHTML = '<div class="diagram-empty">No diagram available.</div>';
        return;
      }
      this.setDiagramSvg(svg, 'process.svg');
      this.diagramLoaded = true;
    } catch (err) {
      this.dom.diagramContainer.innerHTML = `<div class="diagram-empty">Diagram error: ${err?.message || err}</div>`;
    }
  }

  /**
   * Enable/disable diagram navigation buttons.
   */
  updateDiagramControls() {
    const home = this.dom.diagramHome;
    const back = this.dom.diagramBack;
    if (home) {
      home.disabled = !this.diagramCurrent || this.diagramCurrent === 'process.svg';
    }
    if (back) {
      back.disabled = this.diagramHistory.length === 0;
    }
  }

  /**
   * Show or hide the diagram panel.
   * @param {boolean} visible
   * @param {{load?: boolean}} [options]
   */
  async setDiagramVisibility(visible, options = {}) {
    const { load = false } = options;
    const toggle = this.dom.diagramToggle;
    const body = this.dom.diagramBody;
    if (!toggle || !body) return;
    this.diagramVisible = visible;
    toggle.setAttribute('aria-expanded', visible ? 'true' : 'false');
    toggle.textContent = visible ? 'Hide Diagram' : 'Show Diagram';
    body.classList.toggle('is-hidden', !visible);
    if (visible && load && !this.diagramLoaded) {
      await this.loadSvgDiagram();
    }
  }

  /**
   * Build the DSP loader controls in the fallback area.
   */
  renderLoaderUi() {
    if (!this.dom.fallback) return;
    const container = this.dom.fallback;
    container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'browser-loader';

    const title = document.createElement('div');
    title.className = 'browser-loader-title';
    title.textContent = 'Load Faust DSP';

    const header = document.createElement('div');
    header.className = 'browser-loader-header';
    header.append(title);

    const note = document.createElement('div');
    note.className = 'browser-loader-note';
    note.textContent = 'Audio starts after you click Compile & Start or Unlock Audio.';

    const textarea = document.createElement('textarea');
    textarea.className = 'browser-loader-textarea';
    textarea.rows = 12;
    textarea.placeholder = 'Paste Faust DSP code here...';

    const compileBtn = document.createElement('button');
    compileBtn.type = 'button';
    compileBtn.className = 'browser-loader-btn is-primary';
    compileBtn.textContent = 'Compile & Start';

    const unlockBtn = document.createElement('button');
    unlockBtn.type = 'button';
    unlockBtn.className = 'browser-loader-btn is-primary';
    unlockBtn.textContent = 'Unlock Audio';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.dsp,text/plain';
    fileInput.className = 'browser-loader-file';
    fileInput.style.display = 'none';

    const fileBtn = document.createElement('button');
    fileBtn.type = 'button';
    fileBtn.className = 'browser-loader-btn is-primary';
    fileBtn.textContent = 'Load .dsp File';

    const status = document.createElement('div');
    status.className = 'browser-loader-status';
    status.textContent = '';

    compileBtn.addEventListener('click', async () => {
      const code = textarea.value.trim();
      if (!code) {
        status.textContent = 'Paste DSP code or load a file first.';
        return;
      }
      await this.compileFromText(code, status);
    });

    unlockBtn.addEventListener('click', async () => {
      await this.unlockAudio(status);
    });

    fileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        textarea.value = text;
        status.textContent = `Loaded ${file.name}.`;
      } catch (err) {
        status.textContent = `Failed to read file: ${err?.message || err}`;
      }
    });

    const actions = document.createElement('div');
    actions.className = 'browser-loader-actions';
    actions.append(compileBtn, fileBtn);

    const primaryActions = document.createElement('div');
    primaryActions.className = 'browser-loader-actions';
    primaryActions.append(unlockBtn);

    header.append(primaryActions);
    wrap.append(header, note, textarea, actions, status, fileInput);
    container.append(wrap);

    this.loader = {
      textarea,
      compileBtn,
      fileInput,
      fileBtn,
      status,
    };
  }

  /**
   * Compile DSP code entered by the user.
   * @param {string} code
   * @param {HTMLElement|null} statusEl
   */
  async compileFromText(code, statusEl) {
    const statusNode = statusEl || this.loader.status;
    if (statusNode) statusNode.textContent = 'Compiling...';
    this.setStatus('Compiling DSP...');
    try {
      const compiled = await this.runtime.compile_and_start(code);
      await this.mountFaustUi(compiled?.faust_json);
      await this.updateStatusFromRuntime();
      await this.updateScopeFromRuntime();
      await this.refreshMidiInputs();
      await this.refreshProbeData();
      this.resetDiagram();
      await this.setDiagramVisibility(true, { load: true });
      this.setStatus('Running.');
      if (statusNode) statusNode.textContent = 'Running.';
    } catch (err) {
      const message = err?.message || String(err);
      this.setStatus(`Compile failed: ${message}`);
      if (statusNode) statusNode.textContent = `Compile failed: ${message}`;
    }
  }

  /**
   * Unlock audio by resuming the AudioContext.
   * @param {HTMLElement|null} statusEl
   */
  async unlockAudio(statusEl) {
    const statusNode = statusEl || this.loader.status;
    if (statusNode) statusNode.textContent = 'Unlocking audio...';
    try {
      await this.runtime.start();
      await this.updateStatusFromRuntime();
      this.setStatus('Audio unlocked.');
      if (statusNode) statusNode.textContent = 'Audio unlocked.';
    } catch (err) {
      const message = err?.message || String(err);
      this.setStatus(`Unlock failed: ${message}`);
      if (statusNode) statusNode.textContent = `Unlock failed: ${message}`;
    }
  }

  /**
   * Pull runtime status and update header display.
   */
  async updateStatusFromRuntime() {
    try {
      const status = await this.runtime.get_status();
      if (this.dom.dspName) {
        this.dom.dspName.textContent = this.formatDspLabel(status);
      }
      this.updatePolyActivity(status);
    } catch (_) {}
  }

  /**
   * Update scope channel list from the current DSP.
   */
  async updateScopeFromRuntime() {
    try {
      const payload = await this.runtime.get_dsp_json();
      const faustJson = payload?.faust_json || payload?.faustJson || null;
      if (faustJson) {
        this.updateScopeChannelsFromJson(faustJson);
      }
    } catch (_) {}
  }

  /**
   * Populate MIDI select options from the runtime.
   */
  async refreshMidiInputs() {
    if (!this.dom.midiSelect || !this.dom.midiStatus) return;
    try {
      const result = await this.runtime.get_midi_inputs();
      if (!result || result.status !== 'ok') {
        this.dom.midiSelect.innerHTML = '<option value=\"\">Unavailable</option>';
        this.dom.midiStatus.textContent = result?.error || 'MIDI unavailable';
        return;
      }
      this.dom.midiSelect.innerHTML = '';
      if (!result.inputs.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No MIDI inputs';
        this.dom.midiSelect.append(option);
      } else {
        result.inputs.forEach((input) => {
          const option = document.createElement('option');
          option.value = String(input.index);
          option.textContent = input.name;
          this.dom.midiSelect.append(option);
        });
      }
      if (result.selected && Number.isFinite(result.selected.index)) {
        this.dom.midiSelect.value = String(result.selected.index);
      }
      this.dom.midiStatus.textContent = result.available ? '' : 'MIDI unavailable';
      this.dom.midiSelect.onchange = async () => {
        const index = Number(this.dom.midiSelect.value);
        if (!Number.isFinite(index)) return;
        await this.runtime.select_midi_input(index, null);
        await this.updateStatusFromRuntime();
      };
    } catch (err) {
      this.dom.midiStatus.textContent = err?.message || String(err);
    }
  }

  /**
   * Fetch current parameter values from the runtime.
   */
  async fetchParamValues() {
    try {
      const res = await this.runtime.get_param_values();
      return res?.values || [];
    } catch (_) {
      return null;
    }
  }

  /**
   * Sync UI controls with runtime parameter values.
   */
  async refreshParamValues() {
    const values = await this.fetchParamValues();
    if (!values) return;
    this.applyParamValues(values);
  }

  /**
   * Apply parameter values to Faust UI or fallback sliders.
   * @param {Array<{path: string, value: number}>} values
   */
  applyParamValues(values) {
    if (!values || !Array.isArray(values)) return;
    values.forEach((entry) => {
      if (!entry) return;
      const path = entry.path;
      const value = entry.value;
      if (this.faustUiInstance) {
        this.faustUiInstance.paramChangeByDSP(path, value);
      }
      const fallback = this.fallbackControls.get(path);
      if (fallback) {
        fallback.input.value = value;
        fallback.value.textContent = Number(value).toFixed(3);
      }
    });
  }

  /**
   * Render a simple slider UI when Faust UI is unavailable.
   * @param {Array<object>} params
   */
  renderFallback(params) {
    const container = this.dom.fallback;
    if (!container) return;
    container.innerHTML = '';
    this.fallbackControls.clear();
    params.forEach((param) => {
      const wrap = document.createElement('div');
      wrap.className = 'param';
      const label = document.createElement('label');
      label.textContent = `${param.path} (${param.label || ''})`;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = param.min ?? 0;
      input.max = param.max ?? 1;
      input.step = param.step ?? 0.01;
      input.value = param.init ?? param.min ?? 0;
      const value = document.createElement('span');
      value.className = 'value';
      value.textContent = Number(input.value).toFixed(3);
      input.addEventListener('input', async () => {
        value.textContent = Number(input.value).toFixed(3);
        await this.runtime.set_param(param.path, Number(input.value));
      });
      wrap.append(label, input, value);
      container.append(wrap);
      this.fallbackControls.set(param.path, { input, value });
    });
  }

  /**
   * Mount the Faust UI bundle or fall back to sliders.
   * @param {object} faustJson
   * @returns {Promise<boolean>}
   */
  async mountFaustUi(faustJson) {
    if (!faustJson) return false;
    let mounted = false;
    if (this.dom.faustRoot) {
      this.dom.faustRoot.innerHTML = '';
    }
    if (this.dom.fallback) {
      this.dom.fallback.innerHTML = '';
      this.fallbackControls.clear();
    }
    try {
      const module = await import('/faust-ui/index.js');
      const FaustUI = module.default || module.FaustUI || null;
      if (FaustUI && this.dom.faustRoot) {
        const ui = new FaustUI({
          root: this.dom.faustRoot,
          ui: faustJson.ui || [],
          listenWindowMessage: false,
          listenWindowResize: true,
        });
        ui.paramChangeByUI = async (path, value) => {
          await this.runtime.set_param(path, value);
        };
        if (ui && typeof ui.mount === 'function') {
          ui.mount();
        }
        this.faustUiInstance = ui;
        mounted = true;
      }
    } catch (_) {
      mounted = false;
    }
    if (!mounted) {
      const paramsPayload = await this.runtime.get_params();
      if (paramsPayload?.params) {
        this.renderFallback(paramsPayload.params);
      }
    }
    return mounted;
  }

  async loadDspFromQuery() {
    if (!this.loader.textarea) return;
    const params = new URLSearchParams(window.location.search);
    const inlineCode = params.get('dsp');
    const dspUrl = params.get('dsp_url');
    if (inlineCode) {
      this.loader.textarea.value = inlineCode;
      if (this.loader.status) {
        this.loader.status.textContent = 'DSP loaded from ?dsp=. Click Compile & Start.';
      }
      return;
    }
    if (dspUrl) {
      try {
        const res = await fetch(dspUrl);
        if (!res.ok) {
          throw new Error(`Failed to load ${dspUrl} (${res.status})`);
        }
        const text = await res.text();
        this.loader.textarea.value = text;
        if (this.loader.status) {
          this.loader.status.textContent = 'DSP loaded from ?dsp_url=. Click Compile & Start.';
        }
      } catch (err) {
        if (this.loader.status) {
          this.loader.status.textContent = `DSP load failed: ${err?.message || err}`;
        }
      }
    }
  }

  /**
   * Resize a canvas to match its rendered size and DPR.
   * @param {HTMLCanvasElement} canvas
   */
  resizeCanvas(canvas) {
    if (!canvas) return;
    const rect = canvas.parentElement
      ? canvas.parentElement.getBoundingClientRect()
      : canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width * ratio));
    const height = Math.max(1, Math.floor(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  /**
   * Draw the time-domain scope waveform.
   * @param {object} scopePayload
   */
  renderScope(scopePayload) {
    const canvas = this.dom.scopeCanvas;
    if (!canvas || !scopePayload?.samples?.length) return;
    this.resizeCanvas(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height * 0.5);
    ctx.lineTo(width, height * 0.5);
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.font = `${Math.max(10, Math.round(height * 0.06))}px "IBM Plex Mono", monospace`;
    ctx.fillText('+1', 8, 14);
    ctx.fillText('0', 8, height * 0.5 + 12);
    ctx.fillText('-1', 8, height - 6);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#2d6f72';
    ctx.beginPath();
    const samples = scopePayload.samples;
    const len = samples.length;
    for (let i = 0; i < len; i++) {
      const x = (i / (len - 1)) * width;
      const y = (0.5 - samples[i] * 0.45) * height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /**
   * Draw the spectrum bars (dB).
   * @param {object} spectrumPayload
   */
  renderSpectrum(spectrumPayload) {
    const canvas = this.dom.spectrumCanvas;
    if (!canvas || !spectrumPayload) return;
    const bins = spectrumPayload.log_bins_db || spectrumPayload.bins_db;
    if (!bins || !bins.length) return;
    this.resizeCanvas(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    const minDb = spectrumPayload.min_db ?? -90;
    const maxDb = spectrumPayload.max_db ?? 0;
    const range = maxDb - minDb || 1;
    const barWidth = width / bins.length;
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(24, 8);
    ctx.lineTo(24, height - 16);
    ctx.lineTo(width - 8, height - 16);
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.font = `${Math.max(10, Math.round(height * 0.06))}px "IBM Plex Mono", monospace`;
    ctx.fillText(`${maxDb} dB`, 6, 16);
    ctx.fillText(`${minDb} dB`, 6, height - 6);
    const freqs = spectrumPayload.log_freqs_hz || spectrumPayload.freqs_hz;
    if (freqs && freqs.length) {
      const minHz = freqs[0];
      const maxHz = freqs[freqs.length - 1];
      ctx.fillText(`${Math.round(minHz)} Hz`, 32, height - 4);
      ctx.fillText(`${Math.round(maxHz)} Hz`, Math.max(32, width - 80), height - 4);
    }
    ctx.fillStyle = '#c47f3a';
    for (let i = 0; i < bins.length; i++) {
      const db = bins[i];
      const norm = Math.max(0, Math.min(1, (db - minDb) / range));
      const barHeight = norm * height;
      ctx.fillRect(i * barWidth, height - 16 - barHeight, barWidth * 0.9, barHeight);
    }
  }

  /**
   * Populate the probe selector from metrics data.
   * @param {Array<{id: number, value: number}>} probes
   */
  updateProbeOptions(probes) {
    const select = this.dom.probeSelect;
    if (!select) return;
    const ids = (probes || [])
      .map((probe) => probe?.id)
      .filter((id) => Number.isFinite(id))
      .sort((a, b) => a - b);
    const signature = ids.join(',');
    if (signature === this.probeIdsSignature && select.options.length) {
      return;
    }
    this.probeIdsSignature = signature;
    const current = select.value;
    select.innerHTML = '';
    if (!ids.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No probes';
      select.appendChild(opt);
      this.probeSeries = [];
      if (this.dom.probeLabel) this.dom.probeLabel.textContent = 'No probe selected';
      if (this.dom.probeMeta) this.dom.probeMeta.textContent = 'Value: --';
      return;
    }
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'Select…';
    select.appendChild(empty);
    ids.forEach((id) => {
      const opt = document.createElement('option');
      opt.value = String(id);
      opt.textContent = `Probe ${id}`;
      select.appendChild(opt);
    });
    if (current && ids.includes(Number(current))) {
      select.value = current;
    } else {
      select.value = '';
      this.probeSeries = [];
      if (this.dom.probeLabel) this.dom.probeLabel.textContent = 'No probe selected';
      if (this.dom.probeMeta) this.dom.probeMeta.textContent = 'Value: --';
    }
  }

  /**
   * Append the current probe value to the history buffer.
   * @param {object} metrics
   */
  updateProbeSeriesFromMetrics(metrics) {
    const selected = this.dom.probeSelect?.value;
    if (!selected || !metrics?.probes) return;
    const id = Number(selected);
    const probe = metrics.probes.find((entry) => entry.id === id);
    if (!probe) return;
    const value = Number(probe.value);
    if (!Number.isFinite(value)) return;
    this.probeSeries.push(value);
    if (this.probeSeries.length > this.probeMaxPoints) {
      this.probeSeries.shift();
    }
    if (this.dom.probeLabel) this.dom.probeLabel.textContent = `Probe ${id}`;
    if (this.dom.probeMeta) this.dom.probeMeta.textContent = `Value: ${value.toFixed(4)}`;
    this.renderProbeScope();
  }

  /**
   * Render the probe scope from the history buffer.
   */
  renderProbeScope() {
    const canvas = this.dom.probeCanvas;
    if (!canvas) return;
    this.resizeCanvas(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height * 0.5);
    ctx.lineTo(width, height * 0.5);
    ctx.stroke();
    if (!this.probeSeries.length) return;
    const max = Math.max(...this.probeSeries.map((v) => Math.abs(v))) || 1;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.font = `${Math.max(10, Math.round(height * 0.06))}px "IBM Plex Mono", monospace`;
    ctx.fillText(max.toFixed(2), 8, 14);
    ctx.fillText('0.00', 8, height * 0.5 + 12);
    ctx.fillText((-max).toFixed(2), 8, height - 6);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#c47f3a';
    ctx.beginPath();
    this.probeSeries.forEach((value, idx) => {
      const x = (idx / (this.probeSeries.length - 1)) * width;
      const y = (0.5 - (value / max) * 0.45) * height;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  /**
   * Poll probe values and update the probe UI.
   */
  async refreshProbeData() {
    const selected = this.dom.probeSelect?.value;
    let metrics = null;
    try {
      metrics = await this.runtime.get_audio_metrics(false, false);
    } catch (_) {
      return;
    }
    if (!metrics?.probes) return;
    this.updateProbeOptions(metrics.probes);
    if (selected) {
      this.updateProbeSeriesFromMetrics(metrics);
    }
  }

  /**
   * Bind probe selector changes to the history buffer.
   */
  setupProbeSelect() {
    const select = this.dom.probeSelect;
    if (!select) return;
    select.addEventListener('change', () => {
      this.probeSeries = [];
      if (this.dom.probeLabel) {
        this.dom.probeLabel.textContent = select.value ? `Probe ${select.value}` : 'No probe selected';
      }
      if (this.dom.probeMeta) {
        this.dom.probeMeta.textContent = 'Value: --';
      }
      this.refreshProbeData();
    });
  }

  /**
   * Bind the diagram panel toggle.
   */
  setupDiagramToggle() {
    const toggle = this.dom.diagramToggle;
    const body = this.dom.diagramBody;
    if (!toggle || !body) return;
    toggle.addEventListener('click', async () => {
      await this.setDiagramVisibility(!this.diagramVisible, { load: true });
    });
  }

  /**
   * Bind diagram navigation buttons.
   */
  setupDiagramNav() {
    const home = this.dom.diagramHome;
    const back = this.dom.diagramBack;
    if (home) {
      home.addEventListener('click', () => {
        if (!this.diagramSvgs || !this.diagramCurrent) return;
        if (this.diagramCurrent !== 'process.svg') {
          this.diagramHistory.push(this.diagramCurrent);
        }
        const svgString = this.diagramSvgs['process.svg'];
        if (svgString) {
          this.setDiagramSvg(svgString, 'process.svg');
        }
      });
    }
    if (back) {
      back.addEventListener('click', () => {
        if (!this.diagramSvgs || this.diagramHistory.length === 0) return;
        const previous = this.diagramHistory.pop();
        if (!previous) return;
        const svgString = this.diagramSvgs[previous];
        if (svgString) {
          this.setDiagramSvg(svgString, previous);
        }
      });
    }
  }

  /**
   * Apply a metrics payload to scope/spectrum UI.
   * @param {object} metrics
   * @param {{includeScope?: boolean, includeSpectrum?: boolean}} options
   */
  applyMetricsPayload(metrics, { includeScope, includeSpectrum } = {}) {
    if (!metrics) return;
    const channelCount = metrics.output?.channels?.length
      ?? metrics.scope?.channels?.length
      ?? metrics.spectrum?.channels?.length
      ?? 0;
    if (channelCount > 0 && channelCount !== this.scopeChannelCount) {
      this.updateScopeChannelOptions(channelCount);
    }
    const channelIndex = this.scopeChannel === 'mix' ? null : Number(this.scopeChannel);
    const shouldRenderScope = includeScope ?? !!metrics.scope;
    const shouldRenderSpectrum = includeSpectrum ?? !!metrics.spectrum;
    let renderedScope = false;
    let renderedSpectrum = false;
    if (shouldRenderScope && metrics.scope) {
      const scopePayload = Number.isFinite(channelIndex) && metrics.scope.channels
        ? metrics.scope.channels[channelIndex]
        : metrics.scope;
      if (scopePayload?.samples?.length) {
        this.renderScope(scopePayload);
        renderedScope = true;
        if (this.dom.scopeMeta) {
          const label = Number.isFinite(channelIndex) ? `Ch ${channelIndex + 1}` : 'Mix';
          this.dom.scopeMeta.textContent = `${label} · Samples ${scopePayload.samples.length}`;
        }
      }
    }
    if (shouldRenderSpectrum && metrics.spectrum) {
      const spectrumPayload = Number.isFinite(channelIndex) && metrics.spectrum.channels
        ? metrics.spectrum.channels[channelIndex]
        : metrics.spectrum;
      if (spectrumPayload) {
        this.renderSpectrum(spectrumPayload);
        renderedSpectrum = true;
        if (this.dom.scopeMeta) {
          const fft = spectrumPayload.fft_size || 2048;
          const smoothing = spectrumPayload.smoothing ?? 0;
          const label = Number.isFinite(channelIndex) ? `Ch ${channelIndex + 1}` : 'Mix';
          this.dom.scopeMeta.textContent = `${label} · FFT ${fft} · Smoothing ${smoothing}`;
        }
      }
    }
    if (this.dom.scopeLabel) {
      if (renderedScope || renderedSpectrum) {
        this.dom.scopeLabel.textContent = '';
      } else if (shouldRenderScope || shouldRenderSpectrum) {
        this.dom.scopeLabel.textContent = 'Waiting for analyser data...';
      }
    }
  }

  /**
   * Update the scope channel dropdown to match output count.
   * @param {number} channelCount
   */
  updateScopeChannelOptions(channelCount) {
    const select = this.dom.scopeChannel;
    if (!select || !Number.isFinite(channelCount)) return;
    if (channelCount === this.scopeChannelCount && select.options.length === channelCount + 1) {
      return;
    }
    this.scopeChannelCount = channelCount;
    const current = this.scopeChannel;
    select.innerHTML = '';
    const mixOpt = document.createElement('option');
    mixOpt.value = 'mix';
    mixOpt.textContent = 'Mix';
    select.appendChild(mixOpt);
    for (let i = 0; i < channelCount; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `Ch ${i + 1}`;
      select.appendChild(opt);
    }
    if (current === 'mix') {
      select.value = 'mix';
    } else {
      const idx = Number(current);
      if (Number.isFinite(idx) && idx >= 0 && idx < channelCount) {
        select.value = String(idx);
      } else {
        select.value = 'mix';
        this.scopeChannel = 'mix';
      }
    }
  }

  /**
   * Update channels based on Faust JSON output count.
   * @param {object} faustJson
   */
  updateScopeChannelsFromJson(faustJson) {
    const outputs = Number(faustJson?.outputs);
    if (!Number.isFinite(outputs) || outputs <= 0) return;
    if (outputs !== this.scopeChannelCount) {
      this.updateScopeChannelOptions(outputs);
    }
  }

  /**
   * Poll scope/spectrum metrics from the runtime.
   */
  async refreshScopeData() {
    const includeScope = this.scopeMode === 'scope' || this.scopeMode === 'both';
    const includeSpectrum = this.scopeMode === 'spectrum' || this.scopeMode === 'both';
    const perChannel = this.scopeChannel !== 'mix';
    const now = Date.now();
    const includeSpectrumNow = includeSpectrum && (
      this.scopeMode !== 'both' || now - this.lastSpectrumFetch >= this.spectrumPollMs
    );
    if (includeSpectrumNow) {
      this.lastSpectrumFetch = now;
    }
    let metrics = null;
    try {
      metrics = await this.runtime.get_audio_metrics(
        includeScope,
        includeSpectrumNow,
        perChannel,
        includeSpectrumNow ? 1024 : null,
        includeSpectrumNow ? 0.8 : null,
        includeSpectrumNow ? -90 : null,
        includeSpectrumNow ? 0 : null,
        includeScope ? 0.09 : null,
        includeSpectrumNow ? 32 : null,
      );
    } catch (_) {
      return;
    }
    if (!metrics) return;
    this.applyMetricsPayload(metrics, {
      includeScope,
      includeSpectrum: includeSpectrumNow,
    });
  }

  /**
   * Bind scope/spectrum tab buttons.
   */
  setupScopeTabs() {
    const tabs = this.dom.scopeTabs || [];
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const mode = tab.dataset.mode || 'scope';
        this.scopeMode = mode;
        tabs.forEach((btn) => btn.classList.toggle('is-active', btn === tab));
        if (this.dom.scopeCanvas && this.dom.spectrumCanvas) {
          const isScope = mode === 'scope';
          const isSpectrum = mode === 'spectrum';
          const isBoth = mode === 'both';
          this.dom.scopeCanvas.classList.toggle('is-hidden', isSpectrum);
          this.dom.spectrumCanvas.classList.toggle('is-hidden', isScope);
          if (this.dom.scopePaneScope) {
            this.dom.scopePaneScope.classList.toggle('is-hidden', isSpectrum);
          }
          if (this.dom.scopePaneSpectrum) {
            this.dom.scopePaneSpectrum.classList.toggle('is-hidden', isScope);
          }
          const container = this.dom.scopeCanvas.closest('.scope-canvas');
          container?.classList.toggle('is-dual', isBoth);
        }
        if (this.dom.scopeMeta) {
          this.dom.scopeMeta.textContent = 'FFT 1024 · Smoothing 0.8';
        }
        if (this.dom.scopeLabel) {
          this.dom.scopeLabel.textContent = 'Waiting for analyser data...';
        }
        this.refreshScopeData();
      });
    });
  }

  /**
   * Bind scope channel selector changes.
   */
  setupScopeChannel() {
    const select = this.dom.scopeChannel;
    if (!select) return;
    select.addEventListener('change', () => {
      this.scopeChannel = select.value || 'mix';
      if (this.dom.scopeLabel) {
        this.dom.scopeLabel.textContent = 'Waiting for analyser data...';
      }
      this.refreshScopeData();
    });
  }

  /**
   * Register a bridge session for MCP proxy requests.
   */
  async registerBridge() {
    const res = await fetch('/bridge/register', { method: 'POST' });
    if (!res.ok) throw new Error(`Bridge register failed (${res.status})`);
    const payload = await res.json();
    if (!payload?.session_id) throw new Error('Bridge missing session_id');
    this.bridge.sessionId = payload.session_id;
  }

  /**
   * Poll the bridge for pending MCP requests.
   */
  async pollBridgeOnce() {
    if (!this.bridge.sessionId) return;
    const url = `/bridge/poll?session_id=${encodeURIComponent(
      this.bridge.sessionId
    )}&timeout_ms=20000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Bridge poll failed (${res.status})`);
    const payload = await res.json();
    const requests = Array.isArray(payload?.requests) ? payload.requests : [];
    for (const req of requests) {
      await this.handleBridgeRequest(req);
    }
  }

  /**
   * Dispatch an MCP request into the browser runtime.
   * @param {object} req
   */
  async handleBridgeRequest(req) {
    if (!req || typeof req.id !== 'number') return;
    let result = null;
    let error = null;
    try {
      const method = req.method;
      const params = req.params || {};
      if (!method || typeof this.runtime[method] !== 'function') {
        throw new Error(`Unknown method: ${method}`);
      }
      const argOrder = {
        check_syntax: ['dsp_code', 'name'],
        compile: ['dsp_code', 'name', 'input_source', 'input_freq', 'input_file', 'hide_meters'],
        compile_and_start: [
          'dsp_code',
          'name',
          'latency_hint',
          'input_source',
          'input_freq',
          'input_file',
          'hide_meters',
        ],
        get_svg_diagrams: ['name', 'args'],
        get_param: ['path'],
        set_param: ['path', 'value'],
        set_param_values: ['values'],
        get_audio_metrics: [
          'include_scope',
          'include_spectrum',
          'per_channel',
          'fft_size',
          'smoothing',
          'min_db',
          'max_db',
          'edge_threshold',
          'log_bins',
        ],
        select_midi_input: ['index', 'name'],
      };
      const order = argOrder[method];
      if (order) {
        const args = order.map((key) => params[key]);
        result = await this.runtime[method](...args);
      } else if (Array.isArray(params)) {
        result = await this.runtime[method](...params);
      } else {
        result = await this.runtime[method]();
      }
    } catch (err) {
      error = { message: err?.message || String(err) };
    }

    if (!error) {
      try {
        await this.applyBridgeSideEffects(req.method, result);
      } catch (_) {}
    }

    await fetch('/bridge/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: req.id, result, error }),
    });
  }

  /**
   * Update UI after a bridge tool call.
   * @param {string} method
   * @param {object} result
   */
  async applyBridgeSideEffects(method, result) {
    if (method === 'compile' || method === 'compile_and_start') {
      let faustJson = result?.faust_json || result?.faustJson;
      if (!faustJson) {
        const payload = await this.runtime.get_dsp_json();
        faustJson = payload?.faust_json || payload?.faustJson;
      }
      if (faustJson) {
        await this.mountFaustUi(faustJson);
      }
      await this.updateStatusFromRuntime();
      await this.updateScopeFromRuntime();
      await this.refreshMidiInputs();
      await this.refreshProbeData();
      this.resetDiagram();
      await this.setDiagramVisibility(true, { load: true });
      this.setStatus('Running.');
    } else if (method === 'start') {
      await this.updateStatusFromRuntime();
      this.setStatus('Running.');
    } else if (method === 'stop') {
      this.renderEmptyState();
      this.setStatus('Stopped.');
    }
  }

  /**
   * Run the long-polling loop for bridge requests.
   */
  async startBridgeLoop() {
    if (this.bridge.isPolling) return;
    this.bridge.isPolling = true;
    while (this.bridge.isPolling) {
      try {
        await this.pollBridgeOnce();
      } catch (err) {
        console.warn('Bridge poll failed:', err);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.bridge.pollDelayMs)
      );
    }
  }

  /**
   * Initialize runtime, UI state, and polling loops.
   */
  async init() {
    this.restoreCompactMode();
    this.bindEvents();
    this.setupScopeTabs();
    this.setupScopeChannel();
    this.setupProbeSelect();
    this.setupDiagramToggle();
    this.setupDiagramNav();
    this.setStatus('Initializing browser runtime...');

    try {
      await this.runtime.init();
    } catch (err) {
      this.setStatus(`Runtime init failed: ${err?.message || err}`);
      return;
    }

    this.setStatus('Ready. Load a DSP to begin.');
    this.renderEmptyState();
    await this.loadDspFromQuery();

    try {
      await this.registerBridge();
      this.startBridgeLoop();
    } catch (err) {
      console.warn('Bridge unavailable:', err);
    }

    setInterval(() => this.refreshScopeData(), this.scopePollMs);
    setInterval(() => this.refreshProbeData(), this.probePollMs);
    setInterval(() => this.refreshParamValues(), this.paramPollMs);

    // TODO: implement DSP load flow and UI wiring.
    // Suggested flow:
    // 1) Parse ?dsp= URL or open a file picker for .dsp text.
    // 2) Call runtime.compile_and_start(...).
    // 3) Render Faust UI and start polling runtime metrics.
  }
}

const app = new RtBrowserUiApp();
app.init();
