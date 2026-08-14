"""FEAT-55 — portal session list reads ``session_summaries``."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.api.routes.portal import (
    _portal_outcome_from_summary,
    _session_summary_to_rollup,
)


def test_portal_outcome_mapping() -> None:
    assert _portal_outcome_from_summary("success", had_stumble=False) == "ok"
    assert _portal_outcome_from_summary("success", had_stumble=True) == "mixed"
    assert _portal_outcome_from_summary("fail", had_stumble=False) == "error"
    assert _portal_outcome_from_summary("partial", had_stumble=False) == "mixed"
    assert _portal_outcome_from_summary("live", had_stumble=False) == "mixed"


def test_session_summary_to_rollup_projects_n12_fields() -> None:
    rollup = _session_summary_to_rollup(
        {
            "session_id": "sess-1",
            "agent_id": "agt-1",
            "user_id": "usr-1",
            "trace_ids": ["t1", "t2"],
            "turn_count": 2,
            "total_cost_usd": 0.42,
            "total_input_tokens": 100,
            "total_output_tokens": 50,
            "total_latency_ms": 1200.0,
            "session_start": "2026-07-23T12:00:00+00:00",
            "session_end": "2026-07-23T12:01:00+00:00",
            "had_stumble": False,
            "stumble_count": 0,
            "outcome": "success",
            "linked_issue_id": None,
        }
    )
    assert rollup.id == "sess-1"
    assert rollup.agentId == "agt-1"
    assert rollup.userId == "usr-1"
    assert rollup.turnCount == 2
    assert rollup.outcome == "ok"
    assert rollup.durationMs == 1200
    assert rollup.totalTokens == 150
    assert rollup.costUsd == 0.42
    assert rollup.traceIds == ["t1", "t2"]
    assert rollup.diagnosis == "2 turns completed"
    assert rollup.helped == "unknown"
    assert rollup.success is None


@pytest.mark.asyncio
async def test_list_portal_sessions_calls_list_sessions() -> None:
    from eden.api.routes import portal as portal_mod

    summary = {
        "session_id": "sess-9",
        "agent_id": "agt-9",
        "user_id": None,
        "trace_ids": ["tr-9"],
        "turn_count": 1,
        "total_cost_usd": 0.0,
        "total_input_tokens": 10,
        "total_output_tokens": 5,
        "total_latency_ms": 500.0,
        "session_start": "2026-07-23T12:00:00+00:00",
        "session_end": "2026-07-23T12:00:30+00:00",
        "had_stumble": False,
        "stumble_count": 0,
        "outcome": "success",
        "linked_issue_id": None,
    }
    list_mock = AsyncMock(return_value={"sessions": [summary], "total": 1, "limit": 50, "offset": 0})
    related_mock = AsyncMock(return_value={})

    with (
        patch.object(portal_mod, "_require_pg", new=AsyncMock()),
        patch("eden.sessions.list_sessions", list_mock),
        patch.object(portal_mod, "_related_issue_ids_by_session", related_mock),
        patch.object(portal_mod, "_annotate_session_help", new=AsyncMock()),
    ):
        rows = await portal_mod.list_portal_sessions(org_id="org-1", limit=50, _user={})

    list_mock.assert_awaited_once_with("org-1", limit=50)
    assert len(rows) == 1
    assert rows[0].id == "sess-9"
