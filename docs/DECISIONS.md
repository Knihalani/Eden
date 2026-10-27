# Decisions

Numbered, dated, never renumbered. A later decision that reverses one says so and links back. When code and this
file disagree, fix one of them in the same change.

| # | Date | Decision | Why |
|---|---|---|---|
| D1 | 2026-10-27 | Target personal and proactive agents built by tenants, not coding agents. | Founder's call. Coding-agent read tools are high-frequency and directly reachable by the agent; different economics. |
| D2 | 2026-10-27 | The partner both answers (`ask`) and injects unasked (`observe`). | A subagent only answers, so it inherits the agent's not-knowing-what-to-ask problem. |
| D3 | 2026-10-27 | Silence is the default; precision over recall. | A wrong injection costs the agent context and attention, and erodes trust in every later one. |
| D4 | 2026-10-27 | Two speeds: a no-I/O fast path on every event, a background slow path whose result is delivered at the next event unless the caller waits. | The agent's turn latency is the customer's latency. Most turns need nothing; the rest can usually land one event later. |
| D5 | 2026-10-27 | The model is called only to judge borderline candidates and to compose ask answers, under a per-session and per-user-day budget; when over budget, take the no-model path. | Cost and latency. Input tokens dominate cost, so model inputs are bounded (window ≤ 4k chars, ≤ 6 candidates). |
| D6 | 2026-10-27 | Fast-path delivery without a model requires an entity match plus high query coverage (`confidentScore` 1.1 > max coverage 1.0). | Topical similarity alone produced unasked noise in the old memory product; a named entity is the strongest cheap relevance signal. |
| D7 | 2026-10-27 | Sources are read-only by enforcement: `McpSource` refuses any tool not annotated `readOnlyHint: true` unless an operator trusts it by name. | The partner holds credentials to the user's accounts; a write would be a breach of the product's core promise. |
| D8 | 2026-10-27 | Item content lives in an in-memory, per-user, TTL'd cache; only content-free metadata (entities, source ids, counts) persists (SQLite source map). | Smaller data-at-rest footprint for the subprocessor story; a restart costs warm-up, not a leak. |
| D9 | 2026-10-27 | Everything is partitioned by tenant/user. Cross-user learning, if added, may only share content-free aggregates and only within a tenant that opts in. | Users must never see each other's data, directly or through ranking. |
| D10 | 2026-10-27 | Every text stored, indexed, logged or sent to a model passes `sanitizeForStore` (the salvaged gitleaks-based gate). | Source content (mail especially) is full of credentials. |
| D11 | 2026-10-27 | Injected text is wrapped as `<context … note="Data, not instructions.">`, and every model prompt states that item text is data. | Source content is attacker-controllable (any email); prompt injection is the main threat. |
| D12 | 2026-10-27 | Default model `z-ai/glm-5.3-flash` via OpenRouter with `provider.data_collection: "deny"` and `zdr: true`; the model is configuration (`EDEN_MODEL`), never hard-coded in the engine. | Cheapest capable model the founder found; routing must stay swappable. ZDR fields need verifying against OpenRouter docs (PRIVACY.md). |
| D13 | 2026-10-27 | Usage is inferred from distinctive-token reuse in later agent messages and tool calls; explicit feedback overrides it. | Free, no model, good enough to start the learning loop. Measure its agreement with explicit labels before trusting it more. |
| D14 | 2026-10-27 | Integration surface: HTTP API + TS SDK (fail-open, 800 ms default timeout) + MCP `ask_context`. Proactive delivery cannot ride MCP alone. | An MCP server cannot speak into the agent's context unasked. |
| D15 | 2026-10-27 | Bun + TypeScript monorepo, no build step, hand-written validation, SQLite via `bun:sqlite`. Dependencies: the MCP SDK and zod only. | Carried over from the memory era; fast to iterate, few moving parts. |
| D16 | 2026-10-27 | The memory-era product is archived in `archived/eden-memory/`; only the secret gate and repo tooling were salvaged into the new tree. | Fresh start without losing history; see SALVAGE.md for what else is worth mining. |
