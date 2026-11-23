# Local-mode perf (A10): RSS floor, latency, races

Measured on `eden-local` (`EDEN_LOCAL=1`, Bun 1.4.4, linux-x64, this repo's `scripts/local-perf.ts`).
Every number below comes from one command: `bun scripts/local-perf.ts` — it spawns the daemon, pushes
3,000 items, times the hot routes, runs a mixed-load stress, then restarts against the same `EDEN_HOME`.

## RSS floor

| State | RSS | Note |
| --- | --- | --- |
| Startup to `EDEN_LOCAL_READY` | — | ~100-155 ms wall (≈100 ms is Bun runtime + module load; the engine's own startup log line reports 20-43 ms) |
| Idle, no items | ~69-70 MB | Almost entirely the Bun runtime + server plumbing, not per-item state |
| 3,000 items pushed | ~74-76 MB | **+5-6 MB ≈ 1.7-2.2 KB/item** at ~200-char texts (item + BM25F index + graph row) |
| Restart against same `EDEN_HOME` | ~57-58 MB | Persisted users rehydrate lazily (D991); a restart does not re-read sources |

This reconciles with DEPLOY.md's "2-3.4 MB of RAM per user at the 3,000-item cap" — the earlier
~125 MB / ~20 KB-per-item estimate does not reproduce: the floor is the runtime, per-item JS overhead
is ~2 KB. No leak observed across a restart cycle.

## Latency (3,000 items loaded)

| Route | p50 | p95 |
| --- | --- | --- |
| `POST /v1/events` (observe + turn gate) | 0.6-0.8 ms | 1.7-4.6 ms |
| `POST /v1/ask` | 0.4-0.6 ms | 0.6-2.9 ms |

Sub-millisecond medians at the 3,000-item cap; nothing super-linear to fix.

## Multi-tenant machinery on the local path (stripped)

Local mode already skips the router/cluster/edge spec (`spec = local ? null : …`), engine config
(`local ? {} : engineConfig()`), the gate pool (`gateWorkers: 0`), and the paid-endpoint spend guard
(loopback, D2109). What remained:

- **Per-tenant GCRA on the request path — removed.** Under a 2 s mixed load (concurrent
  `/v1/sources/items` + `/v1/ask` + `/v1/events` + `/v1/sources`), the local daemon answered **43,312 × 429**
  before the change — the limiter existed so no tenant starves another, which is meaningless with exactly
  one tenant on one loopback socket. `tenantRatePerSec: 0` now means "no limiter" (`http.ts`), and
  `localConfig` sets it. Same load after: **0 non-200 responses**.
- Per-tenant usage counters and the `tenantSpendFor` budget tracker are O(1) maps over a single key —
  no measurable cost, left in place.

## Races / flakes

- Mixed push/read/ask/sources under load: no 5xx, no hangs (see above).
- Named flakes (`pushCutBehind`, `migrateLayout`, source-calls dedup): `bun test
  packages/engine/src/push-cut-behind.test.ts packages/engine/src/source-yield-partner.test.ts
  packages/engine/src/default.test.ts packages/graph/src/source-map-migrate.test.ts` — 40 tests,
  0 failures across 3 consecutive runs. Not reproduced in this environment; nothing to root-cause here.
- Share attach/replace vs respawn and freeze/thaw mid-request are covered by the engine's existing
  freeze/persist tests; no new failure surfaced under the stress loop.
