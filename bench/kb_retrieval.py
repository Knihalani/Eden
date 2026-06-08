"""KB-retrieval latency benchmark, split by cache tier.

The optimization layer has three tiers:
  - L1: exact-match Redis cache (~1ms)
  - L2: semantic vector cache (~30ms)
  - DB: Postgres fallback (~80ms)

The bench reports p50/p95/p99 for each tier separately so the §11.2
gap (tier labels on the existing telemetry event) can be measured
end-to-end.

Target (from §11.2): KB retrieval p95 < 100ms overall; tier labels
make it possible to see the breakdown.
"""

from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass

from bench.common import BenchResult


# Tier latencies in ms. Real numbers will differ; these match the
# §6.1 cost-optimization architecture doc.
TIER_LATENCY_MS = {
    "L1": 1.0,      # Redis exact match
    "L2": 30.0,     # Qdrant semantic search
    "DB": 80.0,     # Postgres fallback
}

# Realistic hit-rate distribution. Production numbers depend on the
# workload; these are defaults for the bench.
TIER_HIT_RATE = {
    "L1": 0.45,
    "L2": 0.40,
    "DB": 0.15,
}


@dataclass
class TierResult:
    tier: str
    bench: BenchResult
    hit_rate: float

    def to_dict(self) -> dict:
        d = self.bench.to_dict()
        d["hit_rate"] = round(self.hit_rate, 3)
        return d


def _choose_tier() -> str:
    r = random.random()
    cum = 0.0
    for tier, rate in TIER_HIT_RATE.items():
        cum += rate
        if r <= cum:
            return tier
    return "DB"


async def _mock_retrieval(tier: str) -> None:
    await asyncio.sleep(TIER_LATENCY_MS[tier] / 1000.0)


async def bench_kb_retrieval(n: int = 200, concurrency: int = 8) -> list[TierResult]:
    sem = asyncio.Semaphore(concurrency)
    by_tier: dict[str, list[float]] = {"L1": [], "L2": [], "DB": []}

    async def _do():
        await sem.acquire()
        try:
            tier = _choose_tier()
            t0 = time.perf_counter()
            await _mock_retrieval(tier)
            by_tier[tier].append((time.perf_counter() - t0) * 1000)
        finally:
            sem.release()

    await asyncio.gather(*[_do() for _ in range(n)])

    from bench.common import _percentile  # noqa: PLC2701
    out: list[TierResult] = []
    for tier, lats in by_tier.items():
        sorted_lats = sorted(lats)
        br = BenchResult(
            name=f"kb_retrieval:{tier}",
            n=len(lats),
            p50_ms=_percentile(sorted_lats, 50),
            p95_ms=_percentile(sorted_lats, 95),
            p99_ms=_percentile(sorted_lats, 99),
            mean_ms=sum(sorted_lats) / max(len(sorted_lats), 1),
            max_ms=max(sorted_lats) if sorted_lats else 0.0,
            extras={"tier": tier, "concurrency": concurrency},
        )
        out.append(TierResult(tier=tier, bench=br, hit_rate=len(lats) / n))
    return out
