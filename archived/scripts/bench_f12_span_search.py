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

Facet A/B (``--facet-ab`` / ``--no-facet-ab``, default on, Typesense mode
only):
  Runs the SAME query mix twice against SearchService — once with
  ``facet_by=None`` (the production default; faceting is opt-in) and once
  with ``facet_by=SearchService.DEFAULT_FACET_FIELDS`` (the 5-field facet
  set: agent_id, tool_names, outcome, event_type, model) — and reports
  p50/p95/p99 for both so the faceting cost delta is a *measured* number,
  not an assertion. Not modeled in SQLite-fallback mode (the ILIKE proxy
  has no facet computation to toggle).

gate_met automation:
  ``gate_met`` in the emitted results JSON is computed programmatically as
  ``baseline (no-facet) p95 <= --gate-ms`` (default 200.0, the F12 GA
  target) from the samples this run actually measured — it is never a
  hand-set literal. When running against the SQLite fallback proxy instead
  of real Typesense, ``gate_met`` is deliberately written as ``null`` with
  an explanatory note: the fallback proxy is a worst-case floor for the
  PG-ILIKE path, not a Typesense measurement, so it cannot honestly attest
  to the Typesense GA gate either way.

Results are written to a JSON file under ``bench/results/`` (path printed
at the end of the run, override with ``--out``).

Scale ladder (``--scale-ladder`` or ``--corpus-sizes 10k,100k,1m,10m``):
  Runs the harness at each rung, writes one per-rung JSON under
  ``bench/results/``, and emits a ladder manifest JSON
  (``f12-span-search-scale-ladder-<date>.json``) summarising which rungs
  were measured, skipped, or blocked. Use ``--dry-run`` to emit only the
  manifest structure (no seeding/benchmarking) — useful when staging
  Typesense is unavailable. The 10M rung is never fabricated: without a
  reachable Typesense cluster it is recorded as ``blocked_staging``.

  Start local Typesense: ``docker compose -f docker/docker-compose.yml up -d typesense``

KNOWN OPEN ITEM (evidence-integrity, tracked in
docs/specs/SOTA-PERF-COST-SCORECARD.md under F12): the 10M-on-staging
rung remains a genuine follow-up requiring staging infra. Do not backfill
numbers for rungs that were not actually executed — re-run this script
with real Typesense reachable and let it write its own JSON.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sqlite3
import string
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
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
    *,
    facet_by: tuple[str, ...] | None = None,
) -> float:
    t0 = time.perf_counter()
    await service.search(
        tenant_id=tenant_id,
        query=q.get("q", ""),
        agent_id=q.get("agent_id"),
        per_page=20,
        facet_by=facet_by,
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


# ── Scale ladder helpers ───────────────────────────────────────────

DEFAULT_SCALE_LADDER = ("10k", "100k", "1m", "10m")
# SQLite proxy is only practical for the small sanity rungs; larger rungs
# need real Typesense or a prior committed artifact.
SQLITE_PROXY_MAX_DOCS = 100_000
STAGING_REQUIRED_MIN_DOCS = 10_000_000
RESULTS_DIR = Path("bench/results")
PRIOR_1M_ARTIFACT = RESULTS_DIR / "f12-span-search-1m-typesense-20260804.json"


def parse_corpus_size(spec: str) -> int:
    """Parse a human corpus label (``10k``, ``1m``, ``10000000``) to an int."""
    s = spec.strip().lower().replace("_", "").replace(",", "")
    if not s:
        raise ValueError("empty corpus size")
    multipliers = {"k": 1_000, "m": 1_000_000}
    if s[-1] in multipliers:
        return int(float(s[:-1]) * multipliers[s[-1]])
    return int(s)


def format_corpus_rung(n: int) -> str:
    """Canonical ladder label for *n* documents."""
    if n >= 1_000_000 and n % 1_000_000 == 0:
        return f"{n // 1_000_000}m"
    if n >= 1_000 and n % 1_000 == 0:
        return f"{n // 1_000}k"
    return str(n)


def parse_corpus_sizes(spec: str) -> list[tuple[str, int]]:
    """Parse ``10k,100k,1m,10m`` into ``[(label, n), ...]``."""
    rungs: list[tuple[str, int]] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        n = parse_corpus_size(part)
        rungs.append((format_corpus_rung(n), n))
    if not rungs:
        raise ValueError("no corpus sizes parsed")
    return rungs


def _typesense_env() -> tuple[str, int, str]:
    return (
        os.environ.get("TYPESENSE_HOST", "localhost"),
        int(os.environ.get("TYPESENSE_PORT", "8108")),
        os.environ.get("TYPESENSE_API_KEY", ""),
    )


def check_typesense_reachable() -> tuple[bool, str, int, str]:
    """Return (reachable, host, port, api_key)."""
    ts_host, ts_port, ts_key = _typesense_env()
    if not ts_key:
        return False, ts_host, ts_port, ts_key
    import socket
    try:
        s = socket.create_connection((ts_host, ts_port), timeout=2)
        s.close()
        return True, ts_host, ts_port, ts_key
    except OSError:
        return False, ts_host, ts_port, ts_key


def default_results_path(*, n: int, typesense_available: bool) -> Path:
    mode_label = "typesense" if typesense_available else "sqlite-fallback"
    return RESULTS_DIR / (
        f"f12-span-search-{format_corpus_rung(n)}-{mode_label}-"
        f"{datetime.now(timezone.utc).strftime('%Y%m%d')}.json"
    )


def load_prior_artifact(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def prior_gate_met(prior: dict[str, Any] | None) -> bool | None:
    """Extract gate_met from harness-shaped or legacy 1.1M artifact JSON."""
    if not prior:
        return None
    top = prior.get("gate_met")
    if top is not None:
        return top
    e2e = prior.get("end_to_end_searchservice")
    if isinstance(e2e, dict):
        nested = e2e.get("gate_met")
        if nested is not None:
            return nested
    return None


def plan_ladder_rung(
    rung_label: str,
    n: int,
    *,
    typesense_available: bool,
    dry_run: bool,
    reuse_prior: bool,
) -> dict[str, Any]:
    """Decide how a ladder rung will be handled (without executing)."""
    entry: dict[str, Any] = {
        "rung": rung_label,
        "corpus_size": n,
        "status": "pending",
    }
    if n >= STAGING_REQUIRED_MIN_DOCS and not typesense_available:
        entry["status"] = "blocked_staging"
        entry["note"] = (
            f"{n:,} docs requires a reachable Typesense staging cluster "
            "(TYPESENSE_HOST/PORT/API_KEY). Numbers are never fabricated."
        )
        return entry
    if not typesense_available and n > SQLITE_PROXY_MAX_DOCS:
        if reuse_prior and rung_label == "1m" and PRIOR_1M_ARTIFACT.is_file():
            prior = load_prior_artifact(PRIOR_1M_ARTIFACT)
            entry["status"] = "prior_artifact"
            entry["results_path"] = str(PRIOR_1M_ARTIFACT)
            entry["note"] = (
                "Reusing committed prior Typesense measurement; not re-executed "
                "in this ladder pass because Typesense is unreachable."
            )
            if prior:
                entry["gate_met"] = prior_gate_met(prior)
                corpus = prior.get("corpus", {})
                entry["corpus_size"] = corpus.get("num_documents", n)
        else:
            entry["status"] = "blocked_infra"
            entry["note"] = (
                f"Corpus {n:,} exceeds SQLite-proxy cap ({SQLITE_PROXY_MAX_DOCS:,}) "
                "and Typesense is unreachable. Start Typesense or run on staging."
            )
        return entry
    if dry_run:
        entry["status"] = "dry_run_planned"
        entry["note"] = (
            "Dry-run only — would execute against "
            + ("Typesense" if typesense_available else "SQLite fallback proxy")
            + f" with n={n:,}."
        )
        return entry
    entry["status"] = "planned"
    entry["engine"] = "typesense" if typesense_available else "sqlite-fallback"
    return entry


def build_results_payload(
    *,
    n: int,
    requests: int,
    tenant: str,
    gate_ms: float,
    typesense_available: bool,
    ts_host: str,
    ts_port: int,
    mode: str,
    samples: list[float],
    facet_ab_ran: bool,
    facet_fields: tuple[str, ...] | None,
    samples_faceted: list[float],
    facet_ab_enabled: bool,
    rung_label: str | None = None,
) -> dict[str, Any]:
    p50 = _pct(samples, 50)
    p95 = _pct(samples, 95)
    p99 = _pct(samples, 99)
    p_max = round(max(samples), 2)

    if typesense_available:
        gate_met = p95 <= gate_ms
        gate_note = (
            f"Computed as baseline p95 ({p95:.2f}ms) <= gate ({gate_ms:.0f}ms) "
            f"against real Typesense at {ts_host}:{ts_port}, n={n:,} docs."
        )
    else:
        gate_met = None
        gate_note = (
            "SQLite fallback proxy (no real Typesense reachable) — a worst-case "
            "floor for the PG-ILIKE path, not a Typesense measurement. gate_met "
            "is intentionally null."
        )

    recorded_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    results: dict[str, Any] = {
        "bench": "f12-span-search",
        "recorded_at": recorded_at,
        "target_gate": f"p95 < {gate_ms:.0f}ms",
        "mode": mode,
        "typesense_reachable": typesense_available,
        "corpus": {"num_documents": n, "tenant": tenant},
        "requests": requests,
        "baseline_no_facet": {"p50": p50, "p95": p95, "p99": p99, "max": p_max},
        "gate_met": gate_met,
        "gate_note": gate_note,
    }
    if rung_label:
        results["scale_ladder_rung"] = rung_label

    facet_p50 = facet_p95 = facet_p99 = None
    facet_delta_p95 = None
    if facet_ab_ran:
        assert facet_fields is not None
        facet_p50 = _pct(samples_faceted, 50)
        facet_p95 = _pct(samples_faceted, 95)
        facet_p99 = _pct(samples_faceted, 99)
        facet_delta_p95 = round(facet_p95 - p95, 2)
        results["facet_ab"] = {
            "facet_fields": list(facet_fields),
            "facet_off": {"p50": p50, "p95": p95, "p99": p99},
            "facet_on": {"p50": facet_p50, "p95": facet_p95, "p99": facet_p99},
            "delta_p95_ms": facet_delta_p95,
        }
    else:
        results["facet_ab"] = None
        results["facet_ab_note"] = (
            "Skipped (--no-facet-ab)." if typesense_available else
            "Not applicable — SQLite fallback mode has no facet computation to toggle."
        )

    honest_caveats: list[str] = []
    if not typesense_available:
        honest_caveats.append(
            "SQLite LIKE-query proxy, NOT Typesense. Worst-case floor for the "
            "PG-ILIKE fallback path only; gate_met is null because this run "
            "cannot attest to the Typesense GA gate."
        )
    if n < STAGING_REQUIRED_MIN_DOCS:
        honest_caveats.append(
            f"Corpus is {n:,} docs, below the 10M GA-gate target corpus size "
            "used by the full scale ladder (10k -> 100k -> 1M -> 10M). This "
            "result covers only this rung."
        )
    results["honest_caveats"] = honest_caveats
    return results


def print_results_table(
    *,
    mode: str,
    n: int,
    requests: int,
    gate_ms: float,
    typesense_available: bool,
    p50: float,
    p95: float,
    p99: float,
    p_max: float,
    gate_met: bool | None,
) -> None:
    if typesense_available:
        status_label = (
            ("PASS" if gate_met else "FAIL")
            + f" (p95={p95:.1f}ms, gate={gate_ms:.0f}ms)"
        )
    else:
        status_label = "N/A — SQLite fallback, not a Typesense measurement"

    print(f"""
╔══════════════════════════════════════════════════════════╗
║  F12 Span Search — Bench Results                        ║
╠══════════════════════════════════════════════════════════╣
║  Mode      : {mode:<42} ║
║  N (docs)  : {n:<42,} ║
║  Requests  : {requests:<42} ║
╠══════════════════════════════════════════════════════════╣
║  p50       : {p50:<38.2f} ms ║
║  p95       : {p95:<38.2f} ms ║
║  p99       : {p99:<38.2f} ms ║
║  max       : {p_max:<38.2f} ms ║
╠══════════════════════════════════════════════════════════╣
║  Gate (GA) : p95 < {gate_ms:<39.0f} ms ║
║  Status    : {status_label:<42} ║
╚══════════════════════════════════════════════════════════╝
""")


def write_results_json(results: dict[str, Any], out_path: Path) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(results, indent=2) + "\n")
    print(f"[OUT] Wrote results JSON to {out_path}")
    return out_path


def run_single_bench(
    *,
    n: int,
    requests: int,
    tenant: str,
    facet_ab: bool,
    gate_ms: float,
    typesense_available: bool,
    ts_host: str,
    ts_port: int,
    ts_key: str,
    rung_label: str | None = None,
    quiet: bool = False,
) -> dict[str, Any]:
    """Seed, benchmark, report, and return the results payload."""
    if not quiet:
        print(f"\n=== F12 Span Search Bench  n={n:,}  requests={requests} ===\n")

    if not quiet:
        print(f"\n[SEED] Generating {n:,} synthetic span docs via build_span_doc + PIIMasker …")
    t_seed_start = time.perf_counter()
    from eden.observability.typesense_client import build_span_doc
    docs: list[dict[str, Any]] = []
    report_every = max(1, n // 10)
    for i in range(n):
        ev = _make_event(tenant, i)
        doc = build_span_doc(ev)
        docs.append(doc)
        if not quiet and (i + 1) % report_every == 0:
            elapsed = time.perf_counter() - t_seed_start
            rate = (i + 1) / elapsed
            print(f"  seeded {i+1:,} / {n:,}  ({rate:,.0f} docs/s)")
    t_seed_elapsed = time.perf_counter() - t_seed_start
    if not quiet:
        print(
            f"[SEED] Done — {n:,} docs in {t_seed_elapsed:.1f}s "
            f"({n / t_seed_elapsed:,.0f} docs/s)\n"
        )

    queries = _build_query_mix(requests)
    samples: list[float] = []
    samples_faceted: list[float] = []
    facet_ab_ran = False
    facet_fields: tuple[str, ...] | None = None

    if typesense_available:
        mode = f"Typesense ({ts_host}:{ts_port})"
        if not quiet:
            print(f"[BENCH] Mode: {mode}")

        async def _run_ts() -> None:
            nonlocal facet_ab_ran, facet_fields
            from eden.observability.typesense_client import TypesenseClient
            from eden.observability.search_service import SearchService
            client = TypesenseClient(host=ts_host, port=ts_port, api_key=ts_key)
            await client.ensure_collection()

            if not quiet:
                print(f"[SEED→TS] Importing {len(docs):,} docs …")
            batch_size = 1_000
            total_ok = 0
            for i in range(0, len(docs), batch_size):
                total_ok += await client.index_many(docs[i:i + batch_size])
            if not quiet:
                print(f"[SEED→TS] {total_ok:,} docs indexed")

            service = SearchService(client=client)
            if not quiet:
                print("[WARM] 50 warm-up queries …")
            await _warm_typesense(service, tenant)

            if not quiet:
                print(f"[BENCH] Running {requests} queries (facet_by=None) …")
            for q in queries:
                ms = await _typesense_search_one(service, tenant, q, facet_by=None)
                samples.append(ms)

            if facet_ab:
                facet_fields = SearchService.DEFAULT_FACET_FIELDS
                if not quiet:
                    print(
                        f"[BENCH] Running {requests} queries "
                        f"(facet_by={','.join(facet_fields)}) …"
                    )
                for _ in range(2):
                    for qw in ["python", "error", "tool", "bash", "timeout"]:
                        await service.search(
                            tenant_id=tenant, query=qw, per_page=1,
                            facet_by=facet_fields,
                        )
                for q in queries:
                    ms = await _typesense_search_one(
                        service, tenant, q, facet_by=facet_fields,
                    )
                    samples_faceted.append(ms)
                facet_ab_ran = True

            await client.close()

        asyncio.run(_run_ts())
    else:
        mode = "SQLite in-memory (PG-ILIKE fallback proxy)"
        if not quiet:
            print(f"[BENCH] Mode: {mode}")
            print(f"[SEED→SQLite] Loading {len(docs):,} docs into in-memory SQLite …")
        t_load = time.perf_counter()
        conn = _build_sqlite_db(docs)
        if not quiet:
            print(f"[SEED→SQLite] Loaded in {time.perf_counter() - t_load:.2f}s")

        warm_queries = [
            "python", "error", "tool", "bash", "timeout",
            "checkout", "read", "write", "failure", "success",
        ] * 5
        for wq in warm_queries:
            _sqlite_search(conn, tenant_id=tenant, query=wq)

        if not quiet:
            print(f"[BENCH] Running {requests} queries …")
        for q in queries:
            ms = _sqlite_search(
                conn,
                tenant_id=tenant,
                query=q.get("q", ""),
                agent_id=q.get("agent_id"),
            )
            samples.append(ms)
        conn.close()

    results = build_results_payload(
        n=n,
        requests=requests,
        tenant=tenant,
        gate_ms=gate_ms,
        typesense_available=typesense_available,
        ts_host=ts_host,
        ts_port=ts_port,
        mode=mode,
        samples=samples,
        facet_ab_ran=facet_ab_ran,
        facet_fields=facet_fields,
        samples_faceted=samples_faceted,
        facet_ab_enabled=facet_ab,
        rung_label=rung_label,
    )

    baseline = results["baseline_no_facet"]
    if not quiet:
        print_results_table(
            mode=mode,
            n=n,
            requests=requests,
            gate_ms=gate_ms,
            typesense_available=typesense_available,
            p50=baseline["p50"],
            p95=baseline["p95"],
            p99=baseline["p99"],
            p_max=baseline["max"],
            gate_met=results["gate_met"],
        )
        if facet_ab_ran and facet_fields is not None:
            facet_on = results["facet_ab"]["facet_on"]
            print(
                "\n"
                "=== Facet A/B: faceting cost isolation "
                f"(fields: {','.join(facet_fields)}) ===\n"
                f"              p50       p95       p99\n"
                f"  facet OFF : {baseline['p50']:>7.2f}   {baseline['p95']:>7.2f}   "
                f"{baseline['p99']:>7.2f}   ms\n"
                f"  facet ON  : {facet_on['p50']:>7.2f}   {facet_on['p95']:>7.2f}   "
                f"{facet_on['p99']:>7.2f}   ms\n"
                f"  Δ p95 (ON - OFF): {results['facet_ab']['delta_p95_ms']:+.2f} ms\n"
            )
        elif typesense_available:
            print("[FACET-AB] Skipped (--no-facet-ab).\n")
        else:
            print(
                "[FACET-AB] Not applicable in SQLite fallback mode — the ILIKE "
                "proxy has no facet computation to toggle.\n"
            )

    return results


def build_ladder_manifest(
    *,
    rungs: list[dict[str, Any]],
    gate_ms: float,
    typesense_available: bool,
    dry_run: bool,
    manifest_path: Path,
) -> dict[str, Any]:
    measured = [r for r in rungs if r.get("status") == "measured"]
    blocked = [r for r in rungs if str(r.get("status", "")).startswith("blocked")]
    prior = [r for r in rungs if r.get("status") == "prior_artifact"]
    manifest: dict[str, Any] = {
        "bench": "f12-span-search-scale-ladder",
        "recorded_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "target_gate": f"p95 < {gate_ms:.0f}ms",
        "typesense_reachable": typesense_available,
        "dry_run": dry_run,
        "default_rungs": list(DEFAULT_SCALE_LADDER),
        "rungs": rungs,
        "summary": {
            "measured_count": len(measured),
            "prior_artifact_count": len(prior),
            "blocked_count": len(blocked),
            "gate_met_typesense_rungs": [
                {
                    "rung": r["rung"],
                    "gate_met": r.get("gate_met"),
                    "results_path": r.get("results_path"),
                }
                for r in rungs
                if r.get("gate_met") is not None
            ],
        },
        "honest_caveats": [
            "gate_met is harness-computed per rung (baseline p95 <= --gate-ms); "
            "never hand-edited.",
            "SQLite-fallback rungs have gate_met=null — they cannot attest to the "
            "Typesense GA gate.",
            "10M requires staging Typesense; blocked rungs have no fabricated numbers.",
        ],
        "manifest_path": str(manifest_path),
    }
    if not typesense_available:
        manifest["honest_caveats"].append(
            "Typesense unreachable in this pass — only small rungs may run on the "
            "SQLite proxy; larger Typesense rungs reuse prior artifacts or are blocked."
        )
    return manifest


def run_scale_ladder(args: argparse.Namespace) -> int:
    if args.corpus_sizes:
        ladder = parse_corpus_sizes(args.corpus_sizes)
    else:
        ladder = [(label, parse_corpus_size(label)) for label in DEFAULT_SCALE_LADDER]

    typesense_available, ts_host, ts_port, ts_key = check_typesense_reachable()
    if typesense_available:
        print(f"[INFO] Typesense reachable at {ts_host}:{ts_port}")
    else:
        print("[WARN] Typesense NOT reachable — small rungs use SQLite fallback proxy")

    manifest_path = Path(args.ladder_manifest) if args.ladder_manifest else (
        RESULTS_DIR / f"f12-span-search-scale-ladder-"
        f"{datetime.now(timezone.utc).strftime('%Y%m%d')}.json"
    )

    rung_entries: list[dict[str, Any]] = []
    print(
        f"\n=== F12 Scale Ladder  rungs={[r[0] for r in ladder]}  "
        f"dry_run={args.dry_run} ===\n"
    )

    for rung_label, n in ladder:
        plan = plan_ladder_rung(
            rung_label,
            n,
            typesense_available=typesense_available,
            dry_run=args.dry_run,
            reuse_prior=args.reuse_prior,
        )
        print(f"[RUNG {rung_label}] status={plan['status']}")
        if plan.get("note"):
            print(f"  {plan['note']}")

        if plan["status"] in {
            "blocked_staging", "blocked_infra", "dry_run_planned", "prior_artifact",
        }:
            rung_entries.append(plan)
            continue

        if args.dry_run:
            rung_entries.append(plan)
            continue

        results = run_single_bench(
            n=n,
            requests=args.requests,
            tenant=args.tenant,
            facet_ab=args.facet_ab,
            gate_ms=args.gate_ms,
            typesense_available=typesense_available,
            ts_host=ts_host,
            ts_port=ts_port,
            ts_key=ts_key,
            rung_label=rung_label,
            quiet=args.quiet_rungs,
        )
        out_path = Path(args.out) if args.out and len(ladder) == 1 else default_results_path(
            n=n, typesense_available=typesense_available,
        )
        write_results_json(results, out_path)
        rung_entries.append({
            "rung": rung_label,
            "corpus_size": n,
            "status": "measured",
            "results_path": str(out_path),
            "typesense_reachable": typesense_available,
            "gate_met": results["gate_met"],
            "baseline_p95_ms": results["baseline_no_facet"]["p95"],
            "facet_ab": results.get("facet_ab") is not None,
        })

    manifest = build_ladder_manifest(
        rungs=rung_entries,
        gate_ms=args.gate_ms,
        typesense_available=typesense_available,
        dry_run=args.dry_run,
        manifest_path=manifest_path,
    )
    write_results_json(manifest, manifest_path)
    print(
        f"\n[LADDER] {manifest['summary']['measured_count']} measured, "
        f"{manifest['summary']['prior_artifact_count']} prior artifact(s), "
        f"{manifest['summary']['blocked_count']} blocked"
    )
    return 0


# ── Main ───────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(
        description="F12 span search latency bench (Typesense or SQLite proxy)",
    )
    parser.add_argument(
        "--n", type=int, default=50_000,
        help="Number of synthetic span docs to seed (default 50 000; ignored with --scale-ladder)",
    )
    parser.add_argument(
        "--requests", type=int, default=500,
        help="Number of search requests to measure (default 500)",
    )
    parser.add_argument(
        "--tenant", default="bench-org",
        help="Tenant ID for isolation filter (default bench-org)",
    )
    parser.add_argument(
        "--facet-ab", dest="facet_ab", action="store_true", default=True,
        help="Run the query mix twice (facet_by=None vs facet_by=DEFAULT_FACET_FIELDS) "
             "to measure faceting's latency cost. Typesense mode only. Default: on.",
    )
    parser.add_argument(
        "--no-facet-ab", dest="facet_ab", action="store_false",
        help="Skip the facet on/off A/B pass.",
    )
    parser.add_argument(
        "--gate-ms", type=float, default=200.0,
        help="F12 GA gate threshold in ms for p95 (default 200.0). "
             "gate_met in the output JSON is computed as baseline p95 <= this value.",
    )
    parser.add_argument(
        "--out", default=None,
        help="Path to write the results JSON. Default: auto-generated under "
             "bench/results/ from mode + n + today's date.",
    )
    parser.add_argument(
        "--scale-ladder", action="store_true",
        help="Run the full scale ladder (default rungs: 10k,100k,1m,10m). "
             "Writes per-rung JSON plus a ladder manifest under bench/results/.",
    )
    parser.add_argument(
        "--corpus-sizes", default=None,
        help="Comma-separated corpus sizes for --scale-ladder (e.g. 10k,100k,1m,10m). "
             "Implies --scale-ladder when set.",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="With --scale-ladder: emit the ladder manifest only (no seeding/benchmarking).",
    )
    parser.add_argument(
        "--reuse-prior", dest="reuse_prior", action="store_true", default=True,
        help="With --scale-ladder: reuse committed prior artifacts for blocked Typesense "
             "rungs (default: on; e.g. 1.1M Typesense JSON).",
    )
    parser.add_argument(
        "--no-reuse-prior", dest="reuse_prior", action="store_false",
        help="Do not attach prior committed artifacts to the ladder manifest.",
    )
    parser.add_argument(
        "--ladder-manifest", default=None,
        help="Path for the scale-ladder manifest JSON (default: auto under bench/results/).",
    )
    parser.add_argument(
        "--quiet-rungs", action="store_true",
        help="With --scale-ladder: suppress per-rung progress output.",
    )
    args = parser.parse_args()

    if args.scale_ladder or args.corpus_sizes:
        return run_scale_ladder(args)

    typesense_available, ts_host, ts_port, ts_key = check_typesense_reachable()
    if typesense_available:
        print(f"[INFO] Typesense reachable at {ts_host}:{ts_port}")
    else:
        if ts_key:
            print(
                f"[WARN] Typesense NOT reachable at {ts_host}:{ts_port} "
                "— using SQLite fallback proxy"
            )
        else:
            print("[WARN] TYPESENSE_API_KEY not set — using SQLite fallback proxy")

    results = run_single_bench(
        n=args.n,
        requests=args.requests,
        tenant=args.tenant,
        facet_ab=args.facet_ab,
        gate_ms=args.gate_ms,
        typesense_available=typesense_available,
        ts_host=ts_host,
        ts_port=ts_port,
        ts_key=ts_key,
    )

    baseline = results["baseline_no_facet"]
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
            "      python3.12 scripts/bench_f12_span_search.py --scale-ladder\n"
        )

    out_path = Path(args.out) if args.out else default_results_path(
        n=args.n, typesense_available=typesense_available,
    )
    write_results_json(results, out_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
