---
description: Run the Eden eval (no-model and, if a key is set, live) and summarise the metrics against the last recorded run.
---

1. `bun run eval` and record the JSON.
2. If `OPENROUTER_API_KEY` is set, `bun run eval --live` and record the JSON (never print the key).
3. Summarise precision, recall, falseFireRate, modelCallsPerTurn, costPerTurnUsd and latency p50/p95 for both runs
   in a table, and compare with the latest numbers in docs/COST-MODEL.md or the last PR that reported them.
4. Call out any regression in falseFireRate or precision first.
