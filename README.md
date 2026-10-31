# Eden

**A context partner for agents.** Eden runs beside a personal or proactive agent, reads the user's connected sources
(mail, calendar, docs, CRM, memory stores, anything with MCP read tools), answers the agent's questions, and puts the
context the agent needs in front of it before it knows to ask. Most of the time it stays silent.

- **Not a subagent.** A subagent only answers what the agent thinks to ask. Eden watches the session and speaks first.
- **Model as last resort.** Cues, a learned source map and a local index decide most turns, with no model call.
  A cheap model (GLM 5.3 Flash via OpenRouter, ZDR routing) judges only borderline cases, under a hard budget.
- **Read-only, per-user, redacted.** It never calls a write tool; users never share state; secrets are scrubbed
  before anything is stored or sent to a model.

Start with [docs/VISION.md](docs/VISION.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

Needs [Bun](https://bun.sh) 1.3+.

```bash
bun install
bun run check                      # format, typecheck, tests
bun run eval                       # seed scenarios, no model (free, deterministic)
OPENROUTER_API_KEY=… bun run eval --live

# The API, with example sources and no auth:
EDEN_DEV=1 EDEN_SOURCES_FILE=examples/personal-agent/sources.json EDEN_TRACE=1 bun run dev
curl -s -X POST 'localhost:8790/v1/events?waitMs=1000' \
  -d '{"userId":"u","sessionId":"s","kind":"user_message","text":"What time is lunch with Priya Raman?"}'
```

## Integrating an agent

```ts
import { EdenClient, withContext } from "@eden/client";

const eden = new EdenClient({ apiKey, userId, sessionId });
const { injection } = await eden.observe({ kind: "user_message", text });  // report each event
messages = withContext(messages, await eden.collect(injection));           // before each model call
const answer = await eden.ask("What did Dana say about the renewal?");     // or expose as a tool
```

MCP-capable agents can also use the `ask_context` tool: `bun packages/server/src/mcp-stdio.ts` serves it over stdio for
one user (`EDEN_USER`, `EDEN_TENANT`), and `createMcpServer` attaches it to any other MCP transport. A full loop:
[examples/personal-agent/agent.ts](examples/personal-agent/agent.ts).
[docs/INTEGRATION.md](docs/INTEGRATION.md) has advice on placement, caching and cost (unmeasured).

## Repository

| Path | What it is |
|---|---|
| `packages/protocol` | Wire types, ids, validation |
| `packages/engine` | The partner: cues, cache, two-speed pipeline, model judge, learning |
| `packages/sources` | Source interface, MCP read-only source, fan-out |
| `packages/graph` | Source map: who holds which entities, what helps when |
| `packages/llm` | OpenRouter client, pricing, budgets |
| `packages/redact` | Secret gate |
| `packages/server` | HTTP API and MCP server |
| `packages/client` | SDK for agent builders |
| `packages/eval` | Scenario harness and metrics |
| `docs/` | Vision, architecture, decisions, roadmap, cost, privacy, research |
| `archived/` | Earlier products (passive memory for coding agents; compile era; observability). History, not code |

## Status

M0 (scaffold) done. Next: M1, an eval worth tuning against. See [docs/ROADMAP.md](docs/ROADMAP.md).
