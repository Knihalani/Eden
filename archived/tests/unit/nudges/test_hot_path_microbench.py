"""F39 hot-path microbench — p95 < 5ms."""

from eden.nudges.engine import microbench_evaluate_sync


def test_evaluate_sync_p95_under_5ms():
    stats = microbench_evaluate_sync(iterations=3000)
    assert stats["p95_ms"] < 5.0, stats
