import("stdfaust.lib");

freq1 = hslider("freq1[Hz]", 500, 50, 2000, 1);
freq2 = hslider("freq2[Hz]", 600, 50, 2000, 1);
gain = hslider("gain[dB]", -6, -60, 6, 0.1) : ba.db2linear;

process = os.osc(freq1) * gain, os.osc(freq2) * gain;
