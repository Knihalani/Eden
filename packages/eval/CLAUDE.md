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
| `src/run.ts` | `runScenarios`: plays every scenario (a fresh planner and reader per scenario), scores, returns `Metrics`; `proxyOf` (oracle scores, labelled), `unwiredFlags` |
| `src/reader-stub.ts` | No-model readers behind the real `AskReader`: `StubReader` (nothing binds), `OracleReader` (flags the expected items; a proxy). The eval's own copy of the lab's semantics: eval never imports `packages/sim` |
| `src/cli.ts` | `bun run eval [--live] [--wait ms] [--no-planner] [--config '{…}'] [--reader stub\|oracle] [dir]` → one JSON object |
| `scenarios/*.json` | The scenarios; [docs/research/eval-suite.md](../../docs/research/eval-suite.md) says what each covers |

## Rules that apply here

- **Before every merge** `bun run eval` runs on the final tree (CLAUDE.md); when engine behaviour changes, paste the
  JSON in the PR. Engine changes touching scoring, thresholds or delivery also run `bun run eval --live` (needs
  `OPENROUTER_API_KEY`; fractions of a cent) and report both.
- **Precision over recall (D3).** A change that raises `recall` by raising `falseFireRate` needs an explicit
  decision. The no-model run of the default reads precision 0.828, recall 0.48, falseFireRate 0 (D115 removed D112's
  false fire in `people-and-days-4`: `groundOccasion` took a lowercase first name for the occasion): any false fire
  is a regression. `--live` still has one on that turn, from the judge the eval wires (`model:` reason; the servers
  wire none, D112). Precision fell to 0.889 with the `large-*` scenarios (24 of 27 delivered items expected under the
  old default): the rule paths deliver lookalikes there
  (`large-flight-lookalikes` 3 items for 1 expected, `large-people-lookalikes` 2 for 1). That is the gap the reader
  closes, so it is kept in the baseline, not fixed by editing the scenarios.
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
- `secretsLeaked` and `notInert` must stay 0: a scenario plants secrets and an injection in mail to check D10/D11.
- A new scenario is ground truth written by hand: keep its expected items honest (what the agent truly needs), not
  what the engine currently delivers. Add a scenario rather than editing one to make a change pass.

## Test

```bash
bun run test:pkg eval            # ~0.5 s (run.test.ts: the harness, the reader wiring, scenario integrity; no model)
bun run eval                     # a few seconds, no model, deterministic: the metrics JSON
bun run eval --config '{"probes":true}'   # the same scenarios under engine flags
bun run eval --reader stub                # the default with the stub reader wired
bun run eval --config "$(cat docs/profiles/minus-grounds.json)"   # the default minus a part
```

## Where next

`docs/research/eval-suite.md`, `docs/COST-MODEL.md` (where live eval numbers are recorded), the lab
(`packages/sim/src/lab/CLAUDE.md`, `docs/LAB.md`) for larger, generated benchmarks.
