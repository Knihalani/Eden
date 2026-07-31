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

## Known remaining drift

The `tinybird/datasources/*.datasource` files were auto-generated from NDJSON
samples and systematically widen every type: all 17 `LowCardinality(String)`
columns became plain `String`, all six `DateTime64(3)` became `DateTime`
(**truncating to whole seconds, which breaks span ordering within a trace**),
all nine `UUID` became `String`, all seven `Float64` became `Float32`
(including three currency columns), every unsigned integer became signed, and
the `date` DEFAULT column is missing from all four datasources that define it.

`toUUID()` in `query_agent_performance` is therefore valid against local
ClickHouse and invalid against Tinybird. Not yet addressed.
