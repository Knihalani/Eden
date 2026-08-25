# Eden

The agent still talks and still decides. Eden sits on the **tool path**.

1. Record tool calls (cheap, local).
2. After a human approves on the site, host one compiled tool on our MCP.
3. Steer if the agent starts the old stretch anyway.

Approve only on the website. `eden open` is the browser. A key never turns a tool On.

## Install

```bash
npm i -g eden        # single-file bundle; requires Bun (https://bun.sh)
eden init            # config + hooks + MCP + health check in one step
```

Or run from a clone of this repo:

```bash
bun install
bun run --cwd apps/site dev          # dashboard at 127.0.0.1:8787
eden wrap                            # proxy at 127.0.0.1:8788
```

- Site + MCP: https://eden-murex-nine.vercel.app
- Local: `bun run --cwd apps/site dev` then `bun run packages/cli/src/cli.ts setup`

```
Dashboard  /dashboard
Setup      /onboarding
Workshop   /workshop
MCP        POST /mcp
```

## Safety model: a broken Eden never breaks your agent

Eden's prime directive, enforced in code and pinned by tests
(`packages/wrap/src/failsafe.test.ts`):

- **Default mode observes.** Eden records, measures, and steers where provably
  safe — it never blocks, halts, or refuses one of your agent's calls. Hard
  guardrails are opt-in (`EDEN_ENFORCE=1`, `EDEN_STEER_HOOKS=1`).
- **Every Eden failure falls back.** Corrupt state, a throwing program list,
  a crash in our own bookkeeping — your tool call executes exactly as if Eden
  were absent.
- **The proxy never stands in the way.** Even a tripped kill switch only loses
  Eden its steering privilege; requests pass through untouched, never a 409.
- **Writes are never duplicated.** A compiled run that fails after performing
  a mutating step returns a structured result the agent can act on; read-only
  stretches replay raw automatically.
- **Hooks can't hang or deny by default.** The Claude Code hook answers "allow"
  on any internal error and races a hard timeout; steering via hooks requires
  explicit opt-in.

| Package | What it is |
| --- | --- |
| `packages/sdk-js` | TS SDK: wrap tool calls so model traffic routes onto compiled tools |
| `packages/sdk-py` | Pure-stdlib Python SDK: same wrap/fallback contract, no dependencies |

## Measured claims

Every number is produced by a gated benchmark (`bun run bench`, `bench:loop`,
`bench:guard`) that must return WIN — paired, counterbalanced, replicated,
with a clean A/A cell — or it does not ship. Full map: `docs/waste-audit.md`.

- **8× fewer LLM calls** on a compiled stretch vs the raw loop it replaces.
- **4–7.9× faster** fan-out when read-only loops parallelise.
- **86% less spend** when the in-flight guard stops a runaway loop
  (5–12× across thrash shapes; guardrails on = enforcement mode).
