import("stdfaust.lib");

// User DSP
mcp_dsp = environment {
  // Metering (Peak + RMS per channel)
  mcp_lin2db(x) = ba.linear2db(max(x, 0.00001));
  // Output meters
  // Metering paths:
  //   FX -> per-channel Peak/RMS meters (attach, no signal change)
  //   FX -> mono mix (sum) -> Mix Peak/RMS meters (attach)
  //   FX -> mix tap (attach) -> per-channel meters => same output arity
  //
  // ASCII flow (n channels):
  //   FX --+--> per-channel meters (n) ----+
  //        |                                |
  //        +--> sum-to-mono -> mix meters ---+
  //        |                                |
  //        +--> output signal ---------------+
  mcp_out_peak(i) = _ <: (_, (an.peak_envelope(0.1) : mcp_lin2db : hbargraph("v:[99]Output Meters/[0]Peak/ch%2i[unit:dB]", -60, 0))) : attach;
  mcp_out_rms(i) = _ <: (_, (an.rms_envelope_rect(0.1) : mcp_lin2db : hbargraph("v:[99]Output Meters/[1]RMS/ch%2i[unit:dB]", -60, 0))) : attach;
  mcp_out_meter(i) = mcp_out_peak(i) : mcp_out_rms(i);
  mcp_out_mix_peak = _ <: (_, (an.peak_envelope(0.1) : mcp_lin2db : hbargraph("v:[99]Output Meters/[2]Mix Peak[unit:dB]", -60, 0))) : attach;
  mcp_out_mix_rms = _ <: (_, (an.rms_envelope_rect(0.1) : mcp_lin2db : hbargraph("v:[99]Output Meters/[3]Mix RMS[unit:dB]", -60, 0))) : attach;
  mcp_out_mix_meter = mcp_out_mix_peak : mcp_out_mix_rms;
  // Sum N outputs to mono without changing arity upstream.
  mcp_out_mix_signal_n(n) = par(i, n, _) :> _;
  mcp_out_mix_signal(FX) = mcp_out_mix_signal_n(outputs(FX));
  // Attach mix meters without adding outputs (tap-only).
  mcp_out_mix_tap_n(1) = _ <: (_, (mcp_out_mix_signal_n(1) : mcp_out_mix_meter)) : attach;
  mcp_out_mix_tap_n(n) = si.bus(n) <: (si.bus(n), (mcp_out_mix_signal_n(n) : mcp_out_mix_meter)) : (si.bus(n-1), attach);
  mcp_out_mix_tap(FX) = mcp_out_mix_tap_n(outputs(FX));
  // Per-channel meters only (no mix meters, no arity change).
  mcp_output_meters_nomix(FX) = par(i, outputs(FX), mcp_out_meter(i));
  // Per-channel meters + mix meters (adds one extra output).
  mcp_output_meters(FX) = mcp_output_meters_nomix(FX), (mcp_out_mix_signal(FX) : mcp_out_mix_meter);
  // Per-channel meters + mix meters (tap) with unchanged output count.
  mcp_output_meters_tap(FX) = mcp_out_mix_tap(FX) : mcp_output_meters_nomix(FX);

  // User DSP
  import("stdfaust.lib");

  declare options "[midi:on][nvoices:32]";

  gate = button("gate");
  freq = hslider("freq", 440, 50, 2000, 0.01);
  gain = hslider("gain", 0.3, 0, 1, 0.001);
  attack = hslider("attack", 0.01, 0.001, 0.2, 0.001);
  release = hslider("release", 0.25, 0.01, 1.0, 0.001);

  env = en.adsr(attack, 0.05, 0.8, release, gate);
  voice = (0.6 * os.osc(freq) + 0.3 * os.osc(2 * freq) + 0.1 * os.osc(4 * freq))
    * env * gain;

  // Voice output (stereo)
  process = voice * 0.3 <: _, _;

  // Global effect (post-mix)
  fx_cutoff = hslider("cutoff", 8000, 1000, 12000, 1);
  fx_room = hslider("room", 0.3, 0, 1, 0.01);
  fx_damp = hslider("damp", 0.5, 0, 1, 0.01);
  fx_wet = hslider("wet", 0.5, 0, 1, 0.01);
  fx_width = hslider("width", 1, 0, 1, 0.01);

  effect = _,_
    : +
    : fi.lowpass(2, fx_cutoff)
    : re.mono_freeverb(fx_room, fx_damp, fx_wet, fx_width)
    <: _, _;

};
process = mcp_dsp.process;
effect = mcp_dsp.effect <: mcp_dsp.mcp_output_meters_tap(mcp_dsp.effect);