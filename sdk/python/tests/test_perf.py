"""Performance / overhead benchmarks for the Eden SDK.

The contract: SDK overhead (enqueue + decor wrapping) must add no more
than 5 ms p99 latency vs the uninstrumented baseline.

We measure the hot path in isolation (no network), which is what user
code actually blocks on. The async sender runs in a background thread,
so the producer cost is just ``queue.put_nowait`` + JSON encoding.
"""

from __future__ import annotations

import statistics
import time

import pytest

import eden
from eden_sdk import client as client_mod
from eden_sdk.client import EdenClient, TraceEvent, get_default_client
from eden_sdk.config import EdenConfig

PERF_BUDGET_MS = 5.0
SAMPLE_COUNT = 2000


def _percentile(samples_ms: list[float], q: float) -> float:
    if not samples_ms:
        return 0.0
    return statistics.quantiles(samples_ms, n=100, method="inclusive")[int(q) - 1]


def _measure_producer_only() -> list[float]:
    """Measure the cost of building + enqueuing a single event.

    No network. We use a client that's enabled but dry_run so the
    in-memory queue is exercised exactly as in production.
    """
    cfg = EdenConfig(
        org_id="perf",
        api_key="k",
        base_url="http://test.invalid",
        dry_run=True,
    )
    client = EdenClient(cfg)
    client.start()
    try:
        sample_payload = {
            "id": "chatcmpl-perf",
            "object": "chat.completion",
            "model": "gpt-4o-mini",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": "ok"},
                }
            ],
            "usage": {
                "prompt_tokens": 8,
                "completion_tokens": 4,
                "total_tokens": 12,
            },
        }
        # Warm-up.
        for _ in range(50):
            client.enqueue(TraceEvent(payload=sample_payload, source_format="openai"))
        samples: list[float] = []
        for _ in range(SAMPLE_COUNT):
            t0 = time.perf_counter_ns()
            client.enqueue(TraceEvent(payload=sample_payload, source_format="openai"))
            samples.append((time.perf_counter_ns() - t0) / 1_000_000.0)
        return samples
    finally:
        client.shutdown()


def _measure_baseline() -> list[float]:
    """Measure a no-op cost: just construct a dict and a TraceEvent.

    This is the floor: any SDK overhead is added on top of this.
    """
    from eden_sdk.client import TraceEvent as TE

    sample_payload = {
        "id": "chatcmpl-perf",
        "object": "chat.completion",
        "model": "gpt-4o-mini",
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": "ok"},
            }
        ],
        "usage": {
            "prompt_tokens": 8,
            "completion_tokens": 4,
            "total_tokens": 12,
        },
    }
    # Warm-up
    for _ in range(50):
        TE(payload=sample_payload, source_format="openai")
    samples: list[float] = []
    for _ in range(SAMPLE_COUNT):
        t0 = time.perf_counter_ns()
        TE(payload=sample_payload, source_format="openai")
        samples.append((time.perf_counter_ns() - t0) / 1_000_000.0)
    return samples


@pytest.mark.perf
def test_enqueue_overhead_under_budget():
    """Hot-path enqueue adds < 5 ms p99 vs the uninstrumented baseline."""
    baseline = _measure_baseline()
    instrumented = _measure_producer_only()
    p99_baseline = _percentile(baseline, 99)
    p99_instrumented = _percentile(instrumented, 99)
    overhead = p99_instrumented - p99_baseline
    print(
        f"\n[perf] baseline p99={p99_baseline:.3f} ms, "
        f"instrumented p99={p99_instrumented:.3f} ms, "
        f"overhead={overhead:.3f} ms"
    )
    assert overhead < PERF_BUDGET_MS, (
        f"SDK overhead p99 {overhead:.2f} ms exceeds {PERF_BUDGET_MS} ms budget"
    )


@pytest.mark.perf
def test_trace_agent_overhead_under_budget():
    """@trace_agent adds < 5 ms p99 over an unwrapped function call."""

    def plain_add(a: int, b: int) -> int:
        return a + b

    @eden.trace_agent(name="add-traced")
    def traced_add(a: int, b: int) -> int:
        return a + b

    # Warm-up
    for _ in range(50):
        plain_add(1, 2)
        traced_add(1, 2)

    base: list[float] = []
    inst: list[float] = []
    for _ in range(SAMPLE_COUNT):
        t0 = time.perf_counter_ns()
        plain_add(1, 2)
        base.append((time.perf_counter_ns() - t0) / 1_000_000.0)
    for _ in range(SAMPLE_COUNT):
        t0 = time.perf_counter_ns()
        traced_add(1, 2)
        inst.append((time.perf_counter_ns() - t0) / 1_000_000.0)

    p99_base = _percentile(base, 99)
    p99_inst = _percentile(inst, 99)
    overhead = p99_inst - p99_base
    print(
        f"\n[perf] @trace_agent overhead p99={overhead:.3f} ms "
        f"(base={p99_base:.3f}, inst={p99_inst:.3f})"
    )
    assert overhead < PERF_BUDGET_MS, (
        f"@trace_agent overhead p99 {overhead:.2f} ms exceeds {PERF_BUDGET_MS} ms"
    )
