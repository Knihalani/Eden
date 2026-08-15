"""F01 — prefix replay p95 budget tests."""

from __future__ import annotations

from eden.debugger.cache import microbench_prefix_replay


def test_prefix_replay_p95_under_2s_budget() -> None:
    stats = microbench_prefix_replay(prefix_steps=20, iterations=100)
    assert stats["p95_ms"] < 2000.0, f"p95 {stats['p95_ms']}ms exceeds 2s budget"
    assert stats["prefix_steps"] == 20.0
