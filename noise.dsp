import("stdfaust.lib");

gain = hslider("gain[dB]", -6, -60, 6, 0.1) : ba.db2linear;

process = no.noise * gain;
