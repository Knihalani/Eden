"""Shared helpers for the ``bench/`` suite.

The benches don't talk to a real Eden backend. They synthesize fake
workloads (mock LLM responses, mock KB lookups)
so the harness runs in CI without any external dependencies. To
benchmark a real deployment, set the env vars documented in each
module.
"""

from __future__ import annotations

import asyncio
import statistics
import time
from dataclasses import dataclass
from typing import Awaitable, Callable, Iterable, Sequence


@dataclass
class BenchResult:
    """Result of a single benchmark. ``p50``/``p95``/``p99`` are
    latencies in milliseconds."""

    name: str
    n: int
    p50_ms: float
    p95_ms: float
    p99_ms: float
    mean_ms: float
    max_ms: float
    extras: dict

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "n": self.n,
            "p50_ms": round(self.p50_ms, 3),
            "p95_ms": round(self.p95_ms, 3),
            "p99_ms": round(self.p99_ms, 3),
            "mean_ms": round(self.mean_ms, 3),
            "max_ms": round(self.max_ms, 3),
            "extras": self.extras,
        }


def _percentile(values: Sequence[float], pct: float) -> float:
    if not values:
        return 0.0
    return statistics.quantiles(values, n=100, method="inclusive")[int(pct) - 1] if len(values) > 1 else values[0]


async def bench_async(
    name: str,
    fn: Callable[[], Awaitable[None]],
    n: int = 100,
    concurrency: int = 1,
) -> BenchResult:
    """Run ``fn()`` ``n`` times at the given concurrency, return stats.

    All times are wall-clock; we measure end-to-end including the
    coroutine scheduler. This is what the user actually sees.
    """
    sem = asyncio.Semaphore(concurrency) if concurrency > 1 else None
    latencies_ms: list[float] = []

    async def one():
        if sem is not None:
            await sem.acquire()
        try:
            t0 = time.perf_counter()
            await fn()
            latencies_ms.append((time.perf_counter() - t0) * 1000)
        finally:
            if sem is not None:
                sem.release()

    await asyncio.gather(*[one() for _ in range(n)])

    sorted_lat = sorted(latencies_ms)
    return BenchResult(
        name=name,
        n=n,
        p50_ms=_percentile(sorted_lat, 50),
        p95_ms=_percentile(sorted_lat, 95),
        p99_ms=_percentile(sorted_lat, 99),
        mean_ms=statistics.fmean(sorted_lat) if sorted_lat else 0.0,
        max_ms=max(sorted_lat) if sorted_lat else 0.0,
        extras={"concurrency": concurrency},
    )
