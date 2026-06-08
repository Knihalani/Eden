"""§11.5 — pipeline-timeout counter tests."""

import pytest

from eden.pipeline.metrics import (
    PipelineMetrics,
    get_pipeline_metrics,
    get_pipeline_metrics_snapshot,
    reset_pipeline_metrics,
)


def test_pipeline_metrics_records_timeouts():
    m = PipelineMetrics()
    m.record_timeout("planner")
    m.record_timeout("planner")
    m.record_timeout("executor")
    snap = m.snapshot()
    assert snap["timeouts"]["planner"] == 2
    assert snap["timeouts"]["executor"] == 1


def test_pipeline_metrics_computes_timeout_rate():
    m = PipelineMetrics()
    # 4 timeouts out of 20 calls = 20% rate
    for _ in range(4):
        m.record_timeout("planner")
    for _ in range(16):
        m.record_completion("planner")
    snap = m.snapshot()
    assert snap["timeout_rates"]["planner"] == pytest.approx(0.2)


def test_pipeline_metrics_zero_rate_with_no_data():
    m = PipelineMetrics()
    assert m.snapshot()["timeout_rates"] == {}


def test_pipeline_metrics_snapshot_is_json_serializable():
    import json
    m = PipelineMetrics()
    m.record_timeout("planner")
    m.record_error("critic")
    m.record_retry("executor")
    m.record_completion("executor")
    json.dumps(m.snapshot())


def test_global_metrics_singleton():
    """Multiple calls return the same instance — needed for the
    code_quality.py import path to actually record."""
    a = get_pipeline_metrics()
    b = get_pipeline_metrics()
    assert a is b


def test_reset_clears_counters():
    m = PipelineMetrics()
    m.record_timeout("planner")
    reset_pipeline_metrics()
    snap = get_pipeline_metrics_snapshot()
    assert snap["timeouts"] == {}
