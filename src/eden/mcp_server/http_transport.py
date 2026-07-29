"""Streamable HTTP transport for Eden MCP (W28 stretch).

Exposes JSON-RPC over HTTP POST at ``/v1/mcp`` (org-scoped via auth headers).
Full bidirectional SSE Streamable HTTP (2025-03-26 MCP) is partially
supported: POST for request/response; GET returns a short-lived SSE hello
so clients can detect the endpoint. Cursor stdio remains the primary path.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, Header, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from eden.api.deps import require_feature_flag
from eden.mcp_server.errors import McpError
from eden.mcp_server.server import call_tool, list_tools
from eden.mcp_server.verify import verify_mcp_bearer

logger = logging.getLogger(__name__)

# Gated OFF by default. Until the 2026-07 remediation this router accepted any
# non-empty bearer string as full MCP credentials, so it stays behind a flag
# that an operator must set deliberately after reviewing key scopes.
router = APIRouter(
    prefix="/v1/mcp",
    tags=["mcp-http"],
    dependencies=[Depends(require_feature_flag("mcp_http_transport_v1"))],
)

_HTTP_STATUS_KEY = "_eden_http_status"


def _default_base_url() -> str:
    """Base URL the tool layer uses for outbound Eden API calls.

    Mirrors ``auth.resolve_auth``'s resolution order so the stdio and HTTP
    transports agree on where the API lives.
    """
    import os

    return (
        os.environ.get("EDEN_BASE_URL")
        or os.environ.get("EDEN_API_URL")
        or "http://127.0.0.1:8000"
    ).rstrip("/")


def _rpc_error(
    mid: Any,
    *,
    code: int,
    message: str,
    http_status: int | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "jsonrpc": "2.0",
        "id": mid,
        "error": {"code": code, "message": message},
    }
    if http_status is not None:
        out[_HTTP_STATUS_KEY] = http_status
    return out


def _strip_http_status(resp: dict[str, Any]) -> tuple[dict[str, Any], int | None]:
    status = resp.pop(_HTTP_STATUS_KEY, None)
    return resp, status if isinstance(status, int) else None


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
        # Discovery is unauthenticated; tools/call requires a bearer key.
        result = {"tools": list_tools()}
    elif method == "tools/call":
        # Verify the bearer against org_api_keys. Previously this checked only
        # that a key was *present* and then granted full MCP scopes to any
        # string, so `Authorization: Bearer x` was full access to any org named
        # in X-Org-Id. The old org-mismatch comparison below was no defence:
        # both sides of it were attacker-supplied.
        try:
            auth = await verify_mcp_bearer(
                api_key=api_key,
                org_id_header=org_id,
                base_url=_default_base_url(),
            )
        except McpError as exc:
            return _rpc_error(
                mid,
                code=-32001,
                message=exc.message,
                http_status=exc.http_status,
            )

        name = params.get("name") or ""
        arguments = dict(params.get("arguments") or {})
        # org_id now comes from the verified key row, so it overrides whatever
        # the caller put in the arguments rather than merely being compared
        # against it.
        arguments["org_id"] = auth.org_id
        out = await call_tool(name, arguments, auth=auth)
        # Prefer structured content (avoid double-encoding JSON as text).
        # Keep a short text fallback for older MCP clients.
        text = out.get("status", "ok") if isinstance(out, dict) else str(out)
        if isinstance(out, dict) and "summary" in out:
            text = str(out["summary"])
        elif isinstance(out, dict) and "message" in out:
            text = str(out["message"])
        elif isinstance(out, dict) and out.get("status") == "error":
            text = str(out.get("error") or "error")
        result = {
            "content": [{"type": "text", "text": text}],
            "structuredContent": out if isinstance(out, dict) else {"value": out},
            "isError": isinstance(out, dict) and out.get("status") == "error",
        }
    else:
        return _rpc_error(
            mid, code=-32601, message=f"Method not found: {method}"
        )

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
    valid = [msg for msg in messages if isinstance(msg, dict)]
    # Independent RPCs can run concurrently (batch tool/list+ping, etc.).
    gathered = await asyncio.gather(
        *[
            _handle_rpc(msg, api_key=api_key, org_id=x_org_id)
            for msg in valid
        ]
    )
    responses: list[dict[str, Any]] = []
    http_status = 200
    for raw in gathered:
        if not raw:
            continue
        resp, status = _strip_http_status(raw)
        if status == 401:
            http_status = 401
        responses.append(resp)

    if isinstance(body, list):
        return JSONResponse(responses, status_code=http_status)
    if not responses:
        return Response(status_code=202)
    return JSONResponse(responses[0], status_code=http_status)


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
