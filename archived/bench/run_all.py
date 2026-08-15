"""Orchestrate every bench and emit results JSON + a summary table.

Run with::

    python -m bench.run_all              # real suites only
    python -m bench.run_all --simulated  # also run the simulated ones

Writes ``bench/results/{timestamp}.json`` and prints a table to stdout. Used by
``.github/workflows/perf-bench.yml`` (weekly Sunday 4am cron + manual
workflow_dispatch).

**What changed and why.** This runner used to execute exactly four suites —
``api_latency``, ``llm_provider``, ``kb_retrieval`` and ``repo_graph``. The
first three are ``asyncio.sleep`` against a hard-coded latency table
(``latency.py``, ``llm_provider.py``, ``kb_retrieval.py``); the fourth raises
``ModuleNotFoundError`` because the package it benchmarks was retired, and was
being swallowed into ``{"skipped": true}``. So every number this runner ever
wrote to ``bench/results/`` measured ``asyncio.sleep`` resolution, and the
historical files were deleted rather than kept as a baseline.

Meanwhile four suites that drive *real* Eden code — the middleware stack, the
compression layer, the end-to-end ASGI request path, and import-time startup
cost — existed in this directory and were never registered here. They are what
runs now.

The simulated suites are retained behind ``--simulated`` because they still
describe an intended latency budget, but every result they produce is tagged
``"simulated": true`` so no downstream reader can mistake one for a
measurement. ``bench/compare.py`` refuses to gate on them.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

# Direct-run bootstrap: ``python bench/run_all.py`` — add the repo root
# so the ``bench`` package resolves (``python -m bench.run_all`` already
# has cwd on sys.path, so this is a no-op there).
_REPO_ROOT = str(Path(__file__).resolve().parents[1])
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

RESULTS_DIR = Path(__file__).resolve().parent / "results"


async def _run_real_suites() -> dict[str, Any]:
    """Run only the suites that execute real Eden code."""
    from bench import compression_bench, middleware, request_path, startup

    suites: dict[str, Any] = {}

    print("\n== bench: middleware hot path (real dispatch) ==")
    mw = await middleware.run(n=1000)
    suites["middleware"] = [r.to_dict() for r in mw]
    for r in mw:
        print(
            f"  {r.name:<34} p50={r.p50_ms * 1000:8.2f}us "
            f"p95={r.p95_ms * 1000:8.2f}us  n={r.n}"
        )

    print("\n== bench: compression (real zstd + storage layer) ==")
    comp = compression_bench.run(n=5000)
    suites["compression"] = comp
    print(
        f"  ratio={comp['compression_ratio']:.2f}x  "
        f"single={comp['single_thread_ops_per_sec']:.0f} ops/s  "
        f"batch={comp['batch_compress_ops_per_sec']:.0f} ops/s  "
        f"speedup={comp['batch_speedup_vs_single']:.2f}x  "
        f"errors={comp['round_trip_errors']}"
    )

    print("\n== bench: request path (real ASGI app) ==")
    rp = request_path.run(n=200)
    suites["request_path"] = rp
    for name in ("health", "docs"):
        r = rp[name]
        print(
            f"  {name:<34} p50={r['p50_ms']:8.3f}ms "
            f"p95={r['p95_ms']:8.3f}ms  statuses={r['statuses']}"
        )

    print("\n== bench: startup (real imports) ==")
    st = startup.bench_startup(samples=3)
    suites["startup"] = [r.to_dict() for r in st]
    for r in st:
        print(f"  {r.name:<34} median={r.median_ms:8.1f}ms  min={r.min_ms:8.1f}ms")

    return suites


async def _run_simulated_suites() -> dict[str, Any]:
    """Run the sleep-based suites, tagging every result as simulated.

    These do not measure Eden. They sleep for a duration read from a constant
    table, so they describe a latency *budget*, not behaviour. The tag is what
    keeps that distinction visible once the numbers are in a JSON file.
    """
    from bench import kb_retrieval, latency, llm_provider

    suites: dict[str, Any] = {}

    print("\n== bench: api latency (SIMULATED — asyncio.sleep) ==")
    suites["api_latency"] = {
        "simulated": True,
        "reason": "latency.py sleeps for a fixed duration; measures nothing in Eden",
        "results": [r.to_dict() for r in await latency.bench_api(n=200, concurrency=10)],
    }

    print("== bench: llm provider (SIMULATED — asyncio.sleep) ==")
    suites["llm_provider"] = {
        "simulated": True,
        "reason": "llm_provider.py sleeps for a fixed duration; no provider is called",
        "results": [
            r.to_dict()
            for r in await llm_provider.bench_llm_provider(n=30, concurrency=4)
        ],
    }

    print("== bench: kb retrieval (SIMULATED — asyncio.sleep) ==")
    suites["kb_retrieval"] = {
        "simulated": True,
        "reason": "kb_retrieval.py sleeps per TIER_LATENCY_MS; no index is queried",
        "results": [
            r.to_dict()
            for r in await kb_retrieval.bench_kb_retrieval(n=200, concurrency=8)
        ],
    }
    return suites


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--simulated",
        action="store_true",
        help="also run the sleep-based suites (tagged simulated; never gated on)",
    )
    parser.add_argument(
        "--no-write", action="store_true", help="print results without writing JSON"
    )
    args = parser.parse_args(argv)

    started = time.time()
    all_results: dict[str, Any] = {
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
        "suites": {},
    }

    all_results["suites"].update(await _run_real_suites())
    if args.simulated:
        all_results["suites"].update(await _run_simulated_suites())

    all_results["duration_s"] = round(time.time() - started, 2)
    all_results["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    if args.no_write:
        return 0

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = RESULTS_DIR / f"{time.strftime('%Y%m%d-%H%M%S', time.gmtime(started))}.json"
    out_path.write_text(json.dumps(all_results, indent=2))
    try:
        rel = out_path.relative_to(Path.cwd())
        print(f"\nWrote {rel}")
    except ValueError:
        print(f"\nWrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
