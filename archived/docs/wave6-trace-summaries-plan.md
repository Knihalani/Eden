# Wave 6 — Materialized `trace_summaries` read path (10x on the traces hub)

**Status:** implemented, benchmarked, verified (2026-08-10)
**Measured win:** **~284x** page latency (91.2 ms → 320 µs), **~13.5x** count latency (39.2 ms → 2.9 ms) at 20k traces × 6 spans
**Feature flag:** `trace_summaries_read_v1` (default **off** — zero behavior change until ops enables it)

---

## 1. The gap (measured, not assumed)

`GET /orgs/{org}/observability/traces` is the most-hit read path in the product — the portal's
"Traces" hub renders it on every page load, filter change, and pagination. Before this wave it:

1. ran a **GROUP BY over the entire `telemetry_events` table** per page (a 48-column hypertable),
2. executed **two correlated subqueries per returned row** (DISTINCT tags + `agent_session_id` extraction),
3. ran a **second full-window scan** for the distinct-trace COUNT on full pages.

Meanwhile the `trace.finalized` pipeline already computed **near-identical per-trace aggregates**
(`SessionRollupIndexer._TURNS_SQL`) at finalize time and then **discarded them** — only the session
total was stored. The exact aggregates the read path recomputes on every keystroke were being thrown
away one time per trace.

```
live page:  91.2 ms    live count:  39.2 ms     (20k traces, GROUP BY + correlated subqueries)
mat  page: 320 µs      mat  count:   2.9 ms     (one indexed row per trace)
page speedup:  284.6x     count speedup:  13.5x
```

This is a **cost + UX** win: the traces hub stops paying for a full-scan aggregation per request,
so page loads go sub-millisecond and Postgres CPU drops proportionally.

## 2. The design

Three write points + one read point, all idempotent by construction:

### 2a. Migration 167 — `trace_summaries` table

Mirrors the proven `session_summaries` pattern (migration 142): PK `(org_id, trace_id)`, list index
`(org_id, started_at DESC)`, filter index `(org_id, agent_id, started_at DESC)`. Columns are the
byte-for-byte `list_traces` aggregate shape: `started_at`, `realm`, `agent_id`, `model`, `provider`,
`session_id`, `outcome`, `error_type`, `attr_error`, `agent_session_id`, `input_tokens`,
`output_tokens`, `cost_usd`, `span_count`, `duration_ms`, `tags text[]`.

### 2b. Ingest-time placeholder rows (`upsert_trace_placeholders`)

Every batch ingest writes one aggregate-free placeholder row per **new** trace
(`ON CONFLICT DO NOTHING`) so in-flight traces appear in the list immediately. Idempotent: an SDK
retry of a partially-landed batch cannot double-count anything. Best-effort — a missing table or a
Postgres blip never fails ingest (logged at debug, returns 0).

### 2c. `TraceSummaryIndexer` at `trace.finalized`

Runs after the session rollup in `trace_finalized_consumer`. **Recompute-then-upsert**: derives the
row from `telemetry_events` using the exact `list_traces` expressions (they can never drift, because
they are the same SQL), then upserts it. Idempotent by construction — a re-delivered
`trace.finalized` derives the identical row. A trace with no events left (TTL'd/compressed away) is
skipped; the placeholder stays as the last-known summary.

### 2d. Read path (`list_traces`)

When `trace_summaries_read_v1` is on and the table exists, the page + count come from
`trace_summaries` (PK/`(org_id, started_at DESC)` index). **Self-healing fallback**: any error, a
missing table, or a disabled flag falls back to the untouched legacy GROUP BY query (preserved
inline, so the source-inspection tests in `test_w6_backend_query_opt.py` and
`test_list_traces_batch_ids.py` keep passing). Filter semantics note: `outcome`/`agent_id` now
filter on the trace-level value the list *displays* (the max-aggregated value), which is what users
expect a filter to mean; the legacy path matched any-event-with-value.

### 2e. Backfill (`scripts/backfill_trace_summaries.py`)

One-shot + incremental backfill of existing traces into the table (single parameterized query,
`--days` window, `--dry-run`). Idempotent upsert, safe to re-run.

## 3. Why this is a 10x, not a micro-opt

- **Read amplification:** a page of 50 traces costs ~200 correlated-subquery executions + 2 full-window
  scans before; now it is 1 indexed scan of 50 rows.
- **Write amortization:** the indexer does per-trace work *once* at finalize — the same work the read
  path used to redo *per page view*.
- **Scales with retention:** the legacy path degrades as `telemetry_events` grows (TTL 90d of spans);
  `trace_summaries` stays one row per trace forever.
- **Unlocks the next innovation:** with per-trace rows available, the dashboard summary / heatmap /
  cost-per-trace endpoints can migrate off full-scan aggregations in later waves.

## 4. Files

| File | Change |
|---|---|
| `src/eden/db_migrations/versions/167_trace_summaries.py` | new — table + indexes (+ RLS policy) |
| `src/eden/observability/trace_summary.py` | new — `TraceSummaryIndexer`, `upsert_trace_placeholders`, SQL |
| `src/eden/workers/trace_finalized_consumer.py` | wire indexer after session rollup |
| `src/eden/observability/telemetry_collector.py` | ingest-time placeholder write (flag-gated, best-effort) |
| `src/eden/api/routes/observability.py` | `list_traces` materialized fast path + legacy fallback |
| `src/eden/config.py` | `trace_summaries_read_v1` flag (default off) |
| `scripts/backfill_trace_summaries.py` | new — backfill tool |
| `tests/unit/observability/test_trace_summaries.py` | new — 8 live-PG tests (indexer idempotency, placeholder→full, read-shape parity, ordering) |
| `bench/trace_summaries.py` | new — the proof benchmark (20k traces) |
| `bench/trace_summaries_fallback.py` | new — anti-join fallback cost measurement (drove the placeholder design) |

## 5. Verification

- **8/8** live-PG tests pass (`test_trace_summaries.py`): aggregate materialization matches legacy,
  idempotent re-index, `agent_session_id` tag extraction, placeholder→full-row handoff, read-shape
  parity, `ORDER BY started_at DESC`.
- **2204** tests pass across `sessions/`, `workers/`, `api/`, `observability/`.
- ruff clean, mypy clean (0 new errors).
- Benchmark: page 91.2 ms → 320 µs (**284.6x**), count 39.2 ms → 2.9 ms (**13.5x**).

## 6. Bugs found & fixed along the way

| Bug | Fix |
|---|---|
| `_UPSERT_SQL` had a stray closing paren after `updated_at = NOW()` → every index upsert was a syntax error | removed the stray `)` (all 5 statements now prepare cleanly) |
| My first refactor split the legacy query into a helper, breaking the 503-on-query-failure contract (`fetchval` re-raised outside the try) and two source-inspection tests | legacy query restored inline; materialized path is a pure early branch |
| **F70 regression (pre-existing from earlier waves):** `optimization.py`'s Redis-hget log site was removed by FEAT-171, but the *live* overview-fallback log still logged `exc` unredacted — a PII leak exactly what F70 exists to prevent, and the F70 test was left pinning a dead code path (2 failing tests) | added `redact_all(str(exc))` to the fallback log; re-pointed the F70 source test at the live site |

## 7. Rollout

1. Run migration 167 (additive; safe on live traffic).
2. Run `scripts/backfill_trace_summaries.py --days N` for history.
3. Enable `trace_summaries_read_v1` in config.
4. Watch the traces hub: sub-ms pages, PG CPU drop. The flag can be flipped off instantly; the
   fallback is the pre-existing query, verified by 2204 tests.
