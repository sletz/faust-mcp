import argparse

import anyio
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client


async def main(dsp_path: str, server_path: str, tmpdir: str | None) -> None:
    env = {"MCP_TRANSPORT": "stdio"}
    if tmpdir:
        env["TMPDIR"] = tmpdir
    server = StdioServerParameters(command="python3", args=[server_path], cwd=".", env=env)
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            with open(dsp_path, "r", encoding="utf-8") as f:
                dsp = f.read()
            result = await session.call_tool("compile_and_analyze", {"faust_code": dsp})
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
        "--tmpdir",
        default=None,
        help="TMPDIR for the MCP server process.",
    )
    args = parser.parse_args()
    anyio.run(main, args.dsp, args.server, args.tmpdir)
