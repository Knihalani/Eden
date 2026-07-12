"""F48 — portal ↔ API path/type contract for debugger + signals + issues.

Locks the client contract shapes that historically 404'd / 422'd:
* debugger checkpoints are path-scoped by ``trace_id`` (no rewind route)
* signals create body is ``{description, enabled?}`` (no compile route)
* agent-issues paths match the mounted FastAPI router
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.routing import APIRoute

PORTAL_API = (
    Path(__file__).resolve().parents[3]
    / "clients"
    / "portal"
    / "src"
    / "lib"
    / "api.ts"
)
SIDEBAR = (
    Path(__file__).resolve().parents[3]
    / "clients"
    / "portal"
    / "src"
    / "lib"
    / "sidebar-config.ts"
)


def test_portal_api_ts_exists() -> None:
    assert PORTAL_API.is_file(), f"missing {PORTAL_API}"


def test_debugger_portal_paths_match_backend() -> None:
    src = PORTAL_API.read_text(encoding="utf-8")
    assert "/debugger/checkpoints/${encodeURIComponent(traceId)}" in src
    assert "debugger/rewind" not in src
    assert "step_number" in src
    assert "prompt_override" in src
    block = src.split("const debuggerApi")[1].split("const qaApi")[0]
    assert "rewind:" not in block
    assert "listCheckpoints" in block
    assert "rerun:" in block


def test_signals_portal_paths_match_backend() -> None:
    src = PORTAL_API.read_text(encoding="utf-8")
    block = src.split("const signalsApi")[1].split("const debuggerApi")[0]
    assert "/signals" in block
    assert "description: string" in block
    assert "compile:" not in block
    assert "/compile" not in block
    assert "/match" in block
    assert "CompiledRule" in src


def test_agent_issues_portal_paths_match_backend() -> None:
    src = PORTAL_API.read_text(encoding="utf-8")
    block = src.split("export const agentIssuesApi")[1].split(
        "// ── Intelligence: Eval"
    )[0]
    assert "/agent-issues" in block
    assert "/stumbles" in block
    assert "/resolve" in block
    assert "/triage" in block


def test_backend_debugger_routes_are_mounted() -> None:
    from eden.api.routes import debugger

    paths = {r.path for r in debugger.router.routes if isinstance(r, APIRoute)}
    assert "/orgs/{org_id}/debugger/checkpoints/{trace_id}" in paths
    assert "/orgs/{org_id}/debugger/rerun" in paths
    assert not any("rewind" in p for p in paths)


def test_backend_signals_routes_are_mounted() -> None:
    from eden.api.routes import signals

    paths = {r.path for r in signals.router.routes if isinstance(r, APIRoute)}
    assert "/orgs/{org_id}/signals" in paths
    assert any(p.endswith("/match") for p in paths)
    assert not any("/compile" in p for p in paths)


def test_backend_agent_issues_routes_are_mounted() -> None:
    from eden.api.routes import agent_issues

    paths = {
        r.path for r in agent_issues.router.routes if isinstance(r, APIRoute)
    }
    assert "/orgs/{org_id}/agent-issues" in paths
    assert "/orgs/{org_id}/agent-issues/{issue_id}" in paths
    assert "/orgs/{org_id}/stumbles" in paths


def test_sidebar_keeps_signals_hidden_until_smoke() -> None:
    text = SIDEBAR.read_text(encoding="utf-8")
    signal_lines = [ln for ln in text.splitlines() if 'href: "/signals"' in ln]
    assert signal_lines, "expected a commented Signals nav entry"
    assert all(ln.strip().startswith("//") for ln in signal_lines)


@pytest.mark.asyncio
async def test_debugger_list_checkpoints_path_form() -> None:
    """Smoke the path-form handler returns the CheckpointListResponse shape."""
    from eden.api.routes import debugger as dbg

    class _Store:
        async def list_for_trace(self, trace_id: str):  # noqa: ANN001
            assert trace_id == "trc_1"
            return []

    with (
        patch.object(dbg, "get_postgres_client", AsyncMock(return_value=MagicMock())),
        patch.object(dbg, "CheckpointStore", lambda _pg: _Store()),
    ):
        result = await dbg.list_checkpoints(
            org_id="org_1",
            trace_id="trc_1",
            user={"sub": "u1"},
        )
    assert result.checkpoints == []
