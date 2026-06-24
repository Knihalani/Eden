# ClickHouse columnar engine SLOs

> **SLO targets for the Cat 18 columnar engine (migration 022 + ``src/eden/columnar/``).** Per upgradespec §F.5 / Phase 4 B2. Generated 2026-06-24 alongside ``tests/load/columnar_scale.k6.js`` (the authoritative live SLO gate) + ``tests/load/test_columnar_scale.py`` (the CI-fast local regression).

## SLO targets

| Operation | p50 | p95 | p99 | At scale | Source |
|---|---|---|---|---|---|
| Daily rollup query | 200 ms | **2000 ms** | 3500 ms | 10× data (10M rows) | §9.5 spec |
| Weekly rollup query | 500 ms | **5000 ms** | 8000 ms | 10× data (10M rows) | §9.5 spec |
| Hourly compact | 100 ms | **500 ms** | 1000 ms | normal load | §9.5 spec |
| Postgres fallback path | 300 ms | **1500 ms** | 3000 ms | 10× data (10M rows) | Cat 18 contract |

The **bold** column is the SLO gate; the k6 harness fails the build when p95 exceeds it. The p50 / p99 columns are informational (no auto-fail).

## How the SLOs are measured

### Live (authoritative)

The k6 harness in ``tests/load/columnar_scale.k6.js`` runs against a live ClickHouse cluster + 10M rows of synthetic ``telemetry_events``. It sustains 500 concurrent users for 5 minutes (the "10× scale" per the spec).

```bash
docker run --rm -i grafana/k6 run - <tests/load/columnar_scale.k6.js \
  -e BASE_URL=https://api--eden-staging-us-central.northflank.app \
  -e TOKEN=$EDEN_API_TOKEN \
  -e ORG_ID=$EDEN_ORG_ID
```

The harness asserts:

```js
thresholds: {
  "http_req_duration{expected_response:true}": ["p(95)<2000"],
  http_req_failed: ["rate<0.01"],
  rollup_latency_ms: ["p(95)<2000"],
  query_latency_ms: ["p(95)<5000"],
}
```

### Local (CI)

The pytest harness in ``tests/load/test_columnar_scale.py`` runs against the best-effort Postgres fallback (no live CH needed). It's 10× faster than the live harness but exercises the same code path.

```bash
pytest tests/load/test_columnar_scale.py -v
```

Local thresholds are **generous** (the live harness is authoritative):

| Local p95 SLO | Live p95 SLO |
|---|---|
| 200 ms (daily) | 2000 ms (daily) |
| 500 ms (weekly) | 5000 ms (weekly) |
| 100 ms (hourly) | 500 ms (hourly) |

## When to alert

The ``on_compaction_drift`` hook fires with severity `high` when the SLA is breached (see ``src/eden/llmops/promotion_hooks.py:886-910``). The hook reason is one of:

* `sla_breach` — compaction exceeded the 4h SLA
* `compaction_failed` — compaction cycle errored
* `ch_unavailable` — ClickHouse health check failed; the engine fell back to Postgres

The hook payload includes the actual duration + the SLA threshold so the on-call engineer can decide whether to scale the ClickHouse cluster or accept the fallback.

## When to scale

* **Daily rollup p95 > 1500 ms (75% of SLO)**: scale up ClickHouse CPU before the next rollup window.
* **Weekly rollup p95 > 4000 ms (80% of SLO)**: scale up ClickHouse memory; check partition count.
* **Postgres fallback rate > 5% sustained**: ClickHouse is unhealthy; page the on-call DBA per ``docs/runbooks/clickhouse-failover.md`` (Phase D2 — tracked).

## What we do NOT measure

* **Write throughput**: ingestion is covered by the ``tests/load/jobs.js`` harness (per Phase 0 §F.5).
* **Cross-region replication**: REMOVED 2026-06-24 per user (multi-region out of scope).
* **Schema migration time**: covered by ``tests/docs/test_migration_matrix.py`` (Phase B1).
* **Cold start (no cached partitions)**: out of scope for v1; the columnar engine warms partitions lazily.

## Reference

* **Spec**: ``upgradespec-v2.md`` §F.5 Phase 4 — Operational debt §9.5
* **Code**: ``src/eden/columnar/`` (``aggregations.py`` + ``compaction.py`` + ``query.py`` + ``partitions.py``)
* **Migration**: 022 (`src/eden/db_migrations/versions/022_columnar_engine.py`)
* **Hook**: ``on_compaction_drift`` in ``src/eden/llmops/promotion_hooks.py:886-910``
* **Live harness**: ``tests/load/columnar_scale.k6.js``
* **Local harness**: ``tests/load/test_columnar_scale.py``