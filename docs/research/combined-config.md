# Combining the conflict, probe-economy, dense-packet and register flags (PoC, flags off)

Status: 2026-10-30. Merges four branches into one tree, every flag independent and off by default: `groundConflict`
and `quietClear` (D49, [conflict-ground.md](conflict-ground.md)), `probeFresh` and `probeYield` (D50,
[probe-economy.md](probe-economy.md)), `register` (D51, `register.ts`) and `densePacket`, `groundOccasion` and
`recoverNames` (D52, [dense-packets.md](dense-packets.md)). Every number below comes from commands run in this work:
funnel `hidden-funnel.ts --no-record` over hidden and held-out 1–4 (268 tasks, no model), simulation
`quality-cli.ts --planner`, realistic profile, seeds 41–44, judge none and perfect; out of sample zoo-a and zoo-b,
seeds 41–42. Held-out 5 and 6 were not run.

F is D48's best: `probes`, `compactInjection`, `quietSettled`, `groundAway`, `judgeContested`, `judgeItemBytes` 200,
`probeShare`, `probeTopicAlone`, `fallbackAsks`. C = `groundConflict` + `quietClear`; Y = `probeFresh` + `probeYield`;
D = `densePacket` + `groundOccasion`; R = `register`.

## Result

Best: **F + C + Y + D** (no register). Funnel columns are returned / delivered / decoys delivered / calls per task;
sim columns are recall / stated recall / precision / soft fire rate / hard false fires / calls per lookup / bytes per
needed fact; cost is the mean `costPer1kTurnsUsd` of the perfect-judge runs.

| Config                 | Funnel              | No model                                      | Perfect judge                                 | $/1k turns |
| ---------------------- | ------------------- | --------------------------------------------- | --------------------------------------------- | ---------- |
| F                      | 130 / 58 / 40 / 7.2 | .326 / .309 / .588 / .218 / 0 / 7.95 / 584    | .613 / .575 / .949 / .067 / 0 / 7.86 / 484    | 0.02000    |
| F+C+Y+D (best)         | 148 / 128 / 21 / 8.5 | .408 / .366 / .601 / .299 / 0 / 7.76 / 496   | .647 / .604 / .950 / .062 / 0 / 7.79 / 433    | 0.02025    |
| F+C+Y+D+R              | 148 / 129 / 21 / 8.4 | .407 / .365 / .598 / .299 / 0 / 7.76 / 498   | .647 / .604 / .950 / .062 / 0 / 7.79 / 433    | 0.02025    |

Against the bars: calls per lookup 7.79 (≤ 7.9), bytes per needed fact 433 (≤ 455), perfect precision 0.950
(≥ 0.88), no-model recall 0.408 (≥ 0.34), cost $0.02025 per 1k turns (≤ $0.0203, a thin margin), funnel decoys 21
against 128 hidden delivered (0.16, ≤ 0.6), no hard false fire anywhere. Bar 1 is live and was not measured; its
proxy, hidden facts retrieved and delivered on the funnel, rises 130 → 148 and 58 → 128.

## Ablations (each part removed from F+C+Y+D+R)

| Removed            | Funnel               | No-model rec / prec / soft | Perfect rec / prec / calls / B/fact |
| ------------------ | -------------------- | -------------------------- | ----------------------------------- |
| R (register)       | 148 / 128 / 21 / 8.5 | .408 / .601 / .299         | .647 / .950 / 7.79 / 433            |
| C (conflict)       | 148 / 92 / 47 / 8.5  | .379 / .622 / .248         | .649 / .950 / 7.79 / 434            |
| Y (economy)        | 130 / 113 / 20 / 7.2 | .391 / .613 / .247         | .609 / .944 / 7.92 / 443            |
| D (dense)          | 148 / 129 / 21 / 8.4 | .390 / .582 / .299         | .646 / .953 / 7.79 / 477            |

Variants of F+C+Y+D:

| Variant                         | Funnel               | No-model rec / soft / calls | Perfect rec / calls / B/fact / $ |
| ------------------------------- | -------------------- | --------------------------- | -------------------------------- |
| without `quietClear`            | 148 / 128 / 39 / 8.5 | .412 / .299 / 7.78          | .649 / 7.78 / 434 / .02025       |
| `probeFresh` only (no yield)    | 130 / 113 / 20 / 7.2 | .394 / .247 / 7.61          | .608 / 7.57 / 444 / .02000       |
| `probeYield` only (no fresh)    | 148 / 128 / 21 / 8.5 | .407 / .299 / 8.03          | .646 / 8.11 / 437 / .02025       |
| without `groundOccasion`        | 148 / 128 / 21 / 8.5 | .392 / .299 / 7.74          | .647 / 7.79 / 433 / .02025       |
| without `densePacket`           | 148 / 128 / 21 / 8.5 | .406 / .299 / 7.78          | .646 / 7.79 / 477 / .02025       |
| + `recoverNames`                | 148 / 128 / 21 / 8.5 | .411 / .299 / 7.74          | .647 / 7.79 / 433 / .02025       |
| `probeYieldFloor` 0.08          | 148 / 128 / 21 / 8.4 | .398 / .299 / 7.51          | .637 / 7.56 / 437 / .02025       |
| + R + `registerSweepMs` 600000  | 150 / 149 / 20 / 10.4 | .412 / .299 / 8.63         | .642 / 8.66 / 442 / .02050       |

What each part does in the combination:

- **C** carries bar 4: without it funnel decoys go 21 → 47 and delivered 128 → 92. `quietClear` alone halves the
  decoys (39 → 21) at no cost in recall.
- **Y** carries retrieval (funnel returned 130 → 148) and perfect-judge recall (0.609 → 0.647), and lowers calls per
  lookup in the sim. `probeFresh` is what pays for `probeYield`'s wider first person probe: `probeYield` alone breaks
  bar 2 (8.11 calls).
- **D** carries bytes (477 → 433 per needed fact; `densePacket`) and no-model recall (0.392 → 0.408;
  `groundOccasion`).
- **R** adds nothing measurable once C is on (one funnel fact; in the realistic no-model runs its path delivered 2
  items, neither relevant, against 6 of 6 without C), took 45.2 against 36.7 ms per funnel task (one run each, on a shared machine), and is identical out of
  sample. It is left off. Its sweep raises funnel delivery to 149 but breaks bar 2 (8.66 calls) and the cost bar.

## Out of sample (zoo, seeds 41–42)

| Mix, judge     | F rec / prec / ff | F+C+Y+D rec / prec / ff | calls F → best | B/fact F → best |
| -------------- | ----------------- | ----------------------- | -------------- | --------------- |
| zoo-a, none    | .347 / .636 / 0   | .416 / .614 / 0         | 7.84 → 7.69    | 542 → 489       |
| zoo-a, perfect | .560 / .952 / 0   | .596 / .952 / 0         | 7.79 → 7.70    | 516 → 447       |
| zoo-b, none    | .344 / .576 / 0   | .434 / .596 / 0         | 8.16 → 7.77    | 609 → 506       |
| zoo-b, perfect | .681 / .960 / 0   | .722 / .965 / 0         | 8.23 → 7.86    | 469 → 430       |

Adding R changes none of these beyond 0.001 precision.

## Costs and open risks

- No-model soft fire rate (a silent turn that got a delivery) rises 0.218 → 0.299 on realistic, 0.217 → 0.284 on
  zoo-a, 0.367 → 0.400 on zoo-b; C and Y each add about 0.03. No hard false fire in any run. The weakest no-model
  path is `groundOccasion`'s occasion-plus-day rule (21 delivered, 9 relevant in the realistic runs).
- Funnel calls per task 7.2 → 8.5: the funnel builds a new engine per task, so `probeYield` is always cold there.
- The cost margin is thin ($0.02025 against $0.0203); `probeYieldFloor` 0.08 trades 0.010 perfect recall for 0.23
  fewer calls per lookup at the same cost.
- C, R and D's patterns were tuned while reading the dev suites; held-out 5 and 6 remain the clean test. No live run
  (eval `--live`, live funnel) was made for the combination.
