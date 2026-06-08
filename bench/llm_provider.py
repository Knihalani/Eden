"""LLM-provider latency benchmark.

Mocks OpenAI and Anthropic response times based on publicly-known
model characteristics. The point is to compare the two providers
under the same harness so the §6.1 cost-optimization layer can pick
the right model for a given workload.

Target (from §11.4): per-provider error rate < 0.1%.
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass

from bench.common import BenchResult, bench_async


# Per-provider mock latencies (ms). Real numbers will vary; these are
# representative for the §6.1 routing decisions.
PROVIDER_LATENCY_MS = {
    "openai": 250,
    "anthropic": 320,
    "openrouter": 400,  # aggregator, slightly slower
}

# Per-provider simulated error rates.
PROVIDER_ERROR_RATE = {
    "openai": 0.001,
    "anthropic": 0.002,
    "openrouter": 0.005,
}


@dataclass
class ProviderResult:
    name: str
    bench: BenchResult
    errors: int
    total: int

    def error_rate(self) -> float:
        return self.errors / max(self.total, 1)

    def to_dict(self) -> dict:
        d = self.bench.to_dict()
        d["errors"] = self.errors
        d["total"] = self.total
        d["error_rate"] = round(self.error_rate(), 5)
        return d


async def _mock_provider_call(provider: str) -> None:
    """Simulate one LLM call. Injects a small per-call latency and
    raises on simulated error (so the harness can count them)."""
    import random
    base_ms = PROVIDER_LATENCY_MS.get(provider, 300)
    # ±20% jitter
    jitter = base_ms * 0.2 * (random.random() * 2 - 1)
    await asyncio.sleep((base_ms + jitter) / 1000.0)
    err_rate = PROVIDER_ERROR_RATE.get(provider, 0.0)
    if random.random() < err_rate:
        raise RuntimeError(f"{provider} simulated error")


async def bench_llm_provider(
    providers: list[str] | None = None,
    n: int = 30,
    concurrency: int = 4,
) -> list[ProviderResult]:
    providers = providers or list(PROVIDER_LATENCY_MS.keys())
    out: list[ProviderResult] = []
    for provider in providers:
        sem = asyncio.Semaphore(concurrency)
        errors = 0
        latencies: list[float] = []

        async def _do():
            nonlocal errors
            await sem.acquire()
            try:
                t0 = time.perf_counter()
                try:
                    await _mock_provider_call(provider)
                    latencies.append((time.perf_counter() - t0) * 1000)
                except Exception:
                    errors += 1
            finally:
                sem.release()

        await asyncio.gather(*[_do() for _ in range(n)])
        from bench.common import _percentile  # noqa: PLC2701
        ok = max(n - errors, 0)
        br = BenchResult(
            name=f"llm:{provider}",
            n=ok,
            p50_ms=_percentile(sorted(latencies), 50) if latencies else 0.0,
            p95_ms=_percentile(sorted(latencies), 95) if latencies else 0.0,
            p99_ms=_percentile(sorted(latencies), 99) if latencies else 0.0,
            mean_ms=sum(latencies) / ok if ok else 0.0,
            max_ms=max(latencies) if latencies else 0.0,
            extras={"concurrency": concurrency},
        )
        out.append(ProviderResult(name=provider, bench=br, errors=errors, total=n))
    return out
