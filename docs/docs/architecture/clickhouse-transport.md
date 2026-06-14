---
title: ClickHouse transport
description: Why Eden talks to ClickHouse over raw aiohttp HTTP instead of clickhouse-connect, and when to revisit.
---

# ClickHouse transport — the aiohttp choice

## TL;DR

Eden talks to ClickHouse over the **HTTP interface (port 8123) using
raw `aiohttp`**, not the official `clickhouse-connect` driver and not
the native TCP protocol (port 9000). This is the decision we ship.

If you're adding a new ClickHouse-touching code path, use
`eden.data_platform.clickhouse_sink.ClickHouseSink` — it's the
canonical client, already pools per-process and surfaces the right
exceptions.

## Why aiohttp

Three reasons, in order of weight.

### 1. We were already using it

`ClickHouseSink` and the Cat 18 columnar engine
(`src/eden/columnar/`) were written against `aiohttp.ClientSession`
when ClickHouse first landed in the repo. Switching to
`clickhouse-connect` is a ~1.5 KLOC delta across the sink + columnar
partition manager + columnar aggregator + columnar compactor +
columnar query engine, plus the 200+ tests that mock `aiohttp` calls.
The cost is real and the benefit is small.

### 2. Lighter dependency surface

- `aiohttp` is already pulled in indirectly by other deps and is now
  declared explicitly (`pyproject.toml` `[project.dependencies]`).
- `clickhouse-connect` is **not** transitively required and would add
  ~2 MB to the wheel + a C-extension build path on slim images.
- We don't use any clickhouse-connect features today
  (no pandas/Arrow integration, no native protocol streaming, no
  insert-from-DataFrame). What we use is "POST a SELECT, parse TSV,
  POST a row batch" — three things `aiohttp` does fine.

### 3. Async-native, no thread-pool detour

`clickhouse-connect`'s async client (`aclient.AsyncClient`) is a thin
wrapper that dispatches to the synchronous client on a thread pool.
Our HTTP-level code is genuinely async (the sink lives on the
ingestion hot path), so an extra `asyncio.to_thread` hop per query
adds a small but real tail-latency cost.

## What we give up

Picking aiohttp isn't free. The trade-offs:

| Capability | Status | What to do if you need it |
|---|---|---|
| Native TCP protocol (port 9000) | Not wired | Add a second transport class, gate behind a setting |
| Insert-from-Arrow | Not wired | Write a one-off using `clickhouse-connect` in a sidecar |
| Server-side query streaming | Not wired | Currently we paginate via `LIMIT/OFFSET` |
| Auto-retry on `5xx` with backoff | Manual | The sink has a thin `tenacity` wrapper; extend if needed |
| Type-safe column readers | None — we parse TSV strings | Add a small typed-row helper if a hot path needs it |

None of these have surfaced as a real production gap. The columnar
read paths in Cat 18, 19, 20 all use simple `SELECT … FROM … WHERE …`
queries that round-trip in under 50 ms.

## When to revisit

Re-evaluate if **any** of these become true:

- We start streaming columnar reads of >100 MB at a time (Arrow over
  HTTP starts losing badly to the native protocol).
- We start writing >10k rows/sec sustained per pod (HTTP framing
  overhead becomes the bottleneck; native protocol amortises better).
- A first-class type-safe Python client lands in `clickhouse-connect`
  with native async + no thread-pool hop.
- We need server-side compression / `Format Native` reads.

If you hit one of these, the migration path is straight: add a
`NativeClickHouseSink` alongside the HTTP one, settings-flag the
choice, ship a feature flag, watch the metrics, flip the default.
Don't rip out aiohttp until the new transport has been the default
for a release cycle.

## Settings reference

Configured via `eden.config.Settings`:

| Setting | Env var | Default |
|---|---|---|
| `clickhouse_url` | `CLICKHOUSE_URL` | `http://localhost:8123` |
| `clickhouse_database` | `CLICKHOUSE_DATABASE` | `eden` |
| `clickhouse_user` | `CLICKHOUSE_USER` | `default` |
| `clickhouse_password` | `CLICKHOUSE_PASSWORD` | (empty) |
| `clickhouse_timeout` | `CLICKHOUSE_TIMEOUT` | `30` (seconds) |

The Docker Compose stack at `docker/docker-compose.yml` ships a
`clickhouse` service on `8123:8123` (HTTP) and `9000:9000` (native,
unused by Eden today). The default `CLICKHOUSE_URL` points at it.

## Related code

- `src/eden/data_platform/clickhouse_sink.py` — `ClickHouseSink`,
  `ClickHouseConfig`, the singleton `get_clickhouse_sink()`.
- `src/eden/columnar/partitions.py` — `ColumnarPartitionManager`.
- `src/eden/columnar/query_engine.py` — Cat 18 read-only SQL allowlist.
- `docker/docker-compose.yml` — service definition.
