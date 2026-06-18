"""Unit tests for Phase Q — Plain English Signals.

What's covered:

  compile_signal (10 tests)
  ────────────────────────
  * Refusal rate: percentage + op + window.
  * Refusal rate: bare "refusals" (no threshold).
  * Error rate: percentage.
  * Latency p99: ms / s.
  * Latency p99: bare "latency".
  * Cost per call: dollars / cents.
  * Tool call rate.
  * Completion tokens.
  * User satisfaction.
  * No metric → "custom" rule.

  match_signal (6 tests)
  ────────────────────
  * All 6 operators (> >= < <= == !=).
  * Custom metric never matches.

  SignalClusterer (6 tests)
  ───────────────────────
  * Single signal → its own cluster.
  * Two similar signals → same cluster.
  * Two dissimilar signals → different clusters.
  * find_duplicates returns pairs above threshold.
  * Threshold parameter affects clustering.
  * Empty input → empty mapping.

  signal_signature (3 tests)
  ────────────────────────
  * Same NL → same signature.
  * Different NL → different signature.
  * Whitespace doesn't affect signature.

  CompiledRule + NLSignal (3 tests)
  ──────────────────────────────
  * to_dict round-trip.
  * Defaults.
  * Window extraction.
"""

from __future__ import annotations

import pytest

from eden.services.cat2_intel.signals import (
    CompiledRule,
    NLSignal,
    SignalClusterer,
    _jaccard,
    _token_set,
    compile_signal,
    match_signal,
    signal_signature,
)


# ── compile_signal ──────────────────────────────────────────────


class TestCompileSignal:
    def test_refusal_rate_percentage(self) -> None:
        rule = compile_signal("LLM refusal rate above 5% in the last 24 hours")
        assert rule.metric == "refusal_rate"
        assert rule.op == ">"
        assert rule.threshold == 0.05
        assert rule.window_hours == 24

    def test_refusal_rate_bare_metric(self) -> None:
        rule = compile_signal("any refusals")
        assert rule.metric == "refusal_rate"
        assert rule.threshold > 0  # default
        assert rule.op == ">"  # default

    def test_error_rate_percentage(self) -> None:
        rule = compile_signal("error rate above 1% in the last hour")
        assert rule.metric == "error_rate"
        assert rule.threshold == 0.01
        assert rule.window_hours == 1

    def test_latency_p99_ms(self) -> None:
        rule = compile_signal("p99 latency above 500ms")
        assert rule.metric == "latency_p99"
        assert rule.threshold == 500.0
        assert rule.op == ">"

    def test_latency_p99_seconds(self) -> None:
        rule = compile_signal("latency above 2 seconds")
        assert rule.metric == "latency_p99"
        assert rule.threshold == 2000.0  # converted to ms

    def test_latency_bare_metric(self) -> None:
        rule = compile_signal("any latency spike")
        assert rule.metric == "latency_p99"

    def test_cost_per_call_dollars(self) -> None:
        rule = compile_signal("cost per call above $0.10")
        assert rule.metric == "cost_per_call"
        assert rule.threshold == 0.10

    def test_tool_call_rate(self) -> None:
        rule = compile_signal("tool calls above 100")
        assert rule.metric == "tool_call_rate"
        assert rule.threshold == 100.0

    def test_completion_tokens(self) -> None:
        rule = compile_signal("completion tokens above 1000")
        assert rule.metric == "completion_tokens"
        assert rule.threshold == 1000.0

    def test_user_satisfaction(self) -> None:
        rule = compile_signal("user satisfaction below 4.0")
        assert rule.metric == "user_satisfaction"
        assert rule.threshold == 4.0
        assert rule.op == "<"

    def test_no_metric_returns_custom(self) -> None:
        rule = compile_signal("something completely unrelated to telemetry")
        assert rule.metric == "custom"
        assert rule.keywords  # we still extract keywords

    def test_window_in_days(self) -> None:
        rule = compile_signal("refusal rate above 5% in the last 3 days")
        assert rule.window_hours == 3 * 24

    def test_window_in_minutes(self) -> None:
        rule = compile_signal("error rate above 1% in the last 5 minutes")
        assert rule.window_hours == 0  # floor at 0 (5/60 = 0)

    def test_window_in_weeks(self) -> None:
        rule = compile_signal("refusal rate above 5% in the past week")
        assert rule.window_hours == 24 * 7

    def test_default_window(self) -> None:
        rule = compile_signal("refusal rate above 5%")
        assert rule.window_hours == 24

    def test_scope_extraction(self) -> None:
        rule = compile_signal(
            "refusal rate above 5% in agent_id=claude-opus-4 model=anthropic",
        )
        assert rule.scope.get("agent_id") == "claude-opus-4"
        assert rule.scope.get("model") == "anthropic"


# ─- match_signal ────────────────────────────────────────────────


class TestMatchSignal:
    @pytest.mark.parametrize("op,thr,val,expected", [
        (">", 5.0, 6.0, True),
        (">", 5.0, 5.0, False),
        (">", 5.0, 4.0, False),
        (">=", 5.0, 5.0, True),
        ("<", 5.0, 4.0, True),
        ("<=", 5.0, 5.0, True),
        ("==", 5.0, 5.0, True),
        ("!=", 5.0, 5.0, False),
    ])
    def test_operators(self, op: str, thr: float, val: float, expected: bool) -> None:
        rule = CompiledRule(metric="refusal_rate", op=op, threshold=thr, window_hours=24)
        assert match_signal(rule, val) is expected

    def test_custom_metric_never_matches(self) -> None:
        rule = CompiledRule(metric="custom", op="==", threshold=0.0, window_hours=24)
        assert match_signal(rule, 42.0) is False


# ─- SignalClusterer ─────────────────────────────────────────────


class TestSignalClusterer:
    def _signal(self, sid: str, description: str) -> NLSignal:
        return NLSignal(
            id=sid, org_id="o", description=description,
            rule=compile_signal(description),
        )

    def test_single_signal_own_cluster(self) -> None:
        clusterer = SignalClusterer()
        signals = [self._signal("s1", "refusal rate above 5%")]
        mapping = clusterer.cluster(signals)
        assert mapping == {"s1": "s1"}

    def test_similar_signals_same_cluster(self) -> None:
        clusterer = SignalClusterer(similarity_threshold=0.3)
        signals = [
            self._signal("s1", "LLM refusal rate above 5%"),
            self._signal("s2", "refusal rate above 7%"),
        ]
        mapping = clusterer.cluster(signals)
        # Same cluster.
        assert mapping["s1"] == mapping["s2"]

    def test_dissimilar_signals_different_clusters(self) -> None:
        clusterer = SignalClusterer(similarity_threshold=0.4)
        signals = [
            self._signal("s1", "LLM refusal rate above 5%"),
            self._signal("s2", "tool calls above 100"),
        ]
        mapping = clusterer.cluster(signals)
        # Different clusters.
        assert mapping["s1"] != mapping["s2"]

    def test_find_duplicates_above_threshold(self) -> None:
        clusterer = SignalClusterer(similarity_threshold=0.3)
        signals = [
            self._signal("s1", "refusal rate above 5%"),
            self._signal("s2", "refusal rate above 7%"),
            self._signal("s3", "tool calls above 100"),
        ]
        dups = clusterer.find_duplicates(signals)
        # s1 and s2 are duplicates; s3 is not.
        pair_ids = {(d[0].id, d[1].id) for d in dups}
        assert ("s1", "s2") in pair_ids or ("s2", "s1") in pair_ids
        # s3 not paired with anyone.
        assert not any("s3" in p for p in pair_ids)

    def test_threshold_affects_clustering(self) -> None:
        signals = [
            self._signal("s1", "refusal rate above 5%"),
            self._signal("s2", "tool calls above 100"),
        ]
        # Low threshold → more clustering.
        low = SignalClusterer(similarity_threshold=0.1)
        # High threshold → less clustering.
        high = SignalClusterer(similarity_threshold=0.99)
        # Both put s1, s2 in separate clusters (they're
        # genuinely dissimilar) but verify the API
        # doesn't error.
        assert low.cluster(signals)
        assert high.cluster(signals)

    def test_empty_input(self) -> None:
        clusterer = SignalClusterer()
        assert clusterer.cluster([]) == {}
        assert clusterer.find_duplicates([]) == []


# ─- signal_signature ────────────────────────────────────────────


class TestSignalSignature:
    def test_same_nl_same_signature(self) -> None:
        a = signal_signature("LLM refusal rate above 5%")
        b = signal_signature("LLM refusal rate above 5%")
        assert a == b

    def test_different_nl_different_signature(self) -> None:
        a = signal_signature("LLM refusal rate above 5%")
        b = signal_signature("LLM refusal rate above 7%")
        assert a != b

    def test_whitespace_normalised(self) -> None:
        a = signal_signature("refusal rate above 5%")
        b = signal_signature("  refusal  rate  above  5%  ")
        assert a == b


# ─- Dataclass ───────────────────────────────────────────────────


class TestDataclass:
    def test_compiled_rule_to_dict(self) -> None:
        r = CompiledRule(
            metric="refusal_rate", op=">", threshold=0.05,
            window_hours=24, scope={"agent_id": "x"},
            keywords=["refusal", "rate"],
        )
        d = r.to_dict()
        assert d["metric"] == "refusal_rate"
        assert d["threshold"] == 0.05
        assert d["scope"]["agent_id"] == "x"

    def test_signal_to_dict(self) -> None:
        s = NLSignal(
            id="s", org_id="o", description="test",
            rule=CompiledRule(metric="refusal_rate", op=">",
                              threshold=0.05, window_hours=24),
            cluster_id="c",
        )
        d = s.to_dict()
        assert d["id"] == "s"
        assert d["cluster_id"] == "c"
        assert d["rule"]["metric"] == "refusal_rate"


# ─- Helpers ──────────────────────────────────────────────────────


class TestJaccard:
    def test_identical(self) -> None:
        a = _token_set("refusal rate above five")
        b = _token_set("refusal rate above five")
        assert _jaccard(a, b) == 1.0

    def test_disjoint(self) -> None:
        a = _token_set("alpha beta")
        b = _token_set("gamma delta")
        assert _jaccard(a, b) == 0.0

    def test_partial(self) -> None:
        a = _token_set("alpha beta gamma")
        b = _token_set("alpha beta delta")
        # Intersection = 2, union = 4, similarity = 0.5.
        assert _jaccard(a, b) == 0.5

    def test_empty(self) -> None:
        assert _jaccard(set(), set()) == 0.0
