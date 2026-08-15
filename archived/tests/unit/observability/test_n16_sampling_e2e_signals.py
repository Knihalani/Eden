"""N16 sampling — end-to-end signal wiring with real ``TelemetryEvent`` shapes.

These pin the specific bugs an audit found in the ingest-time gate
(``eden.observability.sampling.apply.keep_signals_for_event`` /
``should_route_event``):

1. ``is_high_cost`` was never computed from the event's real, enriched
   ``metrics.cost_usd`` — only from a caller-set ``eden.high_cost``
   attribute nobody actually sets. A genuinely expensive trace with no
   such attribute sampled away exactly like a cheap one.
2. ``sampling_slow_threshold_ms`` existed as a ``Settings`` field but
   ``get_sampling_policy()`` never read it, so
   ``EDEN_SAMPLING_SLOW_THRESHOLD_MS`` was a silent no-op.
3. The Python SDK's ``force_trace`` attribute never reached the server
   as ``eden.force_trace`` (fixed separately in ``sdk/python/eden_sdk/trace.py``)
   — this file pins the *server* half of that contract: once the
   attribute IS ``eden.force_trace`` on the wire, ``keep_signals_for_event``
   must read it and the policy must force-keep on it.

All tests build real ``TelemetryEvent`` instances (not ``SimpleNamespace``
duck-types) so a change to the dataclass's field names/types would be
caught here too.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from eden.observability.sampling.apply import (
    _high_cost_threshold_usd,
    decide_for_event,
    keep_signals_for_event,
    should_route_event,
)
from eden.observability.sampling.policy import (
    IntelligenceAwareSamplingPolicy,
    get_sampling_policy,
    reset_sampling_policy,
)
from eden.observability.sampling.summaries import get_sampling_summary_store
from eden.observability.telemetry_collector import TelemetryEvent


def _event(**overrides) -> TelemetryEvent:
    defaults = {
        "event_id": "evt-1",
        "tenant_id": "org-1",
        "project_id": "proj-1",
        "trace_id": "trace-1",
        "realm": "production",
        "event_type": "llm.completion",
        "timestamp": "2026-07-20T00:00:00Z",
    }
    defaults.update(overrides)
    return TelemetryEvent(**defaults)


class _FakeSettings:
    """Minimal settings stand-in — only the attrs this module reads."""

    def __init__(
        self,
        *,
        sampling_profile: str = "full",
        sampling_enabled: bool = True,
        probabilistic_sample_rate: float = 1.0,
        sampling_slow_threshold_ms: float = 5_000.0,
        sampling_high_cost_usd: float = 0.50,
    ) -> None:
        self.sampling_profile = sampling_profile
        self.sampling_enabled = sampling_enabled
        self.probabilistic_sample_rate = probabilistic_sample_rate
        self.sampling_slow_threshold_ms = sampling_slow_threshold_ms
        self.sampling_high_cost_usd = sampling_high_cost_usd


@pytest.fixture(autouse=True)
def _reset_policy_and_store():
    reset_sampling_policy()
    store = get_sampling_summary_store()
    store.clear()
    yield
    store.clear()
    reset_sampling_policy()


# ── Bug 1: is_high_cost wired from real metrics.cost_usd ───────────────


def test_high_cost_computed_from_real_cost_usd_no_attribute_needed() -> None:
    """A trace whose enriched ``metrics.cost_usd`` clears the threshold
    must be flagged high-cost even with no ``eden.high_cost`` attribute
    set by anything. Before the fix this was always ``False`` unless a
    caller manually stamped the attribute."""
    event = _event(metrics={"cost_usd": 0.75}, attributes={})
    with patch(
        "eden.config.get_settings",
        return_value=_FakeSettings(sampling_high_cost_usd=0.50),
    ):
        signals = keep_signals_for_event(event)
    assert signals.is_high_cost is True


def test_high_cost_respects_configured_threshold() -> None:
    """Same cost, higher threshold → not flagged. Proves the threshold
    is actually read, not hardcoded."""
    event = _event(metrics={"cost_usd": 0.75}, attributes={})
    with patch(
        "eden.config.get_settings",
        return_value=_FakeSettings(sampling_high_cost_usd=5.00),
    ):
        signals = keep_signals_for_event(event)
    assert signals.is_high_cost is False


def test_high_cost_attribute_override_still_works() -> None:
    """The pre-existing ``eden.high_cost`` attribute keeps working as an
    explicit override even when cost is below threshold (OR semantics)."""
    event = _event(metrics={"cost_usd": 0.0}, attributes={"eden.high_cost": "true"})
    with patch(
        "eden.config.get_settings",
        return_value=_FakeSettings(sampling_high_cost_usd=0.50),
    ):
        signals = keep_signals_for_event(event)
    assert signals.is_high_cost is True


def test_cheap_trace_is_not_high_cost() -> None:
    event = _event(metrics={"cost_usd": 0.01}, attributes={})
    with patch(
        "eden.config.get_settings",
        return_value=_FakeSettings(sampling_high_cost_usd=0.50),
    ):
        signals = keep_signals_for_event(event)
    assert signals.is_high_cost is False


def test_high_cost_keeps_the_trace_end_to_end_under_balanced_profile() -> None:
    """A high-cost event must be kept even when the profile's
    probabilistic rate would otherwise drop it (rng seeded to always
    fail the probabilistic roll)."""
    event = _event(
        metrics={"cost_usd": 2.00},
        attributes={},
        outcome="success",
        duration_ms=10,
    )
    with patch(
        "eden.config.get_settings",
        return_value=_FakeSettings(
            sampling_profile="balanced", sampling_high_cost_usd=0.50
        ),
    ):
        reset_sampling_policy()
        import eden.observability.sampling.policy as policy_mod

        # Force every probabilistic roll to fail so only a deterministic
        # keep rule can save this trace.
        policy_mod._policy = IntelligenceAwareSamplingPolicy(
            profile="balanced", keep_rate_override=0.0, rng_seed=0,
        )
        try:
            decision = decide_for_event(event)
        finally:
            reset_sampling_policy()
    assert decision.keep is True
    assert decision.rule_matched == "high_cost"


def test_high_cost_threshold_helper_falls_back_on_settings_error() -> None:
    """Fail-open: a broken settings lookup must not crash sampling."""
    with patch("eden.config.get_settings", side_effect=RuntimeError("boom")):
        assert _high_cost_threshold_usd() == 0.50


# ── Bug 2: sampling_slow_threshold_ms actually reaches the policy ──────


def test_custom_slow_threshold_is_read_from_settings() -> None:
    with patch(
        "eden.config.get_settings",
        return_value=_FakeSettings(sampling_slow_threshold_ms=200.0),
    ):
        reset_sampling_policy()
        policy = get_sampling_policy()
    assert policy.slow_threshold_ms == 200.0


def test_custom_slow_threshold_forces_keep_below_default_5s() -> None:
    """A 300ms trace is nowhere near the hardcoded 5s default but IS
    slow under a 200ms configured threshold — and must be force-kept
    even though the probabilistic roll is forced to fail."""
    event = _event(duration_ms=300.0, outcome="success", attributes={})
    with patch(
        "eden.config.get_settings",
        return_value=_FakeSettings(
            sampling_profile="balanced", sampling_slow_threshold_ms=200.0
        ),
    ):
        reset_sampling_policy()
        policy = get_sampling_policy()
        # Same threshold, but keep_rate forced to 0 so only the slow
        # rule (not a lucky probabilistic roll) can explain a keep.
        policy.keep_rate_override = 0.0
        decision = policy.decide(keep_signals_for_event(event))
    assert decision.keep is True
    assert decision.rule_matched == "slow"


def test_default_slow_threshold_when_setting_absent() -> None:
    """No custom setting → falls back to the 5s default, not zero/None."""
    with patch(
        "eden.config.get_settings",
        return_value=_FakeSettings(),
    ):
        reset_sampling_policy()
        policy = get_sampling_policy()
    assert policy.slow_threshold_ms == 5_000.0


# ── Bug 3 (server half): eden.force_trace on a real TelemetryEvent ────


def test_force_trace_attribute_read_from_real_event() -> None:
    """Mirrors what the fixed SDK now puts on the wire: a string
    ``"True"`` value for ``eden.force_trace`` (the SDK stringifies all
    span attributes)."""
    event = _event(attributes={"eden.force_trace": "True"})
    signals = keep_signals_for_event(event)
    assert signals.force_trace is True


def test_force_trace_keeps_the_trace_under_aggressive_profile() -> None:
    event = _event(
        attributes={"eden.force_trace": "True"},
        outcome="success",
        duration_ms=1,
        metrics={"cost_usd": 0.0},
    )
    with patch(
        "eden.config.get_settings",
        return_value=_FakeSettings(sampling_profile="aggressive"),
    ):
        reset_sampling_policy()
        import eden.observability.sampling.policy as policy_mod

        policy_mod._policy = IntelligenceAwareSamplingPolicy(
            profile="aggressive", keep_rate_override=0.0, rng_seed=0,
        )
        try:
            decision = decide_for_event(event)
        finally:
            reset_sampling_policy()
    assert decision.keep is True
    assert decision.rule_matched == "force_trace"


# ── Full should_route_event() round trip on real events ────────────────


@pytest.mark.asyncio
async def test_should_route_event_keeps_force_traced_drops_plain() -> None:
    """A force-traced event and a plain event, side by side, under a
    policy forced to drop every non-signal trace."""
    reset_sampling_policy()
    import eden.observability.sampling.policy as policy_mod

    policy_mod._policy = IntelligenceAwareSamplingPolicy(
        profile="balanced", keep_rate_override=0.0, rng_seed=0,
    )
    try:
        forced = _event(
            event_id="evt-forced",
            trace_id="trace-forced",
            attributes={"eden.force_trace": "True"},
            outcome="success",
            duration_ms=1,
        )
        plain = _event(
            event_id="evt-plain",
            trace_id="trace-plain",
            attributes={},
            outcome="success",
            duration_ms=1,
        )
        assert await should_route_event(forced) is True
        assert await should_route_event(plain) is False
    finally:
        reset_sampling_policy()

    store = get_sampling_summary_store()
    dropped_ids = {row.trace_id for row in store.buffered()}
    assert "trace-plain" in dropped_ids
    assert "trace-forced" not in dropped_ids


@pytest.mark.asyncio
async def test_should_route_event_keeps_high_cost_event() -> None:
    reset_sampling_policy()
    import eden.observability.sampling.policy as policy_mod

    policy_mod._policy = IntelligenceAwareSamplingPolicy(
        profile="balanced", keep_rate_override=0.0, rng_seed=0,
    )
    try:
        with patch(
            "eden.config.get_settings",
            return_value=_FakeSettings(sampling_high_cost_usd=0.50),
        ):
            expensive = _event(
                event_id="evt-expensive",
                trace_id="trace-expensive",
                metrics={"cost_usd": 3.00},
                attributes={},
                outcome="success",
                duration_ms=1,
            )
            assert await should_route_event(expensive) is True
    finally:
        reset_sampling_policy()
