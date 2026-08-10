"""Shared helpers for the ``bench/`` suite.

The suites fall into two groups, and the difference matters:

**Real** — ``middleware``, ``compression_bench``, ``request_path`` and
``startup`` drive actual Eden code (middleware ``dispatch``, the zstd storage
layer, the ASGI app, import cost). ``bench.run_all`` runs these by default and
``bench.compare`` gates on them.

**Simulated** — ``latency``, ``llm_provider`` and ``kb_retrieval`` call
``asyncio.sleep`` against a hard-coded latency table. They describe an intended
budget, not behaviour, and measure nothing about Eden. They run only under
``--simulated``, every result is tagged ``"simulated": true``, and
``bench.compare`` refuses to gate on them.

Nothing here requires an external service, so the whole harness runs in CI.
"""

from __future__ import annotations

import asyncio
import os
import statistics
import sys
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

# ─────────────────────────────────────────────────────────────────────────────
# Resolve ``eden`` to the app package, not the SDK stub.
#
# ``sdk/python/eden/__init__.py`` is the user-facing SDK shim and shadows
# ``src/eden`` on ``sys.path`` (the editable install puts ``sdk/python``
# ahead of ``src``). pytest (``[tool.pytest] pythonpath = ["src", "."]``),
# ``tests/conftest.py`` (surgical ``sys.path``/``sys.modules`` fixup) and the
# CI ``startup-budget`` workflow (``PYTHONPATH="src:."``) all already work
# around it — the bench harness was the one place that didn't, which is why
# ``bench.startup`` / ``bench.gateway_overhead`` crashed with
# ``ModuleNotFoundError: No module named 'eden.api'``. Prepend ``src`` here so
# every bench that imports ``eden.*`` in-process works, and expose
# :func:`bench_env` so subprocess-based benches (``startup``) inherit the same
# fix. Mirrors ``tests/conftest.py``.
_REPO_ROOT = Path(__file__).resolve().parents[1]
_SRC = _REPO_ROOT / "src"
_src_str = str(_SRC)
if _src_str in sys.path:
    sys.path.remove(_src_str)
sys.path.insert(0, _src_str)


def bench_env() -> dict[str, str]:
    """Env for bench subprocesses: ``src`` first so ``eden`` = the app."""
    env = dict(os.environ)
    src_first = _src_str + os.pathsep + str(_REPO_ROOT)
    existing = env.get("PYTHONPATH")
    env["PYTHONPATH"] = src_first + (os.pathsep + existing if existing else "")
    return env


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
        # Six decimals, not three. The middleware suite measures dispatch in
        # single-digit microseconds — 0.002 ms at three decimals — where one
        # rounding step is a 50% swing. ``bench/compare.py`` would then flag
        # pure quantisation noise as a regression, and a gate that cries wolf
        # gets switched off. Six decimals put the quantisation ~1000x below
        # the smallest value measured here.
        return {
            "name": self.name,
            "n": self.n,
            "p50_ms": round(self.p50_ms, 6),
            "p95_ms": round(self.p95_ms, 6),
            "p99_ms": round(self.p99_ms, 6),
            "mean_ms": round(self.mean_ms, 6),
            "max_ms": round(self.max_ms, 6),
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
