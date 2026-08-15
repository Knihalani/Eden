"""Repo-graph benchmark — speed, memory, and compute budgets for
:class:`eden.code_change.graph.SymbolGraph`.

Reports per-op latency percentiles on the Eden repo itself (not a
mock) and the resulting on-disk SQLite size. The targets the brief
sets on the graphing system are:

* **Speed** — cold-index a fresh clone in under ~10s on a single
  thread (workstation-class hardware); warm re-index with no
  source change should be sub-second; search_symbols under 50ms
  p95 on a fully-warmed cache.
* **Memory** — the on-disk SQLite index stays under ~100 MiB
  for the Eden repo at the time of writing (~1600 source files,
  ~50k indexed symbols, ~250k references).
* **Compute** — the AST parser is single-threaded by default
  (GIL-bound) and finishes within budget; operators can opt into
  multi-thread parsing via ``EDEN_SYMBOL_GRAPH_INDEX_WORKERS``.
* **Token usage** — :meth:`SymbolGraph.query` returns at most
  ``limit`` snippets (default 25) and :meth:`find_affected_areas`
  at most ``limit`` areas (default 25), so the discipline layer
  never sees an unbounded payload.

The harness reuses the repo under ``Path.cwd()`` so this bench
*must* run from the repo root.

Run with::

    python -m bench.repo_graph
"""

from __future__ import annotations

import asyncio
import shutil
import statistics
import tempfile
import time
from pathlib import Path


# Budgets — sourced from the canonical ``BUDGET_*`` constants in
# :mod:`eden.code_change.graph.symbol_graph` so the bench, the
# regression tests, and the public docs always agree.
try:
    from eden.code_change.graph.symbol_graph import (
        BUDGET_COLD_INDEX_MS,
        BUDGET_WARM_INDEX_MS,
        BUDGET_QUERY_P95_MS,
        BUDGET_FIND_AFFECTED_P95_MS,
        BUDGET_DB_BYTES,
        BUDGET_QUERY_LIMIT,
    )
except Exception:  # pragma: no cover - import-time fallback
    BUDGET_COLD_INDEX_MS = 10_000.0
    BUDGET_WARM_INDEX_MS = 200.0
    BUDGET_QUERY_P95_MS = 50.0
    BUDGET_FIND_AFFECTED_P95_MS = 80.0
    BUDGET_DB_BYTES = 100 * 1024 * 1024
    BUDGET_QUERY_LIMIT = 25


def _percentile(values: list[float], pct: int) -> float:
    """Return the inclusive ``pct`` percentile (1..99) in ms."""
    if not values:
        return 0.0
    if len(values) == 1:
        return values[0]
    return statistics.quantiles(values, n=100, method="inclusive")[pct - 1]


async def _cold_index(repo: Path, db: Path) -> tuple[float, int, int, int]:
    """Index the repo from scratch; return elapsed / counts / db_bytes."""
    if db.exists():
        db.unlink()
    for sidecar in db.parent.glob(f"{db.name}-*"):
        sidecar.unlink(missing_ok=True)

    from eden.code_change.graph.symbol_graph import SymbolGraph

    g = SymbolGraph(root=repo, db_path=str(db))

    t0 = time.perf_counter()
    await g.request_index(
        "bench/repo_graph", "main", background=False,
    )
    elapsed_ms = (time.perf_counter() - t0) * 1000

    status = await g.status("bench/repo_graph", "main")
    db_bytes = db.stat().st_size if db.exists() else 0
    return elapsed_ms, status["file_count"], status["symbol_count"], db_bytes


async def _warm_index(repo: Path, db: Path) -> float:
    """Re-run the index against the same SHA + same mtimes; return ms."""
    from eden.code_change.graph.symbol_graph import SymbolGraph

    g = SymbolGraph(root=repo, db_path=str(db))
    t0 = time.perf_counter()
    await g.request_index(
        "bench/repo_graph", "main", background=False,
    )
    return (time.perf_counter() - t0) * 1000


async def _query(repo: Path, db: Path, question: str) -> int:
    """One :meth:`SymbolGraph.query` call; return match count."""
    from eden.code_change.graph.symbol_graph import SymbolGraph

    g = SymbolGraph(root=repo, db_path=str(db))
    res = await g.query("bench/repo_graph", question, "main")
    return 0 if res is None else len(res.snippets)


async def bench_repo_graph(
    *,
    repo: Path | None = None,
    n_query: int = 200,
    concurrency: int = 8,
) -> dict:
    """Run the full benchmark and return a structured report.

    The returned dict has two top-level keys: ``"budgets"``
    (which limits were met / missed) and ``"measurements"``
    (latency + size numbers). Designed to be JSON-serializable
    so it can land in ``bench/results/``.
    """
    repo = repo or Path.cwd()
    bench_workspace = Path(tempfile.mkdtemp(prefix="eden_repo_graph_bench_"))
    db = bench_workspace / "graph.sqlite"

    cold_ms, files, symbols, db_bytes = await _cold_index(repo, db)
    warm_ms = await _warm_index(repo, db)

    questions = [
        "SymbolGraph", "find_affected_areas", "insert_all",
        "_parse_python_single_pass", "RepoGraphClient",
        "GreptileRepoGraph", "_Store",
        "search_symbols", "LocalRepoGraph",
        "AffectedArea", "_format_class_parent",
        "_py_args_string", "_safe_index",
    ]

    # Warm the cache before measuring.
    for _ in range(3):
        for q in questions:
            await _query(repo, db, q)

    query_latencies: list[float] = []
    sem = asyncio.Semaphore(concurrency)

    async def _timed_q(q: str) -> None:
        await sem.acquire()
        try:
            t0 = time.perf_counter()
            await _query(repo, db, q)
            query_latencies.append((time.perf_counter() - t0) * 1000)
        finally:
            sem.release()

    # Distribute the question list ``n_query // len(questions)`` times
    # so the average matches ``n_query`` total samples while keeping
    # the question distribution realistic.
    rounds = max(1, n_query // len(questions))
    await asyncio.gather(*[_timed_q(q) for q in questions] * rounds)

    from eden.code_change.graph.symbol_graph import SymbolGraph

    g = SymbolGraph(root=repo, db_path=str(db))
    find_latencies: list[float] = []

    async def _find_one() -> None:
        await sem.acquire()
        try:
            t0 = time.perf_counter()
            await g.find_affected_areas(
                "bench/repo_graph",
                error_signature=(
                    'File "src/eden/code_change/graph/symbol_graph.py", '
                    'line 480, in foo'
                ),
                file_path_hint="src/eden/code_change/graph/symbol_graph.py",
            )
            find_latencies.append((time.perf_counter() - t0) * 1000)
        finally:
            sem.release()

    await asyncio.gather(*[_find_one() for _ in range(n_query)])

    shutil.rmtree(bench_workspace, ignore_errors=True)

    measurements = {
        "cold_index_ms": round(cold_ms, 2),
        "warm_index_ms": round(warm_ms, 2),
        "query_p50_ms": round(_percentile(query_latencies, 50), 3),
        "query_p95_ms": round(_percentile(query_latencies, 95), 3),
        "query_p99_ms": round(_percentile(query_latencies, 99), 3),
        "find_affected_p95_ms": round(_percentile(find_latencies, 95), 3),
        "file_count": files,
        "symbol_count": symbols,
        "db_bytes": db_bytes,
    }

    budgets = {
        "cold_index_met": cold_ms <= BUDGET_COLD_INDEX_MS,
        "warm_index_met": warm_ms <= BUDGET_WARM_INDEX_MS,
        "query_p95_met": measurements["query_p95_ms"] <= BUDGET_QUERY_P95_MS,
        "find_affected_p95_met": (
            measurements["find_affected_p95_ms"] <= BUDGET_FIND_AFFECTED_P95_MS
        ),
        "db_bytes_met": db_bytes <= BUDGET_DB_BYTES,
    }

    return {
        "budgets": budgets,
        "targets": {
            "cold_index_ms": BUDGET_COLD_INDEX_MS,
            "warm_index_ms": BUDGET_WARM_INDEX_MS,
            "query_p95_ms": BUDGET_QUERY_P95_MS,
            "find_affected_p95_ms": BUDGET_FIND_AFFECTED_P95_MS,
            "db_bytes": BUDGET_DB_BYTES,
        },
        "measurements": measurements,
    }


def main() -> int:
    import json
    report = asyncio.run(bench_repo_graph())
    print(json.dumps(report, indent=2))
    return 0 if all(report["budgets"].values()) else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
