# A no-model fallback for the best candidate (D36)

Status: 2026-10-28, simulation and the hand-written eval only. No live model run (the OpenRouter key's spend limit).

## Question

With no model, the commonest decision on a need turn was "silent: no model" (docs/plans/next.md): the engine found
candidates but delivers only items that name a cue entity and clear `confidentScore` 1.1 (D6). Lowering that bar
raised hard false fires (plan item 2; the owner kept precision). Is there a cheap signal that picks the needed item
among the judge's candidates precisely enough to deliver it without a model?

## Method

1. **Candidate log.** A scratch harness wrapped the engine's ranking and the simulation's perfect judge and logged,
   for every judge call, each candidate's features (score, matched query terms, entity hit, position, gap to the next
   score, cue length, source) with the judge's pick as its label. 4 mixes × seeds 1–5, `--planner --judge perfect`:
   11,418 candidates, 13–18% relevant per mix.
2. **Signal.** On `zoo-tune` (the tuning set) the number of distinct query terms an item holds separated relevant
   from not best:

   | Matched terms | Relevant (zoo-tune) |
   |---|---|
   | 1 | 108 / 1742 (6%) |
   | 2 | 145 / 754 (19%) |
   | 3 | 90 / 201 (45%) |
   | 4 | 58 / 87 (67%) |
   | 5 | 22 / 41 (54%) |

   An entity hit alone was relevant 28% of the time; the top position 25%.
3. **Rule and parameters, on zoo-tune only.** End to end with no model (`quality-cli --planner`, 5 seeds, pooled),
   "deliver the top candidate if it holds ≥ M terms and scores ≥ S":

   | Rule | Recall | Precision | Hard false fires |
   |---|---|---|---|
   | none (main) | 0.204 | 0.640 | 1/713 |
   | M 3, S 0.7, top | 0.241 | 0.625 | 1/713 |
   | **M 3, S 0.8, top** | **0.244** | **0.633** | **1/713** |
   | M 3, S 0.9, top | 0.242 | 0.633 | 1/713 |
   | M 3, S 1.0, top | 0.231 | 0.647 | 1/713 |
   | M 3, S 0.9, any position | 0.256 | 0.605 | 1/713 |
   | M 2, S 0.9, top | 0.262 | 0.573 | 5/713 |
   | M 2, S 1.0, top | 0.232 | 0.577 | 3/713 |

   The selection rule, stated before reading held-out numbers for it: the highest recall with hard false fires not
   up and precision within 1 point of main. That is M 3, S 0.8, top candidate. Two matched terms raised false fires,
   as in plan item 2.
4. **Placement.** Tested first inside `confident()` (so it also ran with a model), then only where the engine would
   otherwise say "no model" or "no model budget", so a model, when present, still judges. The second placement was
   chosen for that reason after seeing held-out numbers for both; they scored alike (first placement: held-out A
   0.243, B 0.287, realistic 0.224).

## Results (the shipped placement, this tree against main)

No model, planner on, 5 seeds pooled: must-know facts delivered (recall), precision of delivered items, hard false
fires (a delivery on a must-stay-silent turn), soft-fire rate (a delivery on a turn where it is merely unhelpful;
mean over seeds), and the paired per-seed gain in facts with a 95% t-interval (df 4). Seeds 1–5 were used for the
earlier decisions too (D33, D34, plan item 2), so seeds 6–10 were run as fresh ones:

| Seeds | Mix | Recall | Precision | Hard false fires | Soft-fire rate | Gain per seed (95% interval) |
|---|---|---|---|---|---|---|
| 1–5 | zoo-tune (tuning) | 0.204 → 0.254 | 0.640 → 0.640 | 1 → 1 of 713 | 0.148 → 0.155 | 9.2 (2.3–16.1) |
| 1–5 | held-out A | 0.188 → 0.244 | 0.624 → 0.643 | 1 → 1 of 713 | 0.208 → 0.216 | 10.4 (7.7–13.1) |
| 1–5 | held-out B | 0.233 → 0.285 | 0.558 → 0.570 | 1 → 1 of 713 | 0.292 → 0.311 | 9.6 (2.7–16.5) |
| 1–5 | realistic | 0.191 → 0.227 | 0.627 → 0.641 | 1 → 1 of 713 | 0.193 → 0.168 | 6.6 (0.4–12.8) |
| 6–10 | held-out A | 0.184 → 0.227 | 0.587 → 0.603 | 0 → 0 of 701 | 0.214 → 0.219 | 8.2 (4.4–12.0) |
| 6–10 | held-out B | 0.197 → 0.237 | 0.542 → 0.529 | 2 → 2 of 701 | 0.282 → 0.322 | 7.6 (3.2–12.0) |
| 6–10 | realistic | 0.176 → 0.223 | 0.579 → 0.585 | 0 → 0 of 701 | 0.177 → 0.186 | 9.0 (6.7–11.3) |

Every one of the 35 seed-and-mix pairs gained facts. The cost: about 25% more deliveries (zoo-tune 392 to 494), the
soft-fire rate up on 6 of the 7 rows (most on held-out B, 0.282 to 0.322 on fresh seeds), and precision down on
held-out B's fresh seeds (0.542 to 0.529). Hard false fires were unchanged everywhere, but at about 1 in 700 the
check can rule out only large increases; precision and soft fires have no intervals here.

With the perfect judge (held-out A and realistic), identical to main: recall 0.373 and 0.362, precision 0.790 and
0.809, 1/713 each.

`bun run eval` (no model): recall 15 to 18 of 43, precision 1.000 (18/18), 0/58 false fires; planted secrets
exposed 2 to 3 (one more delivery cited an item holding a planted secret), leaked 0; 20 injections, none not inert.

## Limits

- The simulation's text comes from templates; its vocabulary overlap between cue and item may be kinder than real
  mail. The hand-written eval agrees in direction (3 more items, no false fire), on 43 expected items.
- Real-model behaviour is unchanged by construction, but not measured (`--live` made no calls).
- One item at most per fallback delivery; the rule never runs on the fast path.
- Some leakage into "held out": the candidate log covered all four mixes (only zoo-tune's rows chose the signal),
  the placement was picked after seeing held-out numbers, and seeds 1–5 had backed earlier decisions; seeds 6–10 are
  the cleanest check. With 5 seeds the t-interval leans on normality (realistic's seeds 1–5 gains are bimodal).
- The eval and the simulation report fallback deliveries as their own decision (`fallback`), so a change in the
  fallback alone shows.
