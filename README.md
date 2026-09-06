# Eden

The agent still talks and still decides. Eden sits on the **tool path**: it records repeated tool stretches, compiles them into one inspectable program, and serves that program after a **human Approve**. The model does not author the loop each time — Eden mines it once from traces.

Compile does not Approve. It does not hit the network. Unique work is 0 programs, not a win. Compile does not mint a wrap candidate.

## Install

Needs [Bun](https://bun.sh). The CLI package is **`@kaiavn/eden`** (`eden` on npmjs is someone else). This tree is private — install from this clone, not a public registry.

```bash
bun install
alias eden='bun packages/cli/src/cli.ts'   # or: bun run cli -- <command>
eden init --dev
```

Hosted wrap (no local process): [https://useeden.vercel.app](https://useeden.vercel.app) — `POST /v1/signup`, then `eden login --url https://useeden.vercel.app --key <key>` and `OPENAI_BASE_URL=https://useeden.vercel.app/v1`. An Eden key is wrap auth, not OpenAI.

## Inspect (offline)

`eden compile --traces` prints a letter. It does not Approve. It does not hit the network. It does not mint a wrap candidate.

```bash
eden compile --traces examples/compile-traces/repeating
eden compile --traces examples/compile-traces/unique     # 0 programs
eden compile --traces examples/compile-traces/foreach     # letter names foreach
eden compile --traces examples/compile-traces/refuse     # underdetermined_write
eden compile --traces examples/compile-traces/branch     # letter names branch
eden compile --traces examples/compile-traces/poll       # letter names poll
eden compile --traces examples/compile-traces/cursor     # letter names cursor
eden compile --traces examples/compile-traces/offset     # letter names offset
```

## Wrap verdict (does not ship)

Wrap stores traces and compiles on `POST /v1/traces`. That mints a candidate. It does not turn a tool On. Toy example traces will show **FAIL**, **INCONCLUSIVE**, or **pending** until shadow certifies measured token or time savings — do not fake duration or tokens to force PASS. Default wrap may print `pending` / uncovered tools; a wrap that can replay still will not PASS these traces without measured savings.

```bash
eden wrap
eden import --traces examples/compile-traces/repeating
eden approve                    # FAIL / INCONCLUSIVE / pending until shadow certifies; cannot ship
```

## Play a compiled tool in one sitting

`eden demo` (same as `bun run demo`) is TicketShip: it compiles, Approves inside the demo, and plays **T-100**. Quote that demo. Do not fake metrics. From a clone it uses the local `eden_dev` key unless `EDEN_API_KEY` is already set.

```bash
eden demo
# then, if that wrap is still up:
eden play <name> --input '{"id":"T-100"}'
```

## Your own agent

Start wrap, then point the agent at it. Compile still does not Approve.

```bash
eden wrap
# OpenAI-compatible agents:
export OPENAI_BASE_URL=http://127.0.0.1:8788/v1
# keep OPENAI_API_KEY as the model key (an Eden key is wrap auth, not OpenAI)
# A compiled hit plays without a model key (model: eden). Miss fail-opens.
# JS:  import { runTool } from "@kaiavn/sdk"        — POST /v1/wrap, then /v1/ingest
# Py:  from eden import wrap_tools                  — same contract; wrap down runs original
```

Record through wrap. Then:

```bash
eden explain
eden approve <id> --yes         # human gate — the only On switch
eden play <name> --input '{...}'
```

See `examples/agent/` for a 20-line JS and Python wrap. A missing compiled tool or a down wrap runs the original callable.

`examples/compile-traces/` is shipped StretchTrace JSON. Open a file; compile the dir (inspect) or import it (wrap verdict). See `examples/compile-traces/README.md`.

Without `--yes`, `eden approve` prints the card (or FAIL / INCONCLUSIVE rows) and does not ship. A key never turns a tool On.

## Commands

```
eden init                 config, hooks, MCP
eden wrap                 local proxy at 127.0.0.1:8788
eden login --url --key    save a hosted key
eden compile --traces     letter (programs, refusals, turns-saved). Local only
eden import --traces      POST wrap /v1/traces. Does not Approve
eden explain              why nothing compiled
eden approve [--yes]     card; --yes ships canary
eden play <tool> --input  run an approved tool (generic JSON)
eden demo                 TicketShip: compile, Approve in the demo, play T-100, stays up
bun run demo              same sitting as eden demo
eden mcp --help           stdio MCP letter (does not start stdio)
eden claims               published limits board (wins, analogue, limits, retired)
eden doctor               health
```

`eden` with no args prints grouped help. GitHub-shaped `eden play <tool> --ids 11,12` still works; generic tools use `--input`.

## Honesty

- Repeating stretches can compile. Unique sequences compile **0 programs**. Sequential single-call turns do not benefit — that is not a token-savings win.
- Named refusals (e.g. `underdetermined_write`) are printed as refusals, not wins.
- Import + `eden approve` on the example traces is a **verdict**, not a ship. Shadow will not PASS toy traces without measured savings.
- The path that actually plays in one sitting is `eden demo` / `bun run demo` (TicketShip), not Approve → play from those examples.
- Wrap down: one sentence, not a stack dump. A broken Eden never breaks the agent (observe by default; hard guardrails are opt-in: `EDEN_ENFORCE=1`, `EDEN_STEER_HOOKS=1`).
- Published numbers live on `eden claims` (`PUBLIC_CLAIMS`). Do not quote a figure that is not on that board. Helix short-launch (already-live 12-step) is measured in `benchmarks/campaign/HELIX.md`.

## Safety model: a broken Eden never breaks your agent

Enforced in code (`packages/wrap/src/failsafe.test.ts`):

- **Default mode observes.** Eden records, measures, and steers where provably safe — it never blocks, halts, or refuses one of your agent's calls.
- **Every Eden failure falls back.** Corrupt state, a throwing program list, a crash in our own bookkeeping — your tool call executes as if Eden were absent.
- **The proxy never stands in the way.** Even a tripped kill switch only loses Eden its steering privilege; requests pass through.
- **Writes are never duplicated.** A compiled run that fails after a mutating step returns a structured result; read-only stretches replay raw automatically.
- **Hooks can't hang or deny by default.** The Claude Code hook answers "allow" on any internal error and races a hard timeout.

| Package | What it is |
| --- | --- |
| `@kaiavn/eden` | CLI: compile, wrap, demo, approve |
| `@kaiavn/sdk` | JS SDK: wrap tool calls onto compiled tools |
| `eden-agent` | Pure-stdlib Python SDK: same wrap/fallback contract |
