# The Eden campaign

> **Compile era: retired.** This campaign measured Eden's earlier tool-path compiler. Its tests still run, but Eden is now passive memory for coding agents ([README](../../README.md)), measured by [benchmarks/memory-long-horizon/](../memory-long-horizon/README.md); the compile-era documents are in [archived/compile-era/](../../archived/compile-era/README.md).

Multi-domain, paired, gated benchmarks plus adversarial end-to-end tests.
Built to answer one question honestly: **does Eden actually help real agent
workloads — short and long running — without ever corrupting state?**

## Layout

| File | What it is |
| --- | --- |
| `holdout-worlds.ts` | **New domains** (not a retune of desk/orders/etl): CRM pipeline, calendar RSVP, nested-JSON payments, cart loop over `{sku,qty}` objects, unique-work noise. `HOLD-OUT.md`. |
| `bench-holdout.ts` | Gated holdout campaign. `--short --fast` is the already-live sequential comparison (short-crm / short-cart 5.00× turns). CI: `holdout.test.ts`. `bun run bench:holdout`. |
| `moonshot-worlds.ts` | **Newer domains** (not holdout): github-pr, terraform, flags, dns-tls, inventory, tenant, map-reduce. `MOONSHOT.md`. |
| `horizon-worlds.ts` | **Still-newer domains** (not moonshot): GraphQL Relay `node.*`, SSO nested object body, ranked top-k, k8s poll, saga 2-arm, SQL templates, webhook fanout, inbox island. `HORIZON.md`. `bun run bench:horizon-short`. |
| `horizon-extra-worlds.ts` | Nested outer-scope k8s, email tz, s3 versionId, 3-way sev fork, set-diff except, four-level JSON. CI: `horizon-extra.test.ts`. |
| `apex-worlds.ts` | **Still-newer domains** (not horizon): Stripe cursor invoices, HRIS lookup, sentry filter, CMS flatten, transcode chunk, catalog zip, OAuth token. `APEX.md`. CI: `apex.test.ts`. |
| `helix-worlds.ts` | **Still-newer domains** (not apex): 12-step launch-pad, GitLab page/limit, 429-retry, nested tree, unique-addr, sort-by-prio, ledger sum, barcode+lotCode. `HELIX.md`. CI: `helix.test.ts`. `bun run bench:helix-short`. |
| `session.ts` | Session driver: charges an LLM turn for every call the agent decides to make (even ones Eden suppresses), records compilable traces, and performs the real go-live path: `compileTraces` → `shadowProgram` on a sandbox world → manifest on PASS. |
| `bench-campaign.ts` | Nine gated scenarios. Every scenario is paired by `(task, repeat)` blocks, counterbalanced via `@eden/measure`'s `runPlan`, and decided by `decide()` (bootstrap CI + permutation p). A LOSS or any correctness violation fails the exit code. |
| `bench-negative.ts` | **Negative controls** — nine regimes where Eden should NOT help dishonestly: non-repeating work, all-judgment stretches, sub-minimum sequences, instant tools, distribution drift, failure-dominant workloads (observe + enforce), concurrent interleaved goals, and a **silent-drop host** (R1: always drops `updatedToolOutput`). Parity here is the success criterion; a LOSS fails the exit code. |
| `gates.ts` | Shared paired/counterbalanced gating machinery used by both campaigns. |
| `edge.test.ts` | End-to-end correctness angles: steering serves a full stretch in one call, out-of-envelope goals fall back raw, exactly-once mutations under flaky tools, oblivious agents are never corrupted. Wired into `scripts/test.sh`. |
| `concurrency-matrix.ts` | Wave 4.1 grid: stretches × tails × think × ≤64/>64. `bun run bench:matrix`. CI: `concurrency-matrix.test.ts`. |
| `session-crosstalk.test.ts` | Wave 4 rotation: identical entity ids on two sessions of a shared store. |
| `fleet-dedupe.ts` | Wave 7.1 rotation: two agents, one fleet, same read-only GET. Duplicate fetches vanish; mutating stays per-session. CI: `fleet-dedupe.test.ts`. |
| `hosted-dispatch.ts` | Wave 7.2: W=100 hosted connections on the shared arming store + MCP initialize skew. CI: `hosted-dispatch.test.ts`. |
| `bench-timeout.ts` | Wave 4.4 timeout sweep → `TIMEOUT.md`. `bun run bench:timeout`. |
| `silent-drop.ts` | Wave 5.4 R1 host: **always drops** `updatedToolOutput`; S1b remainder deny still fires. Oblivious-cents meter → `SILENT-DROP.md`. `bun run benchmarks/campaign/silent-drop.ts --fast`. CI: `silent-drop.test.ts` (n9 in `bench-negative.ts`). |
| `live-ab.ts` | Wave 8.1 paired live-invoice protocol. Missing `EDEN_LIVE_INVOICE` retires live-S1b. Publication: `LIVE-AB.md`. CI: `live-ab.test.ts`. |
| `HOST-DROP.md` | Wave 8.1 leftover 2: live Claude Code cannot ack always-drop of a correct rewrite. Replica host-drop is a permanent host limit. Receipt class `host-drop` stays. |
| `stretch-drop.ts` | Wave 8 rotation (other builder): 3-call serve + remainder skip + host-drop. Home/canvas must name all three. |
| `soak.ts` | Long-run volume: repeated record→compile→steer lifecycles across all worlds with heap-drift checks. `bun run benchmarks/campaign/soak.ts --minutes 5`. |
| `coverage-worlds.ts` | Wave 1.3 missing regimes: slow-tool (>wrap timeout), long-session (100+ stretch fixture), high-cardinality (unique ids / same shape), provider-pagination (paged list → per-item mutate) plus bindable `listAll` counterpart. |
| `bench-coverage.ts` | Gated coverage scenarios for those regimes. |
| `coverage.test.ts` | CI smoke: world scripts, check() dups/missing, **100-stretch** long-session, bindable-vs-cursor compile pin, Wave 3 partial-iteration named miss. |
| `bench-8-witness.ts` | Wave 3.5: go-live at 8 witnesses. `bun run bench:8-witness`. Prints PASS/total and uncertified count. |
| `arc-catchers.test.ts` | Wave 1.3 done-when: every ROADMAP §3 Arc item names a running fixture (`ARC-REGRESSION.md`). |
| `failsafe-fuzz.test.ts` | Wave 6.3: 10,000 generated programs × faults; Eden-absent-equivalent. Both playback schedulers: `failsafe-fuzz-sched.test.ts`. |
| `upstream-rename.ts` | Wave 6.2 rotation: forced `state→conclusion`; canary/control queues a replacement; live stays On. |
| `calibrate.ts` | Wave 1.1: A/A noise-floor → MDE @ n=8/12/16, stability, false-loss rates → `NOISE-FLOOR.md`. |
| `ARC-REGRESSION.md` | Every ROADMAP §3 Arc item → scenario that would catch its regression. |
| `CI-RUNNER.md` | Runner requirements for trustworthy wall_ms gates. |

## Coverage regimes (Wave 1.3)

| Regime | World | Bench scenario | What it pins |
| --- | --- | --- | --- |
| slow-tool | `createSlowTool` | `slow-tool-timeout` | Deopt-claim after timeout; applyCredit exactly-once; notify never duplicated. Wrap timeout via `CAMPAIGN_WRAP_TIMEOUT_MS` (default 120). |
| very-long session | `createLongSession` | `very-long-session` | Envelope over a cycling 4-id pool. `--fast` → 4 live; default → 8; `--long` → 100. |
| high-cardinality | `createHighCard` | `high-card-ids` | Same tool sequence for every unique id; live novel ids → steer miss / parity (unlike `createNoise`). |
| provider-pagination (cursor) | `createPagination` | `pagination-loop` | Page1→2→3 then write each item; **honest refusal** (listPage repeats without bindable foreach). |
| provider-pagination (bindable) | `createPaginationBindable` | compile pin in `coverage.test.ts` | One `listAll` array → foreach mines. |

```bash
bun test benchmarks/campaign/coverage.test.ts
bun test benchmarks/campaign/arc-catchers.test.ts
bun test benchmarks/campaign/failsafe-fuzz.test.ts
bun run benchmarks/campaign/bench-coverage.ts --fast
bun run benchmarks/campaign/bench-coverage.ts --long   # 100 live stretches (gated)
bun run benchmarks/campaign/calibrate.ts               # full noise floor (not --fast)
./scripts/flake-audit.sh --runs 1 --clock-jump --seed 43
```

## Scenarios

1. **short-support** — single-stretch agent, compiled tool already live. Does a short agent benefit?
2. **short-overhead** — cold Eden, no programs. Does wrapping *hurt* when nothing compiles?
3–6. **long-desk / long-orders / long-etl / long-incident** — full lifecycle: record N witnesses, compile+shadow mid-session, then live stretches. Different fan-out/flake/mutation shapes per domain.
7. **ood-long** — every goal out-of-envelope against a live program. Steering must simply miss: parity expected, corruption fails. **Limit**, not a win.
8. **oblivious-long** — LIMIT, not a win. The model never early-stops. Wrap skipRest is +2.8% cents / +3.2% wall (island spend, no turn savings). See Limits.
9. **thrash-enforce** — enforcement mode vs a runaway restart loop.

## Limits (not wins)

These stay in the campaign as measurement fixtures. They are not quoted as wins.

| Scenario | Result | File |
| --- | --- | --- |
| oblivious-long | +2.8% cents / +3.2% wall on wrap skipRest when the model never early-stops. Retired from the win table. | `OBLIVIOUS-LONG.md`, `LIVE-AB.md` |
| ood-long | Steering misses; parity expected; corruption fails. | `bench-campaign.ts` |
| replica host-drop | Live Claude Code cannot ack always-drop of a correct rewrite. Replica host-drop is a permanent host limit. | `HOST-DROP.md` |
| S1b live invoice | No live Claude Code invoice in the tree. Retired until `parseInvoice` returns live-invoice. | `LIVE-AB.md` |

## Honesty rules

- Turn cost is charged per *decision*, so suppressed calls still bill their turn in oblivious mode.
- Correctness (exactly-once mutations) is checked against world state after every session; it overrides any performance number.
- A/A self-checks police wall-clock noise; deterministic simulator metrics (turns) are exact arithmetic, not statistics, and are labeled as such.
- Go-live installs only on a shadow PASS with scraped (or zero-island) usage. Missing provider tokens stay UNCERTIFIED / not installed — there is no simulated-usage bypass. Silent-host is the rotation world for that case.
- Verdicts may be INDISTINGUISHABLE. Only losses and corrupted state fail.

## Run

```bash
bun run benchmarks/campaign/bench-campaign.ts          # full (~40 min)
bun run benchmarks/campaign/bench-campaign.ts --fast   # smoke (~10 min)
bun run benchmarks/campaign/silent-drop.ts --fast      # Wave 5.4 n9 + oblivious cents
bun test benchmarks/campaign/silent-drop.test.ts       # 3-call loop through forced-drop host
bun run benchmarks/campaign/live-ab.ts                 # Wave 8.1: retire or measure live-S1b
bun test benchmarks/campaign/live-ab.test.ts           # retired invoice + host-limit pins
bun run benchmarks/campaign/soak.ts --minutes 5        # volume soak
bun test benchmarks                                    # edge suite
```
