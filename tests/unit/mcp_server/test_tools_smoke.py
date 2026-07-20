"""F04 MCP server smoke — tools list + dispatch with mock client."""

from __future__ import annotations

from typing import Any

import pytest

from eden.mcp_server.auth import McpAuthContext
from eden.mcp_server.server import TOOL_CATALOG, call_tool, list_tools

_WRITE_AUTH = McpAuthContext(
    api_key="test-key",
    base_url="http://127.0.0.1:8000",
    scopes=("mcp:read", "mcp:debug", "mcp:fix"),
)



class _FakeClient:
    async def search_traces(self, org_id: str, **kwargs: Any) -> dict[str, Any]:
        return {"traces": [{"id": "trc_1", "org_id": org_id}], "query": kwargs}

    async def get_trace(self, org_id: str, trace_id: str) -> dict[str, Any]:
        return {"trace_id": trace_id, "org_id": org_id}

    async def get_transcript(
        self, org_id: str, trace_id: str, *, limit: int = 50
    ) -> dict[str, Any]:
        return {"trace_id": trace_id, "steps": [], "limit": limit}

    async def list_checkpoints(self, org_id: str, trace_id: str) -> dict[str, Any]:
        return {"checkpoints": [{"step_number": 0, "trace_id": trace_id}]}

    async def rerun_debugger(
        self, org_id: str, *, trace_id: str, from_step: int = 0, **kwargs: Any
    ) -> dict[str, Any]:
        return {"source_trace_id": trace_id, "from_step": from_step, "diff": []}

    async def search_issues(self, org_id: str, **kwargs: Any) -> dict[str, Any]:
        return {"issues": [{"id": "iss_1"}], "count": 1}

    async def get_issue(self, org_id: str, issue_id: str) -> dict[str, Any]:
        return {"issue": {"id": issue_id}}

    async def triage_issue(
        self, org_id: str, issue_id: str, *, force: bool = False
    ) -> dict[str, Any]:
        return {"issue_id": issue_id, "force": force, "root_cause": "loop"}

    async def run_autofix(
        self, org_id: str, issue_id: str, *, dry_run: bool = True
    ) -> dict[str, Any]:
        return {"issue_id": issue_id, "dry_run": dry_run, "patch_summary": "noop"}

    async def get_improvement_queue(
        self, org_id: str, *, agent_id: str | None = None
    ) -> dict[str, Any]:
        return {
            "items": [{"ref": "issue:1", "column": "urgent"}],
            "count": 1,
            "agent_id": agent_id,
        }

    async def export_fixture(self, org_id: str, issue_id: str) -> dict[str, Any]:
        return {
            "status": "ok",
            "fixture": {"format": "eden-failure-fixture-v1", "issue": {"id": issue_id}},
        }


def test_list_tools_covers_core_catalog() -> None:
    names = {t["name"] for t in list_tools()}
    required = {
        "search_traces",
        "get_transcript",
        "list_checkpoints",
        "rerun_debugger",
        "search_issues",
        "get_issue",
        "triage_issue",
        "run_autofix",
        "get_improvement_queue",
        "export_fixture",
    }
    assert required <= names
    assert len(TOOL_CATALOG) >= len(required)


@pytest.mark.asyncio
async def test_call_tool_search_traces() -> None:
    out = await call_tool(
        "search_traces",
        {"org_id": "org_1", "query": "fail", "limit": 5},
        client=_FakeClient(),
    )
    assert out["status"] == "ok"
    assert out["result"]["traces"][0]["id"] == "trc_1"


@pytest.mark.asyncio
async def test_call_tool_debugger_and_issues() -> None:
    client = _FakeClient()
    cp = await call_tool(
        "list_checkpoints",
        {"org_id": "org_1", "trace_id": "trc_9"},
        client=client,
    )
    assert cp["status"] == "ok"
    assert cp["result"]["checkpoints"]

    triage = await call_tool(
        "triage_issue",
        {"org_id": "org_1", "issue_id": "iss_9"},
        client=client,
        auth=_WRITE_AUTH,
    )
    assert triage["status"] == "ok"
    assert triage["result"]["root_cause"] == "loop"

    fix = await call_tool(
        "run_autofix",
        {"org_id": "org_1", "issue_id": "iss_9", "dry_run": True},
        client=client,
        auth=_WRITE_AUTH,
    )
    assert fix["status"] == "ok"
    assert fix["result"]["dry_run"] is True


@pytest.mark.asyncio
async def test_call_tool_improvement_queue() -> None:
    out = await call_tool(
        "get_improvement_queue",
        {"org_id": "org_1"},
        client=_FakeClient(),
    )
    assert out["status"] == "ok"
    assert out["result"]["count"] == 1


@pytest.mark.asyncio
async def test_unknown_tool() -> None:
    out = await call_tool("not_a_tool", {"org_id": "org_1"}, client=_FakeClient())
    assert out["status"] == "error"
