# Holdout campaign

New domains so compiling is not scored on a retune of desk / orders / etl / incident / research / thrash.

| World | Shape | Goal | Why it is not desk |
|---|---|---|---|
| `createCrm` | linear 5-call sales pipeline | `{ leadId }` | getLead → enrich → deal → assign → Slack. No credit/audit/email. |
| `createCalendar` | linear 4-call, **two-field** input | `{ when, title }` | listBusy → event → invite → reminder. |
| `createPayments` | nested bind | `{ email }` | `getCustomer` returns `{ customer: { billing: { id } } }`, then invoice / charge / receipt. |
| `createCart` | loop over **object** items | `{ cart }` | `listCart` → `{ items: [{ sku, qty }, ...] }` (not `string[]`), width 3, `reserveSku` per sku, `checkoutCart`. |
| `createHoldoutNoise` | unique-work | `{ id }` | shuffled tool sequences; nothing to mine. |

## Expect (pre-registered)

| Scenario | Expect |
|---|---|
| `long-crm` / `long-calendar` / `long-payments` | **WIN on turns** (cents too if turns WIN). goLive failure is FAIL, not skip-as-win. |
| `holdout-unique` | **parity ±1%** (no LOSS). Unique work must not get more expensive. |
| `cart-loop` | **WIN on turns** once the compiler binds object-array `sku` fields. If goLive fails, the scenario **FAIL**s loudly and prints goLive notes. |

`--fast`: 13 witnesses, 3 live, `CAMPAIGN_THINK_MS=1`. Full: think 120ms, 6 live.
`--short`: already-live CRM + cart (the sequential comparison) plus unique-work parity.

```bash
bun test benchmarks/campaign/holdout.test.ts
bun run benchmarks/campaign/bench-holdout.ts --short --fast
bun run benchmarks/campaign/bench-holdout.ts --fast
```

Cart items are `{ sku, qty }` objects, not a string array. `compileTraces` mines a foreach over `items` (`sku` from the item). goLive still has to shadow-certify; a miss is FAIL, not skip-as-win.

## Measured (`--short --fast`, 2026-08-30)

Simulator turns are exact arithmetic. Wall-clock is sampled (A/A not on these three cells). n=8 for WIN cells.

| Scenario | Turns | Wall | Cents | Unique-work |
|---|---|---|---|---|
| short-crm (program live) | **5.00×** (5.0→1.0, p=0.0078) | 3.52× | 3.85× | — |
| short-cart (foreach live) | **5.00×** (5.0→1.0, p=0.0078) | 3.46× | 5.00× | — |
| holdout-unique | 0.0% | +0.2% (sub-material) | 0.0% | parity |

File: `.gauntlet/captures/compile/bench-holdout-short.txt`. Long lifecycle (`--fast` without `--short`) is the 13-witness then 3-live mix; do not quote those as the sequential PTC comparison.
