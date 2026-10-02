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
bun benchmarks/memory-long-horizon/harness/replay.ts            # the canonical session through plugins/eden-memory
bun benchmarks/memory-long-horizon/harness/replay.ts --seed 17  # one R6-shaped session
bun benchmarks/memory-long-horizon/harness/replay.ts --out /tmp/run --plugin path/to/plugin --flush eager
```

It prints a JSON summary (events per point, exit codes, fail-open counts, latency, contexts, transcript size and
a digest that two runs of one script share). `--out` keeps the run directory, with `script.json` and
`events.jsonl`.

| File | Role |
|---|---|
| `payloads.ts` | The 13 hook payloads (SessionStart, InstructionsLoaded, UserPromptSubmit, Pre/PostToolUse, PostToolUseFailure, PostToolBatch, SubagentStart/Stop, Stop, Pre/PostCompact, SessionEnd), field for field |
| `transcript.ts` | The session transcript: line kinds, field order, `parentUuid` chains, rewinds, compaction, subagent files; written lagging (R0 F8) or eagerly |
| `runner.ts` | Runs a plugin's `hooks/hooks.json`: matchers, one process per handler, timeouts, environment, and stdout read by Claude Code's rules |
| `session.ts` | The simulator: prompts, non-human submits, tool batches, subagents, compaction, resume, `/clear`; applies what hooks answer |
| `shape.ts` | The R6-shaped session generator (A5 §3.8), the script format and its player |
| `tools.ts` | Read, Edit, Write, Bash and Agent calls in every shape Claude Code reports them |
| `fixtures/` | Text-free references captured from real sessions (key lists only), and the probe plugin the self-tests use |

Every run lives in its own directory: hooks get `HOME`, `EDEN_HOME` and `EDEN_MEMORY_DIR` inside it, and inherit
nothing else from the caller but `PATH`, `TMPDIR` and `LANG`. The world oracle, the simulated context window and
annotated cues come next (P0.0b), then the A5 arms (P0.0c).
