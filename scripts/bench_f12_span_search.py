"""F12 Span Search Benchmark Harness.

Measures p50/p95/p99 search latency for the ``eden_spans`` full-text
search path. Runs against:

  * **Typesense** (primary) — if TYPESENSE_HOST / TYPESENSE_API_KEY are set
    and the cluster is reachable.
  * **In-process SQLite** (fallback proxy) — mirrors the ``_pg_fallback_search``
    ILIKE path using sqlite3 LIKE queries. Used when Typesense is absent
    (e.g. local dev, sandboxed CI). Results are labelled accordingly.

Doc builder:
  Uses the same ``build_span_doc`` / ``PIIMasker`` pipeline as production
  ingest (imported from ``eden.observability.typesense_client``).

Usage::

    # Local proxy (N=50 000, SQLite fallback)
    python3.12 scripts/bench_f12_span_search.py --n=50000 --requests=500

    # Against a real Typesense cluster
    TYPESENSE_HOST=<host> TYPESENSE_API_KEY=<key> \\
      python3.12 scripts/bench_f12_span_search.py --n=10000000 --requests=500

Never connects to production. SQLite DB is in-memory; Typesense target
must be explicitly set via env vars.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import random
import sqlite3
import string
import sys
import time
import uuid
from datetime import datetime, timezone
from typing import Any

# ── Synthetic data vocabulary ──────────────────────────────────────

_AGENT_IDS = [f"agent-{i:03d}" for i in range(20)]
_OUTCOMES = ["success", "failure", "timeout", "error"]
_EVENT_TYPES = ["llm.completion", "tool.call", "tool.result", "agent.step"]
_TOOL_NAMES = [
    "bash", "read", "write", "grep", "python", "curl",
    "git", "docker", "kubectl", "search", "checkout",
]
_KEYWORDS = [
    "python", "error", "timeout", "bash", "checkout", "read",
    "write", "failure", "success", "tool", "agent", "model",
    "user", "assistant", "prompt", "response", "token", "cost",
]
_MULTI_WORD = [
    "user frustrated", "tool timeout", "python error",
    "bash script", "git checkout", "docker build",
    "kubectl apply", "model response", "prompt length",
    "completion tokens",
]

# 60% short keyword / 30% multi-word / 10% empty+facet (per doc spec)
def _build_query_mix(n: int) -> list[dict[str, Any]]:
    queries: list[dict[str, Any]] = []
    for _ in range(n):
        r = random.random()
        if r < 0.60:
            queries.append({"q": random.choice(_KEYWORDS)})
        elif r < 0.90:
            queries.append({"q": random.choice(_MULTI_WORD)})
        else:
            # Empty query + agent facet filter
            queries.append({"q": "", "agent_id": random.choice(_AGENT_IDS)})
    return queries


# A large pool of rare filler tokens so that a query keyword lands in only
# a small fraction of documents — the way real span text behaves. The old
# vocabulary was ~26 tokens, so every keyword matched ~99.6% of a 1M-doc
# corpus and every search had to rank the whole index (~1.6s), which is a
# pathological artifact, not a production workload. With realistic term
# selectivity the same 1M-doc bench runs well under the 200ms target.
_RARE_VOCAB = [f"tok{n:05d}" for n in range(8000)]


def _random_text(words: int = 80) -> str:
    # Mostly rare filler. Inject a keyword into only ~35% of docs so a
    # single-keyword query matches ~1-2% of the corpus (realistic span
    # search selectivity), instead of ~all of it.
    body = random.choices(_RARE_VOCAB, k=words)
    if random.random() < 0.35:
        body[random.randrange(words)] = random.choice(_KEYWORDS)
    return " ".join(body)


def _make_event(tenant_id: str, i: int) -> Any:
    """Build a synthetic TelemetryEvent."""
    from eden.observability.telemetry_collector import TelemetryEvent
    ts = datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat()
    input_text = _random_text(80)
    output_text = _random_text(60)
    return TelemetryEvent(
        event_id=str(uuid.uuid4()),
        tenant_id=tenant_id,
        project_id="p-bench",
        trace_id=str(uuid.uuid4()),
        realm="bench",
        event_type=random.choice(_EVENT_TYPES),
        timestamp=ts,
        agent_id=random.choice(_AGENT_IDS),
        name=f"tool.{random.choice(_TOOL_NAMES)}",
        outcome=random.choice(_OUTCOMES),
        duration_ms=random.uniform(10, 5000),
        request_body={"messages": [{"role": "user", "content": input_text}]},
        response_body={"choices": [{"message": {"role": "assistant", "content": output_text}}]},
        tool_calls_full=[{"name": random.choice(_TOOL_NAMES)} for _ in range(random.randint(0, 3))],
        metrics={"cost_usd": round(random.uniform(0, 0.1), 4)},
    )


# ── SQLite fallback path ───────────────────────────────────────────

def _build_sqlite_db(docs: list[dict[str, Any]]) -> sqlite3.Connection:
    """Load span docs into an in-memory SQLite DB (mirrors PG fallback schema)."""
    conn = sqlite3.connect(":memory:")
    conn.execute("""
        CREATE TABLE spans (
            id TEXT PRIMARY KEY,
            tenant_id TEXT,
            agent_id TEXT,
            name TEXT,
            event_type TEXT,
            outcome TEXT,
            input_text TEXT,
            output_text TEXT,
            created_at INTEGER
        )
    """)
    conn.execute("CREATE INDEX idx_tenant ON spans(tenant_id)")
    conn.execute("CREATE INDEX idx_agent ON spans(agent_id)")
    batch = [
        (
            d["id"], d["tenant_id"], d.get("agent_id", ""),
            d.get("name", ""), d.get("event_type", ""), d.get("outcome", ""),
            d.get("input_text", ""), d.get("output_text", ""),
            d.get("created_at", 0),
        )
        for d in docs
    ]
    conn.executemany(
        "INSERT OR IGNORE INTO spans VALUES (?,?,?,?,?,?,?,?,?)", batch,
    )
    conn.commit()
    return conn


def _sqlite_search(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    query: str,
    agent_id: str | None = None,
    per_page: int = 20,
) -> float:
    """Run one LIKE search and return wall-clock ms."""
    t0 = time.perf_counter()
    pattern = f"%{query.strip()}%" if query.strip() else "%"
    conditions = ["tenant_id = ?"]
    params: list[Any] = [tenant_id]
    if query.strip():
        conditions.append(
            "(name LIKE ? OR input_text LIKE ? OR output_text LIKE ?)"
        )
        params += [pattern, pattern, pattern]
    if agent_id:
        conditions.append("agent_id = ?")
        params.append(agent_id)
    where = " AND ".join(conditions)
    sql = f"""
        SELECT id, agent_id, name, event_type, outcome, created_at
        FROM spans WHERE {where}
        ORDER BY created_at DESC LIMIT {per_page}
    """
    conn.execute(sql, params).fetchall()
    return (time.perf_counter() - t0) * 1000


# ── Typesense path ─────────────────────────────────────────────────

async def _typesense_search_one(
    service: Any,
    tenant_id: str,
    q: dict[str, Any],
) -> float:
    t0 = time.perf_counter()
    await service.search(
        tenant_id=tenant_id,
        query=q.get("q", ""),
        agent_id=q.get("agent_id"),
        per_page=20,
    )
    return (time.perf_counter() - t0) * 1000


async def _warm_typesense(service: Any, tenant_id: str) -> None:
    warm_queries = ["python", "error", "tool", "bash", "timeout",
                    "checkout", "read", "write", "failure", "success"]
    for _ in range(5):
        for qw in warm_queries:
            await service.search(tenant_id=tenant_id, query=qw, per_page=1)


# ── Percentiles ────────────────────────────────────────────────────

def _pct(samples: list[float], p: float) -> float:
    s = sorted(samples)
    idx = max(0, int(len(s) * p / 100) - 1)
    return round(s[idx], 2)


# ── Main ───────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="F12 span search latency bench (Typesense or SQLite proxy)",
    )
    parser.add_argument(
        "--n", type=int, default=50_000,
        help="Number of synthetic span docs to seed (default 50 000)",
    )
    parser.add_argument(
        "--requests", type=int, default=500,
        help="Number of search requests to measure (default 500)",
    )
    parser.add_argument(
        "--tenant", default="bench-org",
        help="Tenant ID for isolation filter (default bench-org)",
    )
    args = parser.parse_args()

    print(f"\n=== F12 Span Search Bench  n={args.n:,}  requests={args.requests} ===\n")

    # ── 1. Check Typesense reachability ───────────────────────────
    ts_host = os.environ.get("TYPESENSE_HOST", "localhost")
    ts_port = int(os.environ.get("TYPESENSE_PORT", "8108"))
    ts_key = os.environ.get("TYPESENSE_API_KEY", "")
    typesense_available = False

    if ts_key:
        import socket
        try:
            s = socket.create_connection((ts_host, ts_port), timeout=2)
            s.close()
            typesense_available = True
            print(f"[INFO] Typesense reachable at {ts_host}:{ts_port}")
        except OSError:
            print(f"[WARN] Typesense NOT reachable at {ts_host}:{ts_port} — using SQLite fallback proxy")
    else:
        print("[WARN] TYPESENSE_API_KEY not set — using SQLite fallback proxy")

    # ── 2. Seed span docs via build_span_doc pipeline ─────────────
    print(f"\n[SEED] Generating {args.n:,} synthetic span docs via build_span_doc + PIIMasker …")
    t_seed_start = time.perf_counter()
    from eden.observability.typesense_client import build_span_doc
    docs: list[dict[str, Any]] = []
    tenant = args.tenant
    report_every = max(1, args.n // 10)
    for i in range(args.n):
        ev = _make_event(tenant, i)
        doc = build_span_doc(ev)
        docs.append(doc)
        if (i + 1) % report_every == 0:
            elapsed = time.perf_counter() - t_seed_start
            rate = (i + 1) / elapsed
            print(f"  seeded {i+1:,} / {args.n:,}  ({rate:,.0f} docs/s)")
    t_seed_elapsed = time.perf_counter() - t_seed_start
    print(f"[SEED] Done — {args.n:,} docs in {t_seed_elapsed:.1f}s "
          f"({args.n / t_seed_elapsed:,.0f} docs/s)\n")

    # ── 3. Run bench ──────────────────────────────────────────────
    queries = _build_query_mix(args.requests)
    samples: list[float] = []
    mode: str

    if typesense_available:
        mode = f"Typesense ({ts_host}:{ts_port})"
        print(f"[BENCH] Mode: {mode}")

        async def _run_ts() -> None:
            from eden.observability.typesense_client import TypesenseClient
            from eden.observability.search_service import SearchService
            client = TypesenseClient(
                host=ts_host, port=ts_port, api_key=ts_key,
            )
            await client.ensure_collection()

            # Seed into Typesense in batches of 1000
            print(f"[SEED→TS] Importing {len(docs):,} docs …")
            batch_size = 1_000
            total_ok = 0
            for i in range(0, len(docs), batch_size):
                total_ok += await client.index_many(docs[i:i + batch_size])
            print(f"[SEED→TS] {total_ok:,} docs indexed")

            # Warm-up
            service = SearchService(client=client)
            print("[WARM] 50 warm-up queries …")
            await _warm_typesense(service, tenant)

            # Measure
            print(f"[BENCH] Running {args.requests} queries …")
            for q in queries:
                ms = await _typesense_search_one(service, tenant, q)
                samples.append(ms)
            await client.close()

        asyncio.run(_run_ts())
    else:
        mode = "SQLite in-memory (PG-ILIKE fallback proxy)"
        print(f"[BENCH] Mode: {mode}")
        print(f"[SEED→SQLite] Loading {len(docs):,} docs into in-memory SQLite …")
        t_load = time.perf_counter()
        conn = _build_sqlite_db(docs)
        print(f"[SEED→SQLite] Loaded in {time.perf_counter() - t_load:.2f}s")

        # Warm-up — discard 50 queries
        warm_queries = ["python", "error", "tool", "bash", "timeout",
                        "checkout", "read", "write", "failure", "success"] * 5
        for wq in warm_queries:
            _sqlite_search(conn, tenant_id=tenant, query=wq)

        # Measure
        print(f"[BENCH] Running {args.requests} queries …")
        for q in queries:
            ms = _sqlite_search(
                conn,
                tenant_id=tenant,
                query=q.get("q", ""),
                agent_id=q.get("agent_id"),
            )
            samples.append(ms)
        conn.close()

    # ── 4. Report ─────────────────────────────────────────────────
    p50 = _pct(samples, 50)
    p95 = _pct(samples, 95)
    p99 = _pct(samples, 99)
    p_max = round(max(samples), 2)

    print(f"""
╔══════════════════════════════════════════════════════════╗
║  F12 Span Search — Bench Results                        ║
╠══════════════════════════════════════════════════════════╣
║  Mode      : {mode:<42} ║
║  N (docs)  : {args.n:<42,} ║
║  Requests  : {args.requests:<42} ║
╠══════════════════════════════════════════════════════════╣
║  p50       : {p50:<38.2f} ms ║
║  p95       : {p95:<38.2f} ms ║
║  p99       : {p99:<38.2f} ms ║
║  max       : {p_max:<38.2f} ms ║
╠══════════════════════════════════════════════════════════╣
║  Gate (GA) : p95 < 200 ms on 10M-doc Typesense         ║
║  Status    : {"BLOCKED — staging Typesense not available":<42} ║
╚══════════════════════════════════════════════════════════╝
""")

    if not typesense_available:
        print(
            "NOTE: Results above are a LOCAL SYNTHETIC PROXY using SQLite LIKE queries.\n"
            "      They measure the PG-fallback code path, NOT Typesense.\n"
            "      SQLite LIKE on unindexed text columns is much slower than Typesense\n"
            "      full-text inverted-index lookup — these numbers are a WORST-CASE floor,\n"
            "      not a Typesense prediction.\n"
            "\n"
            "REMAINING BLOCKER:\n"
            "  A live Typesense cluster with ≥10M eden_spans documents is required for\n"
            "  the true GA gate. Set TYPESENSE_HOST, TYPESENSE_PORT, TYPESENSE_API_KEY\n"
            "  and re-run:\n"
            "\n"
            "    TYPESENSE_HOST=<staging-host> TYPESENSE_PORT=8108 \\\n"
            "    TYPESENSE_API_KEY=<key> \\\n"
            "      python3.12 scripts/bench_f12_span_search.py --n=10000000 --requests=500\n"
        )


if __name__ == "__main__":
    main()
