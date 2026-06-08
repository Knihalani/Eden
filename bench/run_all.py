"""Orchestrate every bench and emit results JSON + a markdown summary.

Run with::

    python -m bench.run_all

Writes ``bench/results/{timestamp}.json`` and prints a table to
stdout. Used by ``.github/workflows/perf-bench.yml`` (weekly Sunday
4am cron + manual workflow_dispatch).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

RESULTS_DIR = Path(__file__).resolve().parent / "results"


async def main() -> int:
    from bench import kb_retrieval, latency, llm_provider, sandbox_boot

    started = time.time()
    all_results: dict = {
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
        "suites": {},
    }

    print("\n== bench: api latency ==")
    api_results = await latency.bench_api(n=200, concurrency=10)
    api_dicts = [r.to_dict() for r in api_results]
    all_results["suites"]["api_latency"] = api_dicts
    for r in api_dicts:
        print(f"  {r['name']:35s}  p50={r['p50_ms']:7.2f}ms  p95={r['p95_ms']:7.2f}ms  p99={r['p99_ms']:7.2f}ms")

    print("\n== bench: sandbox boot ==")
    sb_result = await sandbox_boot.bench_sandbox_boot(n=20, concurrency=1)
    sb_dict = sb_result.to_dict()
    all_results["suites"]["sandbox_boot"] = sb_dict
    print(f"  {sb_dict['name']:35s}  p50={sb_dict['p50_ms']:7.2f}ms  p95={sb_dict['p95_ms']:7.2f}ms")

    print("\n== bench: llm provider ==")
    llm_results = await llm_provider.bench_llm_provider(n=30, concurrency=4)
    llm_dicts = [r.to_dict() for r in llm_results]
    all_results["suites"]["llm_provider"] = llm_dicts
    for r in llm_dicts:
        print(f"  {r['name']:35s}  p50={r['p50_ms']:7.2f}ms  p95={r['p95_ms']:7.2f}ms  err_rate={r['error_rate']:.4f}")

    print("\n== bench: kb retrieval (tiered) ==")
    kb_results = await kb_retrieval.bench_kb_retrieval(n=200, concurrency=8)
    kb_dicts = [r.to_dict() for r in kb_results]
    all_results["suites"]["kb_retrieval"] = kb_dicts
    for r in kb_dicts:
        print(f"  {r['name']:35s}  p50={r['p50_ms']:7.2f}ms  p95={r['p95_ms']:7.2f}ms  hit_rate={r['hit_rate']:.2f}")

    all_results["duration_s"] = round(time.time() - started, 2)
    all_results["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # Write JSON
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
