"""Unit tests for the §9.5.1 alerts engine."""

from eden.observability.alerts import (
    DEFAULT_RULES,
    AlertRule,
    _percentile_from_histogram,
)


def test_default_rules_include_all_four_criteria():
    """The §9.5.1 SLOs are represented in DEFAULT_RULES.

    Phase 2: the env-gen pipeline is retired, so the
    ``pipeline_timeout_rate`` rule (which read eden.pipeline.metrics)
    is removed. Per-agent failure-mode alerting replaces it — see
    eden.insights.detector_loop which uses JudgeScores.
    """
    rule_ids = {r.rule_id for r in DEFAULT_RULES}
    assert "api_p95_latency" in rule_ids
    assert "llm_provider_error_rate" in rule_ids
    assert "kb_retrieval_p95" in rule_ids
    assert "pipeline_timeout_rate" not in rule_ids


def test_alert_rule_fires_above_threshold():
    r = AlertRule(
        rule_id="test", severity="warning",
        title="test", description="test",
        threshold=100.0,
    )
    a = r.evaluate(150.0)
    assert a is not None
    assert a.value == 150.0
    assert a.threshold == 100.0
    assert a.severity == "warning"


def test_alert_rule_does_not_fire_at_or_below_threshold():
    r = AlertRule(
        rule_id="test", severity="warning",
        title="test", description="test",
        threshold=100.0,
    )
    assert r.evaluate(100.0) is None
    assert r.evaluate(50.0) is None


def test_alert_payload_has_required_fields():
    r = AlertRule(
        rule_id="api_p95_latency", severity="warning",
        title="API p95 latency > 500ms",
        description="API p95 latency is over the 500ms SLO.",
        threshold=500.0,
    )
    a = r.evaluate(750.0)
    d = a.to_dict()
    assert d["rule_id"] == "api_p95_latency"
    assert d["severity"] == "warning"
    assert d["title"] == "API p95 latency > 500ms"
    assert d["value"] == 750.0
    assert d["threshold"] == 500.0
    assert "fired_at" in d


def test_percentile_from_histogram():
    """Approximate p95 recovery from a Prometheus-style cumulative
    histogram."""
    rows = [{
        "count": 100,
        "buckets": {"5": 0, "10": 0, "25": 5, "50": 30, "100": 80, "200": 95, "500": 100, "+Inf": 100},
    }]
    p95 = _percentile_from_histogram(rows, 95.0)
    # p95 is the smallest bucket where count >= 95
    assert p95 == 200.0


def test_percentile_from_histogram_empty():
    assert _percentile_from_histogram([], 95.0) is None
    assert _percentile_from_histogram([{"count": 0, "buckets": {}}], 95.0) is None
