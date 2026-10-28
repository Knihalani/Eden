# Cost model

Input tokens drive the cost, so the design rations them: most turns cost nothing, and a model call sees a bounded
input.

## Prices (verify before relying on them)

`z-ai/glm-5.3-flash` is served by 38 OpenRouter endpoints at different prices (OpenRouter endpoints API, queried
2026-10-27 in the fast-primitives research; [docs/research/fast-primitives.md](research/fast-primitives.md)):

| Endpoint | Input $/M | Output $/M | Cache read $/M | Note |
|---|---|---|---|---|
| Z.AI and most US hosts | 0.15 | 0.50 | 0.03 | Z.AI caches automatically |
| Relace | 0.0513 | 0.0701 | 0.03 | The founder's figure; no `response_format` support |
| Wafer | 0.054 | 0.20 | 0.053 | Almost no cache discount |
| OpenInference (fp4) | 0.082 | 0.06 | 0.0064 | Quantized |

Many endpoints are fp4/nvfp4 quantized; whether that hurts judge precision is unmeasured. With default load
balancing, prompt-cache hits are unlikely: caching pays only with sticky routing (a per-user `session_id`, a
byte-stable system prefix). `packages/llm/src/pricing.ts` budgets with the Z.AI list price, the conservative one.
OpenRouter returns the real cost per call (`usage.cost`), and the engine books that.

## Per call (upper bounds from the engine's caps)

| Call | Input bound | Output bound | Cost at $0.15 / $0.50, uncached |
|---|---|---|---|
| Judge | system ≈ 100 tok + window ≤ 4,000 chars (≈ 1,000 tok) + ≤ 6 candidates × ≈ 100 tok ≈ 1,700 tok | 60 tok | ≈ $0.00029 |
| Ask answer | ≈ 100 + question ≤ 10,000 chars (≈ 2,500) + window ≤ 2,000 chars (≈ 500) + ≤ 20 items × ≈ 170 tok ≈ 6,500 tok | 300 tok | ≈ $0.0011 |

These are arithmetic on list prices, not measurements.

## Measured so far (tiny samples, not statistics)

- `bun run eval --live`, seed scenario, 8 turns, 2026-10-27: 1 model call, $0.0000162 total
  (`costPerTurnUsd` 0.00000202825), p95 observe latency 767 ms with `waitMs` 2000.
- Server smoke test, one `ask`: $0.000013639431, 1,549 ms end to end, including the OpenRouter round trip.

## Budget defaults (`packages/llm/src/budget.ts`)

20 calls and $0.02 per session; $0.25 per user per day; each call reserved at $0.0005 before its real cost is
known. Over budget, the engine takes the no-model path; it never defers spend.

## Levers, in order of leverage

1. Fewer model calls: better cheap scoring (M1 tuning), the graph (M3), learned silence.
2. Smaller inputs: shorter windows, candidate snippets, prompt-cache-friendly prompt layout (stable system prefix).
3. Cheaper model: a fine-tuned small judge (M6).

The non-model costs (source API calls, hosting) are not modelled yet. Source calls may dominate for some connectors;
measure them per connector in M2. The query planner (D28), on by default in the server since D33, adds no model
call. After its iterations it makes 1.36–1.47x planner-off's source calls per lookup in the simulation at time 0 and 1.23–1.32x at
real pacing (about 5.6–6.2 calls per lookup against 4.1–4.65), and 1.00–1.74 calls per lookup per connector on the
lab's real servers at the current settings; with `maxCalls: 1` it adds none
(docs/research/query-planner-results.md).
