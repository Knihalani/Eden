# Architecture

```
            agent (tenant's)                                 Eden context partner
 ┌─────────────────────────────┐   events    ┌──────────────────────────────────────────────────────────┐
 │ user msg / agent msg / tool │ ──────────▶ │ server (HTTP API, MCP ask_context)                        │
 │ call / tool result / external│            │   │                                                       │
 │                             │ ◀────────── │   ▼                                                       │
 │ prompt ← withContext(inj)   │  injection  │ engine: ContextPartner                                    │
 │ tool:   ask_context(q)      │ ◀─answer─── │   observe ─▶ cue ─▶ FAST: item cache (BM25) ─▶ confident? │
 └─────────────────────────────┘             │                     │ no                       │ yes → inject│
                                             │                     ▼                                     │
                                             │              SLOW (background): route (graph) ─▶ sources  │
                                             │                ─▶ cache ─▶ score ─▶ confident? inject      │
                                             │                ─▶ borderline? model judge (budget) ─▶ inject│
                                             │                ─▶ queue; delivered at the next event       │
                                             │   usage inference ─▶ graph.recordOutcome (learning)       │
                                             └──────────────────────────────────────────────────────────┘
                                                  │ read-only            │ ZDR routing
                                                  ▼                      ▼
                                       user's sources (MCP)       OpenRouter (GLM 5.3 Flash)
```

## Packages

| Package | Role |
|---|---|
| `packages/protocol` | Wire types (`AgentEvent`, `ContextItem`, `Injection`, `AskRequest`…), ids, input validation. |
| `packages/redact` | The secret gate (salvaged): gitleaks rules plus extras. Runs on everything stored, indexed or sent to a model. |
| `packages/sources` | `Source` interface; `McpSource` (any MCP server's read tools, read-only enforced); `StaticSource`; fan-out with per-source deadlines. |
| `packages/graph` | The source map (knowledge graph layer 1): which sources mention which entities, and learned usefulness per situation. SQLite. |
| `packages/llm` | `Model` interface, OpenRouter client (ZDR, no data collection), pricing, `Budget`, `FakeModel`. |
| `packages/engine` | `ContextPartner`: cues, BM25 item cache, ledger, two-speed pipeline, model judge, usage inference, traces. |
| `packages/server` | HTTP API (tenant API keys), MCP server exposing `ask_context`, config, wiring. |
| `packages/client` | SDK for agent builders: `EdenClient` (fail-open) and `withContext` for message lists. |
| `packages/eval` | Scenario harness: precision, recall, false-fire rate, model calls and cost per turn, latency. |
| `examples/personal-agent` | A minimal agent loop wired to Eden. |

## Identity and isolation

Tenant (our customer) → user (their end user) → session (one conversation or task run). The API key fixes the tenant.
Every cache, source-map row and budget is keyed by `tenant/user`; session state by `tenant/user#session`. Nothing
crosses a user boundary. Cross-user learning, if ever added, may share only content-free aggregates
(see [DECISIONS.md](DECISIONS.md) D9).

## The two speeds

**Fast path** (every event, no I/O beyond memory, a few ms): build a cue (entities, content terms, situation), look
it up in the user's item cache, and deliver only if an item both names a cue entity and covers most of the query
(`confidentScore` > 1 by construction: idf-weighted coverage of at most 1, plus an entity bonus).

**Slow path** (background; at most one per session at a time): rank the user's sources with the source map, search
the top few live (each under its own deadline), cache the redacted results, record entity mentions, and re-score.
A confident item is delivered with no model. Borderline candidates go to the model judge, whose default is
"none", only if the budget allows. The result is returned directly if the caller passed `waitMs` and it landed in
time; otherwise it is queued and delivered with the next event (or via `/v1/pending`).

**Ask** always searches live (more sources), ignores the not-twice ledger (the agent asked), and uses one model call
to compose a cited answer when a model and budget are available; otherwise it returns the cited items as is.

## Learning loop

Every injection records its distinctive tokens (tokens the session had not seen). A later agent message or tool call
that repeats them marks the injection *used*; an injection with no sign of use within `usageWindowTurns` is *unused*.
Each outcome updates a Beta posterior per (user, situation, source) in the source map, which routing reads. Explicit
feedback from the integration (`/v1/feedback`) overrides the inference.

## What is deliberately missing (see ROADMAP.md)

Per-user MCP connections with OAuth and a token vault; persistent session state (sessions are in memory);
streaming delivery; the OpenAI-compatible injecting proxy; a richer graph (entity resolution, relations, freshness);
learned situation classification; per-agent (not just per-user) learning; multi-instance deployment.
