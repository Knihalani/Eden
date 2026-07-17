"""Streamable HTTP transport for Eden MCP (W28 stretch).

Exposes JSON-RPC over HTTP POST at ``/v1/mcp`` (org-scoped via auth headers).
Full bidirectional SSE Streamable HTTP (2025-03-26 MCP) is partially
supported: POST for request/response; GET returns a short-lived SSE hello
so clients can detect the endpoint. Cursor stdio remains the primary path.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Header, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from eden.mcp_server.auth import resolve_auth
from eden.mcp_server.server import call_tool, list_tools

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/mcp", tags=["mcp-http"])


async def _handle_rpc(
    msg: dict[str, Any],
    *,
    api_key: str | None,
    org_id: str | None,
) -> dict[str, Any]:
    mid = msg.get("id")
    method = msg.get("method")
    params = msg.get("params") or {}

    if method == "initialize":
        result: Any = {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}, "streamableHttp": True},
            "serverInfo": {
                "name": "eden-mcp-server",
                "version": "0.2.0",
                "transport": "streamable-http",
            },
        }
    elif method == "notifications/initialized":
        return {}
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": list_tools()}
    elif method == "tools/call":
        name = params.get("name") or ""
        arguments = dict(params.get("arguments") or {})
        if org_id and "org_id" not in arguments:
            arguments["org_id"] = org_id
        auth = resolve_auth(api_key=api_key, org_id=arguments.get("org_id") or org_id)
        out = await call_tool(name, arguments, auth=auth)
        text = json.dumps(out, default=str)
        result = {
            "content": [{"type": "text", "text": text}],
            "isError": out.get("status") == "error",
        }
    else:
        return {
            "jsonrpc": "2.0",
            "id": mid,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }

    if mid is None:
        return {}
    return {"jsonrpc": "2.0", "id": mid, "result": result}


@router.post("")
@router.post("/")
async def mcp_http_post(
    request: Request,
    authorization: str | None = Header(None),
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    x_api_key: str | None = Header(None, alias="X-Api-Key"),
) -> Response:
    """JSON-RPC over HTTP (Streamable HTTP request/response mode)."""
    api_key = None
    if authorization and authorization.lower().startswith("bearer "):
        api_key = authorization[7:].strip()
    elif x_api_key:
        api_key = x_api_key.strip()

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(
            {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}},
            status_code=400,
        )

    messages = body if isinstance(body, list) else [body]
    responses: list[dict[str, Any]] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        resp = await _handle_rpc(msg, api_key=api_key, org_id=x_org_id)
        if resp:
            responses.append(resp)

    if isinstance(body, list):
        return JSONResponse(responses)
    if not responses:
        return Response(status_code=202)
    return JSONResponse(responses[0])


@router.get("")
@router.get("/")
async def mcp_http_get(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
) -> StreamingResponse:
    """Minimal SSE hello for Streamable HTTP endpoint discovery."""

    async def _gen():  # noqa: ANN202
        payload = {
            "jsonrpc": "2.0",
            "method": "notifications/message",
            "params": {
                "level": "info",
                "data": {
                    "server": "eden-mcp-server",
                    "transport": "streamable-http",
                    "org_id": x_org_id or "",
                    "note": "POST JSON-RPC to this path; prefer stdio for Cursor.",
                },
            },
        }
        yield f"event: message\ndata: {json.dumps(payload)}\n\n"

    return StreamingResponse(_gen(), media_type="text/event-stream")
