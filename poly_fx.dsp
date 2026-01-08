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
