# Arc regression map (Wave 1.3)

Maps **every Arc item in `docs/ROADMAP.md` §3** to a **running** fixture that
would catch its regression (or, for unshipped product work, a **gap-pin** of
the current contract so a false "shipped" claim or a substrate break fails CI).

Wave 1 does not implement Arc 1–8 features. It names the catcher.

Source of truth: ROADMAP §3. Fixture inventory: ROADMAP §14 + this file.
Gated by `benchmarks/campaign/arc-catchers.test.ts` (fails if any table row is unnamed
or a backtick path is missing on disk).

Status vocabulary:

- **covered** — a fixture already exercises the shipped behavior
- **pinned** — a Wave 1 catcher of the substrate the item will use
- **gap-pin** — the item is not shipped; the catcher pins today's absence /
  partial contract so the next wave cannot silently claim it

| Arc | Item | Scenario / fixture that would catch regression | Status |
|---|---|---|---|
| **1** | Token attribution per run (`compiled`/`memoized`/`transparent`/`steered-skip`/`frontier`) | Frozen classes + `dcShare` in `packages/measure/src/dc.ts` / `packages/measure/src/dc.test.ts`; wrap skip shape `{eden:"steered"}` in `packages/wrap/src/wrap.test.ts` | pinned |
| **1** | Certified go-live pipeline (provider-scraped usage; retire UNCERTIFIED) | Shadow refuses extrapolated island tokens: `packages/shadow/src/shadow.test.ts` (`extrapolated island tokens no longer PASS`); campaign still needs `assumeProviderUsage` (`benchmarks/campaign/session.ts`). Gap: flag still required for island worlds. | gap-pin |
| **1** | DC% per workspace/day + trend | Formula frozen in `packages/measure/src/dc.ts` (provider cache excluded). Nightly aggregation is Wave 2; independent-script reproducibility starts here. | pinned |
| **1** | Skip ledger as accounted events | Steer skip is a counted return: `packages/wrap/src/wrap.test.ts` (`{ eden: "steered", skipped }`); S1 serving rows are Wave 5. | pinned |
| **1** | Novelty feed (rank uncompiled patterns) | Nothing-to-mine regime: `unique-work` in `benchmarks/campaign/bench-negative.ts` + `createNoise` in `benchmarks/campaign/negative-worlds.ts` | pinned |
| **1** | `cached_tokens` parsing (both dialects) | `parseCacheTokens` + `parseUsage` isolation: `packages/wrap/src/usage.ts` / `packages/wrap/src/usage.test.ts` | pinned |
| **1** | Activation funnel instrumentation | Doctor stage names (install/wrap/hookd/live-tools): `packages/cli/src/doctor.ts` / `packages/cli/src/doctor.test.ts` | pinned |
| **2** | Honesty-loop diagnosis: sequence entropy too high | `unique-work` (`benchmarks/campaign/bench-negative.ts`) + `createNoise` | pinned |
| **2** | Honesty-loop diagnosis: repeats below support 3 | `micro` (`benchmarks/campaign/bench-negative.ts`) | pinned |
| **2** | Honesty-loop diagnosis: width-class split | `long-orders` in `benchmarks/campaign/bench-campaign.ts`; mixed-width `packages/compile/src/compile.test.ts` | pinned |
| **2** | Honesty-loop diagnosis: envelope coverage gaps | `drift` / `ood-long`; **`high-card-ids`** (`benchmarks/campaign/bench-coverage.ts`) | pinned |
| **2** | Daemon / hookd recording | `packages/cli/src/setup.test.ts`, `packages/cli/src/hook.test.ts`, `packages/cli/src/resilience.test.ts` | covered |
| **2** | First-stretch knock | `packages/cli/src/resilience.test.ts` (live-tools knock) | covered |
| **2** | Doctor expansion | `packages/cli/src/doctor.test.ts` | covered |
| **2** | Approvals / open-reject | `packages/cli/src/open.test.ts` (knock URL + reject unlinks `knock.json`) | pinned |
| **2** | `eden explain` | Help text must not claim it until it ships: `packages/cli/src/cli.ts` (gap-pin in `arc-catchers.test.ts`) | gap-pin |
| **3** | Cache-guard mode (volatile prefix normalization) | Breakpoints exist, no reorder: `packages/wrap/src/anthropic.test.ts` + gap-pin in `arc-catchers.test.ts` | gap-pin |
| **3** | PTC-complement emission (`allowed_callers`) | Coding registry has no `allowed_callers`: `packages/wrap/src/coding.ts` / `packages/wrap/src/coding.test.ts` | gap-pin |
| **3** | Exact-key run cache | `resultCacheKey` identity: `apps/site/src/cache.test.ts` | covered |
| **3** | Parameterized memoization / admission | Witness memo: `packages/wrap/src/island.test.ts`; long-session pressure: **`very-long-session`** | pinned |
| **3** | Compression at rest | Densify ratios: `packages/core/src/densify-bench.test.ts` | pinned |
| **3** | Run single-flight | `singleFlight` in `apps/site/src/cache.test.ts` | covered |
| **3** | Self-tuning TTLs / ETag envelopes | ETag envelope tests in `apps/site/src/cache.test.ts` | covered |
| **4** | Witness-efficiency pipeline | Soak SKIP/INCONCLUSIVE; `long-*` lifecycle; **`high-card-ids`**; mixed-width `packages/compile/src/compile.test.ts` | pinned |
| **4** | Width-class envelope generalization | `drift` / `ood-long`; orders novel-width fallback | covered |
| **4** | Integration guidance: read-set exposure (grepCode lesson) | **`pagination-loop`** (honest refuse) + **`pagination-bindable`** (foreach mines) in `benchmarks/campaign/coverage.test.ts`; unit pin `packages/compile/src/compile.test.ts` | covered |
| **4** | Witness-seeded islands | `withWitnessMemo`: `packages/wrap/src/island.test.ts` | covered |
| **4** | Stability scoring / graduation proposals | gap-pin: island tests pin memo, not a scorer UI — `packages/wrap/src/island.test.ts` | gap-pin |
| **4** | Zero-LLM badge | gap-pin: no badge surface; `creative` refuses all-island stretches in `benchmarks/campaign/bench-negative.ts` | gap-pin |
| **4** | Soft-match tier | gap-pin: steering is envelope-strict; OOD fallback in `benchmarks/campaign/edge.test.ts` | gap-pin |
| **4** | Refusal analytics | Compile refusals named: `packages/compile/src/compile.test.ts`; campaign garbage traces in `benchmarks/campaign/edge.test.ts` | pinned |
| **4** | Envelope editor | gap-pin: no editor UI; envelope identity in `packages/compile/src/compile.test.ts` | gap-pin |
| **4** | Graduated rollout | gap-pin: Approve is binary On; `packages/cli/src/open.test.ts` | gap-pin |
| **4** | Envelope: witnessed ids vs novel ids, same shape | **`high-card-ids`**; `ood-long`; `drift` | covered |
| **5** | Struggle failsafe suite (eviction, slack, timeout, dead island, version churn) | `benchmarks/campaign/struggle.test.ts` P1–P5 | covered |
| **5** | Mid-run timeout / deopt-claim exactly-once | **`slow-tool-timeout`** (`benchmarks/campaign/bench-coverage.ts`); unit P3 | covered |
| **5** | Failsafe property-fuzz | `benchmarks/campaign/failsafe-fuzz.test.ts` (1,000 cases, seed `0xF5A1`) | covered |
| **5** | Drift auto-refresh / canary deploys | `apps/site/src/canary.test.ts` | pinned |
| **5** | Read-your-writes | gap-pin: wrap sibling-claim after a mutating head — `packages/wrap/src/failsafe.test.ts` | gap-pin |
| **5** | Bit-exact replay | `replayRegistry` in `packages/shadow/src/shadow.test.ts` | covered |
| **5** | Audit export JSONL/CSV | gap-pin: no exporter shipped; `packages/cli/src/retention.test.ts` is runs-log sweep only | gap-pin |
| **5** | Retention surfaces | `packages/cli/src/retention.test.ts` | covered |
| **5** | Data-isolation / tenancy / SSRF | `apps/site/src/tenancy.test.ts`; `apps/site/src/ssrf.test.ts`; `apps/site/src/cache.test.ts` tenant isolation | covered |
| **5** | SOC2 groundwork | gap-pin: no SOC2 pack; isolation tests are the shipped evidence — `apps/site/src/tenancy.test.ts` | gap-pin |
| **6** | Multi-tenant arming (W≥100 concurrent) | Struggle **P1b W=100** in `benchmarks/campaign/struggle.test.ts` (fail-open, zero dups). Partitioned store is Wave 4.2. | covered |
| **6** | Concurrent-regime regression gate | `concurrent` in `benchmarks/campaign/bench-negative.ts` | covered |
| **6** | Timeout-regime cost/benefit (Wave 4.4) | **`slow-tool-timeout`**; P3 unit probe | covered |
| **6** | Runtime depth under long sessions | **`very-long-session`** (100 stretches in `benchmarks/campaign/coverage.test.ts`); `benchmarks/campaign/soak.ts` | covered |
| **6** | Loop-breaker | `thrash-enforce` in `benchmarks/campaign/bench-campaign.ts` | covered |
| **6** | Think-time / instant tools | `fastdesk-live` in `benchmarks/campaign/bench-negative.ts` | covered |
| **6** | Densify v2 | `packages/core/src/densify-bench.test.ts` | pinned |
| **6** | Turn-boundary speculation / first-wave streaming | Prefetch + streaming: `apps/site/src/cache.test.ts`; wrap SSE in `packages/wrap/src/wrap.test.ts` | pinned |
| **6** | Remaining v3.1 runtime (watch-time warming, island-miss batching, negative-space, budgets, webhooks, fork mining, composition) | gap-pin: no dedicated fixture per item; soak + `packages/compile/src/fork.test.ts` for fork mining | gap-pin |
| **7** | Shared-fetch dedupe (reuse A4 matched-calls) | Overlap primitive: `concurrent`; unauthenticated slice: `rcp:` public pool in `apps/site/src/cache.test.ts` | pinned |
| **7** | Parent/child runs | gap-pin: one-surface overlap only — `concurrent` in `benchmarks/campaign/bench-negative.ts` | gap-pin |
| **7** | Handoff compilation | gap-pin: no composed handoff fixture; `packages/compile/src/fork.test.ts` is the nearest compile surface | gap-pin |
| **7** | Org view | `apps/control/src/org-binding.test.ts` | pinned |
| **7** | Regional deployment | gap-pin: no regional fixture (named in `benchmarks/campaign/arc-catchers.test.ts`) | gap-pin |
| **7** | Protocol negotiation | `apps/site/src/protocol-gate.test.ts` | pinned |
| **7** | Archival tiers | gap-pin: retention sweep is not archival tiers — `packages/cli/src/retention.test.ts` | gap-pin |
| **8** | Negative-control table publishes with wins | `benchmarks/campaign/bench-negative.ts` + `benchmarks/campaign/README.md` | covered |
| **8** | Production A/B | gap-pin: no live study; paired methodology only — `benchmarks/campaign/gates.ts` | gap-pin |
| **8** | Whitepaper / case studies | gap-pin: unpublished; campaign README is methodology input, not a paper — `benchmarks/campaign/README.md` | gap-pin |
| **8** | Weekly digest honest zeros | Empty-state zeros: `apps/web/app/home/activity.test.ts` | pinned |

## Wave 1.3 worlds → Arc anchors

| New world / scenario | Primary Arc anchors |
|---|---|
| `slow-tool` / `slow-tool-timeout` | Arc 5 timeout/deopt exactly-once; Arc 6 / Wave 4.4 timeout-regime bench |
| `createLongSession` / `very-long-session` | Arc 3 cache/admission pressure; Arc 6 runtime under long sessions (100 stretches in `coverage.test.ts`; gated bench is 8 live, `--long` is 100) |
| `createHighCard` / `high-card-ids` | Arc 4 envelope (witnessed vs novel ids, same shape) |
| `createPagination` / `pagination-loop` | Arc 4 read-set exposure — cursor walk **refuses** foreach (honest) |
| `createPaginationBindable` / `pagination-bindable` | Arc 4 read-set exposure — full array **mines** foreach |

## Counts

- Arc items enumerated in the table above: **64**
- Named running fixture (covered / pinned / gap-pin): **64**
- Explicitly unnamed: **0**

Recompute if ROADMAP §3 gains/loses rows; do not invent fixtures that do not run.
