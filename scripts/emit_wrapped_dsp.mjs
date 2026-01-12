// CLI helper to inspect the Faust code after MCP wrapping (inputs/meters/effects).
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { wrapTestInputs } from '../faust_dsp_utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build the CLI usage text.
 * @returns {string}
 */
function usage() {
  return [
    'Usage: node scripts/emit_wrapped_dsp.mjs --dsp <file> [options]',
    '',
    'Options:',
    '  --input-source <none|sine|noise|file>  (default: none)',
    '  --input-freq <hz>                      (default: 440 for sine)',
    '  --input-file <path>                    (required for input-source=file)',
    '  --hide-meters                          (default: false)',
    '  --out <file>                           (default: stdout)',
  ].join('\n');
}

/**
 * Parse CLI arguments into options.
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
  // Minimal CLI parsing to keep the script dependency-free.
  const args = {
    inputSource: 'none',
    inputFreq: undefined,
    inputFile: undefined,
    hideMeters: false,
    out: undefined,
    dsp: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dsp') {
      // Input DSP file path (required).
      args.dsp = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--input-source') {
      // Optional test input source for wrapping.
      args.inputSource = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--input-freq') {
      // Optional sine frequency for input-source=sine.
      const value = Number(argv[i + 1]);
      args.inputFreq = Number.isFinite(value) ? value : undefined;
      i += 1;
      continue;
    }
    if (arg === '--input-file') {
      // Input file path for input-source=file.
      args.inputFile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--hide-meters') {
      // Append [hidden:1] to metering bargraphs.
      args.hideMeters = true;
      continue;
    }
    if (arg === '--out') {
      // Output path for the wrapped DSP.
      args.out = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
  }

  return args;
}

/**
 * Run the wrapper and emit the resulting DSP.
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dsp) {
    console.error('Missing --dsp.');
    console.error(usage());
    process.exit(1);
  }

  // Resolve and read the input DSP, then apply the standard MCP wrapper.
  const dspPath = path.resolve(__dirname, '..', args.dsp);
  const dspCode = await fs.readFile(dspPath, 'utf-8');
  const wrapped = wrapTestInputs(
    dspCode,
    args.inputSource,
    args.inputFreq,
    args.inputFile,
    args.hideMeters,
  );
  const output = wrapped.code ?? String(wrapped);

  if (args.out) {
    // Write to a file when --out is provided.
    const outPath = path.resolve(__dirname, '..', args.out);
    await fs.writeFile(outPath, output);
    process.stdout.write(`Wrote wrapped DSP to ${outPath}\n`);
  } else {
    // Default: print the wrapped DSP to stdout.
    process.stdout.write(output);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
