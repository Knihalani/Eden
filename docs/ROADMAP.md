# Roadmap

Each milestone ends with an eval run whose numbers go in its PR. Order is a proposal; the founder re-orders.

## M0 — Scaffold (done, 2026-10-27)
Packages, two-speed engine, source map, OpenRouter client, HTTP/MCP server, SDK, eval harness with one seed scenario.

## M1 — An eval worth tuning against
In progress: `packages/sim` generates worlds and labelled sessions at scale and reports per-task and no-model /
with-model (modelled judge) splits ([research/simulation.md](research/simulation.md)). Still to do: a live-model run, a
train / held-out split for tuning, and text not written by templates.
- Done (2026-10-30): live-model runs. The judge's verdict was being cut off by its own token cap on reasoning models;
  fixed (D45, [research/live-judge.md](research/live-judge.md)), GLM 5.3 Flash kept as the default after comparing
  four cheap judges. An agent given search tools against the same agent with Eden
  ([research/agent-ab.md](research/agent-ab.md)): on explicit lookups, tools matched or beat Eden on recall and Eden
  beside tools added nothing measurable; Eden in place of tools cost 18–25% less. On the case Eden is for, context the
  agent was not asked for ([research/agent-hidden.md](research/agent-hidden.md)), tools raised it on 36% of tasks,
  Eden in place of them on 20–24%, Eden with its judge beside them on 40% (within noise of tools). Eden's one clear
  win is a note no search finds (7 of 8 against 2 of 8); its clear gap is scheduling: it never lists the named day.
- Done (2026-10-30, PoC): probes (D46, [research/probes.md](research/probes.md)), measured on a rebuilt benchmark
  with a blind held-out suite, decoy controls and a ledger of every run ([bench/](../bench/README.md)). Large gains
  in simulation and on the dev suite; on the held-out suite Eden's judge alone already beats tools (0.389 against
  0.264 of hidden facts raised) and probes add little over it there (+0.014, within noise), at twice the source calls
  and slower delivery. Next: a larger held-out suite, real connectors, and cutting probe latency.
- Done (2026-10-30, PoC): lean probes and dense packets (D47, [research/lean-probes.md](research/lean-probes.md)).
  Four blind held-out suites (57 templates): Eden with its judge and probes raises the hidden fact 1.63× as often as
  tools (0.614 against 0.377), false concerns +1.3 points; compaction cuts bytes per needed fact 30% with no measurable
  live loss. Cutting probe calls cost live accuracy, and Eden beside the agent's own tools did worse than Eden alone.
  Next: turn on probes with compaction behind a decision, real connectors, and why the agent with tools uses the packet
  less.
- Done (2026-10-30, PoC): sharper grounds, shared calls, denser packets (D48,
  [research/sharper-grounds.md](research/sharper-grounds.md)). Live on five blind held-out suites: Eden 0.602 of hidden
  facts raised against tools' 0.403, at 64% fewer probe calls; precision 0.949 in simulation; packets 39% smaller than
  probes'. Missed: 1.7× tools, cost below tools, no-model decoys. Next: semantic retrieval (about half of the hidden
  facts are never returned by a source), behind its own decision.
- Done (2026-10-30, PoC): a structural conflict test, a learned probe economy, dense packets, name-only quiet and a tied judge (D49–D55, [research/combined-config.md](research/combined-config.md), [research/serverless-bridge.md](research/serverless-bridge.md)), no model and no new dependency. Configuration H, no model, on seven held-out suites: 159 hidden facts delivered against 43 decoys (D48's F: 91 against 59 on six); simulation no-model recall 0.408 and soft fires 0.086, perfect-judge precision 0.952, 432 bytes per needed fact, model cost $0.0172 per 1,000 turns. Not measured live. Next: a live run of H against tools; semantic retrieval across the vocabulary gap (held-out 6 retrieves 29 of 80; a fixed consequence vocabulary gained 1 in 220 blind).
- Done (2026-10-28, [research/eval-suite.md](research/eval-suite.md)): 26 scenarios across personal-agent jobs with
  gold labels, many must-stay-silent turns and 6 adversarial scenarios (prompt injection, planted secrets, look-alike
  names); per-category metrics, a privacy check and direct asks in the report. Baseline with no model: precision
  0.833, recall 0.349, 3 false fires in 58 silent turns, no secret leaked; after plan item 6, precision 1.000 and no
  false fires, recall unchanged.
- Tune `confidentScore`, `candidateScore`, `entityBonus` on a train split; report on a held-out split. Lowering the
  bar raised false fires (the owner kept precision); a no-model fallback for the best candidate, tuned on zoo-tune,
  raised held-out recall with false fires unchanged (D36,
  [research/no-model-fallback.md](research/no-model-fallback.md)).
- Measure how often inferred usage (D13) agrees with labels.

## M2 — Real connectors
- Per-user `McpSource` connections over streamable HTTP with OAuth; a token vault interface (tenant-supplied or ours).
- Per-server search-argument mappings for the first connectors (Gmail, Google Calendar, Notion, Slack, a memory
  product such as Supermemory or Mem0) and a `fetch` mapping for refresh (built, D35; stale copies are kept off the
  fast path, and refetching through `fetch` is opt-in, D40).
- Connector revocation → `forget(scope, sourceId)`.
- An adaptive query planner per (user, connector): what to send, learned from outcomes
  ([plans/query-planner.md](plans/query-planner.md)). Built (D28) and on by default in the server (D33;
  [research/query-planner-results.md](research/query-planner-results.md)); its shadow mode was measured in simulation
  (D29). Iterating on it: a learned cascade gate (D30) and reusing recent answers cut its extra calls by 12–14% and
  then 7–12% with recall within noise; a deadline check cut the calls it gave up on (timeouts and session ends) by
  71–79% (margin chosen on the same runs). Expecting each connector's recent latency then brought
  them within noise of planner-off's rate per call (1.15–1.28x in absolute numbers). The other D31/D32 conditions
  hold in simulation; the owner read the timeout check per call and turned it on by default (D33). A greedy
  cascade with a runner-up prior then cut its learning cost (D38), and crediting the shape that retrieved a
  delivered item cut its calls per lookup by 3–6% (D39). Next: real-account evidence. Its evidence:
  a source survey of real MCP servers ([research/connectors.md](research/connectors.md)) and the connector lab,
  where the query Eden sent reached nothing on whole-string-substring connectors
  ([research/connector-lab.md](research/connector-lab.md)).

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
