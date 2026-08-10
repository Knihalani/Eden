"""Benchmark the pure-Python per-event ingest CPU path (no external sinks).

Measures the fixed per-event overhead the collector pays for every telemetry
event regardless of DB: ``_validate`` → ``_enrich`` (content-hash, cost stamp,
ingest latency) → ``_is_duplicate`` → ``_build_postgres_row`` row assembly
(zstd columns stubbed, since compression is covered by compression_bench) →
``TelemetryEvent.to_dict`` (the SSE/Redis wire shape).

Everything here is in-process CPython: the number is the irreducible
per-event floor the collector can never drop below, and the *deltas* between
runs after a code change are what matter. Run:

    uv run python -m bench.ingest_cpu            # single-event loop
    uv run python -m bench.ingest_cpu --batch    # batch path
"""

from __future__ import annotations

import argparse
import time
from dataclasses import dataclass

# Ensure ``src`` resolves to the app package (mirror bench.common).
import bench.common  # noqa: F401


@dataclass
class IngestCpuResult:
    name: str
    ops_per_sec: float
    us_per_event: float
    n: int


def _make_event(i: int = 0) -> "object":
    from eden.observability.telemetry_collector import TelemetryEvent

    return TelemetryEvent(
        event_id=f"evt-{i:08x}-0002-0003-0004",
        tenant_id="org-1234-5678",
        project_id="proj-0001",
        trace_id=f"trace-abcdef0123{i:08x}",
        realm="production",
        event_type="llm.completion",
        timestamp=f"2026-08-10T12:00:00.{(i % 1000000):06d}+00:00",
        agent_id="agent-42",
        agent_version="1.0.0",
        environment_id="env-1",
        parent_span_id="span-parent",
        span_id="span-child",
        name="gpt-4o-mini",
        duration_ms=123.4,
        payload={"model": "gpt-4o-mini", "temperature": 0.7, "messages": 3},
        metrics={"input_tokens": 150, "output_tokens": 80, "total_tokens": 230},
        attributes={"openai.model": "gpt-4o-mini", "framework": "openai"},
        tags=["llm"],
        outcome="success",
        source_format="openai",
        request_body={"messages": [{"role": "user", "content": "hello"}]},
        response_body={"choices": [{"message": {"content": "hi"}}]},
    )


def _single_run(n: int) -> IngestCpuResult:
    """validate + enrich + dedup + row-build one event at a time."""
    from eden.observability.telemetry_collector import TelemetryCollector

    collector = TelemetryCollector()
    events = [_make_event(i) for i in range(n)]

    start = time.perf_counter()
    accepted = 0
    for ev in events:
        if not collector._validate(ev):
            continue
        collector._enrich(ev)
        if collector._is_duplicate(ev):
            continue
        collector._build_postgres_row(ev, [b"z" * 8 for _ in range(8)])
        accepted += 1
    elapsed = time.perf_counter() - start
    ops = accepted / elapsed
    return IngestCpuResult(
        name="single: validate+enrich+dedup+row",
        ops_per_sec=ops,
        us_per_event=1e6 / ops,
        n=accepted,
    )


def _row_only_run(n: int) -> IngestCpuResult:
    """Row assembly alone (dominated by ~15 _dump_jsonb calls)."""
    from eden.observability.telemetry_collector import TelemetryCollector

    collector = TelemetryCollector()
    events = [_make_event(i) for i in range(n)]

    start = time.perf_counter()
    for ev in events:
        collector._build_postgres_row(ev, [b"z" * 8 for _ in range(8)])
    elapsed = time.perf_counter() - start
    ops = n / elapsed
    return IngestCpuResult(
        name="row build alone",
        ops_per_sec=ops,
        us_per_event=1e6 / ops,
        n=n,
    )


def _to_dict_run(n: int) -> IngestCpuResult:
    from eden.observability.telemetry_collector import TelemetryEvent

    events = [_make_event(i) for i in range(n)]
    start = time.perf_counter()
    for ev in events:
        ev.to_dict()
    elapsed = time.perf_counter() - start
    ops = n / elapsed
    return IngestCpuResult(
        name="to_dict (SSE/Redis wire shape)",
        ops_per_sec=ops,
        us_per_event=1e6 / ops,
        n=n,
    )


def _batch_run(n: int, batch: int) -> IngestCpuResult:
    """Pre-pass of ingest_batch: validate+enrich+dedup in a loop.

    Fresh unique events per rep (the dedup cache would otherwise reject
    every event after the first rep, making the rate meaningless).
    """
    from eden.observability.telemetry_collector import TelemetryCollector

    collector = TelemetryCollector()
    reps = max(1, n // batch)

    start = time.perf_counter()
    total = 0
    for rep in range(reps):
        base = rep * batch
        for j in range(batch):
            ev = _make_event(base + j)
            if not collector._validate(ev):
                continue
            collector._enrich(ev)
            if collector._is_duplicate(ev):
                continue
            total += 1
    elapsed = time.perf_counter() - start
    ops = total / elapsed
    return IngestCpuResult(
        name=f"batch pre-pass (batch={batch})",
        ops_per_sec=ops,
        us_per_event=1e6 / ops,
        n=total,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--n", type=int, default=50_000)
    parser.add_argument("--batch", action="store_true", help="include batch pre-pass")
    args = parser.parse_args()

    results = [_single_run(args.n), _row_only_run(args.n), _to_dict_run(args.n)]
    if args.batch:
        results.append(_batch_run(args.n, batch=200))

    print("\n== bench: ingest pure-Python CPU path ==")
    for r in results:
        print(
            f"  {r.name:<44} {r.ops_per_sec:>12,.0f} ops/s  "
            f"{r.us_per_event:8.2f} us/event  n={r.n}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
