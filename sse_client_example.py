import argparse
import os

import anyio
from mcp.client.sse import sse_client
from mcp.client.session import ClientSession


async def main(url: str, dsp_path: str) -> None:
    async with sse_client(url) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            with open(dsp_path, "r", encoding="utf-8") as f:
                dsp = f.read()
            result = await session.call_tool("compile_and_analyze", {"faust_code": dsp})
            print(result.structuredContent or result.content[0].text)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Call the Faust MCP server over SSE.")
    parser.add_argument(
        "--url",
        default="http://127.0.0.1:8000/sse",
        help="SSE endpoint URL.",
    )
    parser.add_argument(
        "--dsp",
        default="t1.dsp",
        help="Path to a Faust DSP file.",
    )
    parser.add_argument(
        "--tmpdir",
        default=None,
        help="Local TMPDIR override (client-side only).",
    )
    args = parser.parse_args()
    if args.tmpdir:
        os.environ["TMPDIR"] = args.tmpdir
    anyio.run(main, args.url, args.dsp)
