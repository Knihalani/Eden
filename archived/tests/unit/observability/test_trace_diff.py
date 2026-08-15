"""Wave 9 — trace diff: O(n+m) alignment, per-step kinds, aggregates, lean fetch."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.observability.trace_diff import (
    align_events,
    diff_events,
    diff_traces,
    fetch_diff_events,
)


def _ev(
    i: int,
    *,
    name: str = "step",
    outcome: str = "success",
    error_type: str | None = None,
    cost: float = 0.0,
    span_id: str | None = None,
    event_type: str = "llm.call",
    duration_ms: float = 10.0,
) -> dict[str, Any]:
    return {
        "event_id": f"e{i}",
        "trace_id": "t",
        "span_id": span_id if span_id is not None else f"span-{i}",
        "event_type": event_type,
        "name": name,
        "timestamp": f"2026-08-10T00:00:{i:02d}Z",
        "duration_ms": duration_ms,
        "outcome": outcome,
        "error_type": error_type,
        "parent_span_id": None,
        "agent_id": "agent-a",
        "cost_usd": cost,
        "input_tokens": i * 10,
        "output_tokens": i * 5,
    }


@pytest.mark.asyncio
async def test_align_events_matches_by_span_id_in_o_of_n() -> None:
    a = [_ev(i, name=f"s{i}") for i in range(500)]
    b = [_ev(i, name=f"s{i}") for i in range(500)]
    pairs = align_events(a, b)
    assert len(pairs) == 500
    assert all(ea is not None and eb is not None for ea, eb in pairs)
    assert all(ea["span_id"] == eb["span_id"] for ea, eb in pairs)


def test_align_events_marks_removed_and_added() -> None:
    a = [_ev(0), _ev(1), _ev(2)]
    # B dropped span-1 and added span-9.
    b = [_ev(0), _ev(2, span_id="span-2"), _ev(9, span_id="span-9")]
    pairs = align_events(a, b)
    kinds = [
        "same" if ea and eb else ("only_a" if ea else "only_b")
        for ea, eb in pairs
    ]
    assert "only_a" in kinds  # span-1 removed
    assert "only_b" in kinds  # span-9 added
    assert len(pairs) == 4  # 2 matched + 1 removed + 1 added


def test_diff_events_marks_changed_outcome_and_error() -> None:
    a = [_ev(0, outcome="success", error_type=None)]
    b = [_ev(0, outcome="failure", error_type="timeout")]
    out = diff_events("ta", "tb", a, b)
    assert out["steps"][0]["kind"] == "changed"
    assert out["steps"][0]["outcome_a"] == "success"
    assert out["steps"][0]["outcome_b"] == "failure"
    assert out["steps"][0]["error_b"] == "timeout"
    assert out["counts"]["changed"] == 1


def test_diff_events_same_steps_are_same() -> None:
    a = [_ev(0), _ev(1)]
    b = [_ev(0), _ev(1)]
    out = diff_events("ta", "tb", a, b)
    assert out["counts"] == {"same": 2, "changed": 0, "added": 0, "removed": 0}
    assert out["totals"]["span_count_delta"] == 0


def test_diff_events_aggregates_deltas() -> None:
    a = [
        _ev(0, cost=1.0, duration_ms=100.0),
        _ev(1, cost=2.0, duration_ms=200.0, error_type="crash"),
    ]
    b = [
        _ev(0, cost=3.0, duration_ms=300.0),
        _ev(1, cost=4.0, duration_ms=400.0),
        _ev(2, cost=5.0, duration_ms=500.0),
    ]
    out = diff_events("ta", "tb", a, b)
    assert out["totals"]["cost_delta_usd"] == pytest.approx(12.0 - 3.0)
    assert out["totals"]["span_count_delta"] == 1
    assert out["totals"]["failures_a"] == 1
    assert out["totals"]["failures_b"] == 0
    assert out["trace_a"]["cost_usd"] == pytest.approx(3.0)
    assert out["trace_b"]["cost_usd"] == pytest.approx(12.0)


def test_align_events_falls_back_to_ordered_no_span_match() -> None:
    a = [_ev(0, span_id=None, name="llm"), _ev(1, span_id=None, name="tool")]
    b = [_ev(0, span_id=None, name="llm"), _ev(1, span_id=None, name="tool")]
    pairs = align_events(a, b)
    assert len(pairs) == 2
    assert all(ea is not None and eb is not None for ea, eb in pairs)


@pytest.mark.asyncio
async def test_fetch_diff_events_uses_lean_columns() -> None:
    class _PG:
        async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
            # Capture the projection — the wide blobs must NOT be selected.
            assert "request_body" not in sql
            assert "response_body" not in sql
            assert "tool_calls_full" not in sql
            assert "payload," not in sql.split("FROM", 1)[0]
            assert "cost_usd" in sql
            return [{"event_id": "e1", "cost_usd": 0.5}]

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=_PG()),
    ):
        rows = await fetch_diff_events("org", "trace-1")
    assert rows == [{"event_id": "e1", "cost_usd": 0.5}]


@pytest.mark.asyncio
async def test_fetch_diff_events_returns_empty_on_error() -> None:
    async def _boom() -> Any:
        raise RuntimeError("postgres down")

    with patch(
        "eden.storage.postgres.get_postgres_client",
        _boom,
    ):
        assert await fetch_diff_events("org", "trace-1") == []


@pytest.mark.asyncio
async def test_diff_traces_none_when_either_trace_missing() -> None:
    with patch(
        "eden.observability.trace_diff.fetch_diff_events",
        AsyncMock(side_effect=[[], [{"event_id": "e1"}]]),
    ):
        assert await diff_traces("org", "missing", "present") is None


@pytest.mark.asyncio
async def test_diff_traces_returns_payload() -> None:
    events = [_ev(0)]
    with patch(
        "eden.observability.trace_diff.fetch_diff_events",
        AsyncMock(return_value=events),
    ):
        out = await diff_traces("org", "ta", "tb")
    assert out is not None
    assert out["trace_a"]["trace_id"] == "ta"
    assert out["trace_b"]["trace_id"] == "tb"


def test_trace_diff_route_registered() -> None:
    from eden.api.routes.observability import router

    paths = {
        r.path
        for r in router.routes
        if getattr(r, "methods", None) and "POST" in r.methods
    }
    assert "/orgs/{org_id}/observability/traces/diff" in paths
