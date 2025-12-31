import("stdfaust.lib");

freq = hslider("freq[Hz]", 500, 50, 2000, 1);
gain = hslider("gain[dB]", -6, -60, 6, 0.1) : ba.db2linear;

process = os.osc(freq) * gain;
