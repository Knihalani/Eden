# Moonshot campaign

New domains so compiling is not scored on a retune of desk / orders / etl / incident / research / thrash / CRM / calendar / payments / cart.

| World | Shape | Goal | Why it is not desk/crm/cart |
|---|---|---|---|
| `createGithubPr` | object loop `{ path, sha }` + linear cap | `{ pr }` | listFiles → createReviewComment ×3 → publishReview → assignReviewers. Files are path+sha, not sku/qty. |
| `createTerraform` | plan-then-apply | `{ stack }` | showPlan → applyChange foreach addresses → verifyOutputs. Apply is gated on a plan array. |
| `createFlags` | two fields on the item | `{ flag }` | getFlag → listCohorts `{ cohort, pct }` → setRollout → publishFlag. Staged rollout, not a sales pipeline. |
| `createDnsTls` | cert-then-listener | `{ zone }` | listHosts → createCert(host) loop → createListener → checkHttps. TLS bind, not checkout. |
| `createInventory` | three-field object loop | `{ wave }` | listBins `{ sku, qty, warehouse }` → restockLine → createShipment. Warehouse is a third field; restock+ship, not reserve+checkout. |
| `createTenant` | two-key linear seqLen 5 | `{ orgId, plan }` | createTenant → createDb → createRoles → createBilling → sendWelcome. Write-first provision, both envelope keys required. |
| `createMapReduce` | map then merge | `{ job }` | listChunks → mapChunk (read-only) foreach → mergeReport. `rows` binds from the loop's collected results; `job` stays on the envelope. |
| `createMoonshotNoise` | unique-work / hostile empty | `{ id }` | shuffled github/terraform-flavoured reads (`fetchBlob`, `showDiff`, …); nothing to mine. `check()` empty. |

## Expect (pre-registered)

| Scenario | Expect |
|---|---|
| `short-github` / `short-tenant` | **WIN on turns** (program already live). goLive failure is FAIL, not skip-as-win. |
| `moonshot-unique` | **parity ±1%** (no LOSS). Unique work must not get more expensive. |
| `long-terraform` / `long-flags` / `long-dns` | **WIN on turns**. goLive failure is FAIL. |
| `inventory-loop` / `map-reduce-loop` | **WIN on turns**. If goLive fails, the scenario **FAIL**s loudly and prints goLive notes. |

`--fast`: 13 witnesses, 3 live, `CAMPAIGN_THINK_MS=1`. Full: think 120ms, 6 live.
`--short`: already-live github + tenant (the sequential comparison) plus unique-work parity.

```bash
bun test benchmarks/campaign/moonshot.test.ts
bun run benchmarks/campaign/bench-moonshot.ts --short --fast
bun run bench:moonshot --short --fast
bun run benchmarks/campaign/bench-moonshot.ts --fast
```

Inventory items are `{ sku, qty, warehouse }` objects, not a string array and not cart's `{ sku, qty }`. GitHub files are `{ path, sha }`. Tenant envelope has **two** keys. Unique-work must compile 0 programs.

## Measured (`--short --fast`, 2026-08-30)

Simulator **turns and cents** are exact arithmetic. Wall-clock is sampled at `CAMPAIGN_THINK_MS=1`. Numbers below are from `.gauntlet/captures/compile/bench-moonshot-short.txt` (tenant seqLen 5).

| Scenario | Turns | Wall | Cents |
|---|---|---|---|
| short-github (foreach live) | **6.00×** (6.0→1.0, p=0.0078 n=8) | WIN 1.04× (ctrl 90.6 → trt 86.7) | **6.00×** |
| short-tenant (seqLen 5 live) | **5.00×** (5.0→1.0, p=0.0078 n=8) | WIN 1.05× | **5.00×** |
| moonshot-unique | 0.0% | INDISTINGUISHABLE **+0.8%** (within ±1%) | 0.0% parity |

CI: `bun test benchmarks/campaign/moonshot.test.ts` — github / tenant / inventory + terraform / flags / dns-tls + **map-reduce** goLive PASS. map-reduce `mergeReport.rows` binds from the loop.

`--fast` without `--short` is the 13-witness then 3-live mix; do not quote those as the sequential comparison.
