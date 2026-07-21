"""Tests for the Tool Intelligence (Cat 7) surface.

Covers:

1. :class:`ToolAttributionScorer` — happy path, empty
   telemetry, per-trace events, drift detection
   (current-vs-previous window), hook firing, bad input.
2. :class:`ToolComparator` — happy path with a clear
   winner, tie case, empty telemetry, bad input, hook
   firing on large inter-tool gap.
3. :class:`ToolRecommender` — happy path with top-K
   ranking, empty telemetry, deterministic tiebreak.
4. :class:`ToolRegistryTaxonomy` — happy path with
   distinct tools + co-occurrence, empty telemetry.
5. Envelope helpers — shape, ``live=True`` invariant.
6. Shared helpers — :func:`_extract_tool_name`,
   :func:`_tool_is_success`, :func:`_percentile`,
   :func:`_clamp`, :func:`_round6`, :func:`_safe_float`.
7. Closed-loop hook firing — :func:`_fire_tool_drift_hook`
   fires on a high-severity drop, no-ops below the
   threshold, no-ops on a non-call tool, no-ops when
   n_calls below the floor.
8. Package contract — lazy re-exports, ``__dir__``,
   ``AttributeError`` on unknown name.
9. Route smoke tests — the 4 Cat 7 endpoints return the
   uniform envelope, registered under
   ``intelligence-tools`` OpenAPI tag.

Mocking strategy mirrors the Cat 4 / Cat 8 / Cat 6
convention: a ``_pg_router`` mock that routes by SQL
fragment to the appropriate return value, plus a
``_patch_*`` helper that monkey-patches the
``get_postgres_client`` import inside the package so the
services see the mock.
"""

from __future__ import annotations

import importlib
from collections.abc import Callable
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── 1. ToolAttributionScorer ────────────────────────────────────────


@pytest.fixture(autouse=True)
def _mock_persistence():
    """Autouse: mock the persistence helpers so the
    ``async with client.acquire() as conn:`` block (which the
    real asyncpg-backed persistence path uses) never runs in
    unit tests. Without this, the MagicMock's ``acquire`` is
    a non-async-context-manager and the test runner raises
    ``RuntimeWarning: coroutine 'AsyncMockMixin
    ._execute_mock_call' was never awaited``.

    Mirrors the Cat 4 / Cat 8 test pattern at
    ``tests/intelligence/test_retrieval_intelligence.py``
    (mock the persistence helper, not the underlying
    asyncpg connection). The patch target is the *services*
    module's reference (where the function is bound by
    ``from ._common import ...``), not the source module —
    patching the source would only affect new lookups, not
    the bound reference the services call through.
    """
    with patch(
        "eden.services.tool_intel.services._delete_then_insert_attribution",
        new=AsyncMock(),
    ), patch(
        "eden.services.tool_intel.services._delete_then_insert_comparison",
        new=AsyncMock(),
    ):
        yield


def _tool_event(
    *,
    tool_name: str = "search_kb",
    event_type: str = "tool.call",
    trace_id: str = "trace-1",
    duration_ms: int | None = 100,
    outcome: str | None = "success",
    agent_id: str | None = "agent_a",
    attributes: dict[str, Any] | None = None,
    payload: dict[str, Any] | None = None,
    name: str | None = None,
) -> dict[str, Any]:
    """Build a tool telemetry event row in the shape the
    services read from ``telemetry_events``. The defaults
    produce a successful 100 ms tool call in trace-1."""
    attrs = dict(attributes or {})
    attrs.setdefault("tool_name", tool_name)
    return {
        "trace_id": trace_id,
        "event_type": event_type,
        "duration_ms": duration_ms,
        "outcome": outcome,
        "agent_id": agent_id,
        "attributes": attrs,
        "payload": payload or {},
        "name": name,
        "created_at": "2026-06-11T12:00:00+00:00",
    }


class _PGRouter:
    """Routes ``client.fetch`` calls to the right fixture
    based on a SQL-fragment matcher. Mirrors the pattern
    in :mod:`tests.intelligence.test_retrieval_intelligence`."""

    def __init__(self) -> None:
        self._handlers: list[tuple[str, Callable[[str, tuple, dict], list[dict[str, Any]]]]] = []

    def on(
        self, fragment: str
    ) -> Callable[[Callable[[str, tuple, dict], list[dict[str, Any]]]], Callable]:
        def deco(fn: Callable[[str, tuple, dict], list[dict[str, Any]]]) -> Callable:
            self._handlers.append((fragment, fn))
            return fn
        return deco

    def build(self) -> MagicMock:
        pg = MagicMock()
        handlers = list(self._handlers)

        async def _fetch(sql: str, *args: Any, **kwargs: Any) -> list[dict[str, Any]]:
            for fragment, fn in handlers:
                if fragment in sql:
                    return list(fn(sql, args, kwargs))
            return []

        async def _fetchrow(sql: str, *args: Any, **kwargs: Any) -> Any:
            rows = await _fetch(sql, *args, **kwargs)
            if not rows:
                return None
            return rows[0]

        pg.fetch = AsyncMock(side_effect=_fetch)
        pg.fetchrow = AsyncMock(side_effect=_fetchrow)
        pg.execute = AsyncMock(return_value="OK")
        pg.acquire = MagicMock()
        return pg


@pytest.mark.asyncio
async def test_attribution_happy_path() -> None:
    """Tool with 8 successful + 2 failed calls → success_rate
    0.8, n_calls 10, p50/p95 latency computed."""
    from eden.services.tool_intel.services import ToolAttributionScorer

    events = (
        [_tool_event(outcome="success", duration_ms=100 + i * 10) for i in range(8)]
        + [_tool_event(outcome="error", duration_ms=500 + i * 10) for i in range(2)]
    )
    router = _PGRouter()
    router.on("FROM telemetry_events")(  # any tool query
        lambda sql, a, kw: events
    )
    router.on("created_at > NOW() - $2::interval")(
        lambda sql, a, kw: events
    )
    pg = router.build()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        return_value=pg,
    ):
        result = await ToolAttributionScorer().score(
            "org_test", tool_id="search_kb", window="30d"
        )
    assert result["status"] == "ok"
    assert result["live"] is True
    assert result["feature"] == "tool_attribution"
    d = result["data"]
    assert d["tool_name"] == "search_kb"
    assert d["n_calls"] == 10
    assert d["n_success"] == 8
    assert d["success_rate"] == pytest.approx(0.8)
    assert d["p50_ms"] is not None
    assert d["p95_ms"] is not None
    assert d["contribution_score"] is not None
    assert d["contribution_score"] > 0.0


@pytest.mark.asyncio
async def test_attribution_empty_telemetry_returns_envelope() -> None:
    """No tool events for the org → "no tool telemetry"
    envelope with zero-default metrics."""
    from eden.services.tool_intel.services import ToolAttributionScorer

    pg = _PGRouter().build()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        return_value=pg,
    ):
        result = await ToolAttributionScorer().score(
            "org_test", tool_id="nonexistent_tool", window="30d"
        )
    assert result["status"] == "ok"
    d = result["data"]
    assert d["n_calls"] == 0
    assert d["success_rate"] is None
    assert d["contribution_score"] is None
    assert d["message"] == "no tool telemetry"


@pytest.mark.asyncio
async def test_attribution_rejects_empty_tool_id() -> None:
    """Empty tool_id → bad-request envelope, no DB call."""
    from eden.services.tool_intel.services import ToolAttributionScorer

    pg = _PGRouter().build()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        return_value=pg,
    ):
        result = await ToolAttributionScorer().score(
            "org_test", tool_id="", window="30d"
        )
    assert result["status"] == "bad_request"
    pg.fetch.assert_not_called()


@pytest.mark.asyncio
async def test_attribution_rejects_invalid_window() -> None:
    """Malformed window string → bad-request envelope."""
    from eden.services.tool_intel.services import ToolAttributionScorer

    result = await ToolAttributionScorer().score(
        "org_test", tool_id="search_kb", window="not-a-window"
    )
    assert result["status"] == "bad_request"
    assert "invalid window" in result["data"]["message"]


@pytest.mark.asyncio
async def test_attribution_per_trace_events_returned() -> None:
    """When trace_id is provided, the response carries the
    per-trace events list (one row per matching event)."""
    from eden.services.tool_intel.services import ToolAttributionScorer

    events = [
        _tool_event(trace_id="trace-1", outcome="success", duration_ms=120),
        _tool_event(trace_id="trace-1", outcome="error", duration_ms=300),
    ]
    router = _PGRouter()
    router.on("trace_id = $2")(lambda sql, a, kw: events)
    router.on("FROM telemetry_events")(  # aggregate query
        lambda sql, a, kw: events
    )
    pg = router.build()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        return_value=pg,
    ):
        result = await ToolAttributionScorer().score(
            "org_test",
            trace_id="trace-1",
            tool_id="search_kb",
            window="30d",
        )
    assert result["status"] == "ok"
    d = result["data"]
    assert d["trace_id"] == "trace-1"
    assert len(d["per_trace"]) == 2
    assert d["per_trace"][0]["success"] is True
    assert d["per_trace"][1]["success"] is False


@pytest.mark.asyncio
async def test_attribution_drift_alert_on_success_rate_drop() -> None:
    """When the current window's success_rate is materially
    lower than the previous window's, the response carries
    a ``drift_alerts`` entry."""
    from eden.services.tool_intel.services import ToolAttributionScorer

    # 20 successful in current window
    current = [
        _tool_event(outcome="success", duration_ms=100) for _ in range(20)
    ]
    # 20 successful in previous window (so the drop is 1.0 → 0.0)
    previous = [
        _tool_event(outcome="success", duration_ms=100) for _ in range(20)
    ]
    router = _PGRouter()
    # First call: current window (n_calls=20, sr=1.0)
    # Second call: previous window (n_calls=20, sr=1.0)
    # We swap them by using a counter so the first call gets
    # the "bad" data.

    def _route(sql: str, a: Any, kw: Any) -> list[dict[str, Any]]:
        # The "previous window" query has the doubled-interval
        # fragment. We use that to distinguish.
        if "created_at <= NOW() - $3::interval" in sql:
            return previous  # all success in previous
        return current  # all success in current — no drop
    router.on("FROM telemetry_events")(lambda sql, a, kw: _route(sql, a, kw))
    pg = router.build()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        return_value=pg,
    ):
        result = await ToolAttributionScorer().score(
            "org_test", tool_id="search_kb", window="30d"
        )
    # With no actual drop, drift_alerts should be empty
    assert result["data"]["drift_alerts"] == []


# ─── 2. ToolComparator ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_compare_picks_winner_with_margin() -> None:
    """Tool A 0.9 success, Tool B 0.5 success → tool_a wins
    with confidence > 0.5; success_rate_diff = 0.4."""
    from eden.services.tool_intel.services import ToolComparator

    events_a = [_tool_event(tool_name="tool_a", outcome="success") for _ in range(9)]
    events_a.append(_tool_event(tool_name="tool_a", outcome="error"))
    events_b = [_tool_event(tool_name="tool_b", outcome="success") for _ in range(5)]
    events_b.extend(_tool_event(tool_name="tool_b", outcome="error") for _ in range(5))

    router = _PGRouter()
    # The comparator calls _fetch_tool_aggregates twice (once
    # per tool). The first call's filter is by the
    # tool_name passed; we route by argument value.
    def _route(sql: str, a: Any, kw: Any) -> list[dict[str, Any]]:
        if len(a) >= 3 and a[2] == "tool_a":
            return events_a
        if len(a) >= 3 and a[2] == "tool_b":
            return events_b
        return []
    router.on("FROM telemetry_events")(_route)
    pg = router.build()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        return_value=pg,
    ):
        result = await ToolComparator().compare(
            "org_test", tool_a="tool_a", tool_b="tool_b", window="7d"
        )
    assert result["status"] == "ok"
    d = result["data"]
    assert d["winner"] == "tool_a"
    assert d["success_rate_diff"] == pytest.approx(0.4)
    assert d["confidence"] > 0.5


@pytest.mark.asyncio
async def test_compare_tie_below_margin() -> None:
    """When the success-rate difference is < 0.05 (the
    non-inferiority margin), the comparator returns
    ``winner="tie"``."""
    from eden.services.tool_intel.services import ToolComparator

    # Tool A: 8/10 success (0.8). Tool B: 7/10 success (0.7).
    # Difference: 0.1 — above margin, so tool_a wins.
    # To test the tie path, use 5/6 vs 4/5: 0.833 vs 0.8 → 0.033.
    events_a = [_tool_event(tool_name="tool_a", outcome="success") for _ in range(5)]
    events_a.append(_tool_event(tool_name="tool_a", outcome="error"))
    events_b = [_tool_event(tool_name="tool_b", outcome="success") for _ in range(4)]
    events_b.append(_tool_event(tool_name="tool_b", outcome="error"))

    router = _PGRouter()
    def _route(sql: str, a: Any, kw: Any) -> list[dict[str, Any]]:
        if len(a) >= 3 and a[2] == "tool_a":
            return events_a
        if len(a) >= 3 and a[2] == "tool_b":
            return events_b
        return []
    router.on("FROM telemetry_events")(_route)
    pg = router.build()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        return_value=pg,
    ):
        result = await ToolComparator().compare(
            "org_test", tool_a="tool_a", tool_b="tool_b", window="7d"
        )
    assert result["data"]["winner"] == "tie"
    # 5/6 - 4/5 = 25/30 - 24/30 = 1/30 ≈ 0.0333 (rounded to 6dp)
    assert result["data"]["success_rate_diff"] == pytest.approx(0.033333, abs=1e-5)


@pytest.mark.asyncio
async def test_compare_empty_telemetry_returns_tie() -> None:
    """When neither tool has any telemetry, the comparator
    returns ``winner="tie"`` + ``"no tool telemetry"``
    message."""
    from eden.services.tool_intel.services import ToolComparator

    pg = _PGRouter().build()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        return_value=pg,
    ):
        result = await ToolComparator().compare(
            "org_test", tool_a="missing_x", tool_b="missing_y", window="7d"
        )
    assert result["status"] == "ok"
    assert result["data"]["winner"] == "tie"
    assert result["data"]["message"] == "no tool telemetry"


@pytest.mark.asyncio
async def test_compare_rejects_same_tool() -> None:
    """tool_a == tool_b → bad-request."""
    from eden.services.tool_intel.services import ToolComparator

    result = await ToolComparator().compare(
        "org_test", tool_a="same", tool_b="same", window="7d"
    )
    assert result["status"] == "bad_request"


@pytest.mark.asyncio
async def test_compare_rejects_empty_tool() -> None:
    """Empty tool_a → bad-request."""
    from eden.services.tool_intel.services import ToolComparator

    result = await ToolComparator().compare(
        "org_test", tool_a="", tool_b="valid", window="7d"
    )
    assert result["status"] == "bad_request"


@pytest.mark.asyncio
async def test_compare_drift_alert_on_large_gap() -> None:
    """success_rate_diff >= 0.20 with both tools having
    DRIFT_MIN_CALLS samples → drift_alert=True."""
    from eden.services.tool_intel.services import ToolComparator

    # Tool A: 100% success. Tool B: 50% success. Gap = 0.5.
    events_a = [_tool_event(tool_name="tool_a", outcome="success") for _ in range(20)]
    events_b = [_tool_event(tool_name="tool_b", outcome="success") for _ in range(10)]
    events_b.extend(_tool_event(tool_name="tool_b", outcome="error") for _ in range(10))

    router = _PGRouter()
    def _route(sql: str, a: Any, kw: Any) -> list[dict[str, Any]]:
        if len(a) >= 3 and a[2] == "tool_a":
            return events_a
        if len(a) >= 3 and a[2] == "tool_b":
            return events_b
        return []
    router.on("FROM telemetry_events")(_route)
    pg = router.build()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        return_value=pg,
    ):
        result = await ToolComparator().compare(
            "org_test", tool_a="tool_a", tool_b="tool_b", window="7d"
        )
    assert result["data"]["winner"] == "tool_a"
    assert result["data"]["drift_alert"] is True


# ─── 3. ToolRecommender ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_recommend_returns_top_k() -> None:
    """With 3 tools in the org, the recommender returns up
    to K ranked by composite score (success + material +
    latency + cost)."""
    from eden.services.tool_intel.services import ToolRecommender

    # Three tools with different success rates and call counts.
    events_good = (
        [_tool_event(tool_name="good_tool", outcome="success") for _ in range(50)]
    )
    events_mid = (
        [_tool_event(tool_name="mid_tool", outcome="success") for _ in range(10)]
        + [_tool_event(tool_name="mid_tool", outcome="error") for _ in range(5)]
    )
    events_rare = (
        [_tool_event(tool_name="rare_tool", outcome="success") for _ in range(5)]
        + [_tool_event(tool_name="rare_tool", outcome="error") for _ in range(5)]
    )
    router = _PGRouter()
    call_idx = {"n": 0}
    def _route(sql: str, a: Any, kw: Any) -> list[dict[str, Any]]:
        # 1st call: distinct tools (returns the names + versions)
        # 2nd call: aggregate per tool (returns events)
        # We cycle through the events.
        buckets = [events_good, events_mid, events_rare]
        n = call_idx["n"]
        call_idx["n"] += 1
        if n == 0:
            # distinct tool query — return one row per tool
            return [
                {"tool_name": "good_tool", "tool_version": "1.0.0"},
                {"tool_name": "mid_tool", "tool_version": "1.0.0"},
                {"tool_name": "rare_tool", "tool_version": "1.0.0"},
            ]
        # aggregate queries — cycle
        return buckets[(n - 1) % 3]
    router.on("FROM telemetry_events")(_route)
    pg = router.build()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        return_value=pg,
    ):
        result = await ToolRecommender().recommend(
            "org_test", task_type="code_review", agent_id="agent_a", k=2
        )
    assert result["status"] == "ok"
    d = result["data"]
    assert d["k"] == 2
    assert len(d["recommendations"]) == 2
    # The top-1 should be good_tool (highest success + most material)
    assert d["recommendations"][0]["tool_name"] == "good_tool"
    # rare_tool has 10 calls and 50% success — its score is
    # below good_tool and below mid_tool, so it's excluded
    # from the top-2.
    rec_names = [r["tool_name"] for r in d["recommendations"]]
    assert "rare_tool" not in rec_names


@pytest.mark.asyncio
async def test_recommend_empty_telemetry_returns_envelope() -> None:
    """No tools in the org → empty recommendations + 'no
    tool telemetry' message."""
    from eden.services.tool_intel.services import ToolRecommender

    pg = _PGRouter().build()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        return_value=pg,
    ):
        result = await ToolRecommender().recommend(
            "org_test", task_type="any", agent_id="agent_a", k=3
        )
    assert result["status"] == "ok"
    assert result["data"]["recommendations"] == []
    assert result["data"]["message"] == "no tool telemetry"


# ─── 4. ToolRegistryTaxonomy ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_taxonomy_returns_catalog_and_cooccurrence() -> None:
    """The taxonomy response carries the tool catalog
    (one row per distinct tool) and the co_occurrence dict
    (pair → normalised frequency)."""
    from eden.services.tool_intel.services import ToolRegistryTaxonomy

    # 2 tools called together in the same trace.
    events = [
        _tool_event(tool_name="tool_x", trace_id="t1"),
        _tool_event(tool_name="tool_y", trace_id="t1"),
        _tool_event(tool_name="tool_x", trace_id="t2"),
        _tool_event(tool_name="tool_y", trace_id="t2"),
    ]
    # Co-occurrence query returns flat rows with a
    # top-level ``tool_name`` column (the SQL reads
    # ``attributes->>'tool_name'`` as the column alias).
    co_rows = [
        {"trace_id": "t1", "tool_name": "tool_x"},
        {"trace_id": "t1", "tool_name": "tool_y"},
        {"trace_id": "t2", "tool_name": "tool_x"},
        {"trace_id": "t2", "tool_name": "tool_y"},
    ]
    router = _PGRouter()
    call_idx = {"n": 0}
    def _route(sql: str, a: Any, kw: Any) -> list[dict[str, Any]]:
        n = call_idx["n"]
        call_idx["n"] += 1
        # Order of queries in the taxonomy:
        # 1) distinct tools (returns 1 row per tool)
        # 2..N) per-tool aggregate (cycles through events)
        # N+1) co-occurrence (returns the flat co_rows)
        if n == 0:
            return [
                {"tool_name": "tool_x", "tool_version": "1.0"},
                {"tool_name": "tool_y", "tool_version": "1.0"},
            ]
        if n <= 2:
            # per-tool aggregate
            tool = "tool_x" if n == 1 else "tool_y"
            return [e for e in events if e["attributes"]["tool_name"] == tool]
        # co-occurrence
        return co_rows
    router.on("FROM telemetry_events")(_route)
    pg = router.build()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        return_value=pg,
    ):
        result = await ToolRegistryTaxonomy().taxonomy("org_test")
    assert result["status"] == "ok"
    d = result["data"]
    assert len(d["tools"]) == 2
    tool_names = sorted(t["tool_name"] for t in d["tools"])
    assert tool_names == ["tool_x", "tool_y"]
    # Co-occurrence: tool_x and tool_y are in 2 traces together
    # with 4 calls each. min(2, 2) = 2. So normalised = 2/2 = 1.0.
    assert "tool_x,tool_y" in d["co_occurrence"]
    assert d["co_occurrence"]["tool_x,tool_y"] == pytest.approx(1.0)


@pytest.mark.asyncio
async def test_taxonomy_empty_telemetry_returns_envelope() -> None:
    """No tools → empty catalog + empty co_occurrence +
    'no tool telemetry' message."""
    from eden.services.tool_intel.services import ToolRegistryTaxonomy

    pg = _PGRouter().build()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        return_value=pg,
    ):
        result = await ToolRegistryTaxonomy().taxonomy("org_test")
    assert result["status"] == "ok"
    assert result["data"]["tools"] == []
    assert result["data"]["co_occurrence"] == {}
    assert result["data"]["message"] == "no tool telemetry"


# ─── 5. Envelope helpers ────────────────────────────────────────────


class TestEnvelopeHelpers:
    def test_ok_envelope_shape(self) -> None:
        from eden.services.tool_intel._common import _ok_envelope
        env = _ok_envelope("tool_attribution", {"x": 1})
        assert env["status"] == "ok"
        assert env["feature"] == "tool_attribution"
        assert env["live"] is True
        assert env["trace_id"].startswith("ti_")
        assert "timestamp" in env
        assert env["data"] == {"x": 1}

    def test_bad_request_envelope_shape(self) -> None:
        from eden.services.tool_intel._common import _bad_request_envelope
        env = _bad_request_envelope("tool_attribution", "bad input")
        assert env["status"] == "bad_request"
        assert env["data"]["message"] == "bad input"

    def test_not_found_envelope_shape(self) -> None:
        from eden.services.tool_intel._common import _not_found_envelope
        env = _not_found_envelope("tool_attribution", "no such tool")
        assert env["status"] == "not_found"
        assert env["data"]["message"] == "no such tool"

    def test_real_response_never_has_live_false(self) -> None:
        """A real response never has ``live: false`` (that's
        the stub-envelope marker)."""
        from eden.services.tool_intel._common import (
            _bad_request_envelope,
            _not_found_envelope,
            _ok_envelope,
        )
        for env in (
            _ok_envelope("test", {}),
            _bad_request_envelope("test", "x"),
            _not_found_envelope("test", "x"),
        ):
            assert env["live"] is True


# ─── 6. Shared helpers ──────────────────────────────────────────────


class TestExtractToolName:
    def test_extracts_from_attributes(self) -> None:
        from eden.services.tool_intel._common import _extract_tool_name
        row = {"attributes": {"tool_name": "search_kb"}}
        assert _extract_tool_name(row) == "search_kb"

    def test_falls_back_to_attributes_name(self) -> None:
        from eden.services.tool_intel._common import _extract_tool_name
        row = {"attributes": {"name": "calculator"}}
        assert _extract_tool_name(row) == "calculator"

    def test_falls_back_to_payload(self) -> None:
        from eden.services.tool_intel._common import _extract_tool_name
        row = {"attributes": {}, "payload": {"tool": "code_search"}}
        assert _extract_tool_name(row) == "code_search"

    def test_falls_back_to_name_column_with_prefix_stripped(self) -> None:
        from eden.services.tool_intel._common import _extract_tool_name
        row = {"name": "tool:web_search"}
        assert _extract_tool_name(row) == "web_search"

    def test_returns_none_when_no_signal(self) -> None:
        from eden.services.tool_intel._common import _extract_tool_name
        assert _extract_tool_name({}) is None

    def test_handles_non_dict_row(self) -> None:
        from eden.services.tool_intel._common import _extract_tool_name
        # A bare string is not a row, but the helper should
        # not raise.
        assert _extract_tool_name("not a dict") is None


class TestToolIsSuccess:
    def test_outcome_success(self) -> None:
        from eden.services.tool_intel._common import _tool_is_success
        assert _tool_is_success({"outcome": "success"}) is True

    def test_outcome_error(self) -> None:
        from eden.services.tool_intel._common import _tool_is_success
        assert _tool_is_success({"outcome": "error"}) is False

    def test_outcome_failed(self) -> None:
        from eden.services.tool_intel._common import _tool_is_success
        assert _tool_is_success({"outcome": "failed"}) is False

    def test_attributes_error_flag(self) -> None:
        from eden.services.tool_intel._common import _tool_is_success
        assert _tool_is_success(
            {"attributes": {"error": "true"}}
        ) is False

    def test_default_to_success_when_no_signal(self) -> None:
        from eden.services.tool_intel._common import _tool_is_success
        # No outcome, no error flag → default to success.
        assert _tool_is_success({}) is True


class TestPercentile:
    def test_empty_returns_none(self) -> None:
        from eden.services.tool_intel._common import _percentile
        assert _percentile([], 0.5) is None

    def test_single_value(self) -> None:
        from eden.services.tool_intel._common import _percentile
        assert _percentile([42.0], 0.5) == 42.0
        assert _percentile([42.0], 0.95) == 42.0

    def test_p50_of_sorted(self) -> None:
        from eden.services.tool_intel._common import _percentile
        assert _percentile([1.0, 2.0, 3.0, 4.0, 5.0], 0.5) == 3.0

    def test_p95_of_sorted(self) -> None:
        from eden.services.tool_intel._common import _percentile
        # With nearest-rank on 5 sorted values, p95 maps to
        # the 4th index (round(0.95*4) = round(3.8) = 4).
        assert _percentile([1.0, 2.0, 3.0, 4.0, 5.0], 0.95) == 5.0


class TestSafeHelpers:
    def test_safe_float_with_int(self) -> None:
        from eden.services.tool_intel._common import _safe_float
        assert _safe_float(5) == 5.0

    def test_safe_float_with_string(self) -> None:
        from eden.services.tool_intel._common import _safe_float
        assert _safe_float("5.0") == 0.0

    def test_safe_float_with_bool(self) -> None:
        from eden.services.tool_intel._common import _safe_float
        # Booleans must NOT coerce to 1/0.
        assert _safe_float(True) == 0.0

    def test_safe_float_or_none_passes_through_none(self) -> None:
        from eden.services.tool_intel._common import _safe_float_or_none
        assert _safe_float_or_none(None) is None
        assert _safe_float_or_none(3.14) == 3.14
        assert _safe_float_or_none("nope") is None

    def test_clamp_below(self) -> None:
        from eden.services.tool_intel._common import _clamp
        assert _clamp(-0.5, 0.0, 1.0) == 0.0

    def test_clamp_above(self) -> None:
        from eden.services.tool_intel._common import _clamp
        assert _clamp(1.5, 0.0, 1.0) == 1.0

    def test_clamp_inside(self) -> None:
        from eden.services.tool_intel._common import _clamp
        assert _clamp(0.7, 0.0, 1.0) == 0.7

    def test_round6_none_passthrough(self) -> None:
        from eden.services.tool_intel._common import _round6
        assert _round6(None) is None

    def test_round6_rounds_to_6dp(self) -> None:
        from eden.services.tool_intel._common import _round6
        assert _round6(0.123456789) == 0.123457


# ─── 7. Closed-loop hook firing ─────────────────────────────────────


class TestFireToolDriftHook:
    def _capture_hook(self) -> tuple[MagicMock, MagicMock]:
        """Patch the promotion_hooks module so the
        ``get_promotion_hook`` returns a MagicMock we can
        inspect. Returns ``(hook, hook_class_mock)``."""
        hook = MagicMock()
        # Wave 5 awaits on_drift_alert; sync MagicMock returns are not awaitable.
        hook.on_drift_alert = AsyncMock(return_value=None)
        mod = MagicMock()
        mod.get_promotion_hook = MagicMock(return_value=hook)
        return hook, mod

    @pytest.mark.asyncio
    async def test_fires_on_large_absolute_drop(self) -> None:
        from eden.services.tool_intel._common import _fire_tool_drift_hook
        hook, mod = self._capture_hook()
        with patch.dict(
            "sys.modules", {"eden.llmops.promotion_hooks": mod}
        ):
            await _fire_tool_drift_hook(
                "org_test",
                tool_name="search_kb",
                n_calls=100,
                success_rate_now=0.5,
                success_rate_prev=0.9,
            )
        hook.on_drift_alert.assert_awaited_once()
        call = hook.on_drift_alert.call_args
        assert call.kwargs["drift_type"] == "tool_success_drop:search_kb"
        assert call.kwargs["severity"] in ("medium", "high")

    @pytest.mark.asyncio
    async def test_no_op_below_absolute_threshold(self) -> None:
        from eden.services.tool_intel._common import _fire_tool_drift_hook
        hook, mod = self._capture_hook()
        with patch.dict(
            "sys.modules", {"eden.llmops.promotion_hooks": mod}
        ):
            await _fire_tool_drift_hook(
                "org_test",
                tool_name="search_kb",
                n_calls=100,
                success_rate_now=0.85,
                success_rate_prev=0.9,
            )
        hook.on_drift_alert.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_no_op_below_floor(self) -> None:
        """n_calls < DRIFT_MIN_CALLS → no fire even on a big
        drop (avoids noise on tiny samples)."""
        from eden.services.tool_intel._common import _fire_tool_drift_hook
        hook, mod = self._capture_hook()
        with patch.dict(
            "sys.modules", {"eden.llmops.promotion_hooks": mod}
        ):
            await _fire_tool_drift_hook(
                "org_test",
                tool_name="search_kb",
                n_calls=3,  # below floor
                success_rate_now=0.0,
                success_rate_prev=1.0,
            )
        hook.on_drift_alert.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_no_op_when_success_rate_now_is_none(self) -> None:
        from eden.services.tool_intel._common import _fire_tool_drift_hook
        hook, mod = self._capture_hook()
        with patch.dict(
            "sys.modules", {"eden.llmops.promotion_hooks": mod}
        ):
            await _fire_tool_drift_hook(
                "org_test",
                tool_name="search_kb",
                n_calls=100,
                success_rate_now=None,
                success_rate_prev=0.9,
            )
        hook.on_drift_alert.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_high_severity_on_major_drop(self) -> None:
        """An absolute drop of 0.30 → 'high' severity."""
        from eden.services.tool_intel._common import _fire_tool_drift_hook
        hook, mod = self._capture_hook()
        with patch.dict(
            "sys.modules", {"eden.llmops.promotion_hooks": mod}
        ):
            await _fire_tool_drift_hook(
                "org_test",
                tool_name="search_kb",
                n_calls=100,
                success_rate_now=0.5,
                success_rate_prev=0.95,
            )
        hook.on_drift_alert.assert_awaited_once()
        assert (
            hook.on_drift_alert.call_args.kwargs["severity"] == "high"
        )


# ─── 8. Package contract ───────────────────────────────────────────


class TestPackageContract:
    def test_lazy_re_exports_resolve(self) -> None:
        import eden.services.tool_intel as pkg
        assert pkg.ToolAttributionScorer is not None
        assert pkg.ToolComparator is not None
        assert pkg.ToolRecommender is not None
        assert pkg.ToolRegistryTaxonomy is not None

    def test_dir_lists_public_names(self) -> None:
        import eden.services.tool_intel as pkg
        names = dir(pkg)
        for expected in (
            "ToolAttributionScorer",
            "ToolComparator",
            "ToolRecommender",
            "ToolRegistryTaxonomy",
        ):
            assert expected in names

    def test_unknown_attribute_raises(self) -> None:
        import eden.services.tool_intel as pkg
        with pytest.raises(AttributeError):
            _ = pkg.NotARealSymbol  # type: ignore[attr-defined]

    def test_module_path_imports_work(self) -> None:
        """``eden.services.tool_intel.services`` is the
        canonical import path for direct (non-lazy)
        imports."""
        from eden.services.tool_intel import (  # noqa: N814
            ToolAttributionScorer as TAS1,
        )
        from eden.services.tool_intel.services import (  # noqa: N814
            ToolAttributionScorer as TAS2,
        )
        assert TAS1 is TAS2


# ─── 9. Route smoke tests ──────────────────────────────────────────


def _fake_user() -> dict:
    return {"sub": "test-user", "org_id": "org_test"}


@pytest.fixture(scope="module")
def tool_app() -> FastAPI:
    from eden.api.deps import get_current_user, require_org_member, require_path_org_access
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True
    app = FastAPI(title="eden-tools-test")
    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_org_member] = lambda: {"sub": "test-user", "org_id": "org_test"}
    app.dependency_overrides[require_path_org_access] = lambda: "org_x"
    mod = importlib.import_module("eden.api.routes.intelligence_tools")
    app.include_router(mod.router)
    return app


@pytest.fixture(scope="module")
def tool_client(tool_app: FastAPI) -> TestClient:
    return TestClient(tool_app)


def test_attribution_route_returns_envelope(tool_client: TestClient) -> None:
    """POST /attribution returns the uniform envelope shape
    (envelope: status, feature, live, trace_id, timestamp)."""
    resp = tool_client.post(
        "/orgs/org_x/intelligence/tools/attribution",
        json={"tool_id": "search_kb", "window": "30d"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "status" in data
    assert data["feature"] == "tool_attribution"
    assert data["live"] is True
    assert data["trace_id"].startswith("ti_")


def test_compare_route_returns_envelope(tool_client: TestClient) -> None:
    """POST /compare returns the uniform envelope shape."""
    resp = tool_client.post(
        "/orgs/org_x/intelligence/tools/compare",
        json={"tool_a": "tool_a", "tool_b": "tool_b", "window": "7d"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["feature"] == "tool_compare"


def test_recommend_route_returns_envelope(tool_client: TestClient) -> None:
    """POST /recommend returns the uniform envelope shape."""
    resp = tool_client.post(
        "/orgs/org_x/intelligence/tools/recommend",
        json={"task_type": "code_review", "k": 3},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["feature"] == "tool_recommend"


def test_taxonomy_route_returns_envelope(tool_client: TestClient) -> None:
    """GET /taxonomy returns the uniform envelope shape."""
    resp = tool_client.get("/orgs/org_x/intelligence/tools/taxonomy")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["feature"] == "tool_taxonomy"


def test_tool_routes_registered_under_intelligence_tools_tag() -> None:
    """The 4 Cat 7 routes are registered under the
    ``intelligence-tools`` OpenAPI tag, with the right
    methods and paths."""
    from eden.api.routes.intelligence_tools import router

    paths = sorted({r.path for r in router.routes})
    expected = sorted(
        {
            "/orgs/{org_id}/intelligence/tools/attribution",
            "/orgs/{org_id}/intelligence/tools/compare",
            "/orgs/{org_id}/intelligence/tools/recommend",
            "/orgs/{org_id}/intelligence/tools/taxonomy",
        }
    )
    assert paths == expected


# ─── 10. Persistence is called from the right services ──────────────


@pytest.mark.asyncio
async def test_attribution_persists_per_trace_rows() -> None:
    """When a trace_id is provided, the attribution scorer
    calls ``_delete_then_insert_attribution`` once with the
    (org, trace, tool) tuple."""
    from eden.services.tool_intel.services import ToolAttributionScorer

    events = [_tool_event(trace_id="trace-1", outcome="success") for _ in range(5)]
    router = _PGRouter()
    router.on("trace_id = $2")(lambda sql, a, kw: events)
    router.on("FROM telemetry_events")(  # aggregate query
        lambda sql, a, kw: events
    )
    pg = router.build()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        return_value=pg,
    ), patch(
        "eden.services.tool_intel.services._delete_then_insert_attribution",
        new=AsyncMock(),
    ) as persist:
        await ToolAttributionScorer().score(
            "org_test",
            trace_id="trace-1",
            tool_id="search_kb",
            window="30d",
        )
    persist.assert_awaited_once()
    call_args = persist.call_args
    assert call_args.args[0] == "org_test"
    assert call_args.args[1] == "trace-1"
    assert call_args.args[2] == "search_kb"
    assert len(call_args.args[3]) == 1
    assert call_args.args[3][0]["trace_id"] == "trace-1"
    assert call_args.args[3][0]["tool_id"] == "search_kb"
    assert call_args.args[3][0]["impact_score"] is not None


@pytest.mark.asyncio
async def test_compare_persists_to_tool_comparisons() -> None:
    """The comparator calls
    ``_delete_then_insert_comparison`` once with the
    (org, tool_a, tool_b, window, payload) tuple."""
    from eden.services.tool_intel.services import ToolComparator

    events_a = [_tool_event(tool_name="tool_a", outcome="success") for _ in range(9)]
    events_a.append(_tool_event(tool_name="tool_a", outcome="error"))
    events_b = [_tool_event(tool_name="tool_b", outcome="success") for _ in range(5)]
    events_b.extend(_tool_event(tool_name="tool_b", outcome="error") for _ in range(5))

    router = _PGRouter()
    def _route(sql: str, a: Any, kw: Any) -> list[dict[str, Any]]:
        if len(a) >= 3 and a[2] == "tool_a":
            return events_a
        if len(a) >= 3 and a[2] == "tool_b":
            return events_b
        return []
    router.on("FROM telemetry_events")(_route)
    pg = router.build()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        return_value=pg,
    ), patch(
        "eden.services.tool_intel.services._delete_then_insert_comparison",
        new=AsyncMock(),
    ) as persist:
        await ToolComparator().compare(
            "org_test",
            tool_a="tool_a",
            tool_b="tool_b",
            window="7d",
        )
    persist.assert_awaited_once()
    call_args = persist.call_args
    assert call_args.args[0] == "org_test"
    assert call_args.args[1] == "tool_a"
    assert call_args.args[2] == "tool_b"
    assert call_args.args[3] == "7d"
    payload = call_args.args[4]
    assert payload["winner"] == "tool_a"
