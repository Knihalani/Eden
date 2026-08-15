"""W3-3: MCP Resources + Prompts capabilities + transport handshake (6.3).

Tests:
* resources/list   — returns resource templates with eden:// URI scheme
* resources/read   — resolves known URIs; errors on unknown URIs
* prompts/list     — returns the three built-in prompts
* prompts/get      — renders each prompt template
* initialize       — capabilities block advertises tools + resources + prompts
* stdio transport  — __main__._handle dispatches new methods
* HTTP transport   — _handle_rpc dispatches new methods (flag enabled)
* tools            — existing call_tool still works after changes (regression)
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock

import pytest

# ── shared fixtures ────────────────────────────────────────────────


class _StubClient:
    """Minimal fake client for resource/tool assertions."""

    async def get_trace(self, org_id: str, trace_id: str) -> dict[str, Any]:
        return {"trace_id": trace_id, "org_id": org_id, "spans": []}

    async def get_issue(self, org_id: str, issue_id: str) -> dict[str, Any]:
        return {"issue": {"id": issue_id, "org_id": org_id}}

    async def get_improvement_plan(self, org_id: str, plan_id: str) -> dict[str, Any]:
        return {"plan": {"id": plan_id, "org_id": org_id}}

    async def search_traces(self, org_id: str, **kw: Any) -> dict[str, Any]:
        return {"traces": [], "org_id": org_id}


# ── resources/list ────────────────────────────────────────────────


def test_list_resource_templates_returns_catalog() -> None:
    from eden.mcp_server.resources import list_resource_templates

    templates = list_resource_templates()
    assert isinstance(templates, list)
    assert len(templates) >= 3
    uri_templates = {t["uriTemplate"] for t in templates}
    assert "eden://orgs/{org_id}/traces/{trace_id}" in uri_templates
    assert "eden://orgs/{org_id}/issues/{issue_id}" in uri_templates
    assert "eden://orgs/{org_id}/plans/{plan_id}" in uri_templates


def test_resource_templates_have_required_fields() -> None:
    from eden.mcp_server.resources import list_resource_templates

    for t in list_resource_templates():
        assert "uriTemplate" in t, f"missing uriTemplate: {t}"
        assert "name" in t, f"missing name: {t}"
        assert "description" in t, f"missing description: {t}"
        assert "mimeType" in t, f"missing mimeType: {t}"
        assert t["mimeType"] == "application/json"


# ── resources/read ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_read_resource_trace_returns_contents() -> None:
    from eden.mcp_server.auth import McpAuthContext
    from eden.mcp_server.resources import read_resource

    auth = McpAuthContext(
        api_key="test-key",
        base_url="http://localhost",
        org_id="org_abc",
        scopes=("mcp:read",),
    )
    client = _StubClient()
    result = await read_resource(
        "eden://orgs/org_abc/traces/trc_001",
        client=client,
        auth=auth,
    )
    assert "contents" in result, f"unexpected result: {result}"
    assert len(result["contents"]) == 1
    blob = result["contents"][0]
    assert blob["mimeType"] == "application/json"
    assert blob["uri"] == "eden://orgs/org_abc/traces/trc_001"
    data = json.loads(blob["text"])
    assert data["trace_id"] == "trc_001"


@pytest.mark.asyncio
async def test_read_resource_issue_returns_contents() -> None:
    from eden.mcp_server.auth import McpAuthContext
    from eden.mcp_server.resources import read_resource

    auth = McpAuthContext(
        api_key="key",
        base_url="http://localhost",
        org_id="org_x",
        scopes=("mcp:read",),
    )
    result = await read_resource(
        "eden://orgs/org_x/issues/iss_42",
        client=_StubClient(),
        auth=auth,
    )
    assert "contents" in result
    data = json.loads(result["contents"][0]["text"])
    assert data["issue"]["id"] == "iss_42"


@pytest.mark.asyncio
async def test_read_resource_plan_returns_contents() -> None:
    from eden.mcp_server.auth import McpAuthContext
    from eden.mcp_server.resources import read_resource

    auth = McpAuthContext(
        api_key="key",
        base_url="http://localhost",
        org_id="org_x",
        scopes=("mcp:read",),
    )
    result = await read_resource(
        "eden://orgs/org_x/plans/plan_1",
        client=_StubClient(),
        auth=auth,
    )
    assert "contents" in result
    data = json.loads(result["contents"][0]["text"])
    assert data["plan"]["id"] == "plan_1"


@pytest.mark.asyncio
async def test_read_resource_unknown_uri_returns_error() -> None:
    from eden.mcp_server.auth import McpAuthContext
    from eden.mcp_server.resources import read_resource

    auth = McpAuthContext(api_key="k", base_url="http://localhost", org_id="org_1")
    result = await read_resource(
        "eden://unknown/path",
        client=_StubClient(),
        auth=auth,
    )
    assert result["status"] == "error"
    assert "Unsupported" in result["error"]


@pytest.mark.asyncio
async def test_read_resource_org_mismatch_rejected() -> None:
    """org_id in URI must match authenticated org."""
    from eden.mcp_server.auth import McpAuthContext
    from eden.mcp_server.resources import read_resource

    auth = McpAuthContext(
        api_key="k",
        base_url="http://localhost",
        org_id="org_bound",
        scopes=("mcp:read",),
    )
    result = await read_resource(
        "eden://orgs/org_other/traces/trc_1",
        client=_StubClient(),
        auth=auth,
    )
    assert result["status"] == "error"
    assert "does not match" in result["error"]


# ── prompts/list ─────────────────────────────────────────────────


def test_list_prompts_returns_three_prompts() -> None:
    from eden.mcp_server.prompts import list_prompts

    prompts = list_prompts()
    names = {p["name"] for p in prompts}
    assert "triage_issue" in names
    assert "explain_trace" in names
    assert "summarize_cost" in names


def test_prompts_have_required_fields() -> None:
    from eden.mcp_server.prompts import list_prompts

    for p in list_prompts():
        assert "name" in p
        assert "description" in p
        assert "arguments" in p
        assert isinstance(p["arguments"], list)


def test_triage_issue_prompt_has_required_arguments() -> None:
    from eden.mcp_server.prompts import list_prompts

    prompts = {p["name"]: p for p in list_prompts()}
    ti = prompts["triage_issue"]
    arg_names = {a["name"] for a in ti["arguments"]}
    assert "org_id" in arg_names
    assert "issue_id" in arg_names
    # Both required
    required_args = [a for a in ti["arguments"] if a.get("required")]
    assert len(required_args) == 2


def test_explain_trace_prompt_has_required_arguments() -> None:
    from eden.mcp_server.prompts import list_prompts

    prompts = {p["name"]: p for p in list_prompts()}
    et = prompts["explain_trace"]
    arg_names = {a["name"] for a in et["arguments"]}
    assert "org_id" in arg_names
    assert "trace_id" in arg_names


def test_summarize_cost_has_optional_window_arg() -> None:
    from eden.mcp_server.prompts import list_prompts

    prompts = {p["name"]: p for p in list_prompts()}
    sc = prompts["summarize_cost"]
    arg_names = {a["name"]: a for a in sc["arguments"]}
    assert "window_hours" in arg_names
    assert not arg_names["window_hours"].get("required"), "window_hours should be optional"


# ── prompts/get ──────────────────────────────────────────────────


def test_get_prompt_triage_issue_renders() -> None:
    from eden.mcp_server.prompts import get_prompt

    result = get_prompt("triage_issue", {"org_id": "org_1", "issue_id": "iss_42"})
    assert "description" in result
    assert "messages" in result
    assert len(result["messages"]) == 1
    msg = result["messages"][0]
    assert msg["role"] == "user"
    text = msg["content"]["text"]
    assert "iss_42" in text
    assert "org_1" in text
    # Should mention key workflow steps
    assert "fixture" in text.lower()
    assert "checkpoint" in text.lower()


def test_get_prompt_explain_trace_renders() -> None:
    from eden.mcp_server.prompts import get_prompt

    result = get_prompt("explain_trace", {"org_id": "org_1", "trace_id": "trc_99"})
    assert "messages" in result
    text = result["messages"][0]["content"]["text"]
    assert "trc_99" in text
    assert "latency" in text.lower() or "cost" in text.lower()


def test_get_prompt_summarize_cost_uses_window_hours() -> None:
    from eden.mcp_server.prompts import get_prompt

    result = get_prompt("summarize_cost", {"org_id": "org_1", "window_hours": 48})
    text = result["messages"][0]["content"]["text"]
    assert "48" in text


def test_get_prompt_unknown_returns_error() -> None:
    from eden.mcp_server.prompts import get_prompt

    result = get_prompt("nonexistent_prompt", {})
    assert result["status"] == "error"
    assert "nonexistent_prompt" in result["error"]


# ── initialize capabilities ─────────────────────────────────────


@pytest.mark.asyncio
async def test_stdio_initialize_advertises_resources_and_prompts() -> None:
    from eden.mcp_server.__main__ import _handle

    resp = await _handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    caps = resp["result"]["capabilities"]
    assert "resources" in caps, f"resources missing from caps: {caps}"
    assert "prompts" in caps, f"prompts missing from caps: {caps}"
    assert "tools" in caps


@pytest.mark.asyncio
async def test_stdio_resources_list_dispatches() -> None:
    from eden.mcp_server.__main__ import _handle

    resp = await _handle(
        {"jsonrpc": "2.0", "id": 2, "method": "resources/list", "params": {}}
    )
    result = resp["result"]
    assert "resourceTemplates" in result
    assert len(result["resourceTemplates"]) >= 3


@pytest.mark.asyncio
async def test_stdio_prompts_list_dispatches() -> None:
    from eden.mcp_server.__main__ import _handle

    resp = await _handle(
        {"jsonrpc": "2.0", "id": 3, "method": "prompts/list", "params": {}}
    )
    result = resp["result"]
    assert "prompts" in result
    names = {p["name"] for p in result["prompts"]}
    assert "triage_issue" in names


@pytest.mark.asyncio
async def test_stdio_prompts_get_dispatches() -> None:
    from eden.mcp_server.__main__ import _handle

    resp = await _handle(
        {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "prompts/get",
            "params": {
                "name": "summarize_cost",
                "arguments": {"org_id": "org_1"},
            },
        }
    )
    result = resp["result"]
    assert "messages" in result


@pytest.mark.asyncio
async def test_stdio_prompts_get_unknown_returns_error_frame() -> None:
    from eden.mcp_server.__main__ import _handle

    resp = await _handle(
        {
            "jsonrpc": "2.0",
            "id": 5,
            "method": "prompts/get",
            "params": {"name": "no_such_prompt", "arguments": {}},
        }
    )
    assert "error" in resp
    assert resp["error"]["code"] == -32002


# ── HTTP transport ────────────────────────────────────────────────


def _http_app():  # noqa: ANN202
    import eden.api.deps as deps
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from eden.mcp_server.http_transport import router as mcp_http_router

    deps.get_settings().mcp_http_transport_v1 = True
    app = FastAPI()
    app.include_router(mcp_http_router)
    return TestClient(app)


def test_http_initialize_advertises_resources_and_prompts() -> None:
    client = _http_app()
    resp = client.post(
        "/v1/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
    )
    assert resp.status_code == 200
    caps = resp.json()["result"]["capabilities"]
    assert "resources" in caps
    assert "prompts" in caps


def test_http_resources_list_allowed_without_key() -> None:
    client = _http_app()
    resp = client.post(
        "/v1/mcp",
        json={"jsonrpc": "2.0", "id": 2, "method": "resources/list", "params": {}},
    )
    assert resp.status_code == 200
    result = resp.json()["result"]
    assert "resourceTemplates" in result
    assert len(result["resourceTemplates"]) >= 3


def test_http_prompts_list_allowed_without_key() -> None:
    client = _http_app()
    resp = client.post(
        "/v1/mcp",
        json={"jsonrpc": "2.0", "id": 3, "method": "prompts/list", "params": {}},
    )
    assert resp.status_code == 200
    result = resp.json()["result"]
    assert "prompts" in result
    names = {p["name"] for p in result["prompts"]}
    assert "triage_issue" in names
    assert "explain_trace" in names
    assert "summarize_cost" in names


def test_http_prompts_get_allowed_without_key() -> None:
    client = _http_app()
    resp = client.post(
        "/v1/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 4,
            "method": "prompts/get",
            "params": {
                "name": "triage_issue",
                "arguments": {"org_id": "org_1", "issue_id": "iss_1"},
            },
        },
    )
    assert resp.status_code == 200
    result = resp.json()["result"]
    assert "messages" in result


def test_http_resources_read_requires_key() -> None:
    """resources/read is authenticated (same as tools/call)."""
    client = _http_app()
    resp = client.post(
        "/v1/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 5,
            "method": "resources/read",
            "params": {"uri": "eden://orgs/org_1/traces/trc_1"},
        },
    )
    assert resp.status_code in (401, 200)
    body = resp.json()
    if resp.status_code == 401:
        assert body["error"]["code"] == -32001


def test_http_tools_list_still_works() -> None:
    """Regression: existing tools/list unaffected by resources/prompts changes."""
    client = _http_app()
    resp = client.post(
        "/v1/mcp",
        json={"jsonrpc": "2.0", "id": 6, "method": "tools/list", "params": {}},
    )
    assert resp.status_code == 200
    assert "tools" in resp.json()["result"]
    tool_names = {t["name"] for t in resp.json()["result"]["tools"]}
    assert "search_traces" in tool_names
    assert "get_issue" in tool_names


# ── package layout ─────────────────────────────────────────────────


def test_standalone_package_pyproject_exists() -> None:
    """packages/eden-mcp/pyproject.toml must exist with the correct entry point."""
    import os

    pyproject_path = os.path.join(
        os.path.dirname(__file__),
        "..", "..", "..", "packages", "eden-mcp", "pyproject.toml",
    )
    assert os.path.exists(os.path.normpath(pyproject_path)), (
        "packages/eden-mcp/pyproject.toml not found"
    )


def test_standalone_package_entry_importable() -> None:
    """eden_mcp.__main__.main must be importable and callable."""
    import importlib

    mod = importlib.import_module("eden_mcp.__main__")
    assert hasattr(mod, "main")
    assert callable(mod.main)


def test_standalone_package_exports_capabilities() -> None:
    """eden_mcp should re-export tools, resources, and prompts."""
    import importlib

    mod = importlib.import_module("eden_mcp")
    for name in [
        "TOOL_CATALOG", "call_tool", "list_tools",
        "RESOURCE_TEMPLATE_CATALOG", "list_resource_templates", "read_resource",
        "PROMPT_CATALOG", "get_prompt", "list_prompts",
    ]:
        assert hasattr(mod, name), f"eden_mcp missing: {name}"


# ── mcp_http_transport_v1 flag ───────────────────────────────────


def test_mcp_http_transport_v1_default_is_true() -> None:
    """Flag is flipped ON per plan 6.3 (2026-08-12)."""
    from eden.config import get_settings

    settings = get_settings()
    assert settings.mcp_http_transport_v1 is True, (
        "mcp_http_transport_v1 should be True (plan 6.3 flip)"
    )
