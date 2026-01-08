// rt-ui client: renders Faust UI, keeps params/meters in sync, and manages MIDI/scopes/probes.
class RtUiApp {
  /**
   * @param {object} [options]
   * @param {number} [options.paramPollMs]
   * @param {number} [options.midiPollMs]
   * @param {number} [options.dspPollMs]
   * @param {number} [options.scopePollMs]
   * @param {number} [options.spectrumPollMs]
   * @param {number} [options.probePollMs]
   */
  constructor(options = {}) {
    this.paramPollMs = options.paramPollMs || 200;
    this.midiPollMs = options.midiPollMs || 2000;
    this.dspPollMs = options.dspPollMs || 500;
    this.scopePollMs = options.scopePollMs || 400;
    this.spectrumPollMs = options.spectrumPollMs || 1200;
    this.probePollMs = options.probePollMs || 800;
    // Output scope/spectrum state.
    this.scopeMode = 'scope';
    this.scopeChannel = 'mix';
    this.scopeChannelCount = 0;
    // Probe scope history (probe values sampled over time).
    this.probeSeries = [];
    this.probeMaxPoints = 200;
    this.probeIdsSignature = '';
    this.lastJsonSignature = null;
    this.faustUiInstance = null;
    this.faustUiLayout = null;
    this.fallbackControls = new Map();
    this.dom = {
      appShell: document.querySelector('.app-shell'),
      status: document.getElementById('status'),
      dspName: document.getElementById('dsp-name'),
      faustRoot: document.getElementById('faust-ui-root'),
      fallback: document.getElementById('fallback-ui'),
      faustContainer: document.getElementById('faust-ui-container'),
      midiPanel: document.getElementById('midi-panel'),
      midiSelect: document.getElementById('midi-select'),
      midiStatus: document.getElementById('midi-status'),
      polyActive: document.getElementById('poly-active'),
      compactToggle: document.getElementById('compact-toggle'),
      // Scope/spectrum controls.
      scopeTabs: Array.from(document.querySelectorAll('.scope-tab')),
      scopeCanvas: document.getElementById('scope-canvas'),
      spectrumCanvas: document.getElementById('spectrum-canvas'),
      scopeLabel: document.getElementById('scope-label'),
      scopeMeta: document.getElementById('scope-meta'),
      scopeChannel: document.getElementById('scope-channel'),
      scopePaneScope: document.querySelector('.scope-pane-scope'),
      scopePaneSpectrum: document.querySelector('.scope-pane-spectrum'),
      // Probe panel controls.
      probeSelect: document.getElementById('probe-select'),
      probeCanvas: document.getElementById('probe-canvas'),
      probeLabel: document.getElementById('probe-label'),
      probeMeta: document.getElementById('probe-meta'),
    };
    this.lastSpectrumFetch = 0;
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

  // Apply compact mode and persist it in localStorage.
  setCompactMode(enabled) {
    const root = this.dom.appShell;
    if (!root) return;
    root.classList.toggle('is-compact', enabled);
    if (this.dom.compactToggle) {
      this.dom.compactToggle.classList.toggle('is-active', enabled);
      this.dom.compactToggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    }
    try {
      localStorage.setItem('rt-ui-compact', enabled ? '1' : '0');
    } catch (_) {}
    this.updateFaustUiScale();
  }

  // Restore compact mode from localStorage on load.
  restoreCompactMode() {
    try {
      const value = localStorage.getItem('rt-ui-compact');
      this.setCompactMode(value === '1');
    } catch (_) {
      this.setCompactMode(false);
    }
  }

  // Send a parameter update to the UI server.
  async setParam(path, value) {
    await fetch('/param', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, value })
    });
  }

  // Scale the Faust UI to fit within the container.
  updateFaustUiScale() {
    if (!this.faustUiLayout || !this.dom.faustContainer || !this.dom.faustRoot) return;
    const { minWidth, minHeight } = this.faustUiLayout;
    if (!minWidth || !minHeight) return;
    const rect = this.dom.faustContainer.getBoundingClientRect();
    const scale = Math.min(rect.width / minWidth, rect.height / minHeight, 1);
    this.dom.faustRoot.style.transform = `scale(${scale})`;
    this.dom.faustRoot.style.transformOrigin = 'center center';
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

  // Fetch scope/spectrum/probe data from the UI server.
  async fetchAudioMetrics(params) {
    const query = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      query.set(key, String(value));
    });
    const res = await fetch(`/audio-metrics?${query.toString()}`);
    if (!res.ok) return null;
    return res.json();
  }

  // Update probe selector from get_audio_metrics().probes.
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

  // Draw a probe scope from the rolling history buffer.
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

  // Update available channel options based on analyser payload.
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

  // Update channel options based on Faust JSON output count.
  updateScopeChannelsFromJson(faustJson) {
    const outputs = Number(faustJson?.outputs);
    if (!Number.isFinite(outputs) || outputs <= 0) return;
    if (outputs !== this.scopeChannelCount) {
      this.updateScopeChannelOptions(outputs);
    }
  }

  // Update the MIDI status text and styling.
  setMidiStatus(state, text) {
    const status = this.dom.midiStatus;
    if (!status) return;
    status.textContent = text || '';
    status.dataset.state = state || '';
    if (this.dom.midiPanel) {
      this.dom.midiPanel.dataset.state = state || '';
    }
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
    try {
      const payload = await this.fetchMidiInputs();
      if (!payload || payload.status !== 'ok') {
        this.setMidiStatus('error', payload?.error || 'MIDI unavailable');
        return;
      }
      if (!payload.available) {
        this.setMidiStatus('error', payload.error || 'MIDI backend not available');
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
      if (selectedIndex !== '') {
        this.setMidiStatus('connected', 'connected');
      } else if (!options.length) {
        this.setMidiStatus('empty', 'no devices');
      } else {
        this.setMidiStatus('idle', '');
      }
    } catch (err) {
      this.setMidiStatus('error', 'MIDI unavailable');
    }
  }

  // Bind UI selection changes to the MIDI selection endpoint.
  setupMidiSelect() {
    const select = this.dom.midiSelect;
    select.addEventListener('change', async () => {
      const value = select.value;
      if (!value) {
        this.setMidiStatus('idle', '');
        return;
      }
      try {
        const response = await this.selectMidiInput({ index: Number(value) });
        if (response?.status === 'ok') {
          this.setMidiStatus('connected', 'connected');
        } else if (response?.error) {
          this.setMidiStatus('error', response.error);
        } else {
          this.setMidiStatus('error', 'error');
        }
      } catch (err) {
        this.setMidiStatus('error', 'error');
      }
    });
  }

  // Resize a canvas to match its displayed size.
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

  // Draw time-domain scope samples.
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

  // Draw spectrum bins (dB) as vertical bars.
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

  // Update scope/spectrum UI based on the selected mode.
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
    const metrics = await this.fetchAudioMetrics({
      include_scope: includeScope ? 'true' : 'false',
      include_spectrum: includeSpectrumNow ? 'true' : 'false',
      per_channel: perChannel ? 'true' : undefined,
      fft_size: includeSpectrumNow ? '1024' : undefined,
      smoothing: includeSpectrumNow ? '0.8' : undefined,
      min_db: includeSpectrumNow ? '-90' : undefined,
      max_db: includeSpectrumNow ? '0' : undefined,
      edge_threshold: includeScope ? '0.09' : undefined,
      log_bins: includeSpectrumNow ? '32' : undefined,
    });
    if (!metrics) return;
    if (metrics.probes) {
      this.updateProbeOptions(metrics.probes);
    }
    const channelCount = metrics.output?.channels?.length
      ?? metrics.scope?.channels?.length
      ?? metrics.spectrum?.channels?.length
      ?? 0;
    if (channelCount > 0 && channelCount !== this.scopeChannelCount) {
      this.updateScopeChannelOptions(channelCount);
    }
    const channelIndex = this.scopeChannel === 'mix' ? null : Number(this.scopeChannel);
    let renderedScope = false;
    let renderedSpectrum = false;
    if (includeScope && metrics.scope) {
      const scopePayload = Number.isFinite(channelIndex) && metrics.scope.channels
        ? metrics.scope.channels[channelIndex]
        : metrics.scope;
      this.renderScope(scopePayload);
      renderedScope = true;
      if (this.dom.scopeLabel) this.dom.scopeLabel.textContent = '';
      if (this.dom.scopeMeta) {
        const label = Number.isFinite(channelIndex) ? `Ch ${channelIndex + 1}` : 'Mix';
        this.dom.scopeMeta.textContent = `${label} · Samples ${scopePayload.samples.length}`;
      }
      if (!includeSpectrum) return;
    }
    if (includeSpectrumNow && metrics.spectrum) {
      const spectrumPayload = Number.isFinite(channelIndex) && metrics.spectrum.channels
        ? metrics.spectrum.channels[channelIndex]
        : metrics.spectrum;
      this.renderSpectrum(spectrumPayload);
      renderedSpectrum = true;
      if (this.dom.scopeLabel) this.dom.scopeLabel.textContent = '';
      if (this.dom.scopeMeta) {
        const fft = spectrumPayload.fft_size || 2048;
        const smoothing = spectrumPayload.smoothing ?? 0;
        const label = Number.isFinite(channelIndex) ? `Ch ${channelIndex + 1}` : 'Mix';
        this.dom.scopeMeta.textContent = `${label} · FFT ${fft} · Smoothing ${smoothing}`;
      }
      if (!includeScope) return;
    }
    if (this.dom.scopeLabel && !renderedScope && !renderedSpectrum) {
      this.dom.scopeLabel.textContent = 'Waiting for analyser data...';
    }
  }

  // Handle scope/spectrum tab selection.
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

  // Bind channel selector to scope/spectrum rendering.
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

  // Bind probe selector to the probe scope history buffer.
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
    });
  }

  // Poll probe values and update the rolling scope (low rate to avoid UI churn).
  async refreshProbeData() {
    const selected = this.dom.probeSelect?.value;
    if (!selected) return;
    const metrics = await this.fetchAudioMetrics({});
    if (!metrics?.probes) return;
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
      root.style.width = `${ui.minWidth}px`;
      root.style.height = `${ui.minHeight}px`;
      if (typeof ui.resize === 'function') {
        ui.resize();
      }
      this.faustUiInstance = ui;
      this.faustUiLayout = { minWidth: ui.minWidth, minHeight: ui.minHeight };
      this.updateFaustUiScale();
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
      this.updateScopeChannelsFromJson(json);
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
          this.updateScopeChannelsFromJson(json);
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

    // High-rate UI sync (params), lower-rate analysis (scope/spectrum/probes).
    setInterval(() => this.refreshParamValues(), this.paramPollMs);
    setInterval(() => this.refreshMidiInputs(), this.midiPollMs);
    setInterval(() => this.refreshScopeData(), this.scopePollMs);
    setInterval(() => this.refreshProbeData(), this.probePollMs);
  }

  // Bootstrap UI, polling loops, and MIDI selector.
  async start() {
    if (this.dom.compactToggle) {
      this.dom.compactToggle.addEventListener('click', () => {
        const enabled = !this.dom.appShell?.classList.contains('is-compact');
        this.setCompactMode(enabled);
      });
    }
    this.restoreCompactMode();
    window.addEventListener('resize', () => this.updateFaustUiScale());
    this.setupScopeTabs();
    this.setupScopeChannel();
    this.setupProbeSelect();
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
