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
| **1** | Token attribution per run (`compiled`/`memoized`/`transparent`/`steered-skip`/`frontier`) | Recorded window recon: `benchmarks/campaign/provider-window.ts` / `provider-window.test.ts`; wrap skip shape `{eden:"steered"}` in `packages/wrap/src/wrap.test.ts`; canvas `tokenClassForNode` in `apps/web/app/canvas/layout-program.test.ts` | covered |
| **1** | Certified go-live pipeline (provider-scraped usage; retire UNCERTIFIED) | Scraped island usage PASSes: `packages/shadow/src/shadow.test.ts` (`scraped island usage PASSes on tokens without extrapolation`); campaign go-live without the simulated-usage flag: `benchmarks/campaign/certified.test.ts`; silent-host stays uncertified: `benchmarks/campaign/silent-host.test.ts`; cert-rate ≥95%: `benchmarks/campaign/cert-rate.ts`; recon: `packages/wrap/src/recon.test.ts`. | covered |
| **1** | DC% per workspace/day + trend | Formula frozen in `packages/measure/src/dc.ts` (provider cache excluded). Aggregation: `packages/measure/src/dc-day.ts` + `scripts/dc-from-runs.ts` (golden `.gauntlet/refs/07-dc-repro.jsonl`); control `GET /v1/dc`; Home tile `apps/web/app/home/activity.ts` / `activity.test.ts` (null until `tokenClasses`). | covered |
| **1** | Skip ledger as accounted events | Steer skip is a counted return: `packages/wrap/src/wrap.test.ts` (`{ eden: "steered", skipped }`); S1/S1b hook ledger: `packages/cli/src/hook.test.ts` + `benchmarks/campaign/silent-drop.test.ts` (1 transparent + 2 steered-skip) | covered |
| **1** | Novelty feed (rank uncompiled patterns) | Waste rank: `packages/measure/src/novelty.ts` / `novelty.test.ts`; unique-work empty + desk #1 compiles: `packages/compile/src/waste-compile.test.ts`; Home `apps/web/app/home/activity.test.ts` | covered |
| **1** | `cached_tokens` parsing (both dialects) | `parseCacheTokens` + SSE + receipts: `packages/wrap/src/usage.ts` / `usage.test.ts`; POST/GET write+denom `apps/control/src/dc.test.ts`; DC% excludes cache `packages/measure/src/dc.ts` | covered |
| **1** | Activation funnel instrumentation | Funnel counts install→record→mine→knock→approve→serving: `packages/cli/src/doctor.ts` / `packages/cli/src/doctor.test.ts` | covered |
| **2** | Honesty-loop diagnosis: sequence entropy too high | `unique-work` (`benchmarks/campaign/bench-negative.ts`) + `createNoise`; letter `benchmarks/campaign/honesty.test.ts` + `packages/ir/src/honesty.ts` | covered |
| **2** | Honesty-loop diagnosis: repeats below support 3 | `micro` (`benchmarks/campaign/bench-negative.ts`); `Too short · N stretches of 2 calls (need 3)` in `honesty.test.ts` | covered |
| **2** | Honesty-loop diagnosis: width-class split | `long-orders` in `benchmarks/campaign/bench-campaign.ts`; mixed-width `packages/compile/src/compile.test.ts`; `Width split · 2 of 3` in `packages/ir/src/honesty.test.ts` | covered |
| **2** | Honesty-loop diagnosis: envelope coverage gaps | `drift` / `ood-long`; **`high-card-ids`**; `Envelope gap` in `honesty.test.ts` | covered |
| **2** | Daemon / hookd recording | `packages/cli/src/setup.test.ts`, `packages/cli/src/hook.test.ts`, `packages/cli/src/resilience.test.ts`; pid `hookd.pid` + `--stop` | covered |
| **2** | First-stretch knock | `packages/cli/src/resilience.test.ts` (live-tools knock); doctor `knock` stage | covered |
| **2** | Doctor expansion | `packages/cli/src/doctor.test.ts` (install/record/mine/knock/approve/serving) | covered |
| **2** | Approvals / open-reject | `packages/cli/src/open.test.ts`; in-terminal `packages/cli/src/approve.test.ts` | covered |
| **2** | `eden explain` | `packages/cli/src/explain.ts` / `explain.test.ts`; help lists it (`arc-catchers.test.ts`) | covered |
| **3** | Cache-guard mode (volatile prefix normalization) | `EDEN_CACHE_GUARD=1` reorders timestamps after stable; breakpoint on last stable: `packages/wrap/src/anthropic.test.ts` | covered |
| **3** | PTC-complement emission (`allowed_callers`) | `codingRegistry.allowed_callers` + `compiledSchema`: `packages/wrap/src/coding.test.ts` / `wrap.test.ts` | covered |
| **3** | Exact-key run cache | `resultCacheKey` identity: `apps/site/src/cache.test.ts` | covered |
| **3** | Parameterized memoization / admission | Witness memo: `packages/wrap/src/island.test.ts`; run-cache TinyLFU-style writes: `apps/site/src/cache-admit.ts` / `cache-redteam.test.ts`; long-session: **`very-long-session`** | covered |
| **3** | Compression at rest | Envelope gzip+base64 >2KB: `apps/site/src/cache-compress.ts` / `cache-bench.ts`; densify ratios: `packages/core/src/densify-bench.test.ts` | covered |
| **3** | Run single-flight | `singleFlight` in `apps/site/src/cache.test.ts` | covered |
| **3** | Self-tuning TTLs / ETag envelopes | ETag envelope tests in `apps/site/src/cache.test.ts` | covered |
| **4** | Witness-efficiency pipeline | 8-witness go-live 4/4 certified: `benchmarks/campaign/bench-8-witness.ts` / `witness-8.test.ts`; width-inherit after K=3: `benchmarks/campaign/width-inherit.ts` / `width-inherit.test.ts`; rolling shadow `packages/shadow/src/roll.ts`; mixed-width `packages/compile/src/compile.test.ts`; unmapped SKIP/INCONCLUSIVE caught by `benchmarks/campaign/witness-econ.ts` | covered |
| **4** | Width-class envelope generalization | Sibling width inherit after K=3: `benchmarks/campaign/width-inherit.ts`; `packages/compile/src/width-inherit.ts`; live stitch `apps/control/src/inherit-live.ts`. Novel width before K stays raw (`ood-long`). | covered |
| **4** | Integration guidance: read-set exposure (grepCode lesson) | **`pagination-loop`** (honest refuse) + **`pagination-bindable`** (foreach mines) in `benchmarks/campaign/coverage.test.ts`; Wave 3 rotation **`partial-iteration`** (`createPartialIteration` in `benchmarks/campaign/coverage-worlds.ts`) names `read_set_mismatch`; unit pin `packages/compile/src/compile.test.ts` | covered |
| **4** | Witness-seeded islands | `withWitnessMemo`: `packages/wrap/src/island.test.ts` | covered |
| **4** | Stability scoring / graduation proposals | Island pin on Approve (`pinned: true`); scorer `islandStability` in `packages/ir/src/graduate.ts`; wrap lookup-only `packages/wrap/src/island.test.ts`; canvas `pinIslandsOffer` in `apps/web/app/canvas/contract.ts` | covered |
| **4** | Zero-LLM badge | `llmBadge` / `zeroLlm` in `packages/ir/src/graduate.ts`; Home/canvas `apps/web/app/canvas/contract.test.ts` / `apps/web/app/home/activity.test.ts`. Unpinned island never shows the badge. | covered |
| **4** | Soft-match tier | `matchClass` + `mayServe`; steer serves soft only with `contract.softMatch`; OOD fallback in `packages/wrap/src/wrap.test.ts` | covered |
| **4** | Refusal analytics | Compile refusals named: `packages/compile/src/compile.test.ts`; Home `refusalStatus` class+count; `eden explain` honesty letter | covered |
| **4** | Envelope editor | Tighten-only drop on canvas contract strip: `apps/web/app/canvas/contract.ts` / `dropEnvelopeValue`; inventing/emptying 409 in `apps/control/src/rollout.test.ts` | covered |
| **4** | Graduated rollout | Approve ships canary; `POST /v1/tools/:id/promote`; `eden promote`; `apps/control/src/rollout.test.ts`; wrap `filterCanary` | covered |
| **4** | Envelope: witnessed ids vs novel ids, same shape | **`high-card-ids`**; `ood-long`; `drift` | covered |
| **5** | Struggle failsafe suite (eviction, slack, timeout, dead island, version churn) | `benchmarks/campaign/struggle.test.ts` P1–P5 | covered |
| **5** | Mid-run timeout / deopt-claim exactly-once | **`slow-tool-timeout`** (`benchmarks/campaign/bench-coverage.ts`); unit P3 | covered |
| **5** | Failsafe property-fuzz | `benchmarks/campaign/failsafe-fuzz.test.ts` (10,000 cases, seed `0xF5A1`) + both schedulers `failsafe-fuzz-sched.test.ts` | covered |
| **5** | Drift auto-refresh / canary deploys | Site: `apps/site/src/canary.test.ts` + `canary-bind.ts`; control desk: `apps/control/src/refresh.test.ts`; rotation `benchmarks/campaign/upstream-rename.test.ts` | covered |
| **5** | Read-your-writes | After a mutating head, sibling read is not a stale pre-write cache: `packages/wrap/src/failsafe.test.ts` | covered |
| **5** | Bit-exact replay | `replayRegistry` in `packages/shadow/src/shadow.test.ts` | covered |
| **5** | Audit export JSONL/CSV | `packages/cli/src/audit.test.ts`; `apps/control/src/audit-export.ts`; `GET /v1/audit` | covered |
| **5** | Retention surfaces | `packages/cli/src/retention.test.ts` | covered |
| **5** | Data-isolation / tenancy / SSRF | `apps/site/src/tenancy.test.ts`; `apps/site/src/ssrf.test.ts`; `apps/site/src/cache.test.ts` tenant isolation; truth page `apps/web/app/(notes)/isolation/copy.test.ts` | covered |
| **5** | SOC2 groundwork | Evidence pack aligned, **not certified**: `docs/evidence-pack.md`; `/isolation` + `docs/isolation.md`; landing/`/proof` never say SOC2 (`apps/web/app/(notes)/isolation/copy.test.ts`); access-review `apps/control/src/access-review.ts`; doctor `EDEN_NET_ALLOW` `packages/cli/src/doctor.ts`; ZDR `docs/zdr.md` | covered |
| **6** | Multi-tenant arming (W≥100 concurrent) | Struggle **P1c** W=100 sessions on `createArmingStore` in `benchmarks/campaign/struggle.test.ts`; store `packages/wrap/src/arming.ts`. P1b remains the single-session fail-open catcher. | covered |
| **6** | Concurrent-regime regression gate | `concurrent` in `benchmarks/campaign/bench-negative.ts`; Wave 4.1 grid `benchmarks/campaign/concurrency-matrix.test.ts` | covered |
| **6** | Timeout-regime cost/benefit (Wave 4.4) | `benchmarks/campaign/TIMEOUT.md` + `bench-timeout.ts` + `timeout.test.ts`; P3 unit probe | covered |
| **6** | Runtime depth under long sessions | **`very-long-session`** (100 stretches in `benchmarks/campaign/coverage.test.ts`); `benchmarks/campaign/soak.ts` | covered |
| **6** | Loop-breaker | `thrash-enforce` in `benchmarks/campaign/bench-campaign.ts` | covered |
| **6** | Think-time / instant tools | `fastdesk-live` in `benchmarks/campaign/bench-negative.ts` | covered |
| **6** | Densify v2 | `packages/core/src/densify-bench.test.ts` (v1-vs-v2 table; never inflates) | covered |
| **6** | Turn-boundary speculation / first-wave streaming / connection amortization | Speculate: `packages/wrap/src/speculate.ts` / `benchmarks/campaign/speculate.test.ts`; first-wave: `apps/site/src/playback-stream.test.ts`; pool: `apps/site/src/egress-pool.test.ts` / `ssrf.test.ts`; prefetch substrate `apps/site/src/cache.test.ts`; wrap SSE `packages/wrap/src/wrap.test.ts` | covered |
| **6** | Watch-time warming · island-miss batching · negative-space · fork mining | Warm: `packages/wrap/src/warm.ts` / `benchmarks/campaign/watch-warm.test.ts`; batch: `packages/wrap/src/island-batch.ts` / `packages/wrap/src/island.test.ts`; negative-space: `packages/compile/src/negative.ts` / `benchmarks/campaign/poll-world.test.ts`; fork: `packages/compile/src/fork.test.ts` / `benchmarks/campaign/fork-gate.test.ts` | covered |
| **6** | Remaining v3.1 runtime (budgets, schedules, webhooks, PostToolBatch remainder, composition) | Forecast: `packages/wrap/src/forecast.ts` / `benchmarks/campaign/budget-forecast.test.ts`; schedule: `apps/control/src/schedule.ts` / `schedule.test.ts`; webhook GET: `benchmarks/campaign/webhook-get.ts` / `webhook-get.test.ts`; PostToolBatch: `benchmarks/campaign/post-batch.ts`; compose: `packages/compile/src/compose.ts` / `compose.test.ts` | covered |
| **7** | Shared-fetch dedupe (reuse A4 matched-calls) | Fleet read-only claims: `benchmarks/campaign/fleet-dedupe.ts`; unauthenticated slice: `rcp:` in `apps/site/src/cache.test.ts` | covered |
| **7** | Parent/child runs | `tracesMatchSpans` in `packages/ir/src/spans.ts`; fixture `benchmarks/campaign/fleet-dedupe.test.ts` | covered |
| **7** | Handoff compilation | `packages/compile/src/handoff.ts` / `handoff.test.ts`; approve `apps/control/src/handoff-approve.test.ts` | covered |
| **7** | Org view | Clerk binding `apps/control/src/org-binding.test.ts`; Home fleet strip `apps/web/app/home/activity.test.ts` | covered |
| **7** | Regional deployment | `region` on traces/receipts; `us-east-1` in `benchmarks/campaign/fleet-dedupe.test.ts` | covered |
| **7** | Protocol negotiation | MCP initialize `packages/ir/src/mcp-version.ts` + `apps/site/src/mcp.test.ts`; Eden future mismatch still 426 `apps/site/src/protocol-gate.test.ts` | covered |
| **7** | Archival tiers | hot/warm/cold `packages/cli/src/archive.ts` / `archive.test.ts` (retention sweep still `packages/cli/src/retention.test.ts`) | covered |
| **8** | Negative-control table publishes with wins | `benchmarks/campaign/bench-negative.ts` (n1–n9) + `benchmarks/campaign/README.md`; Wave 5.4 rotation `silent-drop` / `benchmarks/campaign/silent-drop.ts` | covered |
| **8** | Production A/B | Live study published with retired live-invoice cell: `benchmarks/campaign/LIVE-AB.md` + `live-ab.test.ts`; host limit `HOST-DROP.md`; stretch vs latest-receipt `stretch-drop.test.ts` | covered |
| **8** | Whitepaper / case studies | `/proof` + `docs/whitepaper.md` + `docs/cases.md`; `PUBLIC_CLAIMS` in `packages/measure/src/claims.ts` | covered |
| **8** | Weekly digest honest zeros | `packages/cli/src/digest.ts` + `apps/web/app/home/activity.test.ts`; empty prints 0 / — | covered |

## Wave 1.3 worlds → Arc anchors

| New world / scenario | Primary Arc anchors |
|---|---|
| `slow-tool` / `slow-tool-timeout` | Arc 5 timeout/deopt exactly-once; Arc 6 / Wave 4.4 timeout-regime bench |
| `createLongSession` / `very-long-session` | Arc 3 cache/admission pressure; Arc 6 runtime under long sessions (100 stretches in `coverage.test.ts`; gated bench is 8 live, `--long` is 100) |
| `createHighCard` / `high-card-ids` | Arc 4 envelope (witnessed vs novel ids, same shape) |
| `createPagination` / `pagination-loop` | Arc 4 read-set exposure — cursor walk **refuses** foreach (honest) |
| `createPaginationBindable` / `pagination-bindable` | Arc 4 read-set exposure — full array **mines** foreach |
| `createPartialIteration` / `partial-iteration` | Wave 3 rotation — 12 hits / 6 reads is a **named** read-set miss |

## Wave 5 rotation

| New world / scenario | Primary Arc anchors |
|---|---|
| `silent-drop` / n9 (`silent-drop.ts`, `silent-drop.test.ts`) | Arc 8 negative-control rotation; Arc 1 skip ledger (transparent + steered-skip on the hook path); R1 silent drop of `updatedToolOutput` with S1b deny still holding |

## Wave 6 rotation

| New world / scenario | Primary Arc anchors |
|---|---|
| `upstream-rename` (`upstream-rename.ts`, `upstream-rename.test.ts`) | Arc 5 drift auto-refresh; forced `state→conclusion`; live stays On |
| unique-GET storm / gzip envelopes (`apps/site/src/cache-redteam.test.ts`, `cache-bench.ts`) | Arc 3 admission + compression at rest |
| audit hash-chain (`packages/cli/src/audit.test.ts`) | Arc 5 audit export / MCP08 |

## Wave 7 rotation

| New world / scenario | Primary Arc anchors |
|---|---|
| `fleet-dedupe` | Arc 7 shared-fetch + parent/child |
| `hosted-dispatch` | Arc 7 W=100 + MCP skew |

## Wave 8 rotation

| New world / scenario | Primary Arc anchors |
|---|---|
| `stretch-drop` (`stretch-drop.ts`) | Arc 8 Home/canvas whole-stretch naming; a drop cannot hide behind Skipped |
| live-ab / digest honest zeros | Arc 8 retired live-invoice; host-limit; weekly letter mirrors Home |

## Wave 9 rotation

| New world / scenario | Primary Arc anchors |
|---|---|
| honesty diagnoses (`honesty.ts` / `honesty.test.ts`) | Arc 2 explain letter: unique-work / micro class+count; not a retune of negative-control cents |

## Wave 10 rotation

| New world / scenario | Primary Arc anchors |
|---|---|
| `width-inherit` (`width-inherit.ts` / `width-inherit.test.ts`) | Arc 4 witness-efficiency: sibling-width inherit after K=3; rolling shadow `packages/shadow/src/roll.ts`; 8-witness `benchmarks/campaign/bench-8-witness.ts` |

## Wave 11 rotation

| New world / scenario | Primary Arc anchors |
|---|---|
| `opencode-drop` (`opencode-drop.ts`, `opencode-drop.test.ts`) | Arc 8 new host-drop class: OpenCode MCP-shaped after payload drops `output.output` mutation (issue #25918); S1b remainder deny still holds. Not a retune of `silent-drop`. |

## Wave 12 rotation

| New world / scenario | Primary Arc anchors |
|---|---|
| `provider-window` (`provider-window.ts`, `provider-window.test.ts`) | Arc 1 ledger recon vs a recorded OpenAI+Anthropic usage window; cache excluded from billed; not a retune of cert-rate |

## Wave 13 rotation

| New world / scenario | Primary Arc anchors |
|---|---|
| `github-review` speculate (`speculate.ts`, `speculate.test.ts`) | Arc 6 turn-boundary read-only eagerness; unique-work/creative parity ±1%; not fastdesk |

## Wave 14 rotation

| New world / scenario | Primary Arc anchors |
|---|---|
| `watch-warm` (`watch-warm.ts`, `watch-warm.test.ts`) | Arc 6 watch-time warming of the next compiled read-only first-wave; mutating never pre-executed |
| `poll-world` (`poll-world.ts`, `poll-world.test.ts`) | Arc 6 negative-space: agent polled; program does not. Not thrash-enforce. unique-work still refuses |
| `fork-gate` (`fork-gate.ts`, `fork-gate.test.ts`) | Arc 6 fork honesty: min-3 / empty_output / underdetermined_write / max_programs |

## Wave 15 rotation

| New world / scenario | Primary Arc anchors |
|---|---|
| `webhook-get` (`webhook-get.ts`, `webhook-get.test.ts`) | Arc 6 webhook-invalidated GET; cache keys drop; live stays On. Not `upstream-rename`. |
| `budget-forecast` (`budget-forecast.ts`, `budget-forecast.test.ts`) | Arc 6 predicted vs actual llm/ms/cents; unique-work halt 0 |
| `post-batch` (`post-batch.ts`, `post-batch.test.ts`) | Arc 6 PostToolBatch remainder; parallel siblings mutate once |

## Wave 16 (landed; no campaign tune)

| Wave | Rotation (must not retune an old fixture) |
|---|---|
| 16 | None — docs/export (`docs/evidence-pack.md`, `eden audit review`, `eden doctor` net-allow, `docs/zdr.md`). Not a campaign world. |

## Wave 16–19 catchers (Wave 20.2)

Every phase row names a fixture or gap-pin. `WAVE_16_19_CATCHERS` in `packages/measure/src/tree.ts` is the CI list.

| Phase | Catcher | Status |
|---|---|---|
| **16.1** | `docs/evidence-pack.md` · isolation copy tests | covered |
| **16.2** | `apps/control/src/access-review.ts` / `access-review.test.ts` | covered |
| **16.3** | `packages/cli/src/doctor.ts` / `doctor.test.ts` (`doctor-net-allow`) | covered |
| **16.4** | `docs/zdr.md` · `docs/marketplace-draft.md` (`zdr-listing`) | covered |
| **17.1** | `benchmarks/campaign/cwd-hop.ts` / `cwd-hop.test.ts` | covered |
| **17.2** | `apps/site/src/webhook.ts` / `webhook.test.ts` (`hmac-only`) | covered |
| **17.3** | `packages/cli/src/hookd.ts` / `doctor.ts` (`hookd-ownership`) | covered |
| **17.4** | `packages/cli/src/setup.ts` / `setup.test.ts` (`installer-home`) | covered |
| **18.1** | `apps/web/app/account/route.ts` (`account-onboarding`) | covered |
| **18.2** | `apps/web/app/account/route.test.ts` (`route-regression`) | covered |
| **18.3** | `apps/web/app/canvas/workbench.test.ts` (`workbench-review`) | gap-pin |
| **18.4** | `packages/wrap/src/wrap-tools.ts` / `forecast.test.ts` (`waste-layer`) | gap-pin |
| **19.1** | `benchmarks/campaign/limits-board.test.ts` / `LIVE-AB.md` (`limits-board`) | covered |
| **19.2** | `packages/measure/src/claims.ts` (`oblivious-long`) | covered |
| **19.3** | `benchmarks/campaign/jit-soak.ts` / `JIT-SOAK.md` | covered |
| **19.4** | `benchmarks/campaign/HOST-DROP.md` (`replica-host-drop`) | covered |

## Wave 17 (landed)

| Wave | Rotation (must not retune an old fixture) |
|---|---|
| 17 | cwd-relative remainder hop (`benchmarks/campaign/cwd-hop.ts` / `benchmarks/campaign/cwd-hop.test.ts`) — not a retune of `post-batch` |

## Wave 18 *(landed)* · Wave 19 *(landed)* · Wave 20 *(landed)* · Wave 21 (scheduled) · Wave 22 (scheduled)

| Wave | Rotation (must not retune an old fixture) |
|---|---|
| 18 | None — gated UI review. **Landed.** Account route suite + in-tree 15–52 |
| 19 | JIT soak remeasure is measurement-only. **Landed.** FAIL `precision=0.789 n=38`; `JIT-SOAK.md`; default `all` |
| 20 | None — Wave 16–20 inventory empty. **Landed.** `eden doctor --tree`; catchers 16–19; §15 grep-complete |
| 21 | JIT soak remeasure is measurement-only (same as 19). **Scheduled.** oblivious-long cited file; isolation Kind/Source; proof cases chrome |
| 22 | None until evidence. **Scheduled.** Live invoice parse if a file exists; `EDEN_SURFACE=jit` only on soak PASS |

## Counts

- Arc items enumerated in the table above: **65**
- Named running fixture (covered / pinned / gap-pin): **65**
- Explicitly unnamed: **0**

Recompute if ROADMAP §3 gains/loses rows; do not invent fixtures that do not run.
