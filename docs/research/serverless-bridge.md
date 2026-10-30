# Combining the consequence probe, name-only quiet and tied judging (D54, flags off)

Status: 2026-10-30. Merges three branches into one tree, every flag independent and off by default:
`consequenceProbe` (B, [consequence-probe.md](consequence-probe.md)), `quietNameOnly` (P, [name-only.md](name-only.md))
and `judgeTied` (C, [judge-tied.md](judge-tied.md)). Every number below comes from commands run in this session on the
merged tree (commit before the docs: `e24159517` plus the held-out 7 registration, which changes no engine code):

- funnel `hidden-funnel.ts --no-record`, no model, seeds 41–44: in-sample suites hidden and held-out 1–4 (268 tasks
  each way); blind suites held-out 5, 6 and 7 (220 tasks), run once, after the choice was fixed;
- simulation `quality-cli.ts --planner`, judge none and perfect: realistic seeds 41–44 (in-sample: P and C were designed
  on it), zoo-a and zoo-b seeds 41–42 (out of sample for P and C; zoo-b is not clean for B's amount rule).

G is D53's recommended set (`probes`, `compactInjection`, `quietSettled`, `groundAway`, `judgeContested`,
`judgeItemBytes` 200, `probeShare`, `probeTopicAlone`, `fallbackAsks`, `groundConflict`, `quietClear`, `probeFresh`,
`probeYield`, `densePacket`, `groundOccasion`). ALL = G + B + P + C. LB, LP, LC = ALL without B, P or C.

## Merge

`quietNameOnly` and the consequence probe both touch the conflict ground in `partner.ts`. The merged rule: an ordinary
conflict candidate needs `about`, `beyondName` (a no-op with P off) and a conflict verdict; a bridged consequence find
is added by B's party rule and is not gated by P, since its class words are a tie beyond a name. `judgeTied` and P both
add a field to `Scored` (`doc`, `beyond`); both are kept. `bun run check`: 735 pass, 0 fail. `bun run eval` (every flag
off) is identical to `cbfec3601` except `latencyP50Ms` and `latencyP95Ms`.

## Choice (in-sample only)

**ALL** (G + `consequenceProbe` + `quietNameOnly` + `judgeTied`):

```json
{"probes":true,"compactInjection":true,"quietSettled":true,"groundAway":true,"judgeContested":true,"judgeItemBytes":200,"probeShare":true,"probeTopicAlone":true,"fallbackAsks":true,"groundConflict":true,"quietClear":true,"probeFresh":true,"probeYield":true,"densePacket":true,"groundOccasion":true,"consequenceProbe":true,"quietNameOnly":true,"judgeTied":true}
```

Bars on the in-sample runs (realistic, funnel hidden + held-out 1–4):

| Bar | Limit | G | ALL |
| --- | --- | --- | --- |
| calls per lookup, perfect judge | ≤ 7.9 | 7.79 | 7.84 |
| bytes per needed fact, perfect | ≤ 455 | 433 | 433 |
| precision, perfect | ≥ 0.88 | 0.950 | 0.953 |
| recall, no model | ≥ 0.34 | 0.408 | 0.408 |
| model cost per 1k turns | ≤ $0.0203 | $0.02025 | $0.0170 |
| funnel decoys / hidden delivered | ≤ 0.6 | 21/128 = 0.16 | 21/137 = 0.15 |
| hard false fires | 0 | 0 | 0 |
| soft fire rate, no model (preferred) | ≤ 0.23 | 0.299 (fails) | 0.086 |

ALL holds every bar, and is the only one of the five configurations measured that holds them all together with the
soft-fire preference and the funnel gain: LB holds every bar but loses the 9 funnel deliveries; LP fails the soft-fire
preference; LC fails the cost bar ($0.0205).

## In-sample funnel (no model, seeds 41–44)

Returned / delivered / decoys delivered / calls per task (as the funnel prints them):

| Suite | G | ALL |
| --- | --- | --- |
| hidden | 28/40, 24/40, 4/40, 9.0 | 28/40, 24/40, 4/40, 9.3 |
| heldout | 28/48, 26/48, 1/48, 8.6 | 29/48, 30/48, 1/48, 9.1 |
| heldout2 | 32/60, 28/60, 3/60, 8.6 | 32/60, 28/60, 3/60, 8.8 |
| heldout3 | 29/60, 24/60, 7/60, 8.3 | 31/60, 26/60, 7/60, 8.6 |
| heldout4 | 31/60, 26/60, 6/60, 8.1 | 34/60, 29/60, 6/60, 8.5 |
| TOTAL | 148/268, 128/268, 21/268, 8.5 | 154/268, 137/268, 21/268, 8.8 |

Every change is B's: passport-away 0 → 4 delivered, trip-passport-expiry 0 → 2, change-freeze 0 → 3, all by the
conflict ground (hidden delivered by path, ALL: sources 24, grounded-conflict 97, grounded-clash 11, fallback 4,
grounded-away 1; G: the same with grounded-conflict 88). Their control twins were returned (6) and none delivered. The
21 decoys are the same tasks and paths in G and ALL.

## Simulation, realistic (in-sample, seeds 41–44)

Recall / stated recall / precision / soft fire rate / hard false fires / calls per lookup / bytes per needed fact /
model calls per turn:

| Config | No model | Perfect judge |
| --- | --- | --- |
| G | .408 / .366 / .601 / .299 / 0 / 7.76 / 496 | .647 / .604 / .950 / .062 / 0 / 7.79 / 433 / .253 |
| ALL | .408 / .369 / .638 / .086 / 0 / 7.88 / 467 | .641 / .598 / .953 / .045 / 0 / 7.84 / 433 / .213 |
| LB (no B) | .407 / .367 / .639 / .086 / 0 / 7.76 / 469 | .645 / .602 / .952 / .045 / 0 / 7.78 / 432 / .213 |
| LP (no P) | .408 / .367 / .598 / .299 / 0 / 7.83 / 495 | .638 / .596 / .949 / .062 / 0 / 7.84 / 436 / .212 |
| LC (no C) | .408 / .369 / .638 / .086 / 0 / 7.88 / 467 | .646 / .602 / .955 / .045 / 0 / 7.86 / 433 / .255 |

## Out of sample: zoo-a and zoo-b (seeds 41–42)

| Profile, config | No model rec / prec / soft / calls | Perfect rec / prec / soft / calls / B/fact |
| --- | --- | --- |
| zoo-a G | .416 / .614 / .284 / 7.69 | .596 / .952 / .134 / 7.70 / 447 |
| zoo-a ALL | .414 / .641 / .134 / 7.75 | .596 / .952 / .100 / 7.82 / 446 |
| zoo-a LB | .411 / .645 / .134 / 7.69 | .596 / .954 / .100 / 7.71 / 445 |
| zoo-a LP | .419 / .611 / .284 / 7.73 | .596 / .949 / .134 / 7.83 / 446 |
| zoo-a LC | .414 / .641 / .134 / 7.75 | .596 / .952 / .100 / 7.80 / 448 |
| zoo-b G | .434 / .596 / .400 / 7.77 | .722 / .965 / .134 / 7.86 / 430 |
| zoo-b ALL | .434 / .637 / .217 / 7.93 | .720 / .970 / .067 / 7.91 / 425 |
| zoo-b LB | .434 / .635 / .217 / 7.84 | .717 / .970 / .067 / 7.84 / 426 |
| zoo-b LP | .434 / .598 / .400 / 7.90 | .722 / .964 / .134 / 7.92 / 428 |
| zoo-b LC | .434 / .637 / .217 / 7.93 | .725 / .971 / .067 / 7.92 / 425 |

No hard false fire in any run. zoo-b ALL's perfect-judge calls per lookup (7.91) is above the 7.9 bar; G is 7.86
there. This was not used for the choice.

## Model cost (perfect judge)

Mean of the runs' `model.costPer1kTurnsUsd` (rounded in each report), then the unrounded mean of `costPerTurnUsd` ×
1000:

| Config | realistic | zoo-a | zoo-b |
| --- | --- | --- | --- |
| G | $0.02025 (0.020311) | $0.0195 (0.019935) | $0.0235 (0.023323) |
| ALL | $0.0170 (0.017243) | $0.0170 (0.016944) | $0.0210 (0.020884) |
| LB | $0.0170 (0.017204) | $0.0170 (0.017043) | $0.0210 (0.020892) |
| LP | $0.0170 (0.017128) | $0.0170 (0.016857) | $0.0210 (0.020730) |
| LC | $0.0205 (0.020518) | $0.0200 (0.019968) | $0.0235 (0.023509) |

## Ablation (one track left out of ALL)

- **Without B**: funnel 154/137/21 → 148/128/21; realistic perfect recall .641 → .645 and calls 7.84 → 7.78. B's only
  measured gain is the 9 funnel deliveries; in the simulation it costs about 0.06 calls per lookup, and the recall
  movement (.004–.006) is within run-to-run perturbation (the simulated world holds almost no constraint vocabulary).
- **Without P**: no-model soft fire rate .086 → .299 and precision .638 → .598 on realistic; the same pattern on both
  zoo profiles. Funnel unchanged.
- **Without C**: model calls per turn .213 → .255 and cost $0.0170 → $0.0205 (over the bar); perfect recall .641 → .646.
  No-model runs and the funnel are unchanged (the flag needs a model).

## Blind: held-out 5, 6 and 7 (run once, after the choice)

`hidden-heldout7.ts` was written by a separate agent and copied in without reading its templates; it is registered as
`heldout7` (measurement only). No engine change was made after this run.

| Suite | G | ALL |
| --- | --- | --- |
| heldout5 | 34/60, 26/60, 8/60, 9.1 | 35/60, 26/60, 8/60, 9.8 |
| heldout6 | 29/80, 9/80, 6/80, 7.4 | 30/80, 10/80, 6/80, 7.8 |
| heldout7 | 33/80, 20/80, 12/80, 8.3 | 34/80, 20/80, 12/80, 8.9 |
| TOTAL | 96/220, 55/220, 26/220, 8.2 | 99/220, 56/220, 26/220, 8.7 |

Decoys over hidden delivered: 0.47 (G) and 0.46 (ALL) overall, within 0.6; held-out 7 alone is 12/20 = 0.60 for
both, at the bar. Per-template changes, G → ALL: lisbon-passport (heldout6) 0 → 1 delivered, trip-cancelled-passport
(heldout7) 0 → 1, both by the conflict ground; passport-expiry-trip (heldout5) returned 0 → 1, not delivered;
meeting-with-leaver (heldout7) delivered 4 → 3 (the remaining 3 by grounded-away). The three passport control twins
were returned once each and not delivered.

Decoys delivered, by template and path (identical for G and ALL): heldout5 birthday-drinks-moved (sources 4),
savings-withdrawal-limit (fallback 3, sources 1); heldout6 prod-access-training (sources 4), agency-dpa-missing
(sources 1, fallback 1); heldout7 offer-above-band (grounded-conflict 4), rfp-suspended-supplier (sources 3,
grounded-conflict 1), isa-allowance (sources 2, fallback 2). Hidden delivered by path, ALL: sources 26,
grounded-conflict 17, fallback 6, grounded-clash 4, grounded-away 3 (G: grounded-conflict 15, grounded-away 4).

Blind reading: the combination generalises its small gain (+3 returned, +1 delivered) with no new decoy, much smaller
than in-sample (+6, +9), and only through the passport (travel) class.

## Risks

- **In-sample choice.** P and C were designed on the realistic profile, B's gains are on the in-sample funnel suites,
  and the choice was made on those. The blind gain is +1 delivered of 220.
- **Thin bars.** Realistic perfect calls per lookup 7.84 (bar 7.9); zoo-b 7.91 is over it. Held-out 7's decoy ratio
  is 0.60, at the bar, for G as well.
- **Perfect judge only.** C's saving and P's effect with a judge are measured against a perfect judge; no live run was
  made. A live judge may lose or gain on the calls C skips.
- **Recall.** Realistic perfect-judge recall .647 → .641 (G → ALL); the leave-one-out rows span .638–.646, so no
  single track carries the loss, but it is not shown to be noise without more seeds.
- **Review.** The `reviewer` subagent was not run on the combined diff; this session cannot start subagents.

## Reproduce

Scripts in the session scratchpad (`inno3/run.sh`, `inno3/blind.sh`); per configuration, as in
[combined-config.md](combined-config.md):

```bash
bun packages/sim/src/lab/hidden-funnel.ts --suite hidden,heldout,heldout2,heldout3,heldout4 --no-record --config "$CFG"
for j in none perfect; do for sd in 41 42 43 44; do
  bun packages/sim/src/quality-cli.ts --profile realistic --seed $sd --planner --judge $j --config "$CFG" > $j-$sd.json
done; done
bun packages/sim/src/lab/hidden-funnel.ts --suite heldout5,heldout6,heldout7 --no-record --config "$CFG" --json blind.json
```
