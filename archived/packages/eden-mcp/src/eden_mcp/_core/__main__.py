"""``python -m eden_mcp`` (standalone _core) — stdio JSON-RPC tool loop.

Implements a minimal MCP-compatible subset:
``initialize``, ``tools/list``, ``tools/call``, ``ping``,
``resources/list``, ``resources/read``,
``prompts/list``, ``prompts/get``.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from eden_mcp._core.prompts import get_prompt, list_prompts
from eden_mcp._core.resources import list_resource_templates, read_resource
from eden_mcp._core.server import call_tool, list_tools


async def _handle(msg: dict[str, Any]) -> dict[str, Any]:
    mid = msg.get("id")
    method = msg.get("method")
    params = msg.get("params") or {}

    if method == "initialize":
        result: Any = {
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "tools": {},
                "resources": {"subscribe": False, "listChanged": False},
                "prompts": {"listChanged": False},
            },
            "serverInfo": {"name": "eden-mcp-server", "version": "0.2.0"},
        }
    elif method == "notifications/initialized":
        return {}
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": list_tools()}
    elif method == "tools/call":
        name = params.get("name") or ""
        arguments = params.get("arguments") or {}
        out = await call_tool(name, arguments)
        text = json.dumps(out, default=str)
        result = {
            "content": [{"type": "text", "text": text}],
            "isError": out.get("status") == "error",
        }
    elif method == "resources/list":
        result = {"resourceTemplates": list_resource_templates(), "resources": []}
    elif method == "resources/read":
        uri = params.get("uri") or ""
        # stdio transport has no bearer; use a minimal unauthenticated auth ctx.
        from eden_mcp._core.auth import resolve_auth
        from eden_mcp._core.client import HttpEdenClient

        auth = resolve_auth()
        client = HttpEdenClient(auth)
        out = await read_resource(uri, client=client, auth=auth)
        if out.get("status") == "error":
            return {
                "jsonrpc": "2.0",
                "id": mid,
                "error": {"code": -32002, "message": out.get("error", "resource read failed")},
            }
        result = out
    elif method == "prompts/list":
        result = {"prompts": list_prompts()}
    elif method == "prompts/get":
        name = params.get("name") or ""
        arguments = params.get("arguments") or {}
        out = get_prompt(name, arguments)
        if out.get("status") == "error":
            return {
                "jsonrpc": "2.0",
                "id": mid,
                "error": {"code": -32002, "message": out.get("error", "prompt not found")},
            }
        result = out
    else:
        return {
            "jsonrpc": "2.0",
            "id": mid,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }

    if mid is None:
        return {}
    return {"jsonrpc": "2.0", "id": mid, "result": result}


async def _stdio_loop() -> None:
    loop = asyncio.get_event_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            err = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": "Parse error"},
            }
            sys.stdout.write(json.dumps(err) + "\n")
            sys.stdout.flush()
            continue
        resp = await _handle(msg)
        if resp:
            sys.stdout.write(json.dumps(resp, default=str) + "\n")
            sys.stdout.flush()


def main() -> None:
    asyncio.run(_stdio_loop())


if __name__ == "__main__":
    main()
