"""Benchmark the full ``TelemetryCollector.ingest_batch`` path with mocked sinks.

Measures the end-to-end in-process cost of the production ingest path the SDK
actually uses: validate → late-span → enrich → dedup → sampling → per-tenant
count → ``_route_postgres_many`` (compress_many via thread + row build +
executemany) → per-event ``_route`` fan-out of 5 non-durable sinks. All sinks
are mocked to no-ops (Redis stream off, SSE nobody listening, CH disabled,
OTel off, Typesense off) — the realistic idle configuration — so the number is
the irreducible in-process cost per batch event.

Run:
    uv run python -m bench.ingest_batch_path [--batch 200] [--n 20000]
"""

from __future__ import annotations

import argparse
import asyncio
import time

import bench.common  # noqa: F401  (sys.path fixup)


class _NoopPG:
    """Stand-in for the asyncpg pool: records executemany without I/O."""

    def __init__(self) -> None:
        self.inserts = 0

    async def execute(self, sql: str, *args: object) -> str:
        return "INSERT 1"

    async def executemany(self, sql: str, rows: list[tuple[object, ...]]) -> None:
        self.inserts += len(rows)

    async def fetch(self, *args: object, **kwargs: object) -> list[dict[str, object]]:
        return []

    async def fetchrow(self, *args: object, **kwargs: object) -> dict[str, object] | None:
        return None

    async def fetchval(self, *args: object, **kwargs: object) -> object:
        return None


def _make_event(i: int) -> object:
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


def _stub_settings() -> None:
    """Pin settings to the idle configuration so sink routing is a no-op."""
    import types

    from eden import config as config_mod

    fake = types.SimpleNamespace(
        content_dedupe_enabled=True,
        telemetry_plaintext_jsonb_write_enabled=True,
        sampling_profile="full",
        sampling_enabled=True,
        sampling_high_cost_usd=0.50,
        probabilistic_sample_rate=None,
        sampling_slow_threshold_ms=5000.0,
        late_span_policy_enabled=False,
        redis_telemetry_stream_enabled=False,
        judges_async_tailer_enabled=False,
        redis_sse_write_when_idle=False,
        redis_sse_numsub_idle_ttl_s=30.0,
        redis_sse_numsub_active_ttl_s=2.0,
        typesense_bulk_index_enabled=True,
    )
    config_mod.get_settings = lambda: fake  # type: ignore[assignment]


async def _run(batch: int, total: int) -> None:
    from eden.observability.telemetry_collector import TelemetryCollector

    _stub_settings()
    collector = TelemetryCollector()
    pg = _NoopPG()
    collector._postgres = pg  # bypass get_postgres_client
    collector._redis = None
    collector._clickhouse = None

    # Warm the sampling cache (one org) + policy + pricing import so the
    # measured loop is steady-state, not cold-import.
    events0 = [_make_event(i) for i in range(batch)]
    await collector.ingest_batch(events0)
    collector._dedup_cache.clear()
    for ev in events0:
        ev.attributes.pop("_content_hash", None)

    batches = []
    for b in range(total // batch):
        base = b * batch + batch  # fresh ids (offset past warm batch)
        batches.append([_make_event(base + j) for j in range(batch)])

    start = time.perf_counter()
    accepted = 0
    for evs in batches:
        res = await collector.ingest_batch(evs)
        accepted += res["accepted"]
        for ev in evs:
            ev.attributes.pop("_content_hash", None)
    elapsed = time.perf_counter() - start

    print(f"\n== bench: full ingest_batch path (mocked no-op sinks) ==")
    print(f"  batch={batch}  events={accepted}  elapsed={elapsed:.3f}s")
    print(f"  {accepted / elapsed:>12,.0f} events/s  {1e6 / (accepted / elapsed):8.2f} us/event")
    print(f"  pg executemany rows: {pg.inserts}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch", type=int, default=200)
    parser.add_argument("--n", type=int, default=20_000)
    args = parser.parse_args()
    asyncio.run(_run(args.batch, args.n))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
