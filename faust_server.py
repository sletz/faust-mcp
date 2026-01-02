from mcp.server.fastmcp import FastMCP
import subprocess
import os
import tempfile
import json

# Server initialization
MCP_HOST = os.environ.get("MCP_HOST", "127.0.0.1")
MCP_PORT = int(os.environ.get("MCP_PORT", "8000"))
mcp = FastMCP("Faust-DSP-Runner", host=MCP_HOST, port=MCP_PORT)

# Path to the C++ architecture file (edit if needed)
ARCH_FILE_PATH = os.path.abspath("analysis_arch.cpp")


@mcp.tool()
def compile_and_analyze(faust_code: str) -> str:
    """
    Compile Faust code, render ~2 seconds of audio, and analyze the signal.

    Returns the max amplitude, RMS, and an ASCII waveform preview as JSON.
    """

    # Create a temporary directory for compilation
    with tempfile.TemporaryDirectory() as temp_dir:
        dsp_file = os.path.join(temp_dir, "process.dsp")
        cpp_file = os.path.join(temp_dir, "process.cpp")
        bin_file = os.path.join(temp_dir, "process_bin")

        # 1. Write the DSP file
        with open(dsp_file, "w") as f:
            f.write(faust_code)

        try:
            # 2. Compile Faust -> C++ with the analysis architecture
            # Assumes 'faust' is in PATH
            cmd_faust = ["faust", "-a", ARCH_FILE_PATH, dsp_file, "-o", cpp_file]
            subprocess.check_output(cmd_faust, stderr=subprocess.STDOUT)

            # 3. Compile C++ -> binary
            # Only the default include path is used
            cmd_gpp = ["g++", cpp_file, "-o", bin_file, "-O3", "-std=c++11"]  # Optimisation, C++11+
            subprocess.check_output(cmd_gpp, stderr=subprocess.STDOUT)

            # 4. Run the binary to generate analysis output
            result_json = subprocess.check_output([bin_file]).decode("utf-8")

            # Parse to validate JSON output
            data = json.loads(result_json)

            return json.dumps(data, indent=2)

        except subprocess.CalledProcessError as e:
            # Compilation error (useful for debugging in an LLM loop)
            error_msg = e.output.decode("utf-8") if e.output else str(e)
            return f"Error during compilation:\n{error_msg}"
        except Exception as e:
            return f"System Error: {str(e)}"


if __name__ == "__main__":
    transport = os.environ.get("MCP_TRANSPORT", "sse")
    mount_path = os.environ.get("MCP_MOUNT_PATH")
    mcp.run(transport=transport, mount_path=mount_path)
