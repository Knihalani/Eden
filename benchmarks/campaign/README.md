# The Eden campaign

Multi-domain, paired, gated benchmarks plus adversarial end-to-end tests.
Built to answer one question honestly: **does Eden actually help real agent
workloads — short and long running — without ever corrupting state?**

## Layout

| File | What it is |
| --- | --- |
| `worlds.ts` | Six agent domains with different waste shapes: billing desk (linear mutating stretch, sloppy-agent noise), orders (fan-out inventory loop → refund), etl (read fan-out, fat payloads, one report), incident triage (flaky reads + retries + mutating tail), code research (many reads + island summary + write), and a thrash loop (failing probe→restart→verify). |
| `session.ts` | Session driver: charges an LLM turn for every call the agent decides to make (even ones Eden suppresses), records compilable traces, and performs the real go-live path: `compileTraces` → `shadowProgram` on a sandbox world → manifest on PASS. |
| `bench-campaign.ts` | Nine gated scenarios. Every scenario is paired by `(task, repeat)` blocks, counterbalanced via `@eden/measure`'s `runPlan`, and decided by `decide()` (bootstrap CI + permutation p). A LOSS or any correctness violation fails the exit code. |
| `bench-negative.ts` | **Negative controls** — eight regimes where Eden should NOT help: non-repeating work, all-judgment stretches, sub-minimum sequences, instant tools, distribution drift, failure-dominant workloads (observe + enforce), and concurrent interleaved goals. Parity here is the success criterion; a LOSS fails the exit code. |
| `gates.ts` | Shared paired/counterbalanced gating machinery used by both campaigns. |
| `edge.test.ts` | End-to-end correctness angles: steering serves a full stretch in one call, out-of-envelope goals fall back raw, exactly-once mutations under flaky tools, oblivious agents are never corrupted. Wired into `scripts/test.sh`. |
| `soak.ts` | Long-run volume: repeated record→compile→steer lifecycles across all worlds with heap-drift checks. `bun run benchmarks/campaign/soak.ts --minutes 5`. |
| `coverage-worlds.ts` | Wave 1.3 missing regimes: slow-tool (>wrap timeout), long-session (100+ stretch fixture), high-cardinality (unique ids / same shape), provider-pagination (paged list → per-item mutate) plus bindable `listAll` counterpart. |
| `bench-coverage.ts` | Gated coverage scenarios for those regimes. |
| `coverage.test.ts` | CI smoke: world scripts, check() dups/missing, **100-stretch** long-session, bindable-vs-cursor compile pin. |
| `arc-catchers.test.ts` | Wave 1.3 done-when: every ROADMAP §3 Arc item names a running fixture (`ARC-REGRESSION.md`). |
| `failsafe-fuzz.test.ts` | Wave 1.4: 1,000 generated programs × faults; Eden-absent-equivalent. |
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
7. **ood-long** — every goal out-of-envelope against a live program. Steering must simply miss: parity expected, corruption fails.
8. **oblivious-long** — the model never early-stops. Measures Eden's value when the integration cannot cooperate (honest lower bound).
9. **thrash-enforce** — enforcement mode vs a runaway restart loop.

## Honesty rules

- Turn cost is charged per *decision*, so suppressed calls still bill their turn in oblivious mode.
- Correctness (exactly-once mutations) is checked against world state after every session; it overrides any performance number.
- A/A self-checks police wall-clock noise; deterministic simulator metrics (turns) are exact arithmetic, not statistics, and are labeled as such.
- Go-lives that pass only because provider token usage is simulated (`assumeProviderUsage`) are counted and printed as UNCERTIFIED — Eden's own shadow gate demands measured tokens or time, which offline simulators cannot provide. That gate behavior is itself a finding: see the report.
- Verdicts may be INDISTINGUISHABLE. Only losses and corrupted state fail.

## Run

```bash
bun run benchmarks/campaign/bench-campaign.ts          # full (~40 min)
bun run benchmarks/campaign/bench-campaign.ts --fast   # smoke (~10 min)
bun run benchmarks/campaign/soak.ts --minutes 5        # volume soak
bun test benchmarks                                    # edge suite
```
