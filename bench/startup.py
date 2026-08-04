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
    parser.add_argument(
        "--budget-ms",
        type=float,
        default=None,
        metavar="MS",
        help=(
            "Assertion mode: exit non-zero when the median cold "
            "`import eden.api.app` exceeds this many milliseconds. "
            "W15-c holds this under 1000ms by deferring ~100 routers "
            "to the lifespan; this flag is the regression tripwire. "
            "Note the benchmark deliberately measures IMPORT cost only "
            "— deferred routers are mounted in the lifespan and are "
            "meant to stay out of this number."
        ),
    )
    args = parser.parse_args()

    results = bench_startup(samples=args.samples, use_subprocess=not args.inprocess)
    if args.json:
        print(json.dumps([r.to_dict() for r in results], indent=2))
    else:
        print(f"{'module':<25} {'median_ms':>10} {'min_ms':>10} {'max_ms':>10} samples")
        print("-" * 70)
        for r in results:
            print(
                f"{r.name:<25} {r.median_ms:>10.1f} {r.min_ms:>10.1f} {r.max_ms:>10.1f} {r.samples_ms}"
            )
        total = sum(r.median_ms for r in results)
        print("-" * 70)
        print(f"{'TOTAL':<25} {total:>10.1f}")

    if args.budget_ms is not None:
        app_result = next(r for r in results if r.name == "app")
        if app_result.median_ms > args.budget_ms:
            print(
                f"BUDGET EXCEEDED: `import eden.api.app` median "
                f"{app_result.median_ms:.1f}ms > budget {args.budget_ms:.1f}ms "
                f"(samples: {[round(s, 1) for s in app_result.samples_ms]}). "
                f"Did a router move back out of the deferred tables in "
                f"eden/api/app.py, or did an eager module grow a heavy "
                f"module-level import? Check `python -X importtime -c "
                f"'import eden.api.app'`.",
                file=sys.stderr,
            )
            sys.exit(1)
        print(
            f"budget ok: `import eden.api.app` median "
            f"{app_result.median_ms:.1f}ms <= {args.budget_ms:.1f}ms"
        )


if __name__ == "__main__":
    main()
