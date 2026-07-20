"""F04 MCP reliable — telemetry emission, console entry, rerun arg passthrough."""

from __future__ import annotations

import logging
from typing import Any
from unittest.mock import patch

import pytest

from eden.mcp_server.auth import McpAuthContext
from eden.mcp_server.server import call_tool, list_tools

_DEBUG_AUTH = McpAuthContext(
    api_key="test-key",
    base_url="http://127.0.0.1:8000",
    scopes=("mcp:read", "mcp:debug", "mcp:fix"),
)



# ── Fake client ────────────────────────────────────────────────────


class _CapturingClient:
    """Records every rerun_debugger call for assertion."""

    def __init__(self) -> None:
        self.rerun_calls: list[dict[str, Any]] = []

    async def search_traces(self, org_id: str, **kwargs: Any) -> dict[str, Any]:
        return {"traces": [], "query": kwargs}

    async def get_trace(self, org_id: str, trace_id: str) -> dict[str, Any]:
        return {"trace_id": trace_id, "org_id": org_id}

    async def get_transcript(
        self, org_id: str, trace_id: str, *, limit: int = 50
    ) -> dict[str, Any]:
        return {"trace_id": trace_id, "steps": [], "limit": limit}

    async def list_checkpoints(self, org_id: str, trace_id: str) -> dict[str, Any]:
        return {"checkpoints": []}

    async def rerun_debugger(
        self,
        org_id: str,
        *,
        trace_id: str,
        from_step: int = 0,
        prompt_override: str | None = None,
        rerun_mode: str | None = None,
        live_prefix: bool | None = None,
    ) -> dict[str, Any]:
        call = {
            "org_id": org_id,
            "trace_id": trace_id,
            "from_step": from_step,
            "prompt_override": prompt_override,
            "rerun_mode": rerun_mode,
            "live_prefix": live_prefix,
        }
        self.rerun_calls.append(call)
        return {
            "source_trace_id": trace_id,
            "from_step": from_step,
            "rerun_mode": rerun_mode,
            "live_prefix": live_prefix,
            "cache_hits": 3,
            "populated_steps": [0, 1, 2],
            "diff": [],
        }

    async def search_issues(self, org_id: str, **kwargs: Any) -> dict[str, Any]:
        return {"issues": [], "count": 0}

    async def get_issue(self, org_id: str, issue_id: str) -> dict[str, Any]:
        return {"issue": {"id": issue_id}}

    async def get_trace_stumbles(
        self,
        org_id: str,
        trace_id: str,
        *,
        kind: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        return {
            "stumbles": [{"id": "s1", "trace_id": trace_id, "kind": kind or "tool_error"}],
            "count": 1,
            "trace_id": trace_id,
            "limit": limit,
        }

    async def triage_issue(
        self, org_id: str, issue_id: str, *, force: bool = False
    ) -> dict[str, Any]:
        return {"issue_id": issue_id, "force": force, "root_cause": "test"}

    async def run_autofix(
        self, org_id: str, issue_id: str, *, dry_run: bool = True
    ) -> dict[str, Any]:
        return {"issue_id": issue_id, "dry_run": dry_run, "patch_summary": "noop"}

    async def get_improvement_queue(
        self, org_id: str, *, agent_id: str | None = None
    ) -> dict[str, Any]:
        return {"items": [], "count": 0, "agent_id": agent_id}

    async def export_fixture(self, org_id: str, issue_id: str) -> dict[str, Any]:
        return {"status": "ok", "fixture": {"issue": {"id": issue_id}}}

    async def create_regression_case(
        self, org_id: str, issue_id: str, *, max_traces: int = 3
    ) -> dict[str, Any]:
        return {"status": "ok", "issue_id": issue_id, "max_traces": max_traces}

    async def preview_change_impact(
        self,
        org_id: str,
        *,
        change_id: str,
        changed_files: list[str],
        agent_id: str | None = None,
    ) -> dict[str, Any]:
        return {"status": "ok", "change_id": change_id, "changed_files": changed_files}


# ── Console entry point ────────────────────────────────────────────


def test_console_entry_main_is_callable() -> None:
    from eden.mcp_server.__main__ import main

    assert callable(main)


def test_pyproject_script_target_importable() -> None:
    """Verify the target referenced by pyproject.toml [project.scripts] is importable."""
    import importlib

    mod = importlib.import_module("eden.mcp_server.__main__")
    assert hasattr(mod, "main"), "eden.mcp_server.__main__ must expose main()"
    assert callable(mod.main)


# ── Telemetry emission ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_call_tool_emits_telemetry_on_success() -> None:
    client = _CapturingClient()
    captured: list[dict[str, Any]] = []

    class _Handler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            captured.append(record.__dict__)

    handler = _Handler()
    server_logger = logging.getLogger("eden.mcp_server.server")
    original_level = server_logger.level
    server_logger.setLevel(logging.INFO)
    server_logger.addHandler(handler)
    try:
        out = await call_tool(
            "search_traces",
            {"org_id": "org_tel", "query": "error"},
            client=client,
        )
    finally:
        server_logger.removeHandler(handler)
        server_logger.setLevel(original_level)

    assert out["status"] == "ok"
    assert any(r.get("msg") == "mcp.tool_call" for r in captured), (
        "Expected a 'mcp.tool_call' log record"
    )
    tel = next(r for r in captured if r.get("msg") == "mcp.tool_call")
    assert tel["mcp.server_name"] == "eden-mcp-server"
    assert tel["mcp.tool_name"] == "search_traces"
    assert tel["eden.mcp_server.org_id"] == "org_tel"
    assert tel["eden.mcp_server.status"] == "ok"
    assert isinstance(tel["eden.mcp_server.duration_ms"], float)


@pytest.mark.asyncio
async def test_call_tool_emits_telemetry_on_error() -> None:
    captured: list[dict[str, Any]] = []

    class _Handler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            captured.append(record.__dict__)

    handler = _Handler()
    server_logger = logging.getLogger("eden.mcp_server.server")
    server_logger.addHandler(handler)
    try:
        out = await call_tool(
            "unknown_tool_xyz",
            {"org_id": "org_tel"},
            client=_CapturingClient(),
        )
    finally:
        server_logger.removeHandler(handler)

    assert out["status"] == "error"


@pytest.mark.asyncio
async def test_telemetry_never_breaks_tool_response() -> None:
    """Even if the telemetry logger raises, the tool result is still returned."""
    client = _CapturingClient()

    with patch("eden.mcp_server.server.logger") as mock_logger:
        mock_logger.info.side_effect = RuntimeError("logger exploded")
        out = await call_tool(
            "search_traces",
            {"org_id": "org_1", "query": "test"},
            client=client,
        )

    assert out["status"] == "ok"


# ── get_trace_stumbles (F28 / WP1) ────────────────────────────────


def test_get_trace_stumbles_registered() -> None:
    names = {t["name"] for t in list_tools()}
    assert "get_trace_stumbles" in names


@pytest.mark.asyncio
async def test_get_trace_stumbles_passthrough() -> None:
    client = _CapturingClient()
    out = await call_tool(
        "get_trace_stumbles",
        {"org_id": "org_1", "trace_id": "trc_s", "kind": "loop"},
        client=client,
    )
    assert out["status"] == "ok"
    result = out["result"]
    assert result["count"] == 1
    assert result["stumbles"][0]["kind"] == "loop"
    assert result["trace_id"] == "trc_s"


# ── rerun_debugger arg passthrough ────────────────────────────────


@pytest.mark.asyncio
async def test_rerun_debugger_passes_rerun_mode_and_live_prefix() -> None:
    client = _CapturingClient()
    out = await call_tool(
        "rerun_debugger",
        {
            "org_id": "org_1",
            "trace_id": "trc_abc",
            "from_step": 3,
            "rerun_mode": "cached_live",
            "live_prefix": True,
        },
        client=client,
        auth=_DEBUG_AUTH,
    )

    assert out["status"] == "ok"
    assert len(client.rerun_calls) == 1
    call = client.rerun_calls[0]
    assert call["trace_id"] == "trc_abc"
    assert call["from_step"] == 3
    assert call["rerun_mode"] == "cached_live"
    assert call["live_prefix"] is True


@pytest.mark.asyncio
async def test_rerun_debugger_defaults_no_rerun_mode() -> None:
    client = _CapturingClient()
    out = await call_tool(
        "rerun_debugger",
        {"org_id": "org_1", "trace_id": "trc_def"},
        client=client,
        auth=_DEBUG_AUTH,
    )

    assert out["status"] == "ok"
    call = client.rerun_calls[0]
    assert call["rerun_mode"] is None
    assert call["live_prefix"] is None


@pytest.mark.asyncio
async def test_rerun_debugger_returns_cache_stats() -> None:
    client = _CapturingClient()
    out = await call_tool(
        "rerun_debugger",
        {
            "org_id": "org_1",
            "trace_id": "trc_cache",
            "rerun_mode": "cached_live",
            "live_prefix": True,
        },
        client=client,
        auth=_DEBUG_AUTH,
    )

    assert out["status"] == "ok"
    result = out["result"]
    assert result["cache_hits"] == 3
    assert result["populated_steps"] == [0, 1, 2]


def test_rerun_debugger_catalog_has_new_params() -> None:
    tools = {t["name"]: t for t in list_tools()}
    schema = tools["rerun_debugger"]["inputSchema"]["properties"]
    assert "rerun_mode" in schema
    assert "live_prefix" in schema
    assert schema["live_prefix"]["type"] == "boolean"


def test_rerun_debugger_description_documents_f01_limitation() -> None:
    from eden.mcp_server.server import TOOL_CATALOG

    entry = next(t for t in TOOL_CATALOG if t["name"] == "rerun_debugger")
    desc = entry["description"]
    assert "new_trace_id" in desc
    assert "F01" in desc
