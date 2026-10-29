# Fewer model calls (D43)

Status: 2026-10-29, simulation only (planner on, `quality-cli`, perfect judge). No live model run (the key's spend
limit).

## Where the calls went

With the perfect judge, realistic mix, seeds 31–40, the engine made 0.378 model calls per agent turn. About half
were judge calls on the slow path (1,320 over the ten seeds) and the rest composed `ask` answers (44% of asks used
the model). An ask answer rewrites the cited items as a short prose answer for the agent; the items and their
citations are found without a model either way.

## Ask answers without a model (shipped, D43)

`ask` returns the rendered items (the same data envelope injections use) and makes no model call unless
`askWithModel` is set (`EDEN_ASK_MODEL=1` in the server). The asker is itself a model and reads the items directly.

Held-out seeds 31–40, perfect judge, on the merged tree (`--ask-model` is the old behaviour). Model calls per turn
and cost are means over the ten seeds; recall and precision are pooled over them; ask recall@5 and MRR are weighted
by ask cases. Every quality figure is identical with and without the flag, per seed.

| Mix | Model calls per turn | Cost per 1,000 turns | Proactive recall / precision | Ask recall@5 / MRR |
|---|---|---|---|---|
| held-out A | 0.384 → 0.204 | $0.0273 → $0.0142 | 0.471 / 0.805, unchanged | 0.845 / 0.558, unchanged |
| held-out B | 0.416 → 0.236 | $0.0311 → $0.0182 | 0.578 / 0.773, unchanged | 0.881 / 0.601, unchanged |
| realistic | 0.378 → 0.198 | $0.0269 → $0.0139 | 0.458 / 0.805, unchanged | 0.851 / 0.565, unchanged |

What the simulation cannot measure: the prose answer could say "not in your sources" when the items were off-topic,
and summarise several items in a sentence. The agent now does that reading itself, from at most `maxItems` items
(default 5) in at most 4,000 bytes.

## Skipping the judge for weak candidate sets (measured, rejected)

Measured with a scratch patch that is not in the tree (a `judgeSkipBelow` setting on the commit before D43's), so
these rows cannot be reproduced from main. A candidate log (zoo-tune seeds 1–10, 1,463 judge calls, 1,108
perfect-judge picks) showed no free rule: candidates holding one query term were picked 6% of the time, two terms 23%,
three 45%. The narrowest rule, "skip the judge when every candidate holds at most one query term and the best scores
below S", end to end:

| S | Judge calls saved | zoo-tune recall per seed | Held-out B recall per seed |
|---|---|---|---|
| 0.5 | 2–3% | +0.0 | −0.3 (−0.6–0.0) |
| 0.6 | 7–9% | −0.3 (−0.6–0.0) | −2.8 (−4.1 to −1.5) |
| 0.7 | 13% (zoo-tune) | −1.5 (−2.4 to −0.6) | not run |

The saving is small and the loss grows with it, so the judge is asked as before.

## Reproduce

```bash
bun packages/sim/src/quality-cli.ts --profile realistic --seed 31 --planner --judge perfect [--ask-model]
bun run eval --live --ask-model   # model-composed ask answers, with the privacy checks, live
```
