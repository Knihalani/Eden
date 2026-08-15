# ClickHouse storage decisions for `telemetry_events_ch`

Every number here was measured against ClickHouse 24.3 (`24.3.18.7`), not
estimated. The measurement scripts are throwaway; the method is recorded below
so the numbers can be reproduced or refuted.

## Starting state

No `CODEC(...)` clause and no data-skipping index existed anywhere in the
repository. Every column used ClickHouse's default LZ4, and the only index was
the primary key `(tenant_id, timestamp)`.

`telemetry_events_ch` carried 31 columns. Of those, **26 were never read by any
Python code** and 16 were never read by anything at all including the Tinybird
pipe. Nine were unbounded payload blobs: `request_body`, `response_body`,
`reasoning`, `tool_calls_full`, `tool_results`, `images`, `audio`, `logprobs`,
`citations`.

## 1. Compression codecs

`CODEC(ZSTD(3))` on the String columns, `CODEC(Delta, ZSTD(3))` on the two
`DateTime64(3)` columns.

The gain is strongly data-dependent, so it is quoted as a range rather than a
single figure:

| payload shape | default LZ4 | ZSTD(3) | gain |
|---|---|---|---|
| prose-shaped (repetitive prompts/completions) | 11.19 MiB | 2.11 MiB | **5.29×** |
| high-entropy (`randomPrintableASCII`, worst case) | 532 MiB | 440 MiB | **1.21×** |

Real LLM traffic is natural-language prose and structured JSON, so the truth
sits nearer the top of that range — but the worst case is what to plan capacity
against. Anyone quoting a single number for this is guessing.

Method: two tables with identical DDL apart from the codec clauses, the same
`INSERT ... SELECT ... FROM numbers(N)` into each, `OPTIMIZE TABLE ... FINAL`,
then `sum(data_compressed_bytes)` from `system.columns`.

`Delta` before `ZSTD` on the timestamps exploits the fact that ingest
timestamps are near-monotonic; it is close to free and helps whenever a part
covers a narrow time range.

## 2. `bloom_filter` skip index on `trace_id`

The sort key is `(tenant_id, timestamp)`, but `telemetry_events_query_api.pipe`
filters on `trace_id` — so "show me this one trace" scanned the whole
partition.

Measured on 120,000 rows, point lookup `WHERE trace_id = '…'`:

| | rows read | bytes read |
|---|---|---|
| no index | 120,000 | 2.23 MiB |
| `bloom_filter(0.01) GRANULARITY 1` | 13,332 | 255 KiB |

**9.0× fewer rows.** The floor is the granule size — a bloom filter skips
granules, not rows, so a single matching row still costs one granule.

## 3. Dropping the nine unread payload blobs

This is the largest win and the only irreversible one.

| payload shape | blobs' share of the compressed table |
|---|---|
| prose-shaped | 58.5% |
| high-entropy | 97.7% |

Combined with the codecs, end-to-end on prose-shaped data: **14.05× smaller**
(11.19 MiB → 815 KiB for 200,000 rows).

### Why this is safe

- No `SELECT` anywhere in `src/` reads any of the nine from ClickHouse.
- `tinybird/pipes/telemetry_events_query_api.pipe` does not read them either.
- **Postgres remains the source of truth for payloads**, and already stores
  exactly these fields zstd-compressed (`request_body_zstd`,
  `response_body_zstd`, `tool_calls_full_zstd` — see `telemetry_collector`).

So this removes a second, *uncompressed* copy of data that already lives
compressed elsewhere. It does not remove the only copy. ClickHouse here is an
analytics mirror; analytics queries aggregate, they do not need the blobs.

### If a payload-serving query is ever wanted from ClickHouse

Do not simply re-add the columns. Either read from Postgres (which has them),
or add them back **with `CODEC(ZSTD(3))` and a considered TTL**, and note that
`images`/`audio` as raw `String` in a 90-day table is the single most expensive
thing this schema can do.

## 4. Not writing `metrics` / `tags` into the mirror (Phase 1, 2026-08)

Same finding as the nine blob columns above, smaller scope: no `SELECT`
anywhere in `src/` reads `metrics` or `tags` back from
`telemetry_events_ch`, and `telemetry_events_query_api.pipe` — the only
Tinybird pipe over this table — selects a fixed column list that omits
both. Postgres remains the real source of truth (`telemetry_collector`
still writes the full JSON there; other code reads `metrics->>'cost_usd'`
etc. straight from Postgres).

Unlike the blob columns, this does **not** `ALTER TABLE ... DROP COLUMN`.
Both columns stay in the DDL and the `.datasource` schema — only
`ClickHouseSink._insert_json` stops populating them
(`_UNREAD_TELEMETRY_MIRROR_FIELDS`), so every future row gets the column's
own default (empty string) instead of a second, unread copy of the JSON
blob. Chosen over a schema change because Tinybird's DDL is
`tb deploy`-owned; stopping the write is reversible (re-add the two keys
to the outgoing row) in a way an already-applied `DROP COLUMN` is not.

## Migration behaviour

Codecs, skip indexes and column drops are all `ALTER`-able in place, so
`_migrate_telemetry_storage()` upgrades an existing table **without losing a
row** — verified: 40 rows before, 40 after. Codec changes apply to newly
written parts; existing parts are recompressed by background merges. The
migration deliberately does *not* issue `OPTIMIZE FINAL`, which would rewrite
the entire table in one go.

This is in contrast to the rollup engine change
(`_migrate_rollup_engines()`), where `SummingMergeTree` → `AggregatingMergeTree`
cannot be `ALTER`ed and the table must be dropped — acceptable only because the
rows it held were numerically wrong.

## Insert compatibility

The collector still serialises the dropped keys. `_insert_json` sets
`input_format_skip_unknown_fields=1` so JSONEachRow ignores them instead of
failing the batch with `UNKNOWN_FIELD`. That also decouples the two schemas
going forward: the collector can add a field without the mirror needing to
learn about it first.

## Drift fixed (2026-08, Phase 1 of the observability overhaul)

The paragraph that used to live here described the `tinybird/datasources/*.datasource`
files as auto-generated from NDJSON samples that systematically widened every
type. That is fixed: `scripts/gen_tinybird_datasources.py` now derives all
five `.datasource` files from this module's DDL (the single source of
truth), and `tests/data_platform/test_tinybird_datasource_drift.py` is the
ratchet that keeps them from drifting apart again. Run
`python scripts/gen_tinybird_datasources.py --check` after touching any
`CREATE TABLE` above.

`toUUID()` was also removed from `query_agent_performance` and the other
`query_*` helpers — see `ClickHouseSink._uuid_column_eq`, which compares the
UUID column against a bare string literal instead (works on both
substrates; `tenant_id = toUUID('org_test')` fails outright on Tinybird for
any tenant id that isn't a syntactically valid UUID).

**CODEC is preserved, not stripped.** An earlier revision of the generator
dropped every `CODEC(...)` clause on the assumption that Tinybird
datasources don't accept it. That assumption was wrong and unverified —
Tinybird's own datafile reference documents `CODEC()` as a supported
`.datasource` SCHEMA field, in the same position ClickHouse DDL puts it
(https://www.tinybird.co/docs/forward/dev-reference/datafiles/datasource-files,
"Column compression codecs"). `telemetry_events_ch.datasource` now carries
the same `ZSTD(3)` / `Delta, ZSTD(3)` codecs as the DDL above; the other four
datasources have no codec in their DDL and correspondingly carry none.

## Home KPI hourly rollup (`home_kpi_hourly`, 2026-08)

`ClickHouseSink.query_home_kpis` (the Home tiles endpoint's data source) used
to re-aggregate `telemetry_events_ch` from scratch on every request —
`countIf`/`avgIf`/`quantileIf` over the raw per-event rows for the current
and previous window. `tinybird/datasources/home_kpi_hourly.datasource` adds a
Tinybird-native `AggregatingMergeTree` rollup, one row per
`(tenant_id, hour)`, fed by `tinybird/pipes/home_kpi_hourly_mv.pipe` (`TYPE
MATERIALIZED`, an insert trigger on `telemetry_events_ch` — it does **not**
backfill history, only rows ingested after deploy). `home_kpi_hourly_api.pipe`
exposes it directly (`countMerge`/`sumMerge`/`avgMerge`/`quantileMerge` over
the `AggregateFunction` state columns) for callers that want the endpoint
rather than going through `ClickHouseSink`.

**Not a self-hosted ClickHouse feature.** This lives entirely under
`tinybird/` and is owned by `tb deploy`, same as every other datasource/pipe
in this project — there is no local ClickHouse-side equivalent table or
migration for it.

**Fallback, not a replacement.** `query_home_kpis` tries the rollup first
only when `ClickHouseConfig.is_tinybird` is true, and falls back to the
original live `telemetry_events_ch` scan (now `_query_home_kpis_live`)
whenever the rollup query raises (datasource not deployed yet, or any other
error) or comes back with zero current-window events (the datasource exists
but genuinely has no materialized rows yet for that tenant/hour — a brand
new rollup starts empty and only fills in from the next inserted
`telemetry_events_ch` block onward). Either fallback path preserves the
existing behaviour exactly, including the outer
`wave6_online._home_kpi_from_clickhouse` → Postgres soft-fail contract this
was already built on.

**Rollback:** delete/skip `home_kpi_hourly_mv.pipe` and `query_home_kpis`
falls straight back to the always-correct live scan — nothing else changes.
