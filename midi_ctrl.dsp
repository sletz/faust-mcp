import("stdfaust.lib");

freq = hslider("freq [midi:ctrl 1]", 440, 50, 2000, 1);
gain = hslider("gain [midi:ctrl 7]", 0.2, 0, 1, 0.001);

process = os.osc(freq) * gain;
