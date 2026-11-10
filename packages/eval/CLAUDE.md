# @eden/eval

The scenario harness behind `bun run eval`: 31 hand-written scenarios (`scenarios/*.json`) played through a real
`ContextPartner` over `StaticSource`s, scored for precision, recall, false-fire rate (overall and per category), a
privacy check (planted secrets, inert framing), direct asks, model calls and cost per turn, and latency. 27 are small
(2.8 docs on average); the four `large-*` ones hold 56–60 synthetic docs each, with lookalikes of the expected item
(a namesake, last year's booking, a vendor with the same first word), so retrieval and the reader have work to do.

## Files

| File | Owns |
|---|---|
| `src/scenario.ts` | The scenario shape: sources and their docs, sessions of turns (an event and its gold label: items due by this turn or the next, `"silent"`, or unscored), planted `secrets`, direct `asks`, a `clock` |
| `src/run.ts` | `runScenarios`: plays every scenario (a fresh planner and reader per scenario), scores, returns `Metrics`; `liveWiring` (what `--live` wires, D128); `proxyOf` (oracle scores, labelled), `unwiredFlags` |
| `src/reader-stub.ts` | No-model readers behind the real `AskReader`: `StubReader` (nothing binds), `OracleReader` (flags the expected items; a proxy). The eval's own copy of the lab's semantics: eval never imports `packages/sim` |
| `src/cli.ts` | `bun run eval [--live --usd-cap usd [--judge]] [--wait ms] [--no-planner] [--config '{…}'] [--reader stub\|oracle] [dir]` → one JSON object |
| `scenarios/*.json` | The scenarios; [docs/research/eval-suite.md](../../docs/research/eval-suite.md) says what each covers |

## Rules that apply here

- **Before every merge** `bun run eval` runs on the final tree (CLAUDE.md); when engine behaviour changes, paste the
  JSON in the PR. Engine changes touching scoring, thresholds or delivery also run `bun run eval --live --usd-cap
  0.05` (needs `OPENROUTER_API_KEY`; fractions of a cent) and report both.
- **`--live` is the shipped wiring (D128).** It wires what `buildPartner` wires with a key: no judge (`model: null`,
  D112) and the ask-time and push reader, `AskReader` over `ModelReaderMaker` on the servers' reader role
  (`modelRolesFromEnv(env).reader` from `server/src/models.ts`, imported by relative path so it cannot drift:
  EDEN_MODEL, default `anthropic/claude-haiku-5.5`, OpenRouter with D12's routing and D95's throughput sort,
  no reasoning, D144) on the servers' default budget limits. Cards and intent stay inert (named under `inert`). The
  JSON adds `wiring`, `readerModel`, `usdCap`, `spentUsd`, `readerPool` (`reader: "live"`, with `failures`) and
  `readerFailure`: the first failed reader call as the server logs it (key removed, redacted). A reader that fails
  on every call (an OpenRouter 403 for the account) still scores, as the no-model path: read `readerPool.failures`
  before the metrics.
  `--live --judge` is the pre-D128 shape (`OpenRouterModel.fromEnv` as judge, default `z-ai/glm-5.3-flash`, no live
  reader; `--reader stub|oracle` as before), so D119's and D125's `--live` numbers can be re-run. `--reader` with
  the shipped `--live` is refused.
- **A paid run has a hard cap.** `--live` refuses to start (exit 2, before any model is built) without `--usd-cap
  <usd>`, a positive number. Every budget the run builds shares one `TenantSpend` of that cap, so a call whose
  reservation (its estimate: $0.002 for the reader) would pass it is refused and its path runs with no model. Actual
  costs replace estimates as calls settle, so the spend can pass the cap by at most what calls in flight cost over
  their estimates. The lab's spend ledger meters only `claude-*` ids and lives in `@eden/sim`, which eval does not
  import.
- **Precision over recall (D3).** A change that raises `recall` by raising `falseFireRate` needs an explicit decision.
  The no-model run of the default reads precision 0.65, recall 0.52, falseFireRate 0 (26 of 50 expected, 40 delivered;
  D435). D119 removed D112's false fire in `people-and-days-4` (`groundOccasion` took a lowercase first name for the
  occasion): any false fire is a regression. The pre-D128 `--live` (now `--live --judge`) still had one on that turn,
  from the judge it wires (`model:` reason; the servers wire none, D112, and neither does `--live` since D128).
  Precision fell to 0.889 with the `large-*` scenarios (24 of 27 delivered items expected under the old default): the
  rule paths deliver lookalikes there (`large-flight-lookalikes` 3 items for 1 expected, `large-people-lookalikes` 2 for
  1). That is the gap the reader closes, so it is kept in the baseline, not fixed by editing the scenarios.
- **The reader (`--reader stub|oracle`).** `bun run eval` runs the default with no model: its reader, cards and
  intent are inert (listed under `inert`), which is the shipped default's no-model path. An override that names
  `askReader` itself is refused without `--reader`. `--reader stub` wires the real
  `AskReader` over a maker that says nothing binds, and adds `readerPool`: expected items in a pool the reader was
  given (by their turn or the next, the window recall uses), overall, per category and for asks, with calls and mean
  pool size. Its delivery is the rule paths' (a stub never binds), and `modelCallsPerTurn` counts the reader's calls
  ($0). `--reader oracle` keeps the stub's headline metrics and adds `oracleProxy` from a second run whose reader flags
  exactly the expected items: it reads the gold labels, so every key in it is named `proxy*`, and it never enters
  precision, recall or falseFireRate. The oracle's verdicts are cached per session and prompt like a real reader's.
- **Unwired flags are labelled.** `cards` and `intent` need a card maker the eval does not
  wire: they run as if off, are named under `inert` in the JSON and on stderr. Use the
  lab's funnel (replayed cards) to measure them.
- **The run's clock is the scenario's (D435).** `runScenarios` passes one clock (`scenarioClock`, then one ms an event)
  to the partner's `now`, every `Budget` and the readers. Anything new that takes a `now` gets it too: a wall-clock
  read made the metrics depend on the date (the push's "today", D436: 0.65 on 2026-11-07, 0.684 on 2026-11-10).
  `run.test.ts` runs every scenario under three faked dates and asserts identical metrics.
- `secretsLeaked` and `notInert` must stay 0: a scenario plants secrets and an injection in mail to check D10/D11.
- A new scenario is ground truth written by hand: keep its expected items honest (what the agent truly needs), not
  what the engine currently delivers. Add a scenario rather than editing one to make a change pass.

## Test

```bash
bun run test:pkg eval            # ~3 s (run.test.ts: harness, reader wiring, scenario integrity, clock; no model)
bun run eval                     # a few seconds, no model, deterministic: the metrics JSON
bun run eval --config '{"probes":true}'   # the same scenarios under engine flags
bun run eval --reader stub                # the default with the stub reader wired
bun run eval --live --usd-cap 0.05        # paid: the shipped wiring (no judge, the role reader), capped
bun run eval --live --judge --usd-cap 0.05   # paid: the pre-D128 judge shape
bun run eval --config "$(cat docs/profiles/minus-grounds.json)"   # the default minus a part
```

## Where next

`docs/research/eval-suite.md`, `docs/COST-MODEL.md` (where live eval numbers are recorded), the lab
(`packages/sim/src/lab/CLAUDE.md`, `docs/LAB.md`) for larger, generated benchmarks.
