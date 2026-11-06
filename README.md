# Eden

**A context partner for agents.** Eden runs beside a personal or proactive agent, reads the user's connected sources
(mail, calendar, docs, CRM, memory stores, anything with MCP read tools), answers the agent's questions, and puts the
context the agent needs in front of it before it knows to ask. Most of the time it stays silent.

- **Not a subagent.** A subagent only answers what the agent thinks to ask. Eden watches the session and speaks first.
- **Model as last resort.** Cues, a learned source map and a local index decide most turns, with no model call.
  With `OPENROUTER_API_KEY` set, one model (`EDEN_MODEL`, default Claude Haiku 5.5 via OpenRouter, ZDR routing) writes
  implication cards and the intent index in the background and reads the candidates for a request that acts, under
  per-session budgets and a per-tenant daily cap; without a key the same default runs its no-model path.
- **Read-only, per-user, redacted.** It never calls a write tool; users never share state; secrets are scrubbed
  before anything is stored or sent to a model.

Start with [docs/VISION.md](docs/VISION.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

Needs [Bun](https://bun.sh) 1.3+.

```bash
bun install
bun run check                      # format, typecheck, tests
bun run eval                       # seed scenarios, no model (free, deterministic)
OPENROUTER_API_KEY=… bun run eval --live --usd-cap 0.05   # the shipped wiring, hard spend cap (D128)

# The API, with example sources and no auth:
EDEN_DEV=1 EDEN_SOURCES_FILE=examples/personal-agent/sources.json EDEN_TRACE=1 bun run dev
curl -s -X POST 'localhost:8790/v1/events?waitMs=1000' \
  -d '{"userId":"u","sessionId":"s","kind":"user_message","text":"What time is lunch with Priya Raman?"}'
```

## Integrating an agent

```ts
import { EdenClient, withContext } from "@eden/client";

const eden = new EdenClient({ apiKey, userId, sessionId }); // a sent user message waits up to 3 s for its lookup
const { injection } = await eden.observe({ kind: "user_message", text });  // report each event
messages = withContext(messages, await eden.collect(injection));           // before each model call
const answer = await eden.ask("What did Dana say about the renewal?");     // or expose as a tool
```

MCP-capable agents can also use the `ask_context` tool: `bun packages/server/src/mcp-stdio.ts` serves it over stdio for
one user (`EDEN_USER`, `EDEN_TENANT`), and `createMcpServer` attaches it to any other MCP transport. A full loop:
[examples/personal-agent/agent.ts](examples/personal-agent/agent.ts), run with the dev server above; without
`OPENAI_API_KEY` it runs a scripted offline model, free.
[docs/INTEGRATION.md](docs/INTEGRATION.md) has advice on placement, caching and cost (unmeasured).

Without a wait, a user message's observe replies before a slow lookup ends and its context misses the first model
call, so the client waits up to 3,000 ms on each sent user message by default (D105, D112) and the server replies as
soon as the lookup ends; `defaultWaitMs: 0` (or `waitMs` per call) overrides it, see
[docs/INTEGRATION.md](docs/INTEGRATION.md).

Both servers run the engine's one default (`DEFAULT_CONFIG`, D112), the best measured configuration: probes, the
no-model grounds, the knowledge graph, anticipation, background sync, implication cards, the intent index and the
ask-time reader. With `OPENROUTER_API_KEY` set, the cards, the intent index and the reader run on `EDEN_MODEL` (default
`anthropic/claude-haiku-5.5`), each role under its own budget and all of a tenant's roles under one cap per UTC day
(`EDEN_MODEL_USD_PER_TENANT_DAY`, default $25); no judge is wired. Without a key no role is built and the same default
answers from its no-model paths. The HTTP server runs one process per core by default (`EDEN_PROCESSES`, the core
count capped at 64, D178), each user pinned to one, and every process holds 1/N of each per-tenant cap (the $25 model
cap, `EDEN_TENANT_RPS` 200 and `EDEN_TENANT_BURST` 400): on 4 cores a tenant whose traffic comes from one user gets
$6.25 a day, 50 rps and a burst of 100. Raise the caps or set `EDEN_PROCESSES=1` for such a tenant; in a container
with a CPU quota set `EDEN_PROCESSES` to the quota (see [docs/INTEGRATION.md](docs/INTEGRATION.md), "Processes"). To change a setting, or take a part out (`PARTS` in `packages/engine/src/parts.ts`),
point `EDEN_ENGINE_CONFIG` at a JSON file of engine settings (`packages/engine/src/config.ts`); an unknown key, a wrong
type, a number out of its range or a setting that would do nothing stops startup with a message naming it (D103).
Trial switches (such as the action firewall, `actionCheck`) stay off until measured;
[docs/profiles/](docs/profiles/README.md) holds "default minus a part" files, and docs/DECISIONS.md lists the trials
with their owners and end dates.
`EDEN_SOURCES_FILE` holds static documents only, since that file's sources are shared by every user. Each user's MCP
connectors, with their own credentials, go in `EDEN_USER_SOURCES_FILE` or an embedding's `SourceDirectory` (D108,
docs/INTEGRATION.md).

## Repository

| Path | What it is |
|---|---|
| `packages/protocol` | Wire types, ids, validation |
| `packages/engine` | The partner: cues, cache, two-speed pipeline, the default's parts, learning |
| `packages/sources` | Source interface, MCP read-only source, fan-out |
| `packages/graph` | Source map: who holds which entities, what helps when |
| `packages/llm` | OpenRouter client, pricing, budgets and the per-tenant daily cap |
| `packages/redact` | Secret gate |
| `packages/server` | HTTP API and MCP server; runs the default and wires the model roles |
| `packages/client` | SDK for agent builders |
| `packages/eval` | Scenario harness and metrics |
| `docs/` | Vision, architecture, decisions, roadmap, cost, privacy, research |
| `archived/` | Earlier products (passive memory for coding agents; compile era; observability). History, not code |

## Status

M0 (scaffold) done. Next: M1, an eval worth tuning against. See [docs/ROADMAP.md](docs/ROADMAP.md).
