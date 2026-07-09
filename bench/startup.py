"""App startup time benchmark.

Measures the wall-clock cost of ``from eden.api.app import app`` plus
a sample of the most-imported sub-modules. Designed to catch the
slow-but-not-broken regressions that the test suite misses.

Run with: ``python bench/startup.py [--json]``
"""

from __future__ import annotations

import argparse
import importlib
import json
import statistics
import subprocess
import sys
import time
from dataclasses import dataclass


@dataclass
class StartupResult:
    name: str
    samples_ms: list
    median_ms: float
    min_ms: float
    max_ms: float

    def to_dict(self):
        return {
            "name": self.name,
            "samples_ms": [round(s, 2) for s in self.samples_ms],
            "median_ms": round(self.median_ms, 2),
            "min_ms": round(self.min_ms, 2),
            "max_ms": round(self.max_ms, 2),
        }


# Targets:
# - "app"             - the whole FastAPI app module (cold start proxy)
# - "kb_router"       - KB router module (gates every KB test)
# - "llm_client"      - LLM client module (gates every LLM test)
# - "episodic_client" - episodic client (gates every KB test that inserts jobs)
TARGETS = (
    ("app", "eden.api.app"),
    ("kb_router", "eden.api.routes.kb"),
    ("llm_client", "eden.llm.client"),
    ("episodic_client", "eden.kb.episodic.client"),
    ("storage_postgres", "eden.storage.postgres"),
    ("storage_redis", "eden.storage.redis"),
    ("storage_compression", "eden.storage.compression"),
    ("optimization_cache", "eden.optimization.cache"),
    ("api_deps", "eden.api.deps"),
)


def _measure_subprocess(module, samples):
    """Run ``python -c 'import <module>'`` ``samples`` times in a fresh
    subprocess and return per-run millisecond wall-clock times.
    """
    times = []
    for _ in range(samples):
        code = (
            "import sys, time;"
            "t0=time.perf_counter();"
            "__import__(" + repr(module) + ");"
            "print((time.perf_counter()-t0)*1000)"
        )
        result = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            cwd="/Users/kaiavnihalani/Downloads/Eden",
            check=True,
        )
        last = result.stdout.strip().splitlines()
        times.append(float(last[-1]))
    return times


def bench_startup(samples=3, use_subprocess=True):
    results = []
    for name, module in TARGETS:
        if use_subprocess:
            t = _measure_subprocess(module, samples)
        else:
            first = time.perf_counter()
            importlib.import_module(module)
            cold = [(time.perf_counter() - first) * 1000]
            reloads = []
            for _ in range(samples):
                t0 = time.perf_counter()
                importlib.reload(importlib.import_module(module))
                reloads.append((time.perf_counter() - t0) * 1000)
            t = cold + reloads
        results.append(
            StartupResult(
                name=name,
                samples_ms=t,
                median_ms=statistics.median(t),
                min_ms=min(t),
                max_ms=max(t),
            )
        )
    return results


def main():
    parser = argparse.ArgumentParser(description="App startup benchmark")
    parser.add_argument("--samples", type=int, default=3)
    parser.add_argument("--json", action="store_true")
    parser.add_argument(
        "--inprocess",
        action="store_true",
        help="Use in-process reload instead of subprocess (faster, noisier)",
    )
    args = parser.parse_args()

    results = bench_startup(samples=args.samples, use_subprocess=not args.inprocess)
    if args.json:
        print(json.dumps([r.to_dict() for r in results], indent=2))
        return

    print(f"{'module':<25} {'median_ms':>10} {'min_ms':>10} {'max_ms':>10} samples")
    print("-" * 70)
    for r in results:
        print(
            f"{r.name:<25} {r.median_ms:>10.1f} {r.min_ms:>10.1f} {r.max_ms:>10.1f} {r.samples_ms}"
        )
    total = sum(r.median_ms for r in results)
    print("-" * 70)
    print(f"{'TOTAL':<25} {total:>10.1f}")


if __name__ == "__main__":
    main()
