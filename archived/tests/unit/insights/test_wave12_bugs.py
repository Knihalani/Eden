"""Wave 12 regressions: BUG-26/31/34/35 helpers and detectors."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock

import pytest

from eden.insights.detectors import (
    Insight,
    PerformanceAnomalyDetector,
    RegressionDetector,
)
from eden.insights.rca._common import (
    _agent_id_from_event,
    _error_type_from_event,
    _first_failed_event,
    _has_tool_error,
    _trace_is_failure,
    event_is_failure,
)
from eden.insights.unified_trace_model import Outcome, Realm, UnifiedTrace
from eden.mcp_server.auth import McpAuthContext
from eden.mcp_server.client import HttpEdenClient

# ── BUG-31: event_is_failure vocabulary ─────────────────────────────


@pytest.mark.parametrize(
    ("ev", "expected"),
    [
        ({"outcome": "success", "error": None}, False),
        ({"outcome": "failure", "error": None}, True),
        ({"outcome": "timeout", "error": None}, True),
        ({"outcome": "crash", "error": None}, True),
        ({"outcome": "partial", "error": None}, True),
        # Legacy literal still matches via != success, but real path is failure.
        ({"outcome": "error", "error": None}, True),
        ({"outcome": "success", "error": {"type": "Boom"}}, True),
        # BUG-32: real DB column error_type also marks failure.
        ({"outcome": "success", "error_type": "Timeout"}, True),
        ({"outcome": "success", "error_type": None, "error": None}, False),
        ({"outcome": None, "error": None}, False),
        ({}, False),
    ],
)
def test_event_is_failure_canonical_vocabulary(
    ev: dict[str, Any], expected: bool
) -> None:
    assert event_is_failure(ev) is expected


def test_tool_error_rule_catches_timeout_outcome() -> None:
    """BUG-31: timeout tool calls must not fall through as 'trace succeeded'."""
    events = [
        {
            "event_type": "tool.search",
            "outcome": "timeout",
            "error": None,
            "name": "search",
        }
    ]
    matched, signals = _has_tool_error(events)
    assert matched is True
    assert signals
    assert _trace_is_failure(events) is True
    assert _first_failed_event(events) is events[0]
    assert _error_type_from_event(events[0]) == "timeout"


def test_error_type_column_preferred_over_error_dict() -> None:
    """BUG-32: prefer DB error_type string; keep legacy error dict fallback."""
    assert (
        _error_type_from_event(
            {"error_type": "RateLimit", "error": {"type": "Ignored"}, "outcome": "failure"}
        )
        == "RateLimit"
    )
    assert _error_type_from_event({"error": {"type": "Boom"}}) == "Boom"
    events = [
        {
            "event_type": "tool.search",
            "outcome": "failure",
            "error_type": "RateLimit",
            "error": None,
        }
    ]
    matched, signals = _has_tool_error(events)
    assert matched is True
    assert "RateLimit" in signals[0]


# ── BUG-34: agent_id clustering key ─────────────────────────────────


def test_agent_id_from_event_uses_trace_namespaced_sentinel() -> None:
    """Missing agent_id keys on __unattributed__:{trace_id}, not literal unknown."""
    assert (
        _agent_id_from_event({}, trace_id="trc_a")
        == "__unattributed__:trc_a"
    )
    assert (
        _agent_id_from_event({"trace_id": "trc_b"})
        == "__unattributed__:trc_b"
    )
    # Explicit arg wins over event field.
    assert (
        _agent_id_from_event({"trace_id": "trc_b"}, trace_id="trc_a")
        == "__unattributed__:trc_a"
    )
    # Distinct traces must not share a bucket.
    a = _agent_id_from_event({}, trace_id="trc_1")
    b = _agent_id_from_event({}, trace_id="trc_2")
    assert a != b
    assert _agent_id_from_event({}) == "unknown"
    assert _agent_id_from_event({"agent_id": "agent-x"}) == "agent-x"


# ── BUG-35: mixed_population flag ───────────────────────────────────


def _trace(
    *,
    tid: str,
    latency: float,
    version: str | None,
    env_version: str | None = "env-1",
    outcome: Outcome = Outcome.SUCCESS,
) -> UnifiedTrace:
    return UnifiedTrace(
        trace_id=tid,
        tenant_id="org_1",
        realm=Realm.PRODUCTION,
        agent_id="agent-1",
        agent_version=version or "",
        environment_version=env_version,
        outcome=outcome,
        duration_ms=latency,
        started_at=datetime.now(UTC),
        metrics={
            "cost_usd": 0.01,
            "total_tokens": 100,
            "mean_latency_ms": latency,
            "mean_cost_usd": 0.01,
        },
    )


def test_performance_anomaly_flags_unknown_version_pool() -> None:
    # Five baseline traces + one spike, all unversioned → mixed pool.
    traces = [
        _trace(tid=f"t{i}", latency=100.0, version=None) for i in range(5)
    ]
    traces.append(_trace(tid="t_spike", latency=500.0, version=None))
    det = PerformanceAnomalyDetector(z_threshold=2.0, min_confidence=0.0)
    insights = det.analyze(traces)
    assert insights
    for ins in insights:
        assert ins.mixed_population is True
        assert ins.confidence <= 0.55
        assert ins.pattern.get("mixed_population") is True
        assert ins.metadata.get("warning") == "mixed_unversioned_baseline"
        assert "mixed_population" in ins.to_dict()


def test_regression_detector_flags_unknown_in_baseline() -> None:
    # Latest versioned; baseline includes unversioned pool.
    latest = [
        _trace(tid=f"l{i}", latency=200.0, version="v2", outcome=Outcome.FAILURE)
        for i in range(5)
    ]
    baseline = [
        _trace(tid=f"b{i}", latency=50.0, version=None, outcome=Outcome.SUCCESS)
        for i in range(5)
    ]
    det = RegressionDetector(
        degradation_threshold=0.05, min_samples=5, min_confidence=0.0
    )
    insights = det.analyze(latest + baseline)
    # May or may not fire on every metric; when it does, flag must be set.
    mixed = [i for i in insights if i.mixed_population]
    assert mixed, f"expected mixed_population insights, got {insights!r}"
    for ins in mixed:
        assert ins.confidence <= 0.55
        assert ins.pattern.get("mixed_population") is True


def test_insight_to_dict_includes_mixed_population_default() -> None:
    ins = Insight(
        insight_id="ins_x",
        detector="test",
        severity="low",
        confidence=0.9,
        summary="ok",
    )
    d = ins.to_dict()
    assert d["mixed_population"] is False


# ── BUG-26: get_judge_scores path ───────────────────────────────────


@pytest.mark.asyncio
async def test_get_judge_scores_hits_judges_endpoint() -> None:
    auth = McpAuthContext(
        api_key="k",
        base_url="http://example.test",
        scopes=("mcp:read",),
    )
    client = HttpEdenClient(auth)
    captured: dict[str, Any] = {}

    async def _fake_request(
        method: str, path: str, *, params: dict | None = None, **_: Any
    ) -> dict[str, Any]:
        captured["method"] = method
        captured["path"] = path
        captured["params"] = params
        return {"scores": [], "total": 0}

    client._request = AsyncMock(side_effect=_fake_request)  # type: ignore[method-assign]
    await client.get_judge_scores("org_1", trace_id="trc_1", judge_name="faithfulness")
    assert captured["method"] == "GET"
    assert captured["path"] == "/orgs/org_1/observability/judges"
    assert captured["params"] == {
        "trace_id": "trc_1",
        "judge_name": "faithfulness",
    }
    assert "/scores" not in captured["path"]
    await client.aclose()
