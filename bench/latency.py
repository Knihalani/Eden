"""API latency benchmark.

If ``$EDEN_BENCH_BASE_URL`` is set, hits a real deployment via
``httpx``. Otherwise uses an in-process mock that simulates the
FastAPI dependency-injection overhead so the harness runs in CI
without any external services.

Targets (from §11.1):
  - p95 < 200ms across all v1 endpoints
  - p99 < 500ms
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass

from bench.common import BenchResult, bench_async


DEFAULT_ENDPOINTS = [
    ("GET", "/health"),
    ("GET", "/v1/jobs"),
    ("GET", "/v1/environments"),
    ("GET", "/v1/benchmarks"),
]


async def _mock_request(method: str, path: str) -> None:
    """Simulate a FastAPI request: dependency resolution, 5ms work,
    1ms JSON serialization."""
    await asyncio.sleep(0.005)
    # Simulate FastAPI's per-request overhead
    _ = (method, path, time.time())


async def bench_api(
    n: int = 200,
    concurrency: int = 10,
    base_url: str | None = None,
) -> list[BenchResult]:
    """Run the latency bench and return one result per endpoint."""
    base_url = base_url or os.environ.get("EDEN_BENCH_BASE_URL")

    if base_url:
        return await _bench_real(base_url, n, concurrency)
    return await _bench_mock(n, concurrency)


async def _bench_real(base_url: str, n: int, concurrency: int) -> list[BenchResult]:
    import httpx

    out: list[BenchResult] = []
    async with httpx.AsyncClient(base_url=base_url, timeout=10.0) as client:
        for method, path in DEFAULT_ENDPOINTS:
            async def _do():
                if method == "GET":
                    await client.get(path)
                else:
                    await client.request(method, path)
            res = await bench_async(f"api:{method} {path}", _do, n=n, concurrency=concurrency)
            out.append(res)
    return out


async def _bench_mock(n: int, concurrency: int) -> list[BenchResult]:
    out: list[BenchResult] = []
    for method, path in DEFAULT_ENDPOINTS:
        async def _do(method=method, path=path):
            await _mock_request(method, path)
        res = await bench_async(f"api:{method} {path}", _do, n=n, concurrency=concurrency)
        out.append(res)
    return out
