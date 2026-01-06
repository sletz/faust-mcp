/**
 * Helpers for DSP wrapping and Faust UI metadata extraction.
 */

/**
 * Wrap DSP code with a generated test input signal when requested.
 * @param {string} dspCode
 * @param {string} inputSource
 * @param {number|undefined|null} inputFreq
 * @param {string|undefined|null} inputFile
 * @param {boolean} hideMeters
 * @returns {string}
 */
export function wrapTestInputs(dspCode, inputSource, inputFreq, inputFile, hideMeters) {
  const source = (inputSource || 'none').trim().toLowerCase();
  const hiddenTag = hideMeters ? '[hidden:1]' : '';

  // Shared meter definitions to keep wrapper variants in sync.
  const buildMeteringDefs = (includeInputMeters) => {
    const defs = [
      '// Metering (Peak + RMS per channel)',
      'mcp_lin2db(x) = ba.linear2db(max(x, 0.00001));',
    ];
    if (includeInputMeters) {
      defs.push(
        '// Input meters',
        `mcp_in_peak(i) = _ <: (_, (an.peak_envelope(0.1) : mcp_lin2db : hbargraph("v:[0]Input Meters/[0]Peak/ch%2i${hiddenTag}[unit:dB]", -60, 0))) : attach;`,
        `mcp_in_rms(i) = _ <: (_, (an.rms_envelope_rect(0.1) : mcp_lin2db : hbargraph("v:[0]Input Meters/[1]RMS/ch%2i${hiddenTag}[unit:dB]", -60, 0))) : attach;`,
        'mcp_in_meter(i) = mcp_in_peak(i) : mcp_in_rms(i);',
        'mcp_input_meters(FX) = par(i, inputs(FX), mcp_in_meter(i));',
      );
    }
    defs.push(
      '// Output meters',
      `mcp_out_peak(i) = _ <: (_, (an.peak_envelope(0.1) : mcp_lin2db : hbargraph("v:[99]Output Meters/[0]Peak/ch%2i${hiddenTag}[unit:dB]", -60, 0))) : attach;`,
      `mcp_out_rms(i) = _ <: (_, (an.rms_envelope_rect(0.1) : mcp_lin2db : hbargraph("v:[99]Output Meters/[1]RMS/ch%2i${hiddenTag}[unit:dB]", -60, 0))) : attach;`,
      'mcp_out_meter(i) = mcp_out_peak(i) : mcp_out_rms(i);',
      `mcp_out_mix_peak = _ <: (_, (an.peak_envelope(0.1) : mcp_lin2db : hbargraph("v:[99]Output Meters/[2]Mix Peak${hiddenTag}[unit:dB]", -60, 0))) : attach;`,
      `mcp_out_mix_rms = _ <: (_, (an.rms_envelope_rect(0.1) : mcp_lin2db : hbargraph("v:[99]Output Meters/[3]Mix RMS${hiddenTag}[unit:dB]", -60, 0))) : attach;`,
      'mcp_out_mix_meter = mcp_out_mix_peak : mcp_out_mix_rms;',
      'mcp_out_mix_signal(FX) = par(i, outputs(FX), _) :> _;',
      'mcp_output_meters(FX) = par(i, outputs(FX), mcp_out_meter(i)), (mcp_out_mix_signal(FX) : mcp_out_mix_meter);',
      '',
    );
    return defs;
  };
  if (source === 'none') {
    const indented = String(dspCode)
      .split('\n')
      .map((line) => (line.trim() ? `  ${line}` : line))
      .join('\n');

    const meteringDefs = buildMeteringDefs(false);

    const wrappedCode = [
      'import("stdfaust.lib");',
      '',
      ...meteringDefs,
      '// User DSP',
      'mcp_dsp = environment {',
      indented,
      '};',
      'process = mcp_dsp.process <: mcp_output_meters(mcp_dsp.process);',
    ].join('\n');

    return { code: wrappedCode, useExternalInput: false };
  }
  if (source !== 'sine' && source !== 'noise' && source !== 'file') {
    throw new Error(`Unsupported input_source: ${inputSource}`);
  }

  // For file input, check if it's HTTP URL or local file
  if (source === 'file') {
    if (!inputFile) {
      throw new Error('input_file is required for input_source=file');
    }

    const indented = String(dspCode)
      .split('\n')
      .map((line) => (line.trim() ? `  ${line}` : line))
      .join('\n');

    // Adaptive metering for N inputs/outputs
    const meteringDefs = buildMeteringDefs(true);

    // HTTP/HTTPS URLs: use FAUST soundfile (works with fetch)
    if (inputFile.startsWith('http://') || inputFile.startsWith('https://')) {
      const escaped = String(inputFile).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

      const wrappedCode = [
        'import("stdfaust.lib");',
        '',
        ...meteringDefs,
        'mcp_so = library("soundfiles.lib");',
        `mcp_sf = soundfile("sound[url:{'${escaped}'}]", 1);`,
        'mcp_play = mcp_so.soundfile_play(mcp_sf);',
        '// User DSP',
        'mcp_dsp = environment {',
        indented,
        '};',
        'process = mcp_play <: mcp_input_meters(mcp_dsp.process) : mcp_output_meters(mcp_dsp.process);',
      ].join('\n');

      return { code: wrappedCode, useExternalInput: false };
    }

    const wrappedCode = [
      'import("stdfaust.lib");',
      '',
      ...meteringDefs,
      '// User DSP',
      'mcp_dsp = environment {',
      indented,
      '};',
      'process = _ <: mcp_input_meters(mcp_dsp.process) : mcp_output_meters(mcp_dsp.process);',
    ].join('\n');

    return { code: wrappedCode, useExternalInput: true, inputFile };
  }

  const inputSignal = source === 'sine'
    ? `os.osc(${inputFreq || 440})`
    : 'no.noise';

  const indented = String(dspCode)
    .split('\n')
    .map((line) => (line.trim() ? `  ${line}` : line))
    .join('\n');

  const meteringDefs = buildMeteringDefs(true);

  const wrappedCode = [
    'import("stdfaust.lib");',
    '',
    ...meteringDefs,
    '// User DSP',
    'mcp_dsp = environment {',
    indented,
    '};',
    `mcp_input = ${inputSignal};`,
    'process = mcp_input <: mcp_input_meters(mcp_dsp.process) : mcp_output_meters(mcp_dsp.process);',
  ].join('\n');

  return { code: wrappedCode, useExternalInput: false };
}

/**
 * Normalize Faust metadata array into a flat key/value map.
 * @param {Array<object>|undefined|null} meta
 * @returns {Record<string, string>}
 */
function metaToObject(meta) {
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
 * Collect bargraph metadata values keyed by address.
 * @param {Array<object>|undefined|null} items
 * @param {Record<string, any>} acc
 * @param {string} metaKey
 * @param {(value: string) => any} mapValue
 */
function collectBargraphMeta(items, acc, metaKey, mapValue) {
  for (const item of items || []) {
    if (!item || typeof item !== 'object') continue;
    if (item.items) {
      collectBargraphMeta(item.items, acc, metaKey, mapValue);
      continue;
    }

    const type = item.type;
    const isBargraph = ['hbargraph', 'vbargraph'].includes(type);
    if (!isBargraph) continue;

    const meta = metaToObject(item.meta);
    if (typeof item.address !== 'string') continue;
    if (!(metaKey in meta)) continue;
    const mapped = mapValue(meta[metaKey]);
    if (mapped === undefined) continue;
    acc[item.address] = mapped;
  }
}

/**
 * Extract parameter descriptors from a Faust JSON object.
 * @param {object|undefined|null} jsonObj
 * @returns {Array<object>}
 */
export function extractParamsFromJson(jsonObj) {
  const params = [];
  collectParams(jsonObj?.ui || [], params);
  return params;
}

/**
 * Extract bargraph units (by address) from a Faust JSON object.
 * @param {object|undefined|null} jsonObj
 * @returns {Object<string, string|null>}
 */
export function extractBargraphUnits(jsonObj) {
  const units = {};
  collectBargraphMeta(jsonObj?.ui || [], units, 'unit', (value) => value ?? null);
  return units;
}

/**
 * Extract bargraph probes (by address) from a Faust JSON object.
 * @param {object|undefined|null} jsonObj
 * @returns {Object<string, number>}
 */
export function extractBargraphProbes(jsonObj) {
  const probes = {};
  collectBargraphMeta(jsonObj?.ui || [], probes, 'probe', (value) => {
    const probeId = Number.parseInt(value, 10);
    return Number.isFinite(probeId) ? probeId : undefined;
  });
  return probes;
}
