// rt-ui client: renders Faust UI, keeps params/meters in sync, and manages MIDI input selection.
class RtUiApp {
  /**
   * @param {object} [options]
   * @param {number} [options.paramPollMs]
   * @param {number} [options.midiPollMs]
   * @param {number} [options.dspPollMs]
   */
  constructor(options = {}) {
    this.paramPollMs = options.paramPollMs || 200;
    this.midiPollMs = options.midiPollMs || 2000;
    this.dspPollMs = options.dspPollMs || 500;
    this.lastJsonSignature = null;
    this.faustUiInstance = null;
    this.fallbackControls = new Map();
    this.dom = {
      status: document.getElementById('status'),
      dspName: document.getElementById('dsp-name'),
      faustRoot: document.getElementById('faust-ui-root'),
      fallback: document.getElementById('fallback-ui'),
      midiSelect: document.getElementById('midi-select'),
      midiStatus: document.getElementById('midi-status'),
      polyActive: document.getElementById('poly-active'),
    };
  }

  // Format the DSP name with mono/poly context when available.
  formatDspLabel(statusJson) {
    const name = statusJson?.name;
    if (!name) return 'DSP: (none)';
    if (typeof statusJson?.poly_nvoices === 'number' && statusJson.poly_nvoices > 0) {
      return `DSP: ${name} (Poly ${statusJson.poly_nvoices})`;
    }
    return `DSP: ${name} (Mono)`;
  }

  // Update the active voice count display (polyphonic DSPs only).
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

  // Fetch JSON from the UI server and raise on HTTP errors.
  async fetchJson(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
    return res.json();
  }

  // Send a parameter update to the UI server.
  async setParam(path, value) {
    await fetch('/param', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, value })
    });
  }

  // Render a basic slider UI when the Faust UI bundle is unavailable.
  renderFallback(params) {
    const container = this.dom.fallback;
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
      value.textContent = input.value;
      input.addEventListener('input', async () => {
        value.textContent = input.value;
        await this.setParam(param.path, Number(input.value));
      });
      wrap.append(label, input, value);
      container.append(wrap);
      this.fallbackControls.set(param.path, { input, value });
    });
  }

  // Fetch current parameter values from the UI server.
  async fetchParamValues() {
    const res = await fetch('/param-values');
    if (!res.ok) return null;
    return res.json();
  }

  // Refresh UI controls with the latest parameter values.
  async refreshParamValues() {
    try {
      const values = await this.fetchParamValues();
      this.applyParamValues(values?.values);
    } catch (err) {
      console.warn('Param refresh failed:', err);
    }
  }

  // Apply parameter values to the Faust UI or fallback controls.
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
        fallback.value.textContent = value;
      }
    });
  }

  // Fetch available MIDI inputs from the UI server.
  async fetchMidiInputs() {
    const res = await fetch('/midi/inputs');
    if (!res.ok) return null;
    return res.json();
  }

  // Request the UI server to select a MIDI input by index or name.
  async selectMidiInput(payload) {
    const res = await fetch('/midi/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} /midi/select`);
    return res.json();
  }

  // Refresh MIDI device list and selection state.
  async refreshMidiInputs() {
    const select = this.dom.midiSelect;
    const status = this.dom.midiStatus;
    try {
      const payload = await this.fetchMidiInputs();
      if (!payload || payload.status !== 'ok') {
        status.textContent = payload?.error || 'MIDI unavailable';
        return;
      }
      if (!payload.available) {
        status.textContent = payload.error || 'MIDI backend not available';
      }
      const selectedIndex = payload.selected?.index ?? '';
      const options = payload.inputs || [];
      const current = select.value;
      select.innerHTML = '';
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = options.length ? 'Select…' : 'No devices';
      select.appendChild(empty);
      options.forEach((input) => {
        const opt = document.createElement('option');
        opt.value = String(input.index);
        opt.textContent = input.name;
        if (String(input.index) === String(selectedIndex)) {
          opt.selected = true;
        }
        select.appendChild(opt);
      });
      if (current && current !== select.value) {
        const match = Array.from(select.options).find((opt) => opt.value === current);
        if (match) match.selected = true;
      }
      status.textContent = selectedIndex !== '' ? 'connected' : status.textContent;
    } catch (err) {
      status.textContent = 'MIDI unavailable';
    }
  }

  // Bind UI selection changes to the MIDI selection endpoint.
  setupMidiSelect() {
    const select = this.dom.midiSelect;
    const status = this.dom.midiStatus;
    select.addEventListener('change', async () => {
      const value = select.value;
      if (!value) {
        status.textContent = '';
        return;
      }
      try {
        const response = await this.selectMidiInput({ index: Number(value) });
        if (response?.status === 'ok') {
          status.textContent = 'connected';
        } else if (response?.error) {
          status.textContent = response.error;
        } else {
          status.textContent = 'error';
        }
      } catch (err) {
        status.textContent = 'error';
      }
    });
  }

  // Create and mount the Faust UI bundle if available.
  async tryFaustUI(faustJson) {
    try {
      const module = await import('/faust-ui/index.js');
      const FaustUI = module.default || module.FaustUI || null;
      if (!FaustUI) return false;
      const root = this.dom.faustRoot;
      root.innerHTML = '';
      const ui = new FaustUI({
        root,
        ui: faustJson.ui || [],
        listenWindowMessage: false,
        listenWindowResize: true,
      });
      ui.paramChangeByUI = async (path, value) => {
        await this.setParam(path, value);
      };
      if (ui && typeof ui.mount === 'function') {
        ui.mount();
      }
      root.style.minWidth = `${ui.minWidth}px`;
      root.style.minHeight = `${ui.minHeight}px`;
      if (typeof ui.resize === 'function') {
        ui.resize();
      }
      this.faustUiInstance = ui;
      return true;
    } catch (err) {
      this.dom.status.textContent = `faust-ui load failed: ${err}`;
      this.faustUiInstance = null;
      return false;
    }
  }

  // Render the UI once and return a JSON signature used for change detection.
  async renderOnce() {
    try {
      const statusJson = await this.fetchJson('/status');
      this.dom.dspName.textContent = this.formatDspLabel(statusJson);
      this.updatePolyActivity(statusJson);
      const json = await this.fetchJson('/json');
      const params = await this.fetchJson('/params');
      const usedFaustUI = await this.tryFaustUI(json);
      if (!usedFaustUI) {
        this.renderFallback(params.params || params);
      }
      const values = await this.fetchParamValues();
      this.applyParamValues(values?.values);
      return JSON.stringify({ name: statusJson.name, json });
    } catch (err) {
      this.dom.status.textContent = String(err);
      return null;
    }
  }

  // Start polling loops for DSP changes, param values, and MIDI devices.
  startPolling() {
    setInterval(async () => {
      try {
        const json = await this.fetchJson('/json');
        const statusJson = await this.fetchJson('/status');
        const current = JSON.stringify({ name: statusJson.name, json });
        if (current && current !== this.lastJsonSignature) {
          const params = await this.fetchJson('/params');
          this.dom.dspName.textContent = this.formatDspLabel(statusJson);
          this.updatePolyActivity(statusJson);
          const usedFaustUI = await this.tryFaustUI(json);
          if (!usedFaustUI) {
            this.renderFallback(params.params || params);
          }
          this.lastJsonSignature = current;
        }
        if (current && current === this.lastJsonSignature) {
          this.updatePolyActivity(statusJson);
        }
      } catch (err) {
        this.dom.status.textContent = String(err);
      }
    }, this.dspPollMs);

    setInterval(() => this.refreshParamValues(), this.paramPollMs);
    setInterval(() => this.refreshMidiInputs(), this.midiPollMs);
  }

  // Bootstrap UI, polling loops, and MIDI selector.
  async start() {
    this.setupMidiSelect();
    await this.refreshMidiInputs();
    this.lastJsonSignature = await this.renderOnce();
    this.startPolling();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new RtUiApp();
  app.start();
});
