"""Portal list payload / SQL bound regressions."""

from __future__ import annotations

import inspect

from eden.api.routes import portal as portal_mod


def test_clip_text_bounds_and_ellipsis():
    assert portal_mod._clip_text("short", 800) == "short"
    assert portal_mod._clip_text("x" * 10, 8) == "xxxxxxx…"
    assert len(portal_mod._clip_text("y" * 2000, 800)) == 800


def test_portal_traces_sql_uses_bounded_id_discovery_not_8k_cte():
    src = inspect.getsource(portal_mod.list_portal_traces)
    assert "LIMIT 3000" in src
    assert "LIMIT 8000" not in src
    assert "FROM telemetry_events e" in src
    assert "INNER JOIN ids" in src


def test_portal_agents_metrics_sample_bound_reduced():
    src = inspect.getsource(portal_mod.list_portal_agents)
    assert "LIMIT 4000" in src
    assert "LIMIT 15000" not in src


def test_portal_sessions_uses_trace_preview_cap():
    src = inspect.getsource(portal_mod.list_portal_sessions)
    assert "preview_trace_limit=40" in src


def test_issue_list_columns_project_slim_triage():
    from eden.issues.repo import _ISSUE_LIST_COLUMNS

    assert "affected_user_ids" not in _ISSUE_LIST_COLUMNS
    assert "experiment_result" not in _ISSUE_LIST_COLUMNS
    assert "jsonb_build_object" in _ISSUE_LIST_COLUMNS
    assert "triage_result->>'summary'" in _ISSUE_LIST_COLUMNS
