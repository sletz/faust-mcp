import("stdfaust.lib");

cutoff = hslider("cutoff[Hz]", 1200, 50, 8000, 1);
drive = hslider("drive[dB]", 0, -24, 24, 0.1) : ba.db2linear;

effect_mono = (*(drive) : fi.lowpass(2, cutoff));

process = effect_mono, effect_mono;
