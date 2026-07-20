"""W9.5 — MCP server surface: auth, org IDOR, HTTP error responses."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.mcp_server.auth import McpAuthContext, pin_org_id, require_scope, resolve_auth
from eden.mcp_server.http_transport import router as mcp_http_router
from eden.mcp_server.server import call_tool


class _FakeClient:
    async def search_traces(self, org_id: str, **kwargs: Any) -> dict[str, Any]:
        return {"traces": [], "org_id": org_id, "query": kwargs}


# ── pin_org_id / scopes ─────────────────────────────────────────────


def test_pin_org_id_rejects_mismatch() -> None:
    ctx = McpAuthContext(
        api_key="k",
        base_url="http://127.0.0.1:8000",
        org_id="org-a",
    )
    with pytest.raises(PermissionError, match="does not match"):
        pin_org_id(ctx, "org-b")


def test_pin_org_id_uses_bound_org() -> None:
    ctx = McpAuthContext(
        api_key="k",
        base_url="http://127.0.0.1:8000",
        org_id="org-a",
    )
    assert pin_org_id(ctx, "org-a") == "org-a"
    assert pin_org_id(ctx, None) == "org-a"


def test_require_scope_honors_limited_scopes() -> None:
    ctx = McpAuthContext(
        api_key="k",
        base_url="http://127.0.0.1:8000",
        org_id="org-a",
        scopes=("mcp:read",),
    )
    require_scope(ctx, "mcp:read")
    with pytest.raises(PermissionError, match="mcp:fix"):
        require_scope(ctx, "mcp:fix")


def test_resolve_auth_key_defaults_to_full_mcp_scopes() -> None:
    ctx = resolve_auth(api_key="secret", org_id="org-1")
    assert "mcp:fix" in ctx.scopes
    assert "mcp:read" in ctx.scopes


# ── call_tool IDOR + error sanitization ─────────────────────────────


@pytest.mark.asyncio
async def test_call_tool_rejects_org_id_mismatch() -> None:
    auth = McpAuthContext(
        api_key="test-key",
        base_url="http://127.0.0.1:8000",
        org_id="org-bound",
        scopes=("mcp:read", "mcp:debug", "mcp:fix"),
    )
    out = await call_tool(
        "search_traces",
        {"org_id": "org-other", "query": "x"},
        client=_FakeClient(),
        auth=auth,
    )
    assert out["status"] == "error"
    assert "does not match" in out["error"]


@pytest.mark.asyncio
async def test_call_tool_pins_bound_org() -> None:
    auth = McpAuthContext(
        api_key="test-key",
        base_url="http://127.0.0.1:8000",
        org_id="org-bound",
        scopes=("mcp:read", "mcp:debug", "mcp:fix"),
    )
    out = await call_tool(
        "search_traces",
        {"org_id": "org-bound", "query": "x"},
        client=_FakeClient(),
        auth=auth,
    )
    assert out["status"] == "ok"
    assert out["result"]["org_id"] == "org-bound"


@pytest.mark.asyncio
async def test_call_tool_scope_denied_when_limited() -> None:
    auth = McpAuthContext(
        api_key="test-key",
        base_url="http://127.0.0.1:8000",
        org_id="org-1",
        scopes=("mcp:read",),
    )
    out = await call_tool(
        "run_autofix",
        {"org_id": "org-1", "issue_id": "iss_1"},
        client=_FakeClient(),
        auth=auth,
    )
    assert out["status"] == "error"
    assert "mcp:fix" in out["error"]


@pytest.mark.asyncio
async def test_call_tool_sanitizes_unexpected_exception() -> None:
    class _Boom:
        async def search_traces(self, org_id: str, **kwargs: Any) -> dict[str, Any]:
            raise RuntimeError("/secret/path.sql leaked")

    out = await call_tool(
        "search_traces",
        {"org_id": "org_1"},
        client=_Boom(),
    )
    assert out["status"] == "error"
    assert out["error"] == "tool execution failed"
    assert "secret" not in out["error"]


# ── HTTP transport ──────────────────────────────────────────────────


def _http_app() -> TestClient:
    app = FastAPI()
    app.include_router(mcp_http_router)
    return TestClient(app)


def test_http_tools_call_without_api_key_is_401() -> None:
    client = _http_app()
    resp = client.post(
        "/v1/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "search_traces",
                "arguments": {"org_id": "org-1", "query": "x"},
            },
        },
    )
    assert resp.status_code == 401
    body = resp.json()
    assert body["error"]["code"] == -32001
    assert "API key" in body["error"]["message"]


def test_http_tools_list_allowed_without_key() -> None:
    client = _http_app()
    resp = client.post(
        "/v1/mcp",
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
    )
    assert resp.status_code == 200
    assert "tools" in resp.json()["result"]


def test_http_tools_call_org_mismatch_is_error() -> None:
    client = _http_app()
    resp = client.post(
        "/v1/mcp",
        headers={
            "Authorization": "Bearer test-key",
            "X-Org-Id": "org-a",
        },
        json={
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "search_traces",
                "arguments": {"org_id": "org-b", "query": "x"},
            },
        },
    )
    assert resp.status_code == 200
    result = resp.json()["result"]
    assert result["isError"] is True
    assert "does not match" in result["structuredContent"]["error"]


@pytest.mark.asyncio
async def test_http_handle_rpc_tools_call_requires_key() -> None:
    from eden.mcp_server.http_transport import _handle_rpc

    resp = await _handle_rpc(
        {
            "jsonrpc": "2.0",
            "id": 9,
            "method": "tools/call",
            "params": {"name": "search_traces", "arguments": {"org_id": "o"}},
        },
        api_key=None,
        org_id="o",
    )
    assert resp.get("error", {}).get("code") == -32001
    assert resp.get("_eden_http_status") == 401
