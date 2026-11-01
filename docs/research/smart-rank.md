# A learned no-model ranker for what Eden surfaces (track rank)

Decision: D82 (proposed until the live measure), `askRank` adopted as an experimental flag and `rankTies` rejected; both
off by default. Development used only the development suites `dev6a` and `dev6b` and the old in-sample suites
(`hidden`, `heldout`, `heldout2`–`heldout4`). Held-out 5–11 were not run or read. $0 model spend: no OpenRouter call was
made; cards are replayed from `packages/sim/lab/cards/cards-v2.jsonl`. Every number below comes from a command run in
this session. Dev and in-sample are reported apart, and the learned component's numbers are leave-one-suite-out (LOSO).

## The question

The held-out-10 live run (D80) showed that what Eden surfaces is the lever: a planted fact in a packet was raised 0.71
of the time, one only in an ask answer 0.887, and in 59 of 192 tasks Eden held the fact (synced) but surfaced it in
neither. Can a learned ranker over what the engine already computes, with no model call and no new source call, cite the
planted item more often and the lookalike decoy (resolved, expired, other party, other day) less often, within +5% of
the agent's input bytes and a few ms of Eden CPU?

## Diagnosis (ALL3, no-model funnel with `--ask`)

```bash
bun packages/sim/src/lab/hidden-funnel.ts --suite dev6a,dev6b,hidden,heldout,heldout2,heldout3,heldout4 --no-record \
  --config "$ALL3" --cards packages/sim/lab/cards/cards-v2.jsonl --ask --json out.json --ask-diag diag.jsonl
```

ALL3 as given (D80), seeds 41–44. "Either" is delivered in a packet or cited by the ask answer.

| | hidden either | control: decoy delivered | control: decoy cited by the ask |
|---|---|---|---|
| dev (240 + 240) | 122 | 10 | 91 |
| in-sample (268 + 268) | 244 | 17 | 148 |

Where the planted item sat among the ask's candidates (the ranked list with `decide.ts` facts, at most 64):

| | absent | rank 0–4 | 5–9 | 10–19 | 20+ | present but surfaced in neither |
|---|---|---|---|---|---|---|
| dev hidden | 91 | 110 | 19 | 19 | 1 | 27 |
| in-sample hidden | 1 | 160 | 26 | 58 | 23 | 23 |

Two findings set the track's ceiling and its real use:

- **Ranking can reach little of the recall gap.** In dev, 91 of the 118 unsurfaced planted items are not among the ask's
  candidates at all (they need an implication no lexical, graph or frame test bridges: cards, which dev has none of).
  Of the 27 dev and 23 in-sample items that are present, most score low on every fact (mean lexical score 0.19 dev,
  0.09 in-sample, against 0.55–0.61 for what was cited instead); in-sample they are mostly graph-walked (binds 0.65).
- **The ask cites the decoy often.** A control task's decoy is cited by the ask in 91 of 240 dev tasks and 148 of 268
  in-sample: the ask answer is the agent's least precise channel. The decoys share the request's words and names by
  construction; what tells them apart is in the facts the engine already computes (the conflict test's `clear` and
  `conflict`, `settled`, the verdict hits, the graph's and the cards' reads).

## What was built

- `rank.ts`: `rankScore(facts)`, a dot product of fitted weights with 36 of `decide.ts`'s facts (the request-level facts,
  equal across one ranking, are left out), and `rankAnswer(pool, outside, limit, margin, score)`. Weights in
  `rank-weights.json` (one number per fact). No state, no model, no call.
- `askRank` (with `askRankMargin`, 5): the ask's pool (the verdict hits, the grounded items, the lexically likely, as the
  rule paths build it) is ordered by the ranker and cut to the same limit (5); the ranker's best candidate outside the
  pool takes the weakest seat when it outscores it by more than the margin. The answer never grows.
- `rankTies`: where a proactive rule path keeps the best few of equally scored items (the sure items, the conflict
  ground's hits, the person ground's pick), the ranker says which of the equals; it never adds an item or lowers a gate.
  Facts are computed only when a cut ties.
- Lab: `rank-fit.ts` fits the ranker on the funnel's ask dump: pairwise logistic loss with an L2 penalty (λ 1), by
  Newton's method on scaled fact differences, pure TypeScript; in a hidden task the planted item should outrank every
  other candidate, in a control task every other candidate should outrank the decoy (weight 0.3). It reports LOSO on
  the dump's exact pool and writes the weights (`--out`) and each fold's (`--folds`). The ask dump now carries the pool
  (`CandidateDump.pool`) and the consequence finds' `bridged` fact (the dump read it as 0 before; no decision changes),
  and `hidden-funnel.ts --rank-model` runs a fold in the engine.

Labels are the dev and in-sample suites' planted items (positive) and every other candidate and the decoys
(negative). No lexicon, no per-template rule: the weights read only general facts. Fitted on all seven suites:

| fact | weight | fact | weight | fact | weight |
|---|---|---|---|---|---|
| `clear` | −3.57 | `conflictHit` | +3.38 | `graphHit` | +3.00 |
| `bridged` | +2.77 | `cardViolated` | +2.50 | `namesRef` | +2.46 |
| `conflict` | +1.33 | `upcoming` | +1.06 | `settled` | −1.04 |
| `mentions` | −1.03 | `walkScore` | +0.77 | `participant` | +0.73 |

A name tie alone (`entity`, `mentions`, `beyondName` all negative) counts against an item once the verdicts are in:
the decoys tie by name as well as the planted items do.

## Choosing the policy (offline, LOSO)

`rank-fit.ts` on the baseline ask dump; each suite re-ranked by weights fitted on the other six:

| decoy weight | margin | dev either | dev decoy cited | in-sample either | in-sample decoy cited |
|---|---|---|---|---|---|
| baseline | | 122 | 91 | 244 | 148 |
| 0.3 | 1 | 118 | 47 | 245 | 56 |
| 0.3 | 3 | 123 | 61 | 245 | 62 |
| **0.3** | **5** | **127** | **70** | **245** | **73** |
| 0.3 | no swap | 127 | 73 | 245 | 84 |
| 1 | 1 | 117 | 30 | 244 | 48 |
| 1 | 5 | 125 | 56 | 244 | 61 |

Lower margins and higher decoy weights buy precision with recall; recall is the lever (D80), so the chosen point keeps
every recall gain. Also measured and rejected: a policy that ranks every candidate (not the pool) loses recall (dev 117,
in-sample 241); two or three swap seats lose recall; extra seats that grow the answer (+0.4–0.7 items, over the byte
bound); source-kind features (no gain); pairwise products of 16 binary facts (dev 117–120, worse). A stump ensemble was
not built: the interaction features, which are what it would add over a linear model, did not help under LOSO.

## Results (engine, LOSO)

Each suite run in the engine with the weights fitted without it (`rank-fit.ts --folds`, `hidden-funnel.ts --suite S
--rank-model folds/S.json`), ALL3 + the flag, seeds 41–44, against the ALL3 baseline. Bytes are the mean agent-facing
bytes per ask answer and per packet.

| | hidden either | control: decoy delivered | control: decoy cited by ask | bytes/ask | bytes/packet | packets |
|---|---|---|---|---|---|---|
| dev ALL3 | 122 / 240 | 10 | 91 | 661 | 353 | 256 |
| dev + `askRank` | **127** (+5) | 10 | **70** (−23%) | 670 (+1.4%) | 353 | 256 |
| dev + `askRank` + `rankTies` | 127 | 10 | 70 | 670 | 354 | 256 |
| in-sample ALL3 | 244 / 268 | 17 | 148 | 638 | 341 | 437 |
| in-sample + `askRank` | **245** (+1) | 17 | **73** (−51%) | 647 (+1.4%) | 341 | 437 |
| in-sample + `askRank` + `rankTies` | 245 | 17 | 73 | 647 | 341 | 437 |

The engine runs match the offline LOSO prediction exactly. Per suite (`askRank`):

| suite | tasks | hidden either | decoy delivered | decoy cited by ask | bytes/ask |
|---|---|---|---|---|---|
| dev6a | 120 | 61 → 62 | 6 → 6 | 52 → 39 | 679 → 683 |
| dev6b | 120 | 61 → 65 | 4 → 4 | 39 → 31 | 643 → 658 |
| hidden | 40 | 40 → 40 | 4 → 4 | 19 → 11 | 703 → 740 |
| heldout | 48 | 39 → 39 | 0 → 0 | 19 → 8 | 585 → 585 |
| heldout2 | 60 | 56 → 56 | 1 → 1 | 39 → 17 | 678 → 684 |
| heldout3 | 60 | 52 → 52 | 4 → 4 | 36 → 21 | 522 → 561 |
| heldout4 | 60 | 57 → 58 | 8 → 8 | 35 → 16 | 713 → 682 |

Of 508 hidden tasks, 10 gained and 4 lost (all four in heldout3: `cat-feeding-friend-away` and
`family-day-out-mobility`, two seeds each); the gains are lumpy (`december-capacity` 4, `bbq-clash-gala` 4, two single
ones). Of 508 control tasks, the ask stopped citing the decoy in 102 and newly cited it in 6. Where the planted item is
cited either way, the answer keeps as much of its detail (`askKept` 0.381 → 0.388). Packets are untouched by `askRank`
(it only orders the answer).

`rankTies` changed the packet of 3 of 1,016 tasks (all controls, one noise item for another) and moved no metric.

## Cost

- No model call, no source call, no new state. The ask's item limit is unchanged; bytes per ask +1.4% (dev and
  in-sample), packets unchanged.
- The ranker itself: 13.6 µs per ask over the dumped asks' 21.5 candidates (`rankScore` and `rankAnswer`, 20,320 asks
  replayed, a loaded machine), 0.63 µs per candidate. Under ALL3 the facts are already computed by `askVerdicts`;
  without it, `askRank` computes them (the ask's top 64).
- `rankTies` is not free: serial dev runs (`--serial --cpu`, dev6a + dev6b, two runs each, alternating) put the
  engine's per-task CPU at 4.17/4.21 s without it and 4.38/4.41 s with `askRank` + `rankTies` (+0.43 ms per task,
  +5%), and the request's wall time at 7.4/7.5 against 8.2/8.0 ms. A cut ties often enough (the person ground's pick of
  one, the sure items' cut of three) that the facts of 64 candidates are computed on a good share of lookups, for no
  measured gain. That is the reason it is rejected.
- With every flag off, `bun run eval` matches main except timings (diffed on everything but timing lines).

## Verdict

- **`askRank`: adopt as an experimental flag, propose for ALL3 after a live check.** It halves the decoys the ask cites
  in-sample (−51%) and cuts them by a quarter in dev (−23%), at +1.4% answer bytes and microseconds of CPU, with a small
  surfacing gain (dev +5 of 240, +2.1 points; in-sample +1 of 268). The surfacing gain is not "significant": the ranker
  orders what the ask already gathers, and in dev three quarters of the unsurfaced planted items are not gathered.
- **`rankTies`: reject.** Inert on the funnel and +5% engine CPU per lookup. Kept in the engine, off, so a live run can
  confirm; remove it if the live run agrees.

## Risks

- **Labels from planted items.** The suites plant one item per task, and the decoy is designed to share its words; the
  ranker learns what tells the two apart in these suites. LOSO keeps a suite's templates out of its own fit, but the
  suites share an author and a style, and dev6a/dev6b copy some templates of held-out 5–9 (D80). Only a blind live run
  says what transfers.
- **Precision proxy, not precision.** "Decoy cited by the ask" is a proxy; the agent raised false concerns in 0.052 of
  held-out-10 tasks with ALL3, so fewer decoy citations may move that number little. The agent's reading, not the funnel,
  decides.
- **Lumpy gains.** The recall gain rests on three templates; a margin of 3 instead of 5 gives back four of the five dev
  gains. The margin is the one tuned knob, chosen on the same LOSO folds it is reported on (a mild selection effect).
- **Fact drift.** The weights are bound to `decide.ts`'s facts as computed today; a change to the conflict test or the
  graph changes their meaning. Refit (`rank-fit.ts --out`) after any change that moves the ask dump's facts, and keep
  `FACT_NAMES` stable. `rank-weights.json` carries `facts`, a fingerprint of the facts' definition (`Facts`,
  `FACT_NAMES` and `partner.ts`'s `rank`, `factsOf` and `askFacts`, comments and whitespace ignored;
  `facts-fingerprint.ts`), written by `rank-fit.ts`; `rank.test.ts` fails when it no longer matches, so a change to
  what `score`, `relScore` or `ageDays` hold cannot leave the weights silently stale. It does not see helpers those
  methods call (the conflict test, the graph): a change there still needs a judgement call.
- **The shipped weights are in-sample for every suite here.** `rank-weights.json` is the full fit on dev6a, dev6b,
  hidden and heldout–heldout4. Any number taken on those suites with the default weights (no `--rank-model`) is
  in-sample, dev included; only the fold runs (`--rank-model folds/<suite>.json`) are honest for them, and every
  number in this note and in smart-combined.md is a fold run.
- **Dumps are not comparable across the merge.** On this branch the lab's `ask` dump computes its facts through
  `askFacts`, which sets `bridged`; main's dump did not. Engine output with every flag off is unchanged, but rank-fit
  data dumped on main and on this branch must not be pooled.
- **The ask's own question.** The funnel asks the request's text; a live agent asks its own questions, which the ranker
  never saw.

## Reproduce

```bash
ALL3='{"probes":true,...,"cardsEconomy":true}'   # D80
# Baseline and its ask dump (with the pool).
bun packages/sim/src/lab/hidden-funnel.ts --suite dev6a,dev6b,hidden,heldout,heldout2,heldout3,heldout4 --no-record \
  --config "$ALL3" --cards packages/sim/lab/cards/cards-v2.jsonl --ask --json base.json --ask-diag diag.jsonl
# LOSO offline, the shipped weights, and each fold's.
bun packages/sim/src/lab/rank-fit.ts diag.jsonl --decoy-weight 0.3 --margin 5 \
  --out packages/engine/src/rank-weights.json --folds folds
# LOSO in the engine: one run per suite with its fold's weights.
for s in dev6a dev6b hidden heldout heldout2 heldout3 heldout4; do
  bun packages/sim/src/lab/hidden-funnel.ts --suite $s --no-record --config "${ALL3%\}},\"askRank\":true}" \
    --cards packages/sim/lab/cards/cards-v2.jsonl --ask --json loso-$s.json --rank-model folds/$s.json
done
```
