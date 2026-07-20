"""N16 — intelligence-aware tail sampling policy tests."""

from __future__ import annotations

import random

import pytest

from eden.observability.sampling.policy import (
    IntelligenceAwareSamplingPolicy,
    KeepSignals,
    PROFILE_KEEP_RATES,
    get_sampling_policy,
    profile_keep_rate,
    reset_sampling_policy,
)
from eden.observability.sampling.summaries import (
    TraceSamplingSummary,
    get_sampling_summary_store,
)
from supplementaries.cat_22_apm import tail_sampling


def test_profile_keep_rates() -> None:
    assert profile_keep_rate("full") == 1.0
    assert profile_keep_rate("balanced") == 0.15
    assert profile_keep_rate("aggressive") == 0.05
    # Unknown → full (soft-launch safe; never silently drop)
    assert profile_keep_rate("unknown") == PROFILE_KEEP_RATES["full"]


def test_loop_never_dropped_when_keep_rate_one() -> None:
    policy = IntelligenceAwareSamplingPolicy(
        profile="aggressive",
        rng_seed=0,
    )
    d = policy.decide(KeepSignals(is_loop=True))
    assert d.keep
    assert d.rule_matched == "loop"


def test_tool_error_always_kept() -> None:
    policy = IntelligenceAwareSamplingPolicy(profile="aggressive", rng_seed=0)
    d = policy.decide(KeepSignals(has_tool_error=True))
    assert d.keep
    assert d.rule_matched == "tool_error"


def test_error_and_stumble_kept_on_aggressive() -> None:
    policy = IntelligenceAwareSamplingPolicy(profile="aggressive", rng_seed=0)
    assert policy.decide(KeepSignals(has_error=True)).keep
    assert policy.decide(KeepSignals(has_stumble=True)).rule_matched == "stumble"


def test_aggressive_drops_most_normal_traces() -> None:
    policy = IntelligenceAwareSamplingPolicy(profile="aggressive", rng_seed=1)
    kept = sum(
        1
        for _ in range(200)
        if policy.decide(KeepSignals()).keep
    )
    # ~5% keep → expect well under 40/200 with seed 1
    assert kept < 40
    assert kept > 0


def test_full_profile_keeps_everything() -> None:
    policy = IntelligenceAwareSamplingPolicy(profile="full", rng_seed=0)
    for _ in range(50):
        assert policy.decide(KeepSignals()).keep


def test_disabled_keeps_everything() -> None:
    policy = IntelligenceAwareSamplingPolicy(
        profile="aggressive", enabled=False, rng_seed=0,
    )
    assert policy.decide(KeepSignals()).keep


def test_metrics_only_flag_on_drop() -> None:
    policy = IntelligenceAwareSamplingPolicy(profile="aggressive", rng_seed=0)
    # Force drop via keep_rate_override=0
    policy = IntelligenceAwareSamplingPolicy(
        profile="balanced", keep_rate_override=0.0, rng_seed=0,
    )
    d = policy.decide(KeepSignals())
    assert not d.keep
    assert d.metrics_only


def test_sampling_summary_store_buffers() -> None:
    store = get_sampling_summary_store()
    store.clear()
    store.record(
        TraceSamplingSummary(
            org_id="org",
            trace_id="t1",
            agent_id="a1",
            duration_ms=12,
            cost_usd=0.01,
            span_count=3,
        )
    )
    assert len(store.buffered()) == 1
    store.clear()


def test_install_cat22_sets_default_keep_rates() -> None:
    from eden.observability.trace_quality import wiring

    reset_sampling_policy()
    wiring.install_cat22_sampling_policy()
    assert tail_sampling.DEFAULT_KEEP_RATES["loop"] == 1.0
    assert tail_sampling.DEFAULT_KEEP_RATES["error"] == 1.0
    assert "probabilistic" in tail_sampling.DEFAULT_KEEP_RATES
    # Cat 22 policy still keeps loops
    d = tail_sampling.SamplingPolicy(keep_rate=0.0).should_keep(
        is_loop=True, rng=random.Random(0),
    )
    assert d.keep
    assert d.rule_matched == "loop"


def test_get_sampling_policy_singleton() -> None:
    reset_sampling_policy()
    a = get_sampling_policy()
    b = get_sampling_policy()
    assert a is b
    reset_sampling_policy()


def test_otel_keep_attributes() -> None:
    policy = IntelligenceAwareSamplingPolicy(profile="balanced", rng_seed=0)
    attrs = policy.otel_keep_attributes(KeepSignals(is_loop=True, force_trace=True))
    assert attrs["eden.keep"] == "true"
    assert attrs["eden.loop_verdict"] == "true"
    assert attrs["eden.force_trace"] == "true"


# ── Ingest apply gate (Wave 3 / PERF+COST safe win) ─────────────────────────


def test_keep_signals_maps_outcome_and_attrs() -> None:
    from types import SimpleNamespace

    from eden.observability.sampling.apply import keep_signals_for_event

    ev = SimpleNamespace(
        outcome="failure",
        duration_ms=120.0,
        attributes={"eden.loop_verdict": "true", "eden.force_trace": "1"},
    )
    sig = keep_signals_for_event(ev)
    assert sig.has_error
    assert sig.is_loop
    assert sig.force_trace
    assert sig.duration_ms == 120.0


def test_decide_for_event_full_keeps() -> None:
    from types import SimpleNamespace

    from eden.observability.sampling.apply import decide_for_event
    from eden.observability.sampling.policy import (
        IntelligenceAwareSamplingPolicy,
        reset_sampling_policy,
    )
    import eden.observability.sampling.policy as policy_mod

    reset_sampling_policy()
    policy_mod._policy = IntelligenceAwareSamplingPolicy(profile="full", rng_seed=0)
    try:
        d = decide_for_event(SimpleNamespace(outcome="success", attributes={}, duration_ms=1))
        assert d.keep
    finally:
        reset_sampling_policy()


@pytest.mark.asyncio
async def test_should_route_event_drops_and_summarizes() -> None:
    from types import SimpleNamespace

    from eden.observability.sampling.apply import should_route_event
    from eden.observability.sampling.policy import (
        IntelligenceAwareSamplingPolicy,
        reset_sampling_policy,
    )
    from eden.observability.sampling.summaries import get_sampling_summary_store
    import eden.observability.sampling.policy as policy_mod

    reset_sampling_policy()
    store = get_sampling_summary_store()
    store.clear()
    # Force drop of non-signal traces.
    policy_mod._policy = IntelligenceAwareSamplingPolicy(
        profile="balanced", keep_rate_override=0.0, rng_seed=0,
    )
    try:
        ev = SimpleNamespace(
            tenant_id="org-1",
            trace_id="tr-1",
            agent_id="agent-a",
            outcome="success",
            duration_ms=10,
            metrics={"cost_usd": 0.02},
            attributes={},
        )
        assert await should_route_event(ev) is False
        buffered = store.buffered()
        assert len(buffered) == 1
        assert buffered[0].trace_id == "tr-1"
        assert buffered[0].cost_usd == 0.02
    finally:
        store.clear()
        reset_sampling_policy()


def test_collector_ingest_calls_should_route() -> None:
    """Source contract: TelemetryCollector wires N16 apply before _route."""
    from pathlib import Path

    src = Path("src/eden/observability/telemetry_collector.py").read_text()
    assert "should_route_event" in src
    assert "sampling.apply" in src
