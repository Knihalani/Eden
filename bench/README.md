# Benchmark ledger

Every benchmark run on Eden appends one line to [`ledger.jsonl`](ledger.jsonl) and writes its per-task rows to
`runs/<id>.jsonl.gz`. The line holds the commit it ran on (`dirty` when the tree had uncommitted changes outside
`bench/`), the tier, suite, label, config, seeds, models, cost, wall time and every summary metric. A change is judged
against this history, not against memory. Only simulated data is recorded here.

## Tiers, cheapest first

| Tier | What it runs | Cost | Command |
|---|---|---|---|
| funnel | The hidden-context suites through Eden alone: the planted item followed through retrieval, cache and delivery; the decoy on control tasks | free, ~1 min | `bun packages/sim/src/lab/hidden-funnel.ts --suite hidden\|heldout` |
| sim | Simulation quality, realistic and held-out connector mixes, no judge and the perfect judge, 4 seeds | free, minutes | `bun packages/sim/src/lab/bench.ts` (runs funnel, sim and eval) |
| eval | The 27 hand-labelled scenarios, no model | free, seconds | (in `bench.ts`) |
| agent | A live agent on the tasks under each condition, graded by a second model | ~$0.3–1 per run | `agent-ab.ts` then `agent-ab-report.ts <file> --record <label>` |

Run the free tiers on every change to retrieval or delivery, under a label (`--label probes --config '{...}'`); run
the agent tier when the free tiers say a change is worth its cost.

## Suites

- **lookups**: requests that name what they need ("What time is my Berlin flight?") and arriving messages, from the
  simulated sessions (`agent-ab.ts`, default suite).
- **hidden** (dev): ten templates whose answer depends on context the request does not ask for (a calendar clash, an
  invoice already paid, …), one item planted per world (`hidden-context.ts`). Designed with Eden's failures in view.
- **heldout**: twelve such templates written blind by a separate agent that never saw the engine or the dev templates
  (`hidden-heldout.ts`). The arbiter for anything tuned on dev.
- Each hidden suite has **controls**: the same request with a near-miss decoy planted instead (an event the next week,
  a different invoice paid, an out-of-office that ended). A good system raises the hidden fact and stays quiet on the
  decoy.

## Metrics

Funnel (per task, then averaged): `hiddenReturned`, `hiddenCached`, `hiddenDelivered` (the planted item reached the
agent, no model), `decoyDelivered` (noise on controls), `callsPerTask` (source calls), `msPerTask` (engine wall time,
sources instant); per template `delivered.<name>` and `decoy.<name>`.

Sim (summed over seeds): `recall`, `precision`, `hardFalseFires` of `silentTurns`, `softFireRate`, `modelCallsPerTurn`,
`sourceCallsPerLookup`, `observeP50Ms`/`observeP95Ms`, `deliveryP95Ms`, `injectionBytesP50`, `redundantShare`,
`noiseShare`, `askRecallAt5`, and per delivery reason `delivered.<reason>` / `precision.<reason>`. `recallStated` (a fact counts
only when three in four of its words are in the packet's line for the item) and `injectionBytesTotal`,
`bytesPerMustFact`, `bytesPerStatedFact` (injected bytes per needed fact: the packet's density).

Latency (`--latency`): the realistic simulation in real time (3 users × 6 sessions, perfect judge): `deliveryP50Ms`,
`deliveryP95Ms`, `observeP50Ms`, `observeP95Ms`, `recall`, `precision`, `sourceCallsPerLookup`. Small (about 29 facts)
and stepped by the agent's turns: compare with larger runs before believing a difference.

Suites (`suites.ts`): `hidden` (dev), `heldout`, `heldout2`, `heldout3`, `heldout4` (blind); `all` and `heldout-all`
for several. `bench.ts --suites`, `hidden-funnel.ts --suite`, `agent-ab.ts --suite`; the report takes several result
files and prints a per-suite table.

Eval: `recall`, `precision`, `falseFireRate`, latency, `secretsLeaked`, `notInert`, `askRecall`, per category.

Agent (per condition and task kind, `<condition>.<kind>.<metric>`): `hit` (share of needed facts the answer states;
for controls, the share that raised the false concern: lower is better), `success`, `modelCalls`, `toolCalls`,
`inTokens`, `outTokens`, `costPer1k` (agent plus Eden's judge, per 1,000 tasks), `edenCalls`, `injected`, `late`,
`wallP50`/`wallP95` (seconds), `leaks`; and `graderAgreement` (grader against a lexical check). Rows keep each
answer's first 300 characters for failure analysis.

## Comparing

```bash
bun packages/sim/src/lab/bench-compare.ts --list                       # every run
bun packages/sim/src/lab/bench-compare.ts --latest baseline probes     # newest of each label, every shared metric
bun packages/sim/src/lab/bench-compare.ts <id-a> <id-b> --metrics hit,cost
```

Per-task rows: `zcat bench/runs/<id>.jsonl.gz | head`.

## Reading it honestly

- Live agent runs vary run to run; compare paired differences on the same tasks (`agent-ab-report.ts` prints them with
  bootstrap intervals), not single numbers.
- The dev suite was written with Eden's failures in view: a gain there alone proves little. The held-out suite decides.
- Backfilled entries carry the commit they ran on and a note saying what differed.
