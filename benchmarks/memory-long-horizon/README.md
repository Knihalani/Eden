# Long-horizon runner

Inflated-duration coding-agent exam: 18 months, 36 months, and 5 years of turns, cap 2000 and 10000, in-process inject **and** spawn-reload (Claude hook = new process).

Protocol and dated numbers: `docs/memory-ship/02-LONG-HORIZON.md`.  
Last run: `RESULTS.json`.

```bash
bun benchmarks/memory-long-horizon/run.ts
```

Does not replace `.whatever/benches/scale.ts`.

## Harness v2: Claude-shaped sessions, one process per hook (`harness/`, P0.0a)

A simulator of Claude Code sessions for the memory program (A5 §3). It drives a plugin's real hooks the way
Claude Code does: every hook event of a session, each handler in a fresh process, with the payloads, the
transcript and the event order of Claude Code 2.1.285.

```bash
bun benchmarks/memory-long-horizon/harness/replay.ts             # the canonical session through plugins/eden-memory
bun benchmarks/memory-long-horizon/harness/replay.ts --seed 17   # one R6-shaped session
bun benchmarks/memory-long-horizon/harness/replay.ts --world 1   # the world scenario of seed 1: sessions, oracle, cues
bun benchmarks/memory-long-horizon/harness/replay.ts --soak 1000 # the latency soak
bun benchmarks/memory-long-horizon/harness/replay.ts --out /tmp/run --plugin path/to/plugin --flush eager
bun benchmarks/memory-long-horizon/harness/aa.ts                 # the A/A: noise floors of every metric
```

It prints a JSON summary (events per point, exit codes, fail-open counts, latency, contexts, transcript size, a
digest that two runs of one script share, and the A5 §2 metrics). `--out` keeps the run directory, with
`scenario.json`, `events.jsonl` and the oracle files under `oracle/` (`oracle.jsonl`, `cues.jsonl`,
`deliveries.jsonl`).

| File | Role |
|---|---|
| `payloads.ts` | The 13 hook payloads (SessionStart, InstructionsLoaded, UserPromptSubmit, Pre/PostToolUse, PostToolUseFailure, PostToolBatch, SubagentStart/Stop, Stop, Pre/PostCompact, SessionEnd), field for field |
| `transcript.ts` | The session transcript: line kinds, field order, `parentUuid` chains, rewinds, compaction, subagent files; written lagging (R0 F8) or eagerly |
| `runner.ts` | Runs a plugin's `hooks/hooks.json`: matchers, one process per handler, timeouts, environment, and stdout read by Claude Code's rules |
| `session.ts` | The simulator: prompts, non-human submits, tool batches, subagents, compaction, resume, `/clear`; applies what hooks answer |
| `shape.ts` | The R6-shaped session generator (A5 §3.8), the script format and its player |
| `tools.ts` | Read, Edit, Write, Bash and Agent calls in every shape Claude Code reports them |
| `oracle.ts` | The world oracle (A5 §3.4): the true value of every slot and policy at every event, by scope |
| `window.ts` | The simulated context window (A5 §3.5): what each window's model sees on the current branch |
| `cues.ts` | Annotated cues (A5 §3.6): `needs`, `allowed`, scope and turn mode on every scripted human prompt |
| `statements.ts` | Reading packets and windows: bullets, normalized content, the values a text states |
| `metrics.ts` | The A5 §2 metrics of a run, from the oracle files only |
| `world.ts` | World scenarios: a storyline woven into R6-shaped sessions in one repo |
| `aa.ts` | The A/A: a plugin against itself in fresh processes, and each metric's noise floor |
| `fixtures/` | Text-free references captured from real sessions (key lists only); the probe and scripted plugins the self-tests use; the demo world and its storyline |

Every run lives in its own directory: hooks get `HOME`, `EDEN_HOME` and `EDEN_MEMORY_DIR` inside it, and inherit
nothing else from the caller but `PATH`, `TMPDIR` and `LANG`. The oracle files sit beside them, outside anything a
hook is pointed at, and no product code imports the harness (`independence.test.ts`).

## The A5 §4 arms (`arms/`, `arms.json`, P0.0c)

Each of A5 §4's 44 arms is a script played through a plugin's hooks in the simulator (or, for the fixture arms, a
product entry point driven as a process), returning named checks. A failing check names the A5 assertion, or a
control the assertion needs, that did not hold. `arms.json` records, per arm and flag state, whether it passes on
today's `plugins/eden-memory` and, when not, exactly which checks fail and why.

```bash
bun benchmarks/memory-long-horizon/arms/run.ts                         # every arm, every recorded flag state
bun benchmarks/memory-long-horizon/arms/run.ts --arm negation --flags on
bun benchmarks/memory-long-horizon/arms/run.ts --scale full --json     # A5's full sizes (scoped's 15840 turns, …)
```

- **Flag states (X7).** `on` runs with no flag file. `off` and `shadow` write `~/.eden/flags.json` with every
  delivery-point flag set to that value, and are judged by generic checks: `off` is identity (exit 0, nothing printed
  at a delivery point, no context or decision, no ledger); `shadow` also writes the shadow ledger and wide events.
- **The gate** (`arms/<group>.gate.test.ts` calling `gate("<group>")`, groups in `arms/groups.ts`): CI runs every
  arm's `on` state, and `off` and `shadow` for one cheap arm per group, at CI scale. It fails when a red state fails
  any other set of checks, or passes, or a green state fails (EXECUTION X4). `run.ts` checks every state of every
  arm; a slice runs it on its arms. Update `arms.json` only with the evidence of a run. A check listed as
  `unstable` is one today's plugin flips between identical runs.
- **References** (`arms/reference.ts`, run by `arms/<group>.reference.test.ts` and `run.ts --reference`): every arm
  also passes against the scripted plugin in reference mode with the arm's answer table and against
  `arms/fixtures/reference-cli.ts`, so no arm is unsatisfiable or vacuous.
- **Entry points the arms define**, run in the repo with the hooks' environment (each arm's header has the
  contract): `eden memory dump --json` (spawn-writers), `eden memory remember --jsonl -` (CueBench, policy-trigger,
  alias-batch, scale), `eden memory extract --jsonl -` (extraction), `eden memory scopes --json <path>…` (R5 rows),
  `eden memory migrate --dry-run --json | --apply | --rollback` with `EDEN_MIGRATE_CRASH_AFTER` (migrate),
  `eden memory aliases --batch FILE --json` (alias-batch), `eden sleep --idle --after 0` (arms after sleep).
- **The clock.** Every arm world hands hooks and the CLI the simulated time as `EDEN_NOW` (epoch ms), so a product
  that honours it sees the days a script skips (intent expiry, a gotcha a week later).

| File | Role |
|---|---|
| `arms.json` | The record: per arm, its slices, A5 text, and each flag state's measured outcome |
| `arms/kit.ts` | Checks, runs in fresh directories, flag runs and their generic checks, the scripted-user driver, the CLI call |
| `arms/floor.ts`, `secrets.ts`, `writers.ts`, `migrate.ts` | Correctness and safety arms |
| `arms/place.ts`, `scope-rows.ts` | Place and scope arms, and the R5 §9.3 + R3 F9 rows |
| `arms/delivery.ts` | Delivery arms (G5) |
| `arms/policy.ts`, `facts.ts` | Policy, guard, fact and cue arms (G1) |
| `arms/cuebench.ts`, `bench.ts`, `extraction.ts`, `scale.ts` | Fixture arms: R1/R8 CueBench, triggers, aliases, E3, the 20k/1e6 world |
| `arms/gate.ts`, `record.ts`, `registry.ts`, `run.ts` | The gate, the record, the arm registry, the runner |
| `arms/reference.ts`, `reference-suite.ts`, `fixtures/reference-cli.ts` | The references every arm passes against, and their suite |
| `arms/fixtures/world.ts`, `legacy-v1.json` | The arms' world (oracle data), and pre-P0.5 stores for `migrate` |
