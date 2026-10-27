# Research notes

## Proactive Memory Agent (Meta, 2026)

Wu, Zhang, Zhou, Wang, Peng, Li, Fan, Zhao. *Remember When It Matters: Proactive Memory Agent for Long-Horizon
Agents.* arXiv:2607.08716, 9 July 2026. https://arxiv.org/abs/2607.08716

- Problem: "behavioral state decay": as trajectories grow, decision-relevant facts and open subgoals get buried or
  pushed out of context and stop shaping actions.
- Method: a memory agent beside an unmodified action agent. It updates a structured memory bank from recent steps
  and decides whether to inject a memory-grounded reminder or stay silent. Plug-and-play with frontier agents and
  existing harnesses.
- Results (abstract): +8.3 pp pass@1 on Terminal-Bench 2.0, +6.8 pp on τ²-Bench, for weaker and stronger action
  agents. Ablations: selective intervention vs passive bank exposure, always-on injection, advisor-only guidance,
  and general retrieval. The numbers for those ablations were not read yet: read the PDF.
- Open-weight: Qwen3.5-27B trained with SFT + GRPO on SETA as a memory policy, with partial transfer.

From the full paper (read 2026-10-27; details in [research/fast-primitives-notes/proactive_decision_and_routing.md](research/fast-primitives-notes/proactive_decision_and_routing.md)):
- Bank: a private status the action agent never sees, knowledge memories, procedural memories (attempts, failures,
  fixes). Phase 1 edits the bank with four tool calls; phase 2 emits a reminder or an explicit no-intervention.
  A reminder goes into the next call only and is never kept in history.
- It ran every step with an 8-message window. No cost or intervention-rate figures are reported.
- τ²-Bench ablation (macro / micro): selective 64.3 / 61.2, always inject 63.5 / 61.5, full-bank exposure
  61.5 / 58.6, Mem0 top-10 62.1 / 60.8, no bank 61.0 / 60.8. Always-inject ties on micro; silence buys balance
  across domains, and (for Eden) fewer tokens.
- An untrained Qwen3.5-27B memory agent hurt (reward 0.709 → 0.693); SFT then GRPO lifted it to 0.734.

What it means for Eden:
- Supports D2/D3: selective injection beats both silence and always-on.
- Their partner sees only the trajectory. Eden's also reads external sources, which is a harder routing problem and
  the reason for the source map.
- Their memory agent calls a model at each interval. Eden's design bets that most turns can be decided without one
  (D5). The eval must test that bet against a model-every-turn baseline.

To do: add an "always call the model" arm to `packages/eval` for a direct comparison. The paper's code repo (for the
verbatim prompts) was not reachable from the research session.

## Questions to answer with the eval

1. How much of the recall needs the model? (no-model vs with-model runs on the same scenarios)
2. What does a false injection cost the downstream agent? Needs end-to-end task success, not just retrieval metrics.
3. Does inferred usage (D13) track real usefulness?
4. How fast does the source map converge per user?

## Landscape (to research, not yet verified)

Memory stores to treat as sources: Supermemory, Mem0, Zep, Letta. Connector platforms that may supply MCP servers
or compete on the "context layer" pitch: to survey. Agent platforms whose users are the target tenants: to survey.
