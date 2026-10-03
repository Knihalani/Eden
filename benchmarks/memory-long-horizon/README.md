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
hook is pointed at, and no product code imports the harness (`independence.test.ts`). The A5 arms come next
(P0.0c).
