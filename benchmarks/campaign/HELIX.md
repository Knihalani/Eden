# Helix campaign

New domains so compiling is not scored on a retune of desk / CRM / cart / github / graphql / k8s / saga / stripe-cursor / sentry / oauth / cms / zip / chunk / group.

| World | Shape | Goal | Why new |
|---|---|---|---|
| `createLaunchPad` | 12-step linear two-key | `{ site, env }` | Not tenant's 5-step seq. Order-of-magnitude turns when live. |
| `createGitlabOffset` | 1-based `page`/`limit` then foreach | `{ project }` | Not Stripe `nextCursor`. |
| `createRateLimitRetry` | 429×2 then ok | `{ tag }` | Not k8s same-args ready poll. Failed events are real. |
| `createFsTree` | nested `children` leaves | `{ tree }` | Not CMS one-level `sections.blocks`. |
| `createDedupeMail` | first-seen unique `addr` | `{ inbox }` | Not filter `level==error`, not prefix top-k. |
| `createPrioQueue` | sort by `prio` desc then drain | `{ queue }` | Not unsorted array order. |
| `createLedgerSettle` | foreach then `sum(amt)` | `{ batch }` | Not map-reduce merge of row objects. |
| `createBarcodeLots` | `{ barcode, lotCode }` foreach | `{ wave }` | Fields not on the old item-name allowlist. |
| `createHelixNoise` | unique-work | `{ id }` | 0 programs |

## Expect (pre-registered)

| Scenario | Expect |
|---|---|
| `short-launch` | **WIN on turns ≥10×** (program already live). goLive failure is FAIL. |
| `helix-unique` | **parity ±1%** (no LOSS). Unique work must not get more expensive. |
| `long-offset` / `long-retry` / `long-tree` / `long-unique` / `long-sort` / `long-reduce` / `long-barcode` | **WIN on turns**. goLive failure is FAIL, not skip-as-win. |

`--fast`: 13 witnesses, 3 live, `CAMPAIGN_THINK_MS=1`. Full: think 120ms, 6 live.
`--short`: already-live launch-pad plus unique-work parity. Writes `.gauntlet/captures/compile/bench-helix-short.txt`.

```bash
bun test benchmarks/campaign/helix.test.ts
bun run benchmarks/campaign/bench-helix.ts --short --fast
bun run bench:helix --short --fast
```

Unique-work must compile 0 programs. Offset pages are 1-based integers, not cursor tokens.

## Measured (`--short --fast`, 2026-08-31)

Simulator turns and cents are exact arithmetic. File: `.gauntlet/captures/compile/bench-helix-short.txt`.

| Scenario | Turns | Wall | Cents |
|---|---|---|---|
| short-launch (seqLen 12 live) | **12.00×** (12.0→1.0, p=0.0078 n=8) | **11.93×** (1465.3→122.8) | **12.00×** |
| helix-unique | 0.0% | +0.2% (within ±1%) | 0.0% parity |

CI: `bun test benchmarks/campaign/helix.test.ts` — launch / offset / barcode + retry / tree / unique / sort / reduce goLive PASS. Unique-work compiles 0 programs.
