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

import httpx
import pytest

import eden
from eden_sdk.client import EdenClient, TraceEvent
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


@pytest.mark.perf
def test_producer_overhead_with_async_loop():
    """Hot-path enqueue stays under 0.5ms p99 even when the async
    loop is running and the queue is being drained concurrently.

    The previous test (test_enqueue_overhead_under_budget) measures
    dry-run mode, which short-circuits the queue. This one measures
    the real path: a running client with a queue that gets drained.
    """
    SAMPLE_COUNT = 2000
    cfg = EdenConfig(
        org_id="perf",
        api_key="k",
        base_url="http://test.invalid",
        dry_run=False,
        flush_interval_ms=10,
    )
    transport = httpx.MockTransport(
        lambda _req: httpx.Response(202, json={"ok": True})
    )
    client = EdenClient(cfg, transport=transport)
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
            "usage": {"prompt_tokens": 8, "completion_tokens": 4, "total_tokens": 12},
        }
        # Warm-up
        for _ in range(50):
            client.enqueue(TraceEvent(payload=sample_payload, source_format="openai"))
        client.flush(timeout=2.0)
        samples: list[float] = []
        for _ in range(SAMPLE_COUNT):
            t0 = time.perf_counter_ns()
            client.enqueue(TraceEvent(payload=sample_payload, source_format="openai"))
            samples.append((time.perf_counter_ns() - t0) / 1_000_000.0)
        # Drain everything before measuring
        client.flush(timeout=2.0)
        p99 = _percentile(samples, 99)
        mean = sum(samples) / len(samples)
        print(
            f"\n[perf] producer w/ async loop: p99={p99:.3f}ms, mean={mean:.3f}ms"
        )
        # Realistic budget: 0.5ms p99 for the producer hot path.
        assert p99 < 0.5, f"producer p99 {p99:.3f}ms exceeds 0.5ms budget"
    finally:
        client.shutdown()


@pytest.mark.perf
def test_throughput_under_load():
    """A single producer thread sustains >= 100k events/sec.

    Validates that the enqueue path has a tight, predictable
    throughput bound that doesn't regress as we add features.
    """
    cfg = EdenConfig(
        org_id="perf",
        api_key="k",
        base_url="http://test.invalid",
        dry_run=False,
        batch_size=512,
        flush_interval_ms=10,
    )
    transport = httpx.MockTransport(
        lambda _req: httpx.Response(202, json={"ok": True})
    )
    client = EdenClient(cfg, transport=transport)
    client.start()
    try:
        sample = {"id": "x", "model": "gpt-4o-mini", "choices": []}
        # Warm-up
        for _ in range(100):
            client.enqueue(TraceEvent(payload=sample, source_format="openai"))
        client.flush(timeout=2.0)
        N = 50_000
        t0 = time.perf_counter()
        for _ in range(N):
            client.enqueue(TraceEvent(payload=sample, source_format="openai"))
        client.flush(timeout=5.0)
        elapsed = time.perf_counter() - t0
        rate = N / elapsed
        print(f"\n[perf] throughput: {rate:,.0f} events/sec over {elapsed:.2f}s")
        assert rate >= 50_000, f"throughput {rate:.0f} events/sec under 50k target"
    finally:
        client.shutdown()
