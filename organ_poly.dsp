import("stdfaust.lib");

declare options "[midi:on][nvoices:8]";

gate = button("gate");
freq = hslider("freq", 440, 50, 2000, 0.01);
gain = hslider("gain", 0.3, 0, 1, 0.001);
attack = hslider("attack", 0.01, 0.001, 0.2, 0.001);
release = hslider("release", 0.2, 0.01, 1.0, 0.001);

env = en.adsr(attack, 0.05, 0.8, release, gate);
fund = os.osc(freq);
organ = 0.6 * fund + 0.3 * os.osc(2 * freq) + 0.1 * os.osc(4 * freq);
sig = organ * env * gain;

process = sig <: _,_;
