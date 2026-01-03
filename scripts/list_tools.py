#!/usr/bin/env python3
"""List available MCP tools from an SSE endpoint."""

import argparse

import json
import anyio
from mcp.client.sse import sse_client
from mcp.client.session import ClientSession


async def main(url: str, details: bool) -> None:
    """Connect to the SSE endpoint and print tool metadata."""
    async with sse_client(url) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            if details:
                payload = [tool.model_dump() for tool in tools.tools]
                print(json.dumps(payload, indent=2))
            else:
                print([t.name for t in tools.tools])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="List MCP tools from an SSE endpoint.")
    parser.add_argument(
        "--url",
        default="http://127.0.0.1:8000/sse",
        help="SSE endpoint URL.",
    )
    parser.add_argument(
        "--details",
        action="store_true",
        help="Print full tool metadata as JSON.",
    )
    args = parser.parse_args()
    anyio.run(main, args.url, args.details)
