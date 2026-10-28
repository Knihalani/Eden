# Roadmap

Each milestone ends with an eval run whose numbers go in its PR. Order is a proposal; the founder re-orders.

## M0 — Scaffold (done, 2026-10-27)
Packages, two-speed engine, source map, OpenRouter client, HTTP/MCP server, SDK, eval harness with one seed scenario.

## M1 — An eval worth tuning against
In progress: `packages/sim` generates worlds and labelled sessions at scale and reports per-task and no-model /
with-model (modelled judge) splits ([research/simulation.md](research/simulation.md)). Still to do: a live-model run, a
train / held-out split for tuning, hand-written adversarial scenarios, and text not written by templates.
- 20+ scenarios across personal-agent jobs: scheduling, inbox triage, follow-ups, travel, purchases, relationships,
  with gold `expect` labels, including many must-stay-silent turns and adversarial ones (prompt injection in mail).
- Report per-situation metrics, and the no-model / with-model split.
- Tune `confidentScore`, `candidateScore`, `entityBonus` on a train split; report on a held-out split.
- Measure how often inferred usage (D13) agrees with labels.

## M2 — Real connectors
- Per-user `McpSource` connections over streamable HTTP with OAuth; a token vault interface (tenant-supplied or ours).
- Per-server search-argument mappings for the first connectors (Gmail, Google Calendar, Notion, Slack, a memory
  product such as Supermemory or Mem0) and a `fetch` mapping for refresh.
- Connector revocation → `forget(scope, sourceId)`.
- An adaptive query planner per (user, connector): what to send, learned from outcomes
  ([plans/query-planner.md](plans/query-planner.md)). Built and opt-in (D28,
  [research/query-planner-results.md](research/query-planner-results.md)); its shadow mode was measured in simulation
  (D29). Iterating on it: a learned cascade gate (D30) and reusing recent answers cut its extra calls by 12–14% and
  then 7–12% with recall within noise; a deadline check cut the calls it gave up on (timeouts and session ends) by
  71–79% (margin chosen on the same runs). The default-on gate (D31, D32) is open only on those (still 3–6x
  planner-off's). Next: the remaining ones, the planner's learning cost, delivery and usage rewards. Its evidence:
  a source survey of real MCP servers ([research/connectors.md](research/connectors.md)) and the connector lab, where the query Eden
  sent reached nothing on whole-string-substring connectors ([research/connector-lab.md](research/connector-lab.md)).

## M3 — The graph, layer 2
- Entity resolution (aliases, email ↔ name), typed relations (person–company–project), freshness per source.
- Background sync for sources that support it, so the fast path warms without waiting for a lookup.
- Situation classifier learned from labelled traffic (replace keyword rules).

## M4 — Learning per agent
- Utility keyed by (agent, situation, source), not just user, so one tenant's assistants learn separately.
- Explicit feedback hooks in the SDK; bandit-style exploration so new sources earn a place.
- Cost-aware routing: skip sources whose expected value is below their latency or cost.

## M5 — Production
- Persistent session state (Redis or SQLite), multi-instance, rate limits per tenant, metrics and tracing export.
- OpenAI-compatible injecting proxy (port the archived `packages/wrap` approach) for agents that cannot add the SDK.
- Streaming delivery (SSE) for long-running proactive agents.
- DPA template, subprocessor list, data-flow diagram for tenants (PRIVACY.md).

## M6 — Beyond
- Coding-agent read tools (explicitly out of scope today, D1).
- Fine-tuned small judge model (the Meta paper trains Qwen3.5-27B with SFT + GRPO) to cut cost and latency further.
