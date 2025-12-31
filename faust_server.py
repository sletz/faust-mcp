from mcp.server.fastmcp import FastMCP
import subprocess
import os
import tempfile
import json

# Initialisation du serveur
MCP_HOST = os.environ.get("MCP_HOST", "127.0.0.1")
MCP_PORT = int(os.environ.get("MCP_PORT", "8000"))
mcp = FastMCP("Faust-DSP-Runner", host=MCP_HOST, port=MCP_PORT)

# Chemin vers votre fichier d'architecture C++ (A MODIFIER)
ARCH_FILE_PATH = os.path.abspath("analysis_arch.cpp")


@mcp.tool()
def compile_and_analyze(faust_code: str) -> str:
    """
        Compile du code Faust, génère 2 secondes d'audio, et analyse le
    signal.
        Retourne l'amplitude max, le RMS et une visualisation ASCII de l'onde.
    """

    # Création d'un dossier temporaire pour la compilation
    with tempfile.TemporaryDirectory() as temp_dir:
        dsp_file = os.path.join(temp_dir, "process.dsp")
        cpp_file = os.path.join(temp_dir, "process.cpp")
        bin_file = os.path.join(temp_dir, "process_bin")

        # 1. Écriture du fichier DSP
        with open(dsp_file, "w") as f:
            f.write(faust_code)

        try:
            # 2. Compilation Faust -> C++ avec l'architecture d'analyse
            # On suppose que 'faust' est dans le PATH
            cmd_faust = ["faust", "-a", ARCH_FILE_PATH, dsp_file, "-o", cpp_file]
            subprocess.check_output(cmd_faust, stderr=subprocess.STDOUT)

            # 3. Compilation C++ -> Binaire
            # On inclut juste le header courant
            cmd_gpp = ["g++", cpp_file, "-o", bin_file, "-O3", "-std=c++11"]  # Optimisation, C++11+
            subprocess.check_output(cmd_gpp, stderr=subprocess.STDOUT)

            # 4. Exécution du binaire pour générer l'analyse
            result_json = subprocess.check_output([bin_file]).decode("utf-8")

            # On parse pour vérifier que c'est du JSON valide
            data = json.loads(result_json)

            return json.dumps(data, indent=2)

        except subprocess.CalledProcessError as e:
            # En cas d'erreur de compilation (très utile pour l'IA)
            error_msg = e.output.decode("utf-8") if e.output else str(e)
            return f"Error during compilation:\n{error_msg}"
        except Exception as e:
            return f"System Error: {str(e)}"


if __name__ == "__main__":
    transport = os.environ.get("MCP_TRANSPORT", "sse")
    mount_path = os.environ.get("MCP_MOUNT_PATH")
    mcp.run(transport=transport, mount_path=mount_path)
