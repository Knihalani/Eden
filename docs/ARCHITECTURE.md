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
| `packages/primitives` | Benchmarked building blocks: hashing, tokenizer + interner, multi-pattern matcher, top-k, BM25F sparse index, S3-FIFO cache, deadline, singleflight, GCRA, circuit breaker, AIMD limiter, histogram, reply stripping and near-duplicate sketches, calibration and certification statistics, Thompson sampling, budgeted packing, worker pool (D25, D26) ([research/primitives.md](research/primitives.md)). |
| `packages/redact` | The secret gate (salvaged): gitleaks rules plus extras, prefiltered by one Aho–Corasick pass; the rules that backtrack in JavaScript and every allowlist run on RE2 (re2js, D24). Runs on everything stored, indexed or sent to a model. |
| `packages/sources` | `Source` interface; `McpSource` (any MCP server's read tools, read-only enforced; arguments from the tool's schema when no mapping is given; an optional fetch tool that reads one record by id, D35, not yet behind `SourceFanout`'s guards or redaction); `StaticSource`; `QueryPlanner` (what each lookup sends to each connector, learned per user; D28, on by default in the server since D33); `SourceFanout`: per-source deadlines, coalescing, a result cache that serves stale on failure, rate limits, circuit breakers and adaptive concurrency, redacting before anything is held. |
| `packages/graph` | The source map (knowledge graph layer 1): which sources mention which entities, and learned usefulness per situation. SQLite. |
| `packages/llm` | `Model` interface, OpenRouter client (ZDR, no data collection), pricing, `Budget`, `FakeModel`. |
| `packages/engine` | `ContextPartner`: cues, a per-user BM25F item cache (title, body), near-duplicate suppression, ledger, two-speed pipeline, model judge, usage inference, traces. Each event is tokenized once, into a per-session vocabulary. |
| `packages/server` | HTTP API (tenant API keys, per-tenant rate limit: `EDEN_TENANT_RPS`, `EDEN_TENANT_BURST`), MCP server exposing `ask_context`, config, wiring; an optional worker pool that redacts lookup results (`EDEN_GATE_WORKERS`, D26). |
| `packages/client` | SDK for agent builders: `EdenClient` (fail-open) and `withContext` for message lists. |
| `packages/eval` | Scenario harness over 26 hand-written scenarios (docs/research/eval-suite.md): precision, recall, false-fire rate, overall and per category; a privacy check (planted secrets, inert framing); direct asks; model calls and cost per turn, latency. |
| `packages/sim` | Simulation: generated worlds and sessions with fact-level ground truth, connectors that behave like real ones, an oracle judge, and the real server under simulated agents over HTTP ([research/simulation.md](research/simulation.md)); the connector lab, open-source MCP servers over seeded backends in isolated containers ([research/connector-lab.md](research/connector-lab.md)). Not product code. |
| `examples/personal-agent` | A minimal agent loop wired to Eden. |

## Identity and isolation

Tenant (our customer) → user (their end user) → session (one conversation or task run). The API key fixes the tenant.
Every cache, source-map row and budget is keyed by `tenant/user`; session state by `tenant/user#session`. Nothing
crosses a user boundary. Cross-user learning, if ever added, may share only content-free aggregates
(see [DECISIONS.md](DECISIONS.md) D9).

## The two speeds

**Fast path** (every event, no network call and no model call, a few ms; it may write learning outcomes to the local
SQLite source map): build a cue (entities, content terms, situation), look it up in the user's item cache, and
deliver only if an item names a cue entity as whole words, covers most of the query, and holds at least two of its
terms (D6: `confidentScore` > 1 by construction, since idf-weighted coverage is at most 1, plus an entity bonus).
An item a recent tool result or agent message holds whole is never pushed (an ask still returns it), and bulk mail
is never pushed without a model (D34). A cached copy older than two hours is never delivered from here: its cue goes
to the slow path, which delivers the source's current copy when its live search returns it (and the cached one if it
does not: a source down, or a search that no longer finds the item; D40).

**Slow path** (background; at most one per session at a time): rank the user's sources with the source map, search
the top few live (each under its own deadline), cache the redacted results, record entity mentions, and re-score.
A confident item is delivered with no model. Borderline candidates go to the model judge, whose default is
"none", only if the budget allows. With no model (or no budget), the best candidate alone is delivered if it holds
three or more query terms and scores at least 0.8 (coverage plus the entity bonus; D36). The result is returned
directly if the caller passed `waitMs` and it landed in time; otherwise it is queued and delivered with the next
event (or via `/v1/pending`).

**Ask** always searches live (more sources), ignores the not-twice ledger (the agent asked), and uses one model call
to compose a cited answer when a model and budget are available; otherwise it returns the cited items as is.

## Learning loop

When an injection is handed to the agent, it records its distinctive tokens (tokens the session had not seen). A
later agent message or tool call that repeats them marks the injection *used*; an injection with no sign of use within
`usageWindowTurns` is *unused*. Feedback may arrive after the session ends: each user's recorded outcomes outlive
their sessions (bounded), so it can still correct them.
Each outcome updates a Beta posterior per (user, situation, source) in the source map, which routing reads. Explicit
feedback from the integration (`/v1/feedback`) overrides the inference, correcting an outcome already recorded (D18).

## Session lifecycle

Sessions live in memory, capped per tenant and dropped when idle. Each owns an AbortController: session_end,
eviction and `forget` abort in-flight lookups and model calls, and nothing is cached, learned, charged or queued for a
closed session afterwards (D17).

## What is deliberately missing (see ROADMAP.md)

Per-user MCP connections with OAuth and a token vault; persistent session state;
streaming delivery; the OpenAI-compatible injecting proxy; a richer graph (entity resolution, relations, freshness);
learned situation classification; per-agent (not just per-user) learning; multi-instance deployment.
