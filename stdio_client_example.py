"""Example stdio client for calling the Faust MCP server.

Starts the server as a subprocess over stdio, calls compile_and_analyze,
and prints the result.
"""

import argparse

import anyio
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client


async def main(
    dsp_path: str,
    server_path: str,
    tmpdir: str | None,
    tool: str,
    name: str | None,
    latency_hint: str | None,
    input_source: str | None,
    input_freq: float | None,
    input_file: str | None,
    param_path: str | None,
    param_value: float | None,
    param_values: list[str] | None,
) -> None:
    """Run the stdio MCP client and call the requested tool.

    Args:
        dsp_path: Path to the Faust DSP source file.
        server_path: Python entrypoint for the MCP server.
        tmpdir: Optional TMPDIR override for the server process.
        tool: Tool name to invoke.
        name: Optional DSP instance name for compile_and_start.
        latency_hint: Optional latency hint for compile_and_start.
        input_source: Optional test input source (none, sine, noise, file).
        input_freq: Optional sine frequency in Hz.
        input_file: Optional audio file path for file test input.
        param_path: Parameter path for get_param/set_param.
        param_value: Parameter value for set_param.
    """
    env = {"MCP_TRANSPORT": "stdio"}
    if tmpdir:
        env["TMPDIR"] = tmpdir
    server = StdioServerParameters(command="python3", args=[server_path], cwd=".", env=env)
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            args = None
            if tool in ("compile_and_analyze", "compile_and_start", "check_syntax"):
                with open(dsp_path, "r", encoding="utf-8") as f:
                    dsp = f.read()
                args = {"faust_code": dsp}
                if tool in ("compile_and_analyze", "compile_and_start"):
                    if input_source is not None:
                        args["input_source"] = input_source
                    if input_freq is not None:
                        args["input_freq"] = input_freq
                    if input_file is not None:
                        args["input_file"] = input_file
                if tool == "compile_and_start":
                    if name:
                        args["name"] = name
                    if latency_hint:
                        args["latency_hint"] = latency_hint
                elif tool == "check_syntax" and name:
                    args["name"] = name
            elif tool == "get_param":
                if not param_path:
                    raise ValueError("--param-path is required for get_param")
                args = {"path": param_path}
            elif tool == "get_param_values":
                args = {}
            elif tool == "set_param_values":
                if not param_values:
                    raise ValueError("--param-values is required for set_param_values")
                values = []
                for entry in param_values:
                    if "=" not in entry:
                        raise ValueError("param entry must be PATH=VALUE")
                    path, value = entry.split("=", 1)
                    values.append({"path": path, "value": float(value)})
                args = {"values": values}
            elif tool == "set_param":
                if not param_path or param_value is None:
                    raise ValueError("--param-path and --param-value are required for set_param")
                args = {"path": param_path, "value": param_value}
            elif tool in ("get_params", "stop"):
                args = {}
            else:
                raise ValueError(f"Unsupported tool: {tool}")

            result = await session.call_tool(tool, args)
            print(result.structuredContent or result.content[0].text)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Call the Faust MCP server over stdio.")
    parser.add_argument("--dsp", default="t1.dsp", help="Path to a Faust DSP file.")
    parser.add_argument(
        "--server",
        default="faust_server.py",
        help="Path to the MCP server entrypoint.",
    )
    parser.add_argument(
        "--tool",
        default="compile_and_analyze",
        help="Tool name (compile_and_analyze, compile_and_start, check_syntax, get_params, get_param, get_param_values, set_param_values, set_param, stop).",
    )
    parser.add_argument(
        "--name",
        default=None,
        help="DSP instance name for compile_and_start.",
    )
    parser.add_argument(
        "--latency",
        default=None,
        help="Latency hint for compile_and_start (interactive or playback).",
    )
    parser.add_argument(
        "--tmpdir",
        default=None,
        help="TMPDIR for the MCP server process.",
    )
    parser.add_argument(
        "--input-source",
        default=None,
        help="Input source for compile_and_analyze (none, sine, noise, file). DawDreamer only.",
    )
    parser.add_argument(
        "--input-freq",
        default=None,
        type=float,
        help="Input frequency in Hz for sine test input (DawDreamer only).",
    )
    parser.add_argument(
        "--input-file",
        default=None,
        help="Input file path for file test input (DawDreamer only).",
    )
    parser.add_argument(
        "--param-path",
        default=None,
        help="Parameter path for get_param/set_param.",
    )
    parser.add_argument(
        "--param-value",
        default=None,
        type=float,
        help="Parameter value for set_param.",
    )
    parser.add_argument(
        "--param-values",
        action="append",
        help="Repeated PATH=VALUE pairs for set_param_values.",
    )
    args = parser.parse_args()
    anyio.run(
        main,
        args.dsp,
        args.server,
        args.tmpdir,
        args.tool,
        args.name,
        args.latency,
        args.input_source,
        args.input_freq,
        args.input_file,
        args.param_path,
        args.param_value,
        args.param_values,
    )
