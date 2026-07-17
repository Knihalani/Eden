"""F03 stretch — hot-path p99 microbench + 1k-trace/hr backfill budget."""

from __future__ import annotations

from eden.debugger.cache import (
    microbench_backfill_throughput,
    microbench_llm_input_hash,
)


def test_hot_path_llm_input_hash_p99_under_1ms() -> None:
    stats = microbench_llm_input_hash(iterations=5_000)
    assert stats["p99_ms"] < 1.0, f"p99 too slow: {stats}"


def test_backfill_throughput_at_least_1k_traces_per_hour() -> None:
    stats = microbench_backfill_throughput(trace_count=200, steps_per_trace=8)
    assert stats["traces_per_hour"] >= 1_000.0, f"backfill too slow: {stats}"
