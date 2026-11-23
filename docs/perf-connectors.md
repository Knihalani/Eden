# Connector interactions — measured (A5)

Connector-call economics, latency bounds and recall on the days sim. Every number has its
command; "machinery" names the code path that already does what the checklist asks.

## Numbers

Simulated world: 8 users × 28 days, seeds 41–48, days-calls workload (sleep/wake requests +
background sync). All Eden counters, deterministic.

### Calls per lookup and per user-day

| push mode | request-time calls/lookup | background calls/user-day | steady calls/request | unpolled items | owed-arrived |
|---|---|---|---|---|---|
| `none` (floor poll) | 0.850 | 12.97 | 1.656 | 287 | gmail 184/371 |
| `signals`→notify payload 5% | 1.006 | 12.94 | 1.810 | 1 | gmail 371/371 |

Command:

```
bun packages/sim/src/days-calls.ts --users 8 --days 28 --seeds 41-48 --push none
bun packages/sim/src/days-calls.ts --users 8 --days 28 --seeds 41-48 --notify-share 0.05
```

Read: ~13 connector calls/user-day background ≈ 390/user-month — under the ~800/heavy-user-month
floor-poll estimate, because quiet sources' floor polls back off and notifying sources are never
floor-polled. Request-time cost is ~0.9–1.0 calls/lookup. The notify-vs-poll delta is recall, not
calls: push payloads all but eliminated the unpolled gap (287→1) and doubled owed arrival
(184→371/371) at ~9% more calls — prefer notify-driven sync wherever offered.

### Tail latency and partial failure

Stub connectors through `SourceFanout` (4 at 1–3 ms, 1 at 200 ms, 1 throwing), 60 lookups,
`timeoutMs: 60`:

```
p50=3.1ms p95=60.4ms max=60.6ms items/lookup=8 statuses={"ok":4,"open":2}
```

Command: `bun scripts/fanout-perf.ts` (six stubs, 60 iterations).

Read: one slow connector cannot stall a lookup — p95 equals the deadline, and the thrower's
breaker opens after its first failure ("open" = refused without a call). One dead connector loses
only its own items; the other four sources' 8 items land.

## Machinery that answers the checklist

- **Dedupe in-flight / across turns** — `Singleflight` (one flight per user+source+key; waiters join)
  and `S3FifoCache` result pages (fresh `freshMs` 60 s, stale-serve `staleMs` 600 s) in `guarded.ts`.
  A lookup with no time left still answers from what is held (D140).
- **Notify over poll** — `Source.notifies` → `syncPush`; a notifying source is not floor-polled.
  Push payloads carried at `/v1/sources/items` mean a notice delivers items, not just a signal.
- **Stop polling dead sources** — floor polls thin out by learned change rate
  (`staleChance`/`syncMaxStaleMs`, sync.ts ~line 1280: `1 - exp(-rate·age/HOUR)`); quiet sources
  approach the max-stale bound, and `active-poll` backoff covers liveness (D1131).
- **Batch** — `list` pages with `MAX_PUSHED_ITEMS` batching on push; the planner sizes a poll's
  first page to twice the changes the learned rate expects.
- **Parallel under deadline** — `SourceFanout.search` = `Promise.all` over sources with a shared
  abort; `planner` stops early when `deadlineMargin × callMs` says another call cannot land.
- **Early-exit / probes** — `probes` + `ProbeEconomy` widen recall on thin first passes with
  probe memos; consequence probes (`consequence.ts`).
- **Retry/backoff** — `RETRY_AFTER_MS` per failed connect; `429`/`rate limited` replies push the
  (user, source) back by the server's `Retry-After`.
- **Partial failure** — fanout never throws; per-source outcomes are `ok`/`open`/guards, and a
  dead source only forfeits its own items.
- **Timeout + breaker + degraded delivery** — per-(user, source) circuit breaker, rolling
  latency histogram, `untilAborted` timeouts, and the stale-serve cache when a connector is down.
- **Items/refs in the notice** — `/v1/sources/items` accepts pushed items directly (no re-read);
  `sourceChanged` falls back to refs/listing only when the push was incomplete.

## What a lookup still costs

At the measured ~1 call/lookup the dominant residual is request-time re-listing of fast-moving
sources (gmail: 0.44–0.49 calls/lookup) — by design: the staleness model polls a source when its
learned change rate makes its copy probably stale, and gmail genuinely changes fast. Cutting it
further would trade freshness for calls.
