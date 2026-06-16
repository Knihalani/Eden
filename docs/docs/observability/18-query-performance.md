---
title: "18 — Query Performance / Columnar Engine (v1.3)"
status: IMPLEMENTED v1
last_updated: 2026-06-11
version: 0.3
---

# 18 — Query Performance / Columnar Engine (v1.3)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-11).
> 4 service classes + 1 shared helper module in
> `src/eden/columnar/`, reading from the existing
> :class:`ClickHouseSink` substrate and falling back to
> Postgres on a degraded substrate. Closes the
> Braintrust-Brainstore gap. **Decision (2026-06-11):**
> shared multi-tenant ClickHouse with `org_id` as
> partition key — matches Brainstore's per-customer
> partition model and keeps cache locality high.

## Ship log

- [x] **Build green:** all 4 services importable from
  `eden.columnar` via lazy re-export
  (`ColumnarPartitionManager`, `ColumnarAggregator`,
  `ColumnarCompactor`, `ColumnarQueryEngine`).
- [x] **4 routes registered:**
  `POST /partitions/ensure`,
  `POST /rollups/precompute`, `POST /compact`,
  `POST /query`. All 4 return the live envelope
  (`status: "ok"`, `live: true`) on the happy path; the
  Postgres-fallback path adds
  `data_source: "postgres_fallback"` so the UI can
  render a "slower than usual" badge.
- [x] **Persistence to all 3 new tables:**
  `columnar_rollups` (delete-then-insert on
  `(org, source_table, granularity, window)`),
  `columnar_partitions` (composite-PK upsert on
  `(org, partition_id)`), `columnar_compaction_log`
  (append-only audit log).
- [x] **Per-org ClickHouse partitioning:** the partition
  name is `eden.<safe-org>.<YYYY_MM>` — alphanumerics +
  underscores + dots only, so a maliciously-crafted
  `org_id` cannot inject SQL.
- [x] **Rollup pre-compute:** ClickHouse happy path
  issues a single `INSERT ... SELECT` against the
  whitelisted source table
  (`telemetry_events|usage_events|judge_scores`); the
  Postgres fallback runs the same shape with
  `date_trunc(...)`. The aggregator is re-runnable
  (delete-then-insert on the unique window tuple).
- [x] **Compaction with 4h SLA:** the compactor issues
  `OPTIMIZE TABLE ... FINAL` on the named partition
  and records `rows_in / rows_out / bytes_in /
  bytes_out` + the duration in the audit log. A wall-
  clock time over `SLA_SECONDS = 4 * 60 * 60` fires
  the closed-loop hook with `reason="sla_breach"`,
  `severity="high"`.
- [x] **Read-only SQL allowlist:** the query engine
  rejects any non-`SELECT`/`WITH` leading keyword AND
  any of the disallowed DML keywords
  (`DROP | DELETE | INSERT | UPDATE | ALTER | TRUNCATE |
  CREATE | REPLACE | RENAME | GRANT | REVOKE | OPTIMIZE |
  KILL`). String literals are stripped first so a
  column name like `drop_count` doesn't false-positive.
- [x] **Missing-org-id filter rejected:** the query
  engine does NOT auto-inject `org_id` in v1.3 — the
  caller must include the filter explicitly. This
  prevents the worst-case "data leak across orgs"
  failure mode the failure-modes table calls out.
- [x] **ClickHouse health probe + 30s negative cache:**
  the probe caches a single failure per process for
  30s, so a request burst doesn't each pay a 1s
  timeout before falling back.
- [x] **Closed-loop hook fires on the 3 expected
  reasons:** `sla_breach` (compactor), `compaction_failed`
  (compactor on ClickHouse exception),
  `ch_unavailable` (query engine on the auto-fallback
  path).
- [x] **41 new tests pass:** 4 partition manager
  (invalid granularity, invalid source_table, fallback
  to Postgres, ClickHouse happy path) + 5 aggregator
  (invalid source_table, invalid granularity, inverted
  window, ClickHouse happy path, Postgres fallback) +
  4 compactor (empty partition_id, ClickHouse happy
  path, Postgres fallback, SLA breach fires hook) +
  8 query engine (invalid engine, empty query,
  read-only violation, missing org_id, ClickHouse
  happy path, ClickHouse failure with auto falls
  back, ClickHouse failure with explicit engine
  returns error, Postgres-only path) + 9 read-only
  SQL allowlist (SELECT, WITH, DROP, UPDATE, DELETE,
  INSERT, ALTER, empty, string-literal-with-keywords)
  + 3 package contract (lazy re-exports, `__dir__`,
  unknown attribute) + 2 hook (singleton registered,
  `on_compaction_drift` logs) + 5 route smoke
  (partitions, rollups, compact, query pg-only,
  query read-only violation) + 1 hook firing on
  ClickHouse failure. Total: 41 tests, ~1.1s.
- [x] **No regressions in adjacent suites:** full
  `tests/intelligence/` = 533 passed (1 pre-existing
  live-tail skip); `tests/unit/llmops/ +
  tests/unit/observability/` = 264/264 pass.
- [x] **Migration 022 added:** `022_columnar_engine.py`
  creates the 3 Cat 18 tables with the standard
  `idx_<name>_org (org_id, created_at DESC)` indexes
  plus the per-table secondary indexes
  (`columnar_rollups_lookup` for the dashboard's
  read pattern, `columnar_compaction_partition` for
  the SLA-breach detector). Downgrade drops the
  indexes + the tables.
- [x] **Master roadmap updated:** status matrix now
  shows Cat 1, 2, 3, 4, 5, 6, 8, 16, 18, 21 as
  IMPLEMENTED (10/22). Cat 18 is the third v1.3 cat
  to ship after Cat 21; the v1.3 surface now reads
  `Cat 18, 21 ✅ / Cat 19, 20 🟡`.

## Table of Contents

1. [Goal & motivation](#goal--motivation)
2. [Source articles & research](#source-articles--research)
3. [What's already in Eden](#whats-already-in-eden)
4. [Feature inventory](#feature-inventory)
5. [API contracts](#api-contracts)
6. [Data model](#data-model)
7. [Algorithm / pseudo-code](#algorithm--pseudo-code)
8. [Failure modes & guardrails](#failure-modes--guardrails)
9. [Telemetry](#telemetry)
10. [Test plan](#test-plan)
11. [Acceptance criteria](#acceptance-criteria)
12. [Open questions](#open-questions)
13. [Cross-references](#cross-references)

## Goal & motivation

Make the Eden dashboards (Cat 8 cost, Cat 13 drift,
Cat 14 autonomous reports, Cat 9 cohort analytics)
**fast on months of data**. Postgres is fine for the
hot tail; ClickHouse is fast for the analytical queries.
The Cat 8 cost dashboard currently takes 8-12 seconds
on a 90-day range; with Cat 18 it should take < 1s.

The user story:

> "I open the Cat 8 cost dashboard at 9am Monday. It
> should load in < 1 second. Right now it takes 8
> seconds and times out on Friday afternoons. That's
> the difference between 'I check my costs' and 'I
> forget to check my costs'."

## Source articles & research

* **Article 1 §18 (Columnar Analytics)**: "Braintrust
  Brainstore (custom Rust engine on object storage),
  ClickHouse ClickStack (open-source columnar),
  Hydrolix (managed ClickHouse-compatible), Datadog
  DDSQL (Postgres-compatible SQL)."
* **Braintrust Brainstore (2025)**: per-customer
  partitioned columnar engine; tanatomy-style rowstore
  + columnstore + inverted index. The Eden v1.3
  implementation uses ClickHouse instead of a custom
  engine (per the "what we don't build" transparency
  section).
* **ClickHouse ClickStack (2026)**: open-source columnar
  observability stack — OTel-native ingestion, single
  ClickHouse store, HyperDX UI. Eden v1.3 ships the
  ClickHouse store but not the HyperDX UI (the portal
  is the Eden portal).
* **Hydrolix (2026)**: managed ClickHouse-compatible
  with extreme compression for high-volume observability
  data. Considered for v3 if ClickHouse costs become
  prohibitive.
* **2026 Sematext scaling guide**: "Running OpenTelemetry
  at Scale: Architecture Patterns for 100s of Services"
  — the tier-1 / tier-2 collector architecture that
  Eden's gateway tier implements.

## What's already in Eden

* `src/eden/data_platform/clickhouse_sink.py` —
  `ClickHouseSink` (async HTTP, idempotent schema init,
  batch ingestion, Postgres fallback). The substrate.
* `src/eden/analytics/cohorts.py` — `_cohorts_clickhouse`
  read path with `_cohorts_postgres` fallback.
* `src/eden/analytics/funnels.py` — same dual-write
  pattern as `cohorts.py`.
* `src/eden/realtime/kafka_consumer.py` —
  `ClickHouseAnalyticsConsumer` (streams Kafka events
  into ClickHouse).
* `src/eden/db_migrations/versions/020_intelligence_gap_tables.py`
  — already migrated migration 020 tables into the
  schema; the 3 new v1.3 tables (columnar_rollups,
  columnar_partitions, columnar_compaction_log) are
  in migration 022.

## Feature inventory

| Service | File | Routes | Effort |
|---|---|---|---|
| `ColumnarPartitionManager.ensure_org_partition` | `src/eden/columnar/partitions.py` | 1 | M |
| `ColumnarAggregator.precompute_rollups` | `src/eden/columnar/aggregations.py` | 1 | L |
| `ColumnarCompactor.compact_segments` | `src/eden/columnar/compaction.py` | 1 | M |
| `ColumnarQueryEngine.execute` | `src/eden/columnar/query.py` | 1 | M |
| **v2 additions:** | | | |
| `ColumnarBench.run` (ClickBench-style harness) | `src/eden/columnar/bench.py` | 1 | M |
| `ColumnarTuner.optimize` (auto-tune ClickHouse settings) | `src/eden/columnar/tuner.py` | 1 | L |

**v1.3 surface:** 4 services, 4 routes. **v2 surface:**
6 services, 6 routes. v2 adds the bench + tuner.

## API contracts

### `POST /orgs/{org_id}/intelligence/columnar/partitions/ensure`

```json
body: { "granularity": "hour" }  // hour|day|week
→ {
    "data": {
      "org_id": "org_abc",
      "partition_id": "p_2026_06_11_h14",
      "clickhouse_partition": "eden.org_abc.2026_06",
      "rows_estimate": 124000,
      "bytes_estimate": 52428800
    }
  }
```

### `POST /orgs/{org_id}/intelligence/columnar/rollups/precompute`

```json
body: {
  "table": "telemetry_events",
  "granularity": "day",
  "window_start": "2026-05-01",
  "window_end": "2026-06-01"
}
→ {
    "data": {
      "rollup_id": "rollup_abc",
      "n_rows": 892341,
      "duration_seconds": 4.2,
      "compressed_size_bytes": 12582912
    }
  }
```

### `POST /orgs/{org_id}/intelligence/columnar/compact`

```json
body: { "partition_id": "p_2026_05_h_00_to_23" }
→ {
    "data": {
      "compaction_id": "compact_abc",
      "rows_in": 124000,
      "rows_out": 2480,  // 50x compression
      "duration_seconds": 12.3,
      "size_in_bytes": 524288000,
      "size_out_bytes": 10485760
    }
  }
```

### `POST /orgs/{org_id}/intelligence/columnar/query`

```json
body: {
  "query": "SELECT span_attributes.model, count() AS n FROM telemetry_events WHERE org_id = 'org_abc' AND created > now() - INTERVAL 90 DAY GROUP BY span_attributes.model",
  "engine": "clickhouse"  // clickhouse|postgres|auto
}
→ {
    "data": {
      "rows": [
        { "model": "claude-sonnet-4", "n": 452000 },
        { "model": "gpt-4o", "n": 312000 },
        { "model": "claude-haiku-4", "n": 89000 }
      ],
      "engine_used": "clickhouse",
      "duration_ms": 87,
      "data_source": "clickhouse"
    }
  }
```

## Data model

```sql
-- 1. Columnar rollups (the pre-computed aggregates)
CREATE TABLE columnar_rollups (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    source_table        VARCHAR(64) NOT NULL,  -- telemetry_events|usage_events|judge_scores
    granularity         VARCHAR(16) NOT NULL,  -- hour|day|week
    window_start        TIMESTAMPTZ NOT NULL,
    window_end          TIMESTAMPTZ NOT NULL,
    payload_json        TEXT NOT NULL,  -- {col: aggregated_value, ...}
    n_rows              BIGINT NOT NULL,
    compressed_bytes    BIGINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_columnar_rollups
    ON columnar_rollups (org_id, source_table, granularity, window_end DESC);

-- 2. Columnar partition metadata
CREATE TABLE columnar_partitions (
    org_id                  VARCHAR(128) NOT NULL,
    partition_id            VARCHAR(128) NOT NULL,
    clickhouse_partition    VARCHAR(256) NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_compaction_at      TIMESTAMPTZ,
    last_compaction_dur_ms  INT,
    rows_total              BIGINT NOT NULL DEFAULT 0,
    bytes_total             BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, partition_id)
);

-- 3. Columnar compaction log
CREATE TABLE columnar_compaction_log (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    partition_id        VARCHAR(128) NOT NULL,
    started_at          TIMESTAMPTZ NOT NULL,
    completed_at        TIMESTAMPTZ NOT NULL,
    rows_in             BIGINT NOT NULL,
    rows_out            BIGINT NOT NULL,
    bytes_in            BIGINT NOT NULL,
    bytes_out           BIGINT NOT NULL,
    status              VARCHAR(16) NOT NULL,  -- ok|failed
    error               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_columnar_compaction
    ON columnar_compaction_log (org_id, partition_id, completed_at DESC);
```

## Algorithm / pseudo-code

### `ColumnarPartitionManager.ensure_org_partition`

```python
async def ensure_org_partition(org_id, granularity="hour"):
    # Per Brainstore's per-customer partitioning: each
    # org gets its own ClickHouse partition
    partition_name = f"eden.{org_id}.{now().strftime('%Y_%m')}"
    # 1. Create the partition (idempotent)
    await ch.execute(f"""
        ALTER TABLE telemetry_events
        ADD PARTITION IF NOT EXISTS {partition_name}
    """)
    # 2. Record the metadata
    await db.upsert_columnar_partition(
        org_id=org_id,
        partition_id=partition_name,
        clickhouse_partition=partition_name,
        rows_total=0, bytes_total=0,
    )
    return {"partition_id": partition_name, "clickhouse_partition": partition_name}
```

### `ColumnarAggregator.precompute_rollups`

```python
async def precompute_rollups(org_id, table, granularity, window_start, window_end):
    # 1. Choose the aggregation function based on
    #    granularity (per ClickHouse best practice)
    if granularity == "hour":
        trunc = "toStartOfHour(created)"
    elif granularity == "day":
        trunc = "toDate(created)"
    elif granularity == "week":
        trunc = "toMonday(created)"
    # 2. Run the aggregation
    rollup_sql = f"""
        INSERT INTO eden.columnar_rollups
        SELECT
            '{org_id}', '{table}', '{granularity}',
            {trunc}, {trunc} + INTERVAL 1 {granularity[0]},
            groupArray((col, value)) AS payload,
            count() AS n_rows
        FROM eden.{table}
        WHERE org_id = '{org_id}'
          AND created BETWEEN '{window_start}' AND '{window_end}'
        GROUP BY {trunc}
    """
    n_rows = await ch.execute(rollup_sql)
    return {"n_rows": n_rows, "duration_seconds": ...}
```

### `ColumnarCompactor.compact_segments` (with SLA tracking)

```python
async def compact(org_id, partition_id):
    # Per 2026 OTel tail-sampling sizing (Sematext):
    # compaction is best-effort, 4h SLA
    started_at = now()
    rows_in = await ch.execute(f"SELECT count() FROM eden.{partition_id}")
    bytes_in = await ch.execute(f"SELECT sum(bytes) FROM system.parts WHERE table = '{partition_id}'")
    try:
        await ch.execute(f"OPTIMIZE TABLE {partition_id} FINAL")
        status = "ok"
        error = None
    except Exception as e:
        status = "failed"
        error = str(e)
    completed_at = now()
    rows_out = await ch.execute(f"SELECT count() FROM eden.{partition_id}")
    bytes_out = await ch.execute(f"SELECT sum(bytes) FROM system.parts WHERE table = '{partition_id}'")
    duration_ms = (completed_at - started_at).total_seconds() * 1000
    await db.insert_columnar_compaction(
        org_id, partition_id, started_at, completed_at,
        rows_in, rows_out, bytes_in, bytes_out, status, error,
    )
    # Update the partition metadata
    await db.update_columnar_partition(
        org_id, partition_id,
        last_compaction_at=completed_at,
        last_compaction_dur_ms=duration_ms,
    )
    # Fire the closed-loop hook if SLA breached
    if (now() - started_at).total_seconds() > 4 * 3600:
        await ColumnarHook.on_compaction_drift(org_id, partition_id, "sla_breach")
    return {"rows_in": rows_in, "rows_out": rows_out, "duration_seconds": duration_ms / 1000}
```

### `ColumnarQueryEngine.execute` (with Postgres fallback)

```python
async def execute(org_id, query, engine="auto"):
    if engine in ("clickhouse", "auto") and ch_available():
        try:
            t0 = time.monotonic()
            rows = await ch.execute(query)
            return {
                "rows": rows, "engine_used": "clickhouse",
                "duration_ms": (time.monotonic() - t0) * 1000,
                "data_source": "clickhouse",
            }
        except (ChTimeout, ChUnavailable) as e:
            logger.warning(f"ClickHouse failed, falling back: {e}")
            ColumnarHook.on_compaction_drift(org_id, None, reason="ch_unavailable")
    # Postgres fallback
    rows = await pg.execute(query, timeout=5000)
    return {"rows": rows, "engine_used": "postgres", "duration_ms": ..., "data_source": "postgres_fallback"}
```

## Failure modes & guardrails

| Mode | Mitigation |
|---|---|
| ClickHouse SPOF (catastrophic) | Postgres-fallback path returns `data_source: "postgres_fallback"`; the UI shows a "slower than usual" badge; `ColumnarHook.on_compaction_drift` fires the alert |
| Slow rollup query | `timeout_ms` cap (default 30s for rollup pre-compute); kill via `KILL QUERY` if exceeded |
| Partition drift (per-org row count diverges from `telemetry_events` row count) | Per-org partition rows in `columnar_partitions`; reconciliation worker compares row counts and alerts on >5% drift |
| Compaction lag (best-effort, 4h SLA) | `ColumnarHook.on_compaction_drift` fires after 4h; v0 default is best-effort |
| Cost blowout (compaction runs 24/7) | Per-org TenantBudget; rollup cycle aborts when `usage_events.cost_usd` exceeds budget |
| Data leak across orgs | `org_id` is always in WHERE clause; `ColumnarQueryEngine` re-injects it if the query omits it (and the linter warns) |
| ClickHouse upgrade breaks rollups | v0 ships a "pause rollups" admin route; admin can disable new rollup cycles during a CH upgrade window |

## Telemetry

* `columnar_partition_ensured` (counter, tagged by `granularity`)
* `columnar_rollup_computed` (counter, tagged by `source_table`, `granularity`)
* `columnar_compaction_completed` (counter, tagged by `status`)
* `columnar_query_executed` (counter, tagged by `engine`)
* `columnar_query_fallback` (counter, tagged by `reason`)
* `columnar_compaction_sla_breach` (counter)

## Test plan

* Partition ensure: idempotent; org_id is always
  present in the partition name
* Rollup pre-compute: matches a hand-rolled SQL on a
  100k-row fixture within 1%
* Compaction: 50x compression on a synthetic 100k-row
  fixture
* Query execute: clickhouse happy path; postgres
  fallback; clickhouse timeout
* SLA breach fires the closed-loop hook (verified via
  mock)
* RLS: cross-tenant query returns no rows
* End-to-end: a 90-day cost dashboard query returns
  < 1s on a 1M-row fixture

Target: **~20 tests, ~0.8s.**

## Acceptance criteria

- [ ] All 4 v1.3 services + 2 v2 services implemented
- [ ] Partition ensure is idempotent
- [ ] Rollup matches hand-rolled SQL within 1%
- [ ] Compaction 50x compression
- [ ] Query execute works on all 3 paths
- [ ] SLA breach fires the hook
- [ ] 90-day cost dashboard < 1s on 1M-row fixture
- [ ] All 20 tests pass
- [ ] RLS verified

## Open questions

* **ClickHouse vs Hydrolix** — at very high volumes
  (10B+ rows/mo), ClickHouse costs become prohibitive.
  **Recommendation: ClickHouse in v1.3; revisit Hydrolix
  in v3 if cost becomes a customer complaint.**
  (Owner: Cat 18 lead)
* **Per-org ClickHouse tenant vs shared multi-tenant** —
  per the decision (2026-06-11), shared multi-tenant with
  `org_id` as partition key. **Document the tradeoff
  in `docs/decisions/0007-columnar-tenanting.md` for
  future reference.** (Owner: Cat 18 lead)
* **Compaction SLA** — 4h is the default. **Per-org
  configurable in `organizations.features`.** (Owner:
  Cat 18 lead)
* **Rollup auto-scheduler** — currently cron-driven
  hourly. **v2.1 ships adaptive scheduling: rollups
  are computed when the rollup data is queried
  (lazy, JSDR-style).** (Owner: Cat 18 lead)

## Cross-references

* Master doc: [`eden-observability-gap-roadmap.md`](../eden-observability-gap-roadmap.md) § Cat 18
* ClickHouse sink: [`src/eden/data_platform/clickhouse_sink.py`](../../src/eden/data_platform/clickhouse_sink.py)
* Cohorts (uses ClickHouse today):
  [`src/eden/analytics/cohorts.py`](../../src/eden/analytics/cohorts.py)
* Funnels (uses ClickHouse today):
  [`src/eden/analytics/funnels.py`](../../src/eden/analytics/funnels.py)
* Cat 8 (Cost — the headline beneficiary of Cat 18):
  [`08-cost-intelligence.md`](./08-cost-intelligence.md)
* Cat 9 (User cohort analytics):
  [`09-user-intelligence.md`](./09-user-intelligence.md)
* Cat 13 (Drift detection on large windows):
  [`13-predictive-intelligence.md`](./13-predictive-intelligence.md)
* Cat 17 (closed-loop — `ColumnarHook.on_compaction_drift`):
  [`17-closed-loop-wiring.md`](./17-closed-loop-wiring.md)
* Research: Braintrust Brainstore (per-customer
  partitioning); ClickHouse ClickStack (open-source
  columnar observability); Sematext 2026 OTel scaling
  guide
