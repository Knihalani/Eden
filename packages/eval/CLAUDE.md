# @eden/eval

The scenario harness behind `bun run eval`: 27 hand-written scenarios (`scenarios/*.json`) played through a real
`ContextPartner` over `StaticSource`s, scored for precision, recall, false-fire rate (overall and per category), a
privacy check (planted secrets, inert framing), direct asks, model calls and cost per turn, and latency.

## Files

| File | Owns |
|---|---|
| `src/scenario.ts` | The scenario shape: sources and their docs, sessions of turns (an event and its gold label: items due by this turn or the next, `"silent"`, or unscored), planted `secrets`, direct `asks`, a `clock` |
| `src/run.ts` | `runScenarios`: plays every scenario (a fresh planner per scenario when `planner`), scores, returns `Metrics` |
| `src/cli.ts` | `bun run eval [--live [--ask-model]] [--wait ms] [--no-planner] [--config '{…}'] [dir]` → one JSON object |
| `scenarios/*.json` | The scenarios; [docs/research/eval-suite.md](../../docs/research/eval-suite.md) says what each covers |

## Rules that apply here

- **Before every merge** `bun run eval` runs on the final tree (CLAUDE.md); when engine behaviour changes, paste the
  JSON in the PR. Engine changes touching scoring, thresholds or delivery also run `bun run eval --live` (needs
  `OPENROUTER_API_KEY`; fractions of a cent) and report both.
- **Precision over recall (D3).** A change that raises `recall` by raising `falseFireRate` needs an explicit
  decision. The no-model run on main reads precision 1, falseFireRate 0 (2026-11-02): any false fire is a regression.
- `secretsLeaked` and `notInert` must stay 0: a scenario plants secrets and an injection in mail to check D10/D11.
- A new scenario is ground truth written by hand: keep its expected items honest (what the agent truly needs), not
  what the engine currently delivers. Add a scenario rather than editing one to make a change pass.

## Test

```bash
bun run test:pkg eval            # ~0.6 s (run.test.ts: the harness itself, no model)
bun run eval                     # ~2 s, no model, deterministic: the metrics JSON
bun run eval --config '{"probes":true}'   # the same scenarios under engine flags
```

## Where next

`docs/research/eval-suite.md`, `docs/COST-MODEL.md` (where live eval numbers are recorded), the lab
(`packages/sim/src/lab/CLAUDE.md`, `docs/LAB.md`) for larger, generated benchmarks.
