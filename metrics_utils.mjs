/**
 * Helpers for audio metering, scope, and spectrum collection.
 */

/**
 * Convert dB values back to linear amplitude.
 * @param {number} db
 * @returns {number}
 */
function dbToLinear(db) {
  if (!Number.isFinite(db)) return NaN;
  return Math.pow(10, db / 20);
}

/**
 * Normalize a Faust UI path by stripping UI layout prefixes and ordering tags.
 * @param {string} path
 * @returns {string}
 */
function normalizeMeterPath(path) {
  return path
    .replace(/^\/[^/]+\//, '')
    .replace(/v:/g, '')
    .replace(/\/\[\d+\]/g, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/ch\s*(\d+)/g, 'ch$1')
    .trim();
}

/**
 * Apply analyser tuning options when provided.
 * @param {AnalyserNode} analyser
 * @param {object} opts
 */
export function applyAnalyserConfig(analyser, opts = {}) {
  if (!analyser) return;
  const { fft_size, smoothing, min_db, max_db } = opts;
  if (Number.isFinite(fft_size)) {
    analyser.fftSize = fft_size;
  }
  if (typeof smoothing === 'number') {
    analyser.smoothingTimeConstant = smoothing;
  }
  if (typeof min_db === 'number') {
    analyser.minDecibels = min_db;
  }
  if (typeof max_db === 'number') {
    analyser.maxDecibels = max_db;
  }
}

/**
 * Compute output metering (RMS/Peak) from cached bargraph values.
 * @returns {{ input: { channels: Array<{ rms: number|null, peak: number|null }> }, output: { mix: { rms: number, peak: number, hasNaN: boolean }, channels: Array<{ rms: number|null, peak: number|null, hasNaN?: boolean }> }, probes: Array<{ id: number, value: number }> }}
 */
export function computeAudioMetrics(
  outputParamsCache = {},
  meterUnitsByPath = {},
  meterProbesByPath = {},
) {
  const inputPeakRegex = /Input Meters\/Peak ch(\d+)/;
  const inputRmsRegex = /Input Meters\/RMS ch(\d+)/;
  const peakRegex = /Output Meters\/Peak ch(\d+)/;
  const rmsRegex = /Output Meters\/RMS ch(\d+)/;
  const mixPeakRegex = /Output Meters\/Mix Peak/;
  const mixRmsRegex = /Output Meters\/Mix RMS/;
  const inputChannels = [];
  const outputChannels = [];
  const probes = {};
  let hasNaN = false;
  let mixRms = null;
  let mixPeak = null;

  const applyChannelValue = (channels, idx, isPeak, value, includeNaNFlag) => {
    if (!channels[idx]) {
      channels[idx] = includeNaNFlag
        ? { rms: null, peak: null, hasNaN: false }
        : { rms: null, peak: null };
    }
    if (isPeak) {
      channels[idx].peak = value;
    } else {
      channels[idx].rms = value;
    }
  };

  const applyOutputChannelValue = (idx, isPeak, value) => {
    applyChannelValue(outputChannels, idx, isPeak, value, true);
    if (Number.isNaN(value)) {
      outputChannels[idx].hasNaN = true;
    }
  };

  for (const [path, value] of Object.entries(outputParamsCache)) {
    const normalizedPath = normalizeMeterPath(path);
    const unit = meterUnitsByPath[path] ?? null;
    const mappedValue = unit === 'dB' ? dbToLinear(value) : value;
    const probeId = meterProbesByPath[path];
    if (Number.isFinite(probeId)) {
      probes[probeId] = mappedValue;
    }
    const inputPeakMatch = normalizedPath.match(inputPeakRegex);
    const inputRmsMatch = normalizedPath.match(inputRmsRegex);
    if (inputPeakMatch || inputRmsMatch) {
      const idx = parseInt((inputPeakMatch || inputRmsMatch)[1], 10);
      if (!Number.isFinite(idx)) continue;
      applyChannelValue(inputChannels, idx, !!inputPeakMatch, mappedValue, false);
      if (Number.isNaN(mappedValue)) hasNaN = true;
      continue;
    }
    if (mixPeakRegex.test(normalizedPath)) {
      const peak = mappedValue;
      mixPeak = peak;
      if (Number.isNaN(peak)) hasNaN = true;
      continue;
    }
    if (mixRmsRegex.test(normalizedPath)) {
      const rms = mappedValue;
      mixRms = rms;
      if (Number.isNaN(rms)) hasNaN = true;
      continue;
    }
    const peakMatch = normalizedPath.match(peakRegex);
    const rmsMatch = normalizedPath.match(rmsRegex);
    if (!peakMatch && !rmsMatch) continue;
    const idx = parseInt((peakMatch || rmsMatch)[1], 10);
    if (!Number.isFinite(idx)) continue;
    if (peakMatch) {
      applyOutputChannelValue(idx, true, mappedValue);
      if (Number.isNaN(mappedValue)) hasNaN = true;
    }
    if (rmsMatch) {
      applyOutputChannelValue(idx, false, mappedValue);
      if (Number.isNaN(mappedValue)) hasNaN = true;
    }
  }

  const definedInputChannels = inputChannels.filter(Boolean);
  const definedOutputChannels = outputChannels.filter(Boolean);

  const resolvedMixRms = mixRms ?? 0;
  const resolvedMixPeak = mixPeak ?? 0;
  const probeEntries = Object.entries(probes)
    .map(([id, value]) => ({ id: Number(id), value }))
    .sort((a, b) => a.id - b.id);

  return {
    input: {
      channels: definedInputChannels,
    },
    output: {
      mix: {
        rms: resolvedMixRms,
        peak: resolvedMixPeak,
        hasNaN,
      },
      channels: definedOutputChannels,
    },
    probes: probeEntries,
  };
}

/**
 * Collect a window of time-domain samples aligned to a rising edge.
 * @param {AnalyserNode} analyser
 * @param {number} edgeThreshold
 * @returns {{samples: number[], rising_edge_index: number}}
 */
function collectScopeData(analyser, edgeThreshold) {
  const sampleCount = analyser.frequencyBinCount;
  const timeData = new Float32Array(sampleCount);
  analyser.getFloatTimeDomainData(timeData);

  let risingEdge = 0;
  while (
    timeData[risingEdge] > 0 &&
    risingEdge < timeData.length
  ) {
    risingEdge++;
  }

  if (risingEdge >= timeData.length) risingEdge = 0;

  while (
    timeData[risingEdge] < edgeThreshold &&
    risingEdge < timeData.length
  ) {
    risingEdge++;
  }

  if (risingEdge >= timeData.length) risingEdge = 0;

  const samples = new Array(timeData.length);
  for (let i = 0; i < timeData.length; i++) {
    samples[i] = timeData[(risingEdge + i) % timeData.length];
  }

  return { samples, rising_edge_index: risingEdge };
}

/**
 * Collect spectrum bins (dB) with optional log rebinning.
 * @param {AnalyserNode} analyser
 * @param {AudioContext|null} audioContext
 * @param {number|undefined|null} logBins
 * @returns {object}
 */
function collectSpectrumData(analyser, audioContext, logBins) {
  const binCount = analyser.frequencyBinCount;
  const freqData = new Float32Array(binCount);
  const freqs = new Array(binCount);
  const fftSize = analyser.fftSize;
  const sampleRate = audioContext?.sampleRate ?? 44100;

  if (typeof analyser.getFloatFrequencyData === 'function') {
    analyser.getFloatFrequencyData(freqData);
  } else {
    const byteData = new Uint8Array(binCount);
    analyser.getByteFrequencyData(byteData);
    for (let i = 0; i < binCount; i++) {
      freqData[i] = (byteData[i] / 255) * (analyser.maxDecibels - analyser.minDecibels) + analyser.minDecibels;
    }
  }

  for (let i = 0; i < binCount; i++) {
    freqs[i] = (i * sampleRate) / fftSize;
  }

  const spectrum = {
    fft_size: fftSize,
    min_db: analyser.minDecibels,
    max_db: analyser.maxDecibels,
    smoothing: analyser.smoothingTimeConstant,
    bins_db: Array.from(freqData),
    freqs_hz: freqs,
  };

  if (Number.isFinite(logBins) && logBins > 0) {
    const logBinCount = Math.floor(logBins);
    const logBinsDb = new Array(logBinCount).fill(-Infinity);
    const logFreqs = new Array(logBinCount).fill(0);
    const minFreq = 20;
    const maxFreq = sampleRate / 2;
    for (let i = 0; i < logBinCount; i++) {
      const t0 = i / logBinCount;
      const t1 = (i + 1) / logBinCount;
      const f0 = minFreq * Math.pow(maxFreq / minFreq, t0);
      const f1 = minFreq * Math.pow(maxFreq / minFreq, t1);
      logFreqs[i] = Math.sqrt(f0 * f1);
      const start = Math.max(0, Math.floor((f0 / maxFreq) * binCount));
      const end = Math.min(binCount - 1, Math.ceil((f1 / maxFreq) * binCount));
      let maxVal = -Infinity;
      for (let b = start; b <= end; b++) {
        if (freqData[b] > maxVal) maxVal = freqData[b];
      }
      logBinsDb[i] = maxVal;
    }
    spectrum.log_bins_db = logBinsDb;
    spectrum.log_freqs_hz = logFreqs;
  }

  return spectrum;
}

/**
 * Build scope payload for get_audio_metrics (including samples + metadata).
 * @param {AnalyserNode} analyser
 * @param {object} opts
 * @returns {object}
 */
export function collectScopePayload(analyser, {
  edge_threshold,
  sample_rate,
}) {
  const scope = collectScopeData(analyser, edge_threshold);
  return {
    edge_threshold,
    sample_rate,
    samples: scope.samples,
    rising_edge_index: scope.rising_edge_index,
  };
}

/**
 * Build spectrum payload for get_audio_metrics (including bins + metadata).
 * @param {AnalyserNode} analyser
 * @param {AudioContext|null} audioContext
 * @param {object} opts
 * @returns {object}
 */
export function collectSpectrumPayload(analyser, audioContext, {
  log_bins,
}) {
  return collectSpectrumData(analyser, audioContext, log_bins);
}

/**
 * Normalize get_audio_metrics options with defaults.
 * @param {object} opts
 * @returns {object}
 */
export function normalizeAudioMetricsOptions(opts = {}) {
  const {
    include_scope = false,
    include_spectrum = false,
    per_channel = false,
    fft_size,
    smoothing,
    min_db,
    max_db,
    edge_threshold = 0.09,
    log_bins,
  } = opts;
  return {
    include_scope,
    include_spectrum,
    per_channel,
    fft_size,
    smoothing,
    min_db,
    max_db,
    edge_threshold,
    log_bins,
  };
}
