"""Wave 3 — BUG-18/20/21: MCP docs, query_eql route, EdenApiClient Protocol."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from eden.mcp_server import tools as tool_fns
from eden.mcp_server.auth import McpAuthContext


def _read_auth() -> McpAuthContext:
    return McpAuthContext(
        api_key="test-key",
        base_url="http://127.0.0.1:8000",
        org_id="org-1",
        scopes=("mcp:read",),
    )


def test_mcp_cursor_doc_does_not_instruct_dead_mcp_keys_route() -> None:
    doc = Path("docs/docs/how-to/mcp-cursor.md").read_text()
    assert "Settings → MCP" not in doc
    assert "POST /orgs/{org}/mcp/keys" not in doc or "not mounted" in doc
    assert "EDEN_API_KEY" in doc
    assert "Settings → API Keys" in doc


@pytest.mark.asyncio
async def test_query_eql_forwards_to_compile_nl_alert() -> None:
    captured: dict[str, Any] = {}

    class _Client:
        async def compile_nl_alert(
            self,
            org_id: str,
            *,
            nl_text: str,
            context: dict[str, Any] | None = None,
            eql_override: str | None = None,
        ) -> dict[str, Any]:
            captured.update(
                {
                    "org_id": org_id,
                    "nl_text": nl_text,
                    "context": context,
                    "eql_override": eql_override,
                }
            )
            return {"eql": 'status = "error"', "warnings": []}

    out = await tool_fns.query_eql(
        _Client(), "org-1", nl_text="errors in the last hour"
    )
    assert out["eql"] == 'status = "error"'
    assert captured == {
        "org_id": "org-1",
        "nl_text": "errors in the last hour",
        "context": None,
        "eql_override": None,
    }


@pytest.mark.asyncio
async def test_query_eql_maps_eql_param_to_eql_override() -> None:
    captured: dict[str, Any] = {}

    class _Client:
        async def compile_nl_alert(
            self,
            org_id: str,
            *,
            nl_text: str,
            context: dict[str, Any] | None = None,
            eql_override: str | None = None,
        ) -> dict[str, Any]:
            captured["eql_override"] = eql_override
            captured["nl_text"] = nl_text
            return {"eql": eql_override or "", "warnings": []}

    await tool_fns.query_eql(
        _Client(),
        "org-1",
        eql='SELECT count() FROM telemetry_events WHERE status = "error"',
    )
    assert captured["eql_override"].startswith("SELECT count()")
    assert len(captured["nl_text"]) >= 3


@pytest.mark.asyncio
async def test_http_client_typed_methods_hit_live_routes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from eden.mcp_server.client import HttpEdenClient

    captured: list[tuple[str, str, dict[str, Any] | None, dict[str, Any] | None]] = []

    async def _fake_request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        captured.append((method, path, json_body, params))
        return {"status": "ok"}

    monkeypatch.setattr(HttpEdenClient, "_request", _fake_request)

    client = HttpEdenClient(auth=_read_auth())
    await client.compile_nl_alert("org-1", nl_text="alert on errors")
    await client.query_sql("org-1", sql="SELECT 1", limit=10)
    await client.list_datasets("org-1", limit=25)
    await client.list_experiments("org-1", limit=25)
    await client.get_judge_scores("org-1", trace_id="trc_1")
    await client.get_cost_breakdown("org-1", window_hours=48)
    await client.get_agentic_metrics("org-1", window_hours=12, agent_id="agent-a")
    await client.eden_status("org-1")
    await client.label_tool_call(
        "org-1",
        span_id="sp_1",
        label="good",
        tool_name="search",
        trace_id="trc_1",
    )

    paths = [item[1] for item in captured]
    assert "/orgs/org-1/alerts/compile" in paths
    assert "/orgs/org-1/alerts/nl/preview" not in paths
    assert "/orgs/org-1/sql/execute" in paths
    assert "/orgs/org-1/datasets" in paths
    assert "/orgs/org-1/experiments/offline" in paths
    assert "/orgs/org-1/observability/judges" in paths
    judge_call = next(c for c in captured if c[1].endswith("/observability/judges"))
    assert judge_call[0] == "GET"
    assert judge_call[3] == {"trace_id": "trc_1"}
    assert "/orgs/org-1/finops/explorer" in paths
    assert "/orgs/org-1/agentic-metrics/summary" in paths
    assert "/orgs/org-1/admin/eden-status" in paths
    assert "/orgs/org-1/tool-calls/sp_1/label" in paths

    compile_call = next(c for c in captured if c[1].endswith("/alerts/compile"))
    assert compile_call[0] == "POST"
    assert compile_call[2] == {"nl_text": "alert on errors"}

    sql_call = next(c for c in captured if c[1].endswith("/sql/execute"))
    assert sql_call[0] == "POST"
    assert sql_call[2] == {"sql": "SELECT 1", "max_rows": 10}


@pytest.mark.asyncio
async def test_query_sql_tool_prefers_max_rows_over_limit() -> None:
    calls: list[dict[str, Any]] = []

    class _Client:
        async def query_sql(
            self, org_id: str, *, sql: str, limit: int = 100
        ) -> dict[str, Any]:
            calls.append({"org_id": org_id, "sql": sql, "limit": limit})
            return {"status": "ok"}

    await tool_fns.query_sql(
        _Client(), "org-1", sql="SELECT 1", limit=50, max_rows=25
    )
    assert calls == [{"org_id": "org-1", "sql": "SELECT 1", "limit": 25}]


def test_query_sql_catalog_uses_max_rows_field() -> None:
    from eden.mcp_server.server import TOOL_CATALOG

    spec = next(t for t in TOOL_CATALOG if t["name"] == "query_sql")
    props = spec["inputSchema"]["properties"]
    assert "max_rows" in props
    assert "limit" not in props
