# The judge, live (D45)

Status: 2026-10-30. Simulation (`quality-cli --live`, realistic connectors, planner on), the eval (`--live`), and
direct probes of OpenRouter. Every number is OpenRouter's reported cost or the harness's own count.

## What was wrong

Until now the judge had run live only on the eval's few turns. Run over the simulation (about 400 judge calls per
seed), the default model, `z-ai/glm-5.3-flash`, barely beat having no model: recall 0.284 against 0.259 with none and
0.466 with a perfect judge (realistic, seeds 41–43).

The cause was the output cap. The judge asked for at most 60 tokens; GLM 5.3 Flash reasons before it answers and
counts its reasoning against the cap. On a probe with an obvious answer ("What time is my Berlin flight?", the flight
among two candidates) it spent 58 tokens thinking and returned `{"pick` with `finish_reason: "length"`, which the
parser reads as "none". With 400 tokens it answered `{"pick": [0]}` every time.

| Model | 60 tokens | 400 tokens | Reasoning tokens |
|---|---|---|---|
| GLM 5.3 Flash | cut off | `[0]` | 58 / 1 |
| DeepSeek V4.1 Flash | cut off (empty) | `[0]` | 60 / 64 |
| GPT-5 nano | cut off (empty) | `[0]` | 109 / 256 |
| Claude Haiku 5.5 | `[0]` | `[0]` | 0 |

GLM's endpoints refuse to turn reasoning off ("Reasoning is mandatory for this endpoint"); asking for low effort with
the reasoning excluded from the reply works (about 20 reasoning tokens, `[0]` on three of three calls).

## The fix

The judge asks for `reasoning: {effort: "low", exclude: true}` with a 512-token cap, the ask answer the same with
1,000. Output is billed on tokens used, so the caps bound spend without raising it. A verdict cut off at the cap with
no pick goes to the no-model path (grounding and the fallback, D44, D36), as a failing call does (D41): before, it was
silence that looked like a considered "none".

## Results

Realistic connectors, planner on, seeds 41–43 (417 silent turns):

| Judge | Recall | Precision | Hard false fires | Judge picks right | Per 1,000 turns |
|---|---|---|---|---|---|
| none | 0.259 | 0.595 | 0 | — | $0 |
| GLM, 60 tokens | 0.284 | 0.623 | 1 | 90 / 131 (69%) | $0.011 |
| GLM, fixed | 0.393 | 0.636 | 3 | 196 / 269 (73%) | $0.010 |
| perfect | 0.466 | 0.799 | 0 | all | (oracle) |

The fix closes about 65% of the gap between no judge and a perfect one, at the same cost. It is not free of false
fires: 3 hard false fires in 417 silent turns, where the no-model path has none; D45 records that trade.

Other judges, seed 41, after the fix (154 silent turns; one seed: a ranking, not a precise gap):

| Judge | Recall | Precision | Hard false fires | Per 1,000 turns |
|---|---|---|---|---|
| none | 0.261 | 0.632 | 0 | $0 |
| GLM 5.3 Flash | 0.426 | 0.699 | 1 | $0.010 |
| Claude Haiku 5.5 | 0.410 | 0.692 | 0 | $0.027 |
| GPT-5 nano | 0.351 | 0.643 | 1 | $0.018 |
| DeepSeek V4.1 Flash | 0.340 | 0.673 | 0 | $0.052 |
| perfect | 0.479 | 0.815 | 0 | (oracle) |

Qwen 3.7 Flash, the cheapest listed, has no zero-retention endpoint and cannot serve under Eden's default routing.
GLM 5.3 Flash stays the default: the best of these on recall and the cheapest.

The judge costs latency: delivery p95 3.5 s on seed 41 with it, 11 ms without. Delivery is off the agent's path
unless the caller waits (`waitMs`).

The eval, live, after the fix (two runs, its turns vary run to run): recall 0.667 and 0.622, precision 0.938 and
0.966, false-fire rate 0.017 and 0, no secret leaked. Before: recall 0.644, precision 0.935, false-fire rate 0.033.
The eval's candidate lists are short, so the cap mattered less there.

## Reproduce

```bash
bun packages/sim/src/quality-cli.ts --profile realistic --seed 41 --planner --live    # $0.006–0.008 per seed (41–43)
EDEN_MODEL=anthropic/claude-haiku-5.5 bun packages/sim/src/quality-cli.ts --profile realistic --seed 41 --planner --live
bun run eval --live
```
