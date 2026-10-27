# Cost model

Input tokens drive the cost, so the design rations them: most turns cost nothing, and a model call sees a bounded
input.

## Prices (verify before relying on them)

| Model | Input $/M | Output $/M | Source |
|---|---|---|---|
| `z-ai/glm-5.3-flash` | 0.0513 | — | Founder's figure |
| `z-ai/glm-5.3-flash` | 0.075 (cache read 0.015) | 0.25 | OpenRouter listing via web search, 2026-10-27, not checked on the live page |

`packages/llm/src/pricing.ts` budgets with the higher figure. OpenRouter returns the real cost per call
(`usage.cost`), and the engine books that.

## Per call (upper bounds from the engine's caps)

| Call | Input bound | Output bound | Cost at $0.075 / $0.25 |
|---|---|---|---|
| Judge | system ≈ 100 tok + window ≤ 4,000 chars (≈ 1,000 tok) + ≤ 6 candidates × ≈ 100 tok ≈ 1,700 tok | 60 tok | ≈ $0.00014 |
| Ask answer | ≈ 100 + window ≤ 2,000 chars (≈ 500) + ≤ 20 items × ≈ 170 tok ≈ 4,000 tok | 300 tok | ≈ $0.00038 |

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
measure them per connector in M2.
