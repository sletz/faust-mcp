/**
 * Faust analysis architecture example.
 *
 * Renders DSP output offline, computes basic amplitude metrics, and prints
 * a JSON report including ASCII waveform summaries.
 */

#include <iostream>
#include <vector>
#include <cmath>
#include <algorithm>
#include <string>

// Faust interface requirements
#include "faust/gui/MapUI.h"
#include "faust/gui/meta.h"
#include "faust/dsp/dsp.h"

/******************************************************************************
 *******************************************************************************
 
 VECTOR INTRINSICS
 
 *******************************************************************************
 *******************************************************************************/

<<includeIntrinsic>>

/********************END ARCHITECTURE SECTION (part 1/2)****************/

/**************************BEGIN USER SECTION **************************/

<<includeclass>>

/***************************END USER SECTION ***************************/

/*******************BEGIN ARCHITECTURE SECTION (part 2/2)***************/

// -- ASCII Art Helper --
/**
 * Create a compact ASCII waveform summary for a buffer.
 *
 * Returns a string of length `width` with characters chosen from the
 * local min/max amplitude range in each bucket.
 */
std::string asciiWaveform(const std::vector<float>& buffer, int width, int height)
{
    std::string out = "";
    int step = buffer.size() / width;
    for (int i = 0; i < width; i++) {
        float maxVal = -1.0f;
        float minVal = 1.0f;
        // Find min/max in this chunk
        for (int j = 0; j < step && (i*step + j) < buffer.size(); j++) {
            float val = buffer[i*step + j];
            if (val > maxVal) maxVal = val;
            if (val < minVal) minVal = val;
        }
        // Simple visualization: stick to one char based on amplitude
        if (maxVal < 0.01 && minVal > -0.01) out += "_";
        else if (maxVal > 0.5) out += "#";
        else if (maxVal > 0.2) out += "=";
        else out += "-";
    }
    return out;
}

/**
 * Render the compiled DSP, analyze output levels, and print a JSON report.
 */
int main(int argc, char* argv[])
{
    // 1. Instantiate the DSP (The class name 'mydsp' is standard in Faust compilation)
    mydsp DSP;
    
    int sr = 44100;
    int samples = 44100 * 2; // Analyze 2 seconds
    DSP.init(sr);
    
    // 2. Prepare Audio Buffers
    int inputs = DSP.getNumInputs();
    int outputs = DSP.getNumOutputs();
    
    // We only support generators (0 inputs) for this simplified test
    // or simple effects processing silence
    float** input_buffers = new float*[inputs];
    for (int i = 0; i < inputs; i++) {
        input_buffers[i] = new float[samples];
        std::fill(input_buffers[i], input_buffers[i] + samples, 0.0f);
    }
    
    float** output_buffers = new float*[outputs];
    for (int i = 0; i < outputs; i++) output_buffers[i] = new float[samples];
    
    // 3. Render Audio (Block by block processing simulated in one go for simplicity here)
    // For Faust class, we usually compute small blocks, but here lets do ne big block
    // if the memory allows, or loop. Let's loop 1024 frames.
    int blockSize = 256;
    int computed = 0;
    
    // Create UI to pass default params
    MapUI ui;
    DSP.buildUserInterface(&ui);
    
    // Metrics (global + per-channel)
    float maxAmp = 0.0;
    float sumSq = 0.0;
    std::vector<float> monoMix; // To visualize (global)

    std::vector<float> chanMax(outputs, 0.0f);
    std::vector<float> chanSumSq(outputs, 0.0f);
    std::vector<std::vector<float>> chanWave(outputs);
    
    while (computed < samples) {
        
        // Pointers for this block
        float* ib[inputs];
        float* ob[outputs];
        for (int i = 0; i < inputs; i++) ib[i] = input_buffers[i] + computed;
        for (int i = 0; i < outputs; i++) ob[i] = output_buffers[i] + computed;
        
        int n = std::min(blockSize, samples - computed);
        DSP.compute(n, ib, ob);
        
        // Analyze this block
        for (int i = 0; i < n; i++) {
            float val = 0.0;
            // Per-channel metrics + sum to mono
            for (int c = 0; c < outputs; c++) {
                float cval = ob[c][i];
                if (std::abs(cval) > chanMax[c]) chanMax[c] = std::abs(cval);
                chanSumSq[c] += cval * cval;
                chanWave[c].push_back(cval);
                val += cval;
            }
            if (outputs > 0) val /= (float)outputs; // Average
            
            if (std::abs(val) > maxAmp) maxAmp = std::abs(val);
            sumSq += val * val;
            monoMix.push_back(val);
        }
        computed += n;
    }
    
    float rms = std::sqrt(sumSq / samples);
    
    // 4. Output JSON for the MCP Server
    std::cout << "{" << std::endl;
    std::cout << "  \"status\": \"success\"," << std::endl;
    std::cout << "  \"max_amplitude\": " << maxAmp << "," << std::endl;
    std::cout << "  \"rms\": " << rms << "," << std::endl;
    std::cout << "  \"is_silent\": " << (maxAmp < 0.0001 ? "true" : "false") << "," << std::endl;
    std::cout << "  \"waveform_ascii\": \"" << asciiWaveform(monoMix, 60, 10) << "\"," << std::endl;
    std::cout << "  \"num_outputs\": " << outputs << "," << std::endl;
    std::cout << "  \"channels\": [" << std::endl;
    for (int c = 0; c < outputs; c++) {
        float crms = std::sqrt(chanSumSq[c] / samples);
        bool csilent = chanMax[c] < 0.0001f;
        std::cout << "    {" << std::endl;
        std::cout << "      \"index\": " << c << "," << std::endl;
        std::cout << "      \"max_amplitude\": " << chanMax[c] << "," << std::endl;
        std::cout << "      \"rms\": " << crms << "," << std::endl;
        std::cout << "      \"is_silent\": " << (csilent ? "true" : "false") << "," << std::endl;
        std::cout << "      \"waveform_ascii\": \"" << asciiWaveform(chanWave[c], 60, 10) << "\"" << std::endl;
        std::cout << "    }" << (c == outputs - 1 ? "" : ",") << std::endl;
    }
    std::cout << "  ]" << std::endl;
    std::cout << "}" << std::endl;
    
    return 0;
}
