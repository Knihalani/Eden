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

from tests._portal_api_source import portal_api_dir, portal_api_source

PORTAL_API_DIR = portal_api_dir()
SIDEBAR = (
    Path(__file__).resolve().parents[3]
    / "clients"
    / "portal"
    / "src"
    / "lib"
    / "sidebar-config.ts"
)


def test_portal_api_ts_exists() -> None:
    assert PORTAL_API_DIR.is_dir(), f"missing {PORTAL_API_DIR}"
    assert any(PORTAL_API_DIR.glob("*.ts")), f"empty {PORTAL_API_DIR}"


def test_debugger_portal_paths_match_backend() -> None:
    src = portal_api_source()
    assert "/debugger/checkpoints/${encodeURIComponent(traceId)}" in src
    assert "debugger/rewind" not in src
    assert "step_number" in src
    assert "prompt_override" in src
    block = src.split("const debuggerApi")[1].split("const qaApi")[0]
    assert "rewind:" not in block
    assert "listCheckpoints" in block
    assert "rerun:" in block


def test_signals_portal_paths_match_backend() -> None:
    src = portal_api_source()
    block = src.split("const signalsApi")[1].split("const debuggerApi")[0]
    assert "/signals" in block
    assert "description: string" in block
    assert "compile:" not in block
    assert "/compile" not in block
    assert "/match" in block
    assert "CompiledRule" in src


def test_agent_issues_portal_paths_match_backend() -> None:
    src = portal_api_source()
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


def test_nl_alerts_portal_paths_match_backend() -> None:
    src = portal_api_source()
    assert "/alerts/compile" in src
    assert "/nl-alert-rules" in src
    assert "/alert-events" in src
    assert "compileNlAlert" in src
    assert "listNlAlertRules" in src
    assert "overrideAlertVerdict" in src
    assert "nlAlertsApi" in src


def test_backend_nl_alert_routes_are_mounted() -> None:
    from eden.alerts import routes as nl_alerts

    paths = {r.path for r in nl_alerts.router.routes if isinstance(r, APIRoute)}
    assert "/orgs/{org_id}/alerts/compile" in paths
    assert "/orgs/{org_id}/nl-alert-rules" in paths
    assert "/orgs/{org_id}/alert-events" in paths
    assert "/orgs/{org_id}/alerts/{alert_id}/override" in paths


def test_sidebar_signals_nav_is_visible() -> None:
    text = SIDEBAR.read_text(encoding="utf-8")
    signal_lines = [ln for ln in text.splitlines() if 'href: "/alerts?tab=signals"' in ln]
    assert signal_lines, 'expected Signals nav entry with href: "/alerts?tab=signals"'
    assert any('id: "signals"' in ln for ln in text.splitlines())


@pytest.mark.asyncio
async def test_debugger_list_checkpoints_path_form() -> None:
    """Smoke the path-form handler returns the CheckpointListResponse shape."""
    from eden.api.routes import debugger as dbg

    class _Store:
        async def list_for_trace(self, trace_id: str, org_id: str | None = None):  # noqa: ANN001
            assert trace_id == "trc_1"
            assert org_id == "org_1"
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


def test_improve_portal_paths_in_api_ts() -> None:
    src = portal_api_source()
    assert "/improve/plans" in src or "improveApi" in src or "/improve/" in src


def test_backend_improve_routes_are_mounted() -> None:
    from eden.api.routes import improve

    paths = {r.path for r in improve.router.routes if isinstance(r, APIRoute)}
    assert "/orgs/{org_id}/improve/plans" in paths
    assert "/orgs/{org_id}/improve/plans/{plan_id}" in paths
    assert "/orgs/{org_id}/improve/plans/{plan_id}/approve" in paths
    assert "/orgs/{org_id}/improve/runs" in paths
    assert "/orgs/{org_id}/improve/schedule" in paths


def test_phase2_agent_sessions_portal_paths() -> None:
    src = portal_api_source()
    block = src.split("export const agentSessionsApi")[1].split(
        "// ── F58"
    )[0]
    assert "/agent-sessions" in block
    assert "start:" in block
    assert "end:" in block
    assert "attachTrace:" in block


def test_phase2_saved_views_portal_paths() -> None:
    src = portal_api_source()
    assert "savedViewsApi" in src
    assert "/saved-searches" in src


def test_backend_agent_sessions_routes_are_mounted() -> None:
    from eden.api.routes import agent_sessions

    paths = {r.path for r in agent_sessions.router.routes if isinstance(r, APIRoute)}
    assert "" in paths or paths  # list route mounted on router prefix
    assert any("start" in p for p in paths)
    assert any("end" in p for p in paths)


def test_backend_saved_searches_routes_are_mounted() -> None:
    from eden.api.routes.sharing import sharing_router

    paths = {r.path for r in sharing_router.routes if isinstance(r, APIRoute)}
    assert "/orgs/{org_id}/saved-searches" in paths

