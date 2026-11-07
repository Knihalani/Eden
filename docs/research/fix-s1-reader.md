# Fix S1: the reader's cost on turns with nothing to add, and its latency

Status: results, 2026-11-07. Session S1 of the RealUse-1 fix wave ([realuse-1-weak-points.md](realuse-1-weak-points.md),
issues 1 and 6). Decisions D190–D194. Every paid call went to the Anthropic API with `HAIKU_API_KEY`,
`claude-haiku-5-5` in every role (agent, grader, Eden's cards, intent and reader), through the lab provider (D97),
`OPENROUTER_API_KEY` unset, on one spend ledger with a hard $5 cap (`--spend-cap 5 --spend-headroom 0.3`):
**Anthropic-direct lab figures**. The servers ship the same model through OpenRouter (D12), which nothing here called.
Never run here: `heldout15` (reserved for the final blind check).

## In plain words

- Two of the five fixes ship. **An `ask_context` call made while the user's request is still current now reuses the
  reader's push reading instead of paying for a second reading (D193).** **Re-reads of items a change signal put in
  doubt now start only for items the reader actually names (D192).** Together, on the Pi agent with Haiku: about 23%
  less spent per task across the realistic 1:1:8 traffic mix ($0.856 → $0.628 per 1,000 tasks), 0.49 s less wall time
  per task, 2.45 fewer connector calls, and on neutral turns half the reader calls (1.78 → 0.88). No measured loss in
  hidden facts raised or rise in false concerns.
- Three fixes were measured and deleted with their code and tests. An evidence gate in front of the reader (D190) could
  not tell turns that need the reader from those that do not: every bar lost hidden facts and raised decoys. Not
  waiting for a weak push (D191) gave no measurable speed-up and cost more on look-alike turns. A shorter reader reply
  (D194) was 24% faster per call but let through 108 more decoys of 384: the written reason before the verdict is what
  rejects look-alikes (as D96 found).
- **Spent: $1.9935** of the $5 cap.

## What was built and how each ended

| Fix                                    | Switch (all trials, D112)                       | $0 train screen (paid reader replayed)                                    | Live (Pi, Haiku)                                         | Outcome                     |
| -------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------- |
| (a) evidence gate on the reader's call | `readerEvidence` (+ its bar's 4 numbers)        | every bar: hidden down 3–22, decoys up 1–37                               | not run (failed the screen)                              | deleted (D190)              |
| (b) no observe wait on a weak pool     | `readerPushWeakNoWait` (+ the same bar)         | identical score (replayed readings take no time)                          | no latency gain; control $ and reader calls up           | deleted (D191)              |
| (c) re-reads after the reader names    | `readerVerifyAfter`                             | identical (no change signals in the train funnel)                         | fetches −1.6 to −2.6 a task; slower alone, faster with d | **promoted with d (D192)**  |
| (d) a same-turn ask reuses the push    | `readerReuse`                                   | narrow asks: reader calls 1,222 → 674, hidden 306 → 304, decoys 137 → 139 | neutral reader calls −0.9 a task, mix −$0.23/1k          | **promoted with c (D193)**  |
| (e) shorter reader output schema       | `readerShort` (`READER_SYSTEM_SHORT`, v7 short) | hidden 311 → 305, decoys 137 → 245; output 138 → 45 tokens                | not run (failed the screen)                              | deleted (D194)              |

The trials opened and closed in this session, so no row is left in DECISIONS.md's trials table (owner "repo owner",
end 2026-12-07, as asked).

## The $0 screens on train (LAB.md recipe 2a)

Train1–6, seeds 41–42 (768 tasks), the shipped default with cards and intent requests replayed and the paid Haiku
reader replayed from `reader-haiku-train-4142-intent.jsonl.gz`, topped up on Anthropic where a fix changed the reader's
prompts (below). "Binding nothing" counts reader calls whose reply named no binding item: the funnel's stand-in for a
turn where the reader had nothing to add (train has no neutral variant; heldout14's is blind).

```bash
gunzip -c packages/sim/lab/distilled/reader-haiku-train-4142-intent.jsonl.gz > .local/reader-haiku-train-4142-intent.jsonl
bun run funnel --jobs 4 --allow-misses --set '<SET>' -- --reader replay --reader-model claude-haiku-5-5 \
  --reader-cache <CACHE> --reader-log <LOG> [--ask-question narrow]
```

| Arm                                                                     | Reader calls | Binding nothing | Hidden /384 | Decoys /384 |
| ----------------------------------------------------------------------- | ------------ | --------------- | ----------- | ----------- |
| default (before this work)                                              | 651          | 302             | 311         | 137         |
| a: `readerEvidence` at 3 / 0.3 / 2 / 0.5 (top, coverage, matched, score) | 489          | 226             | 290         | 161         |
| a: top 8, coverage 0, matched 1, score 0.5 (loosest)                    | 642          | 298             | 308         | 138         |
| a: coverage 0.25, matched 1, score 0.3                                  | 567          | 271             | 298         | 144         |
| a: top 2                                                                | 435          | 197             | 289         | 174         |
| a: top 5, coverage 0.35, matched 2, score 0.7                           | 419          | 189             | 290         | 168         |
| b: `readerPushWeakNoWait`                                               | 651          | 302             | 311         | 137         |
| c: `readerVerifyAfter`                                                  | 651          | 302             | 311         | 137         |
| e: `readerShort` (topped up, cache `rc-short`)                          | 655          | 105             | 305         | 245         |
| default, narrow agent-worded asks (topped up, cache `rc`)               | 1,222        | 652             | 306         | 137         |
| d: `readerReuse`, narrow asks                                           | 674          | 325             | 304         | 139         |
| **the new default (c + d on)**                                          | 636          | 296             | 311         | 136         |
| the new default, narrow asks                                            | 674          | 325             | 304         | 139         |

- **(a) does not separate.** Before building it, the default's replay was instrumented (a scratch patch, not kept) to
  dump each reading's pool with every item's no-model score, card kind, constraint wording and intent-hit coverage,
  next to the replayed verdict. A turn "like neutral" was approximated by each pool with its planted item removed.
  Over a grid of bars (top 1–8 candidates, coverage 0–0.5, matched 1–4, score 0.3–0.9, a separate card floor), every
  bar that skipped at least a fifth of those neutral-like pools also skipped the reading that flagged 24 or more of the
  384 hidden facts. A real mailbox pool almost always holds a constraint-worded, carded item that matches the request's
  words. The planted fact itself is often an intent-only find with a no-model score of 0. The gate also costs decoys:
  a gated ask loses the reader's drops of look-alikes (`askReaderDrop`), so its answer lists them.
- **(e)'s reply is shorter and faster, and its verdict is worse.** On its 655-call top-up the output fell from a mean of
  138 to 45 tokens (p50 117.5 → 48) and the latency p50 from 1,073 to 816 ms (mean 1,159 → 875; the usual schema's
  figures from the 592-call narrow top-up), at the same $0.00022–0.00025 a call (input dominates). But the reader
  named 159 decoys as binding, against 23 with the usual schema. The prompt still told it to check who, what, when and
  where; what it no longer did was write, per item, what the item means for the request and whether it is the same
  thing before deciding. That is D96's finding (v4/v5's `why` before `binds`) from the other side.
- **(d) holds the screen.** With asks worded as an agent words them (`--ask-question narrow`, a simulation assumption,
  `narrow.ts`), each task's ask is a new reader call in the default (1,222 calls for 768 tasks). With reuse the ask
  reads the push's verdict: 674 calls, hidden 306 → 304 and decoys 137 → 139, both within the lab's ±3-task noise. With
  the funnel's default question (the request's own text) the ask already hit the reader's cache, so the new default
  changes that screen little (651 → 636 calls, 311/137 → 311/136).

## Live: Pi on Anthropic Haiku

Read suites `heldout13` (hidden, control) and `heldout14` (hidden, control, neutral), seeds 41–42 (one process each),
the direct market profile, `--push signals`, time scale 1, cards and intent requests replayed (1,598–1,599 of 1,605–1,608
items), 0 ungraded and `overBudget: reader 0, cards 0` in every run. n = 128 hidden, 128 control, 64 neutral per arm.
Paired bootstrap 95% intervals over tasks (4,000 resamples; RealUse-1's `t1.py` summariser through
`packages/sim/lab/fix-s1/s1.py`), against the plain default (`eden`) in the same run. A difference is called only
when its interval excludes zero. Outputs: `packages/sim/lab/fix-s1/pi-run{1,2}.txt` and `-summary.json`.

```bash
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite heldout13,heldout14 --seeds $SEED \
  --variants hidden,control,neutral --conditions eden,eden~b,eden~c,eden~d --config default \
  --variant-config '{"b":{"readerPushWeakNoWait":true},"c":{"readerVerifyAfter":true},"d":{"readerReuse":true}}' \
  --cards packages/sim/lab/cards/cards-v2.jsonl --cards-out .local/s1/pi/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push signals --budget 1.5 \
  --spend-ledger .local/ledger.jsonl --spend-cap 5 --spend-headroom 0.3 --run-label $L --out .local/s1/pi/$L.json
# run 2: --conditions eden,eden~cd,eden~d --variant-config '{"cd":{"readerVerifyAfter":true,"readerReuse":true},"d":{"readerReuse":true}}'
python3 -I packages/sim/lab/fix-s1/s1.py OUT.json .local/ledger.jsonl run-41.json,run-42.json
```

### Run 2, the shipped pair (c + d) against the default

| arm     | kind    | rate  | wall p50 / mean s | Eden on path ms | Eden task $/1k | all-in $/1k | reader | Eden fetch |
| ------- | ------- | ----- | ----------------- | --------------- | -------------- | ----------- | ------ | ---------- |
| eden    | hidden  | 0.758 | 4.05 / 4.70       | 1,693           | 0.327          | 0.657       | 1.25   | 4.38       |
| eden    | control | 0.016 | 5.50 / 5.71       | 2,220           | 0.453          | 0.835       | 1.73   | 5.80       |
| eden    | neutral | 0.062 | 6.05 / 6.26       | 2,531           | 0.465          | 0.883       | 1.78   | 6.64       |
| eden~cd | hidden  | 0.773 | 4.32 / 4.61       | 1,702           | 0.239          | 0.566       | 0.91   | 2.80       |
| eden~cd | control | 0.016 | 5.28 / 5.40       | 1,999           | 0.267          | 0.645       | 1.03   | 3.23       |
| eden~cd | neutral | 0.016 | 5.51 / 5.70       | 2,032           | 0.218          | 0.634       | 0.88   | 4.17       |

rate: hidden facts raised (hidden), false concerns (control), any concern (neutral). The 1:1:8 mix (1 hidden, 1
control, 8 neutral in 10; RealUse-1's assumption): eden $0.856/1k (Eden $0.511), wall mean 6.05 s, 10.34 connector
calls; eden~cd $0.628/1k (Eden $0.286), 5.56 s, 7.89 calls.

| eden~cd − eden | hidden facts             | wall s                   | all-in $/1k                 | connector calls          | reader calls             | Eden fetches             | Eden on path ms        |
| -------------- | ------------------------ | ------------------------ | --------------------------- | ------------------------ | ------------------------ | ------------------------ | ---------------------- |
| hidden         | +0.016 (−0.047..+0.078)  | −0.09 (−0.37..+0.18)     | **−0.091 (−0.137..−0.048)** | **−1.88 (−2.37..−1.43)** | **−0.34 (−0.47..−0.23)** | **−1.59 (−1.95..−1.23)** | +9 (−148..+168)        |
| control        | +0.000 (−0.023..+0.023)  | −0.32 (−0.67..+0.04)     | **−0.191 (−0.244..−0.138)** | **−2.65 (−3.30..−2.02)** | **−0.70 (−0.85..−0.55)** | **−2.57 (−3.04..−2.10)** | **−221 (−431..−7)**    |
| neutral        | −0.047 (−0.125..+0.016)  | **−0.56 (−0.93..−0.17)** | **−0.250 (−0.331..−0.174)** | **−2.50 (−3.27..−1.75)** | **−0.91 (−1.14..−0.69)** | **−2.47 (−3.17..−1.81)** | **−499 (−769..−226)**  |
| 1:1:8 mix      | raised +0.002 (−0.005..+0.009), wrong −0.038 (−0.098..+0.013) | **−0.49 (−0.80..−0.18)** | **−0.228 (−0.292..−0.165)** | **−2.45 (−3.05..−1.87)** | | | |

The "control" and "neutral" rates are false concerns: lower is better.

### Every arm, both runs (differences against `eden` in the same run)

| arm, run      | kind    | rate                     | wall s                   | all-in $/1k                 | reader calls             | Eden fetches             |
| ------------- | ------- | ------------------------ | ------------------------ | --------------------------- | ------------------------ | ------------------------ |
| b, run 1      | hidden  | −0.008 (−0.094..+0.070)  | −0.12 (−0.43..+0.20)     | +0.023 (−0.030..+0.081)     | +0.04 (−0.09..+0.16)     | +0.13 (−0.27..+0.54)     |
| b, run 1      | control | +0.023 (+0.000..+0.055)  | −0.12 (−0.43..+0.18)     | **+0.057 (+0.003..+0.111)** | **+0.13 (+0.01..+0.26)** | +0.38 (−0.09..+0.84)     |
| b, run 1      | neutral | −0.031 (−0.094..+0.031)  | −0.18 (−0.58..+0.22)     | −0.042 (−0.117..+0.028)     | −0.17 (−0.36..+0.02)     | +0.02 (−0.64..+0.69)     |
| c, run 1      | hidden  | +0.039 (−0.031..+0.109)  | +0.07 (−0.24..+0.37)     | −0.037 (−0.085..+0.010)     | −0.12 (−0.23..+0.00)     | **−1.84 (−2.23..−1.45)** |
| c, run 1      | control | +0.016 (+0.000..+0.039)  | **+0.38 (+0.10..+0.65)** | +0.030 (−0.011..+0.073)     | +0.06 (−0.03..+0.16)     | **−1.95 (−2.37..−1.51)** |
| c, run 1      | neutral | −0.016 (−0.047..+0.000)  | +0.22 (−0.09..+0.52)     | −0.026 (−0.087..+0.034)     | −0.06 (−0.20..+0.08)     | **−2.42 (−3.11..−1.77)** |
| d, run 1      | hidden  | +0.016 (−0.062..+0.094)  | −0.15 (−0.45..+0.12)     | **−0.079 (−0.123..−0.037)** | **−0.37 (−0.49..−0.25)** | −0.33 (−0.68..+0.02)     |
| d, run 1      | control | +0.016 (+0.000..+0.039)  | −0.17 (−0.49..+0.12)     | **−0.149 (−0.198..−0.100)** | **−0.67 (−0.81..−0.53)** | −0.11 (−0.46..+0.25)     |
| d, run 1      | neutral | −0.031 (−0.094..+0.031)  | −0.37 (−0.81..+0.07)     | **−0.242 (−0.320..−0.165)** | **−0.95 (−1.19..−0.72)** | −0.58 (−1.20..+0.08)     |
| d, run 2      | hidden  | −0.078 (−0.156..+0.000)  | **−0.35 (−0.67..−0.04)** | **−0.079 (−0.130..−0.030)** | **−0.31 (−0.44..−0.20)** | −0.35 (−0.74..+0.05)     |
| d, run 2      | control | −0.008 (−0.023..+0.000)  | **−0.35 (−0.69..−0.01)** | **−0.176 (−0.228..−0.125)** | **−0.72 (−0.87..−0.57)** | **−0.70 (−1.12..−0.27)** |
| d, run 2      | neutral | −0.047 (−0.125..+0.016)  | **−0.64 (−1.05..−0.22)** | **−0.251 (−0.334..−0.175)** | **−0.88 (−1.11..−0.66)** | **−1.05 (−1.67..−0.44)** |

Run 1's `eden` read hidden 0.727, control 0.000, neutral 0.047; run 2's 0.758, 0.016, 0.062. The same arm moved by up
to 3 points between runs, which is the agent's and grader's sampling.

What the numbers say:

- **(d) is the cost and latency fix.** An agent's `ask_context` in the request's turn was a second reader call over a
  pool most of which the push had just read. Reusing the push's reading removes most of those calls (neutral −0.88 to
  −0.95 a task), and with them their wait and the re-reads started beside them. Alone, its hidden-facts difference was
  +1.6 points in run 1 and −7.8 points in run 2 (−15.6..0.0, touching zero), so a loss of a few points cannot be ruled
  out for (d) alone. With (c) it read +1.6 (−4.7..+7.8). An ask that acts on its own (another request) and an ask whose
  push gave no verdict still read as before.
- **(c) is the connector-call fix.** It removes 1.6 to 2.6 fetches a task: the re-reads `checkAhead` started beside
  every reader call, on doubted items the reader mostly did not name (D134 kept them for latency). Alone it was slower
  (control wall +0.38 s): a delivery whose item is doubted now waits for its re-read after the reader. With (d) there
  are fewer readings and fewer deliveries to wait on, and the pair is faster than the default (mix −0.49 s). On a
  connector platform billed per call (RealUse-1's $12 per 1,000 calls, an assumption), 2.45 fewer calls a task is about
  $29 per 1,000 tasks, far more than the model's whole bill.
- **(b) did not pay.** Returning from `observe` at once on a weak pool moved neither wall time nor Eden's time on the
  path (Eden on path +30 to +60 ms, n.s.). On control tasks the agent asked a little more often (reader calls +0.13,
  $ +0.057/1k, both excluding zero), probably because it more often started without the push's packet.

## Decision rows (D190–D194; renumber on merge)

D190 (rejected: evidence gate), D191 (rejected: no observe wait on a weak pool), D192 (promoted: re-reads after the
reader names an item; reopens D134), D193 (promoted: a same-turn ask reuses the push's reading), D194 (rejected:
the short output schema). `DEFAULT_CONFIG` gains `readerVerifyAfter: true` and `readerReuse: true`; both are in the
`reader` part, and `readerVerifyAfter` is in the `freshness` and `sync` parts too (its parent `verifyDelivery` is
theirs), so every `minus-<part>` preset stays valid.

## Checks on the final tree

- `bun run eval` (no model): identical to the parent commit apart from latency: precision 0.8276, recall 0.48,
  falseFireRate 0, 0 secrets leaked, notInert 0.
- Live eval on Anthropic (`bun packages/sim/src/lab/eval-live.ts --spend-ledger .local/ledger.jsonl --spend-cap 5`,
  the shipped wiring with the reader on `claude-haiku-5-5`, a lab transport, not the shipped OpenRouter route):
  precision 0.8276, recall 0.48, falseFireRate 0, 6 reader calls, $0.00084 (the 2026-11-05 `close-eval-live` run had
  the same three metrics, 6 calls, $0.00103).
- Funnel recipe 2a on the new default: hidden 311/384, decoys 136/384, 636 reader calls replayed, 0 missed.

## Spend

| Ledger run         | What                                                       | Calls / runs        | $       |
| ------------------ | ---------------------------------------------------------- | ------------------- | ------- |
| `s1-narrow-topup`  | reader top-up for narrow agent-worded asks (screen of d)   | 592 reader calls    | 0.1465  |
| `s1-short-topup`   | reader top-up for the short schema (screen of e)           | 655 reader calls    | 0.1444  |
| `s1-pi-41`, `-42`  | Pi run 1: eden, eden~b, eden~c, eden~d                     | 1,280 task runs     | 0.9926  |
| `s1-pi2-41`, `-42` | Pi run 2: eden, eden~cd, eden~d                            | 960 task runs       | 0.7091  |
| `run`              | live eval on Anthropic                                     | 6 reader calls      | 0.0008  |
| **Total**          |                                                            |                     | **1.9935** |

## Caveats

- Two live runs on two seeds; neutral n = 64 per arm. Every quality difference here is within noise; the promotion
  rests on cost and latency at no measured quality loss, as D112 asks, not on a quality gain.
- The funnel's narrow ask is a simulation of agent wording; the live runs are the real ask pattern.
- Anthropic-direct transport; the OpenRouter route the servers ship is not measured.
- heldout13 and heldout14 have both been read before (D112, RealUse-1), so these runs are not blind; `heldout15` stays
  unread for the wave's final check.
