# The generalise tracks combined: ALL3 (D73–D79, proposed)

Branch `gen/combined`, from `main` (`0bc877deb`) with the two development suites (`gen/dev6a`, `gen/dev6b`) and the
three tracks whose verdict was adopt behind a flag: `gen/ask` (docs/research/gen-ask.md), `gen/proactive`
(docs/research/gen-proactive.md) and `gen/tokens` (docs/research/gen-tokens.md). Every flag stays off by default. ALL3
is chosen on the development suites (dev6a, dev6b) and the old in-sample suites (hidden, held-out 1–4) only. Held-out
5–9 were neither run nor read, and no model was called ($0).

## Merging

- `suites.ts` conflicted on each merge (each branch added the other dev suite or a comment); both suites are kept.
- `ask` and `tokens` both compact the ask's answer, under two flags that share `askItemBytes` (320):
  - `askCompact` (ask): drops the current year from dates as packets do, unless `packetDates` keeps it; has a tail cut
    (`askFullItems`, `askLineBytes`, off at its defaults); caps the answer at `askMaxBytes`; with `densePacket`, folds
    echoes out of the answer before rendering.
  - `compactAsk` (tokens): keeps dates as written, with their year; no tail cut.
  - Both are kept as alternatives. `ContextPartner.answering` builds the render options for both; `askCompact` wins if
    both are on. `renderPacket` takes the ask track's `fullItems`/`tailBytes` and the tokens track's `shownBefore`
    (`askDedup`) and `split` (`compactParts`) together, so `askDedup` and `compactParts` work under either.
- `config.ts` merged with `askItemBytes` declared twice; it is declared once.
- The tracks each took D73. Here they are one row per flag: D73 `askVerdicts`, D74 `askCompact`, D75 `conflictVocab`,
  D76 `compactAsk`, D77 `askDedup`, D78 `compactParts`, and D79 for ALL3. Code comments and the track write-ups now
  cite those numbers.

Checks on the final tree: `bun run check` green (1,090 tests). `bun run eval` with every flag off equals `main`'s
(`0bc877deb`, run in a separate worktree this session) except latency (p50 0.392 → 0.357 ms, p95 4.06 → 3.58 ms
on the final tree).

## Method

No-model funnel, seeds 41–44, real sync, cards replayed from `packages/sim/lab/cards/cards-v2.jsonl` (no live
enrichment: dev items with no card stay uncovered), `--ask`, `--packets`:

```bash
bun packages/sim/src/lab/hidden-funnel.ts --suite dev6a,dev6b --no-record --config "$CFG" \
  --cards packages/sim/lab/cards/cards-v2.jsonl --ask --packets out.jsonl
# and --suite hidden,heldout,heldout2,heldout3,heldout4
```

ALL is D64's (R plus `sync`). ALL3 is ALL plus the adopted flags that earn their place below. Measures are read from
the packets file, per task:

- **delivered**: a packet cited the planted item (hidden tasks).
- **askCited**: the ask's answer cited it.
- **either**: one or the other.
- **decoys**: the same two on control tasks (the decoy planted instead).
- **bytes per packet**: mean over packets.
- **bytes per ask**: mean answer over all tasks.
- **bytes per task**: packets plus one answer.
- **retention**: the evidence-word proxy of gen-tokens.md. Of the detail's key words (numbers, words of four letters or
  more) that the planted item holds, the share the packets and answer hold, over hidden tasks where either cites the
  planted item. "Lower" counts tasks cited in both runs whose retention fell.
- **card sends and calls**: the enricher's counters.

The ALL baseline reproduces every track's (in-sample 218 / 191 / 240, decoys 18; dev 49 / 108 / 109, decoys 14).

## ALL against ALL3

ALL3 = ALL + `askVerdicts` + `conflictVocab` + `compactAsk` + `askDedup` + `compactParts` + `cardsEconomy`.

| | dev6a ALL | dev6a ALL3 | dev6b ALL | dev6b ALL3 | dev ALL | dev ALL3 | in-sample ALL | in-sample ALL3 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| hidden tasks | 120 | 120 | 120 | 120 | 240 | 240 | 268 | 268 |
| delivered | 25 | 38 | 24 | 59 | 49 | **97** | 218 | 216 |
| askCited | 58 | 61 | 50 | 61 | 108 | **122** | 191 | **244** |
| either | 59 | 61 | 50 | 61 | 109 | **122** | 240 | **244** |
| decoys delivered | 6 | 6 | 8 | 4 | 14 | 10 | 18 | 17 |
| decoys askCited | 53 | 52 | 42 | 39 | 95 | 91 | 143 | 148 |
| bytes per packet | 306.6 | 335.4 | 312.6 | 375.9 | 309.1 | 353.5 | 339.8 | 340.6 |
| bytes per ask | 1,229.5 | 678.8 | 1,161.5 | 642.7 | 1,195.5 | **660.7** | 1,253.6 | **637.6** |
| bytes per task | 1,381.5 | 877.2 | 1,273.5 | 821.3 | 1,327.5 | **849.3** | 1,528.2 | **915.3** |
| retention | 0.945 | 0.939 | 0.982 | 0.985 | 0.962 | 0.962 | 1.000 | 0.995 |
| card sends | | | | | 2,785 | 1,294 | 6,660 | 2,970 |
| card calls | | | | | 411 | 215 | 970 | 496 |

### Task by task, ALL3 against ALL

- **Dev hidden**:
  - 48 delivery gains, 0 losses.
  - 14 askCited gains, 0 losses.
  - either +13, −0.
- **Dev decoys**: 4 fewer delivered and 4 fewer cited by the ask; none added.
- **In-sample hidden**:
  - 2 deliveries lost, the `po-threshold` pair gen-proactive.md traced.
  - 53 askCited gains, 0 losses.
  - either +4, −0.
- **In-sample decoys**: 1 fewer delivered; the ask cites 6 more and 1 fewer.
- **Retention fell** in 3 dev and 9 in-sample tasks cited in both runs:
  - 2 tasks: the year "2026" (`askDedup`, as in gen-tokens.md).
  - 10 tasks: the user's own first name "robin" (the agent's user, whom compaction names as the sender's self or
    drops).
  - No other word of a planted fact was lost.
- **Bytes the agent reads per task**: −36% on dev, −40% in-sample.
  - At 4 bytes a token and $0.053/M input (gen-tokens.md's figures), that is about −$0.006 per 1,000 tasks on dev
    and −$0.008 in-sample. Estimate from measured bytes; not tokenised.
- **Card calls**: −48% on dev and −49% in-sample. Replayed cards cost nothing here; gen-tokens.md's estimate of what
  that saves is about −$0.019 per 1,000 tasks.
- **Bytes per packet** rise on dev (309 → 354) because `conflictVocab` delivers 48 more conflict packets. Those
  packets are longer than the average; packets per task rise too. In-sample bytes per packet are flat.

## Leave one out (from ALL3)

Each row is ALL3 without one flag; the change is what that flag adds to ALL3, read task by task.

| ALL3 without | dev delivered | dev askCited | dev either | dev decoys del / ask | in delivered | in askCited | in either | in decoys del / ask | dev bytes per ask / task | in bytes per ask / task | retention lower (dev / in) | card calls (dev / in) |
|---|---:|---:|---:|---|---:|---:|---:|---|---|---|---|---|
| (ALL3) | 97 | 122 | 122 | 10 / 91 | 216 | 244 | 244 | 17 / 148 | 660.7 / 849.3 | 637.6 / 915.3 | 3 / 9 vs ALL | 215 / 496 |
| `askVerdicts` | 97 | 121 | 122 | 10 / 95 | 216 | 191 | 239 | 17 / 143 | 652.2 / 840.7 | 624.3 / 902.0 | 3 / 10 vs ALL | 215 / 496 |
| `conflictVocab` | 49 | 109 | 109 | 14 / 91 | 218 | 244 | 244 | 18 / 148 | 682.8 / 814.7 | 637.6 / 912.4 | 4 / 9 vs ALL | 215 / 496 |
| `compactAsk` | 97 | 122 | 122 | 10 / 91 | 216 | 244 | 244 | 17 / 148 | 1,099.7 / 1,288.2 | 1,074.6 / 1,352.3 | 3 / 3 vs ALL | 215 / 496 |
| `askDedup` | 97 | 122 | 122 | 10 / 91 | 216 | 244 | 244 | 17 / 148 | 767.7 / 956.2 | 795.1 / 1,072.8 | 3 / 7 vs ALL | 215 / 496 |
| `compactParts` | 97 | 122 | 122 | 10 / 91 | 216 | 244 | 244 | 17 / 148 | 643.9 / 833.8 | 636.6 / 914.0 | 11 / 9 vs ALL | 215 / 496 |
| `cardsEconomy` | 97 | 122 | 122 | 10 / 91 | 216 | 244 | 244 | 17 / 148 | 659.2 / 847.7 | 637.6 / 915.3 | 3 / 9 vs ALL | 411 / 970 |
| `compactAsk` → `askCompact` | 97 | 122 | 122 | 10 / 91 | 216 | 244 | 244 | 17 / 148 | 646.6 / 835.2 | 623.0 / 900.7 | 3 / 24 vs ALL | 215 / 496 |

What each flag adds to ALL3, task by task:

- **`askVerdicts`**:
  - dev: askCited +1, and 4 fewer decoys cited by the ask.
  - in-sample: askCited +53, either +5, decoys cited by the ask +6 / −1.
  - Retention: 1 task lower, 2 higher.
  - Cost: +8–13 bytes per answer.
- **`conflictVocab`**:
  - dev: +48 delivered, +13 askCited and +13 either, 4 fewer decoys delivered.
  - in-sample: −2 delivered, −1 decoy, either unchanged.
  - dev retention: 1 task higher.
- **`compactAsk`**:
  - Answers −40% (dev −439 B, in-sample −437 B).
  - Facts unchanged.
  - 6 in-sample tasks lower in retention (the user's own name, above).
- **`askDedup`**:
  - Answers −107 B on dev and −158 B in-sample.
  - Facts unchanged.
  - 2 in-sample tasks lower (the year).
- **`compactParts`**:
  - +17 B per answer on dev, +1 B in-sample.
  - Facts unchanged.
  - Keeps more evidence: 8 dev tasks higher in retention (dev retention 0.948 → 0.962).
- **`cardsEconomy`**:
  - Card sends −54% and −55%, card calls −48% and −49%.
  - Facts, decoys and bytes unchanged.
- **`askCompact` in place of `compactAsk`**:
  - Facts the same.
  - 14 to 15 bytes per answer fewer.
  - 15 more in-sample tasks lose evidence words (the year, which it drops from dates).
  - So ALL3 takes `compactAsk`, and `askCompact` stays a flag outside it.

## ALL3

Every flag in ALL3 earns its place in the leave-one-out on the evidence allowed: facts (`askVerdicts`,
`conflictVocab`), bytes at no fact (`compactAsk`, `askDedup`), evidence kept (`compactParts`) or card spend at no fact
(`cardsEconomy`).

```json
{"probes":true,"compactInjection":true,"quietSettled":true,"groundAway":true,"judgeContested":true,"judgeItemBytes":200,"probeShare":true,"probeTopicAlone":true,"fallbackAsks":true,"groundConflict":true,"quietClear":true,"probeFresh":true,"probeYield":true,"densePacket":true,"groundOccasion":true,"quietNameOnly":true,"judgeTied":true,"consequenceProbe":true,"probeRoles":true,"graph":true,"graphMerge":true,"cards":true,"anticipate":true,"sync":true,"askVerdicts":true,"conflictVocab":true,"compactAsk":true,"askDedup":true,"compactParts":true,"cardsEconomy":true}
```

It is proposed, not recommended. ALL stays the recommended experimental configuration (D64, D72) until a
pre-registered live measure of ALL3 against ALL passes.

## What this does not show

- **No generalisation evidence for the facts gains.**
  - `conflictVocab`'s dev gain is on the suites its fixes were read from.
  - `askVerdicts`' gain is in-sample, where its verdicts were studied.
  - On the other suite group each is neutral: `askVerdicts` +1 dev fact; `conflictVocab` −2 in-sample deliveries.
  - Only a blind measure says whether either generalises.
- **ALL2 precedent.** ALL2 (D72) passed the no-model funnel and lost live (−0.042 hidden). ALL3 contains
  `cardsEconomy`, one of ALL2's four flags, and changes what the agent reads, which the funnel cannot grade.
- **Live uptake of compacted answers is unmeasured.** An answer is about half its old size; whether an agent raises
  the fact from it as often is the live measure's question.
- **`askDedup` assumes the earlier packet is still in the agent's context.** A harness that trims context would read
  "(shown above)" for an item it no longer holds.
- **Uncovered dev cards.** 312 of 1,294 dev sends had no replayed card under ALL3 (339 of 2,785 under ALL). Dev items
  were not enriched live, so card-dependent verdicts are under-measured on dev.
- **No reviewer pass.** None of the three tracks, nor this combination, ran the `reviewer` subagent (no subagent tool
  in these sessions). It should run on the merged diff before `main`.

## Next

1. The pre-registered live measure: ALL3 against ALL on the Pi harness over blind suites, reading hidden facts
   raised, false concerns, agent input tokens and cost.
2. Make cards live for the blind suites first, so card-dependent verdicts are not under-measured.
3. Mark D73–D79 accepted or rejected from that measure.
