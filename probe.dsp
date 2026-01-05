import("stdfaust.lib");

probe_rms_db(id, hide, x) = x <: attach(x, an.rms_envelope_rect(0.1)
  : max(0.00001) : ba.linear2db
  : hbargraph("Probe RMS%2id[probe:%id][unit:dB][hidden:%hide]", -60, 0));

probe_rms_lin(id, hide, x) = x <: attach(x, an.rms_envelope_rect(0.1)
  : hbargraph("Probe RMS%2id[probe:%id][hidden:%hide]", 0, 1));
  
probe_peak_db(id, hide, x) = x <: attach(x, an.peak_envelope(0.1)
  : max(0.00001) : ba.linear2db
  : hbargraph("Probe Peak%2id[probe:%id][unit:dB][hidden:%hide]", -60, 0));

probe_peak_lin(id, hide, x) = x <: attach(x, an.peak_envelope(0.1)
  : hbargraph("Probe Peak%2id[probe:%id][hidden:%hide]", 0, 1));

freq = hslider("freq", 440, 20, 2000, 1);
gain = hslider("gain", 0.5, 0, 1, 0.01);
gate = button("gate");

// Pipeline with probes at each stage
osc = os.sawtooth(freq) : probe_rms_db(0, 0);
shaped = osc * en.adsr(0.01, 0.1, 0.7, 0.3, gate) : probe_rms_db(1, 0);
output = shaped * gain : probe_rms_db(2, 0);

process = output <: _,_;