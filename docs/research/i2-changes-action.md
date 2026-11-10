# I2: does the item change what the agent should do? Opus labels it; can a small checker learn it?

Status: 2026-11-10, branch `claude/i2-changes-action` (from `claude/lucid-hypatia-v9wqk5` with I1 merged), session I2.
Decisions D490–D494. Train suites only (train1–6); no held-out suite was dumped, labelled or run (heldout18 stays
blind). Numbers marked **[EST]** are arithmetic or judgement; every other number comes from a command in this note.

## In plain words

- **The question.** I1 found that Opus could not tell a planted fact from its look-alike when asked "is this about the
  same person, thing and date?", because the train suites' look-alikes are the fact's all-clear twin. I2 asked the
  product's question instead: "does this item change what the assistant should do for this request?"
- **Opus can answer it.** On 40 templates held out from everything, Opus's confidence ranks the fact above its
  look-alike with AUC **0.917** (I1: 0.548), and 0.898 on fresh worlds. Measured first, as the brief asked.
- **A small model cannot learn it from these labels.** Seven cross-encoders, 4 M to 568 M parameters, distilled on
  Modal from Opus's labels on 12,468 pairs, learn Opus's sense of topic (AUC 0.83–0.92 against Opus) but rank the
  fact above its look-alike only half the time on new templates (0.45–0.55). In sample they learned it (0.864): 154
  templates with one fact-and-twin each are too few for the distinction to transfer. In the funnel the best CPU
  checker silenced the packet instead of sorting it (planted facts in the packet 104 → 36): it failed the
  pre-registered bar, so no live Pi run was made.
- **But the mechanism works with a good enough judge.** Opus's own labels served as the checker passed the bar on
  the held-out templates and again on fresh worlds: look-alikes in the packet 84 → 18 and 66 → 9, planted facts kept
  (104 → 104, 64 → 65), neutral tasks given a packet 135 → 5 and 107 → 3. **Haiku 5.5**, asked the same question,
  passed too (look-alikes in the packet −42 and −16, planted facts +14 and +20, neutral packets 135 → 9 and 107 → 9).
  A per-push Haiku check is a model call on the request path, so it is a recommendation for a later session, not a
  change here.
- **Cost:** $12.97 Anthropic (Opus $12.70, Haiku $0.27; ledger), $0.77 Modal. The engine is unchanged.

## 1. What I1 left and what I2 asks

I1 (docs/research/i1-checker.md, D470–D474) asked Opus 5.5 whether each push-pool item is "about the same person,
thing and date as the request and bears on it". The train suites' decoys are the planted fact's all-clear twin (the
same person, thing and date, saying it is fine to go ahead), so Opus said yes to both: planted-vs-decoy AUC 0.548 on
the held-out templates. I2 asks the product's question instead: **does this item change what the assistant should
do for this request** (a constraint, conflict, deadline, prior decision, exception, a reason to stop or check), or is
it consistent with going ahead as asked, background, or about something else?

## 2. The teacher on the new question (step 1)

**Pairs.** I1's recipe on the current tree: `bun run funnel --suite train --seeds 41,42,43,44 --jobs 4 -- --neutral
--pool-dump` (17 s), then `i1-label.ts pairs`: 768 groups (every train template, 192, on four seeds), 16,223 pairs
(564 planted, 495 decoys, 15,164 other). The same split as I1 (40 templates held out by a hash of suite and
template): 160 groups, 3,698 pairs.

**Prompt.** `CHANGES_SYSTEM` (`packages/sim/src/lab/i2-label.ts`), fixed before any held-out label was read. Layout,
fencing, shuffle and output format are I1's; the request and items are fenced as data. Checked for format only on 4
train-template groups of seed 41 (direct, $0.1594).

**The gate, measured first.** The 160 held-out groups (seeds 41–44) as one Message Batch ($2.4138): Opus's confidence
separates planted facts from their decoys with **AUC 0.917** (I1's question: 0.548), and from other items with 0.993.
It said yes (confidence ≥ 50) to 99 of 125 planted facts, 20 of 98 decoys and 49 of 3,475 other items. The gate
(AUC ≥ 0.75) passed, so the train templates were labelled: 608 groups in one batch ($8.1502), 2 replies unparsed
(`train5/42/rail-strike-leeds`, `train5/43/valencia-hotel-night-works`), 12,468 pairs. On the train templates:
planted-vs-decoy **0.941**, planted yes 365 of 437, decoys 54 of 395, other 251 of 11,636.

| Question (Opus 5.5, effort low) | Held-out planted vs decoy | Planted yes | Decoy yes | Other yes |
| --- | --- | --- | --- | --- |
| I1: same person, thing, date and bears on it | 0.548 | 413/423 (all) | 273/372 (all) | 338/11,494 (all) |
| **I2: changes what the assistant should do** | **0.917** | 99/125 | 20/98 | 49/3,475 |

**Anthropic so far: $10.7235** on the ledger (`.local/i2/ledger.jsonl`): pilot $0.1594, held-out batch $2.4138, train
batch $8.1502. (The runner's printed "ledger total" adds its in-process reservation of the batch's worst case; the
ledger's rows sum to $10.7235.)

## 3. The distilled checkers (step 2)

I1's trainer unchanged (`packages/sim/modal/i1_checker.py`: pointwise BCE on Opus's confidence, decoy and planted pairs
weighted `--decoy-weight`, max length 256, Modal L4/A10G/T4), trained on the train templates of all four seeds
(12,468 pairs), scored on the 40 held-out templates (3,698 pairs). CPU: `evaluate.py`, one thread, this container,
one request's first 15 pool items.

| Model | params | epochs, decoy weight | AUC vs Opus (before → after) | planted vs rest | **planted vs decoy** | CPU ms / 15 pairs p50 (p90), int8 |
| --- | --- | --- | --- | --- | --- | --- |
| ms-marco-TinyBERT-L2-v2 | 4 M | 3, 2 | 0.650 → 0.829 (int8) | 0.864 | 0.449 | 24 (28) |
| ms-marco-MiniLM-L2-v2 | 16 M | 3, 2 | 0.624 → 0.849 (int8) | 0.872 | 0.464 | 84 (110) |
| ms-marco-MiniLM-L6-v2 | 23 M | 3, 2 | 0.644 → 0.869 (int8) | 0.909 | 0.464 | 241 (289) |
| **ms-marco-MiniLM-L6-v2** (primary) | 23 M | 5, 8 | → 0.882 (int8) | 0.915 | **0.478** | 230 (282) |
| ms-marco-MiniLM-L12-v2 | 33 M | 5, 8 | → 0.899 (int8) | 0.928 | 0.517 | 494 (595) |
| bge-reranker-base (GPU AUCs) | 278 M | 3, 2 | → 0.891 | 0.907 | 0.540 | not run |
| bge-reranker-v2-m3 (GPU AUCs) | 568 M | 2, 2 | → 0.921 | 0.943 | 0.554 | not run |
| (Opus 5.5 itself) | | | | 0.991 | 0.917 | |

**No distilled model learns the distinction on templates it was not trained on.** They learn Opus's topic judgement
(0.83–0.92 against Opus, about as I1's did) but rank the planted fact above its decoy about half the time (0.45–0.55),
the 568 M model included. In sample they had learned it: the first MiniLM-L6 separates the train templates' planted
facts from their decoys at **0.864** (`insample` check, 439 planted, 397 decoys), 0.464 held out. 154 templates, one
fact-and-twin pair each, are not enough examples of "constraint against all-clear" for it to transfer; more pairs per
template would not help (I1 §7). Training took 23–238 s a small model, 924–1,133 s the two bge models.

## 4. Pre-registration (written and committed before the funnel screen, step 3)

The distilled checkers fail the gate the brief set for the teacher (planted-vs-decoy AUC ≥ 0.75), so the expected
outcome of the primary arm is a fail. The screen runs anyway, because it is cheap ($0) and because I1 found the
checker's real cost in the packet, not in AUCs; and it adds an upper bound I1 did not have.

**Arms** (`pushCheck`, I1's D471 trial revived as D491; code from commit fced3789; the funnel's `--checker URL`):

- **A, primary:** the distilled checker chosen by this rule, fixed before the screen: the best held-out planted-vs-decoy
  AUC (int8, CPU) among models under 300 ms p50 for 15 pairs on one thread: **MiniLM-L6, 5 epochs, decoy weight 8,
  int8** (0.478). Pass mark **0.5** (its score is calibrated to Opus's confidence).
- **B, upper bound (not shippable):** Opus's own labels served as the checker (`sidecar.py serve --oracle`), pass
  mark 0.5 (confidence 50). Any shippable checker is at best this. It needs a teacher label for each pool item, so it
  runs on seeds 41–44 only; an item with no label (the 2 unparsed groups) scores 0.

The rule both arms run (D471's): the push's candidates are the pool's first 15 items (bulk mail out, pool order)
scoring at least the pass mark, the first 5 of them; none passing sends no candidates packet.

**Screen.** `bun run funnel --suite train --seeds 41,42,43,44 --jobs 2 -- --neutral` with each arm against the same run
with the trial off, task by task (`compare.py --bar i2`). Primary figures: **the 40 held-out templates** (160 hidden,
160 control and 160 neutral tasks).

**The bar (D493), on the held-out templates, all four seeds; every clause must hold:**

1. decoy handed (the decoy in the candidates packet) **16 or more fewer** than the trial off (about a fifth of I1's 83);
2. planted handed **at most 5 fewer** (I1's lesson: the funnel's "surfaced" hides a fact moved from the packet to the
   ask, and D257 showed that loses facts live);
3. hidden surfaced **at most 2 fewer**; decoys surfaced **at most 2 more**;
4. neutral tasks given a candidates packet **not more** than with the trial off.

**Confirmation (step 3b).** An arm that passes is checked once on fresh worlds, **the held-out templates on seeds
45–48**, against the trial off on the same seeds, by the same bar. Arm A needs nothing more. Arm B needs Opus's labels
for those worlds: their 160 held-out groups are dumped and labelled by the same prompt as one batch (about $2.4
[EST], from the held-out batch above) only if B passes on seeds 41–44.

**Live (step 4)** only if arm A passes both the screen and the confirmation: a Pi run on Modal (at most two Anthropic
shards at a time, the existing `HAIKU_API_KEY` Secret, Sonnet-regraded concerns). Arm B passing alone is not run live
(a model call a push is not on the fast path; it would need its own decision and a cost estimate).

## 4b. Addendum, pre-registered before its run: Haiku 5.5 as the checker, on fresh worlds

Written after §5's screens (arm A failed, arm B passed and confirmed) and after an exploratory arm not in §4: Haiku 5.5
(`claude-haiku-5-5`, effort low) labelled the 160 held-out groups of seeds 41–44 with the same `CHANGES_SYSTEM`
($0.1241: a batch with 23 replies cut short, re-run direct), planted-vs-decoy AUC 0.876, and its labels served as
the checker passed §4's bar on those tasks. That arm was chosen after seeing arm B, so it is checked once on worlds no
step has seen: **the held-out templates on seeds 45–48**, Haiku's labels for their 160 groups made the same way, the
same pass mark (0.5) and bar (§4), against the trial off on the same seeds (intent inert in both arms, as in §5).
Passing would recommend a per-push Haiku check to a later session (a model call a push needs its own decision and a
cost estimate, docs/COST-MODEL.md); no live run is made in this session either way, since §4's live step was for a
CPU checker (arm A) only.

## 5. Results (step 3)

Funnel, `bun run funnel --suite train --jobs 2 -- --neutral` with `pushCheck` on (`pushCheckWaitMs` 60,000, so every
decision is the checker's: 636 calls a process, 0 failures in every arm) against the same seeds with it off
(`compare.py --bar i2`). Held-out templates: 160 tasks a variant. "Planted (decoy) handed": the planted item (decoy)
in the candidates packet; "surfaced" is the funnel's (packet or ask); "neutral packets": neutral tasks given one.

| Arm | Seeds | Hidden surfaced | Decoys surfaced | Planted handed | Decoy handed | Neutral packets | Packet KB (hid/ctl/neu) | Bar |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| trial off | 41–44 | 136 | 104 | 104 | 84 | 135 | 216 / 197 / 149 | |
| **A: MiniLM-L6 int8, 0.5** | 41–44 | 134 (+1 −3) | 105 (+1 −0) | **36** | 25 | 1 | 69 / 46 / 10 | **fail** |
| **B: Opus's labels, 0.5** | 41–44 | 141 (+5 −0) | 103 (+3 −4) | **104** | **18** | 5 | 124 / 51 / 13 | **pass** |
| Haiku's labels, 0.5 (exploratory) | 41–44 | 145 (+9 −0) | 102 (+4 −6) | 118 | 42 | 9 | 139 / 73 / 15 | pass |
| trial off (intent inert) | 45–48 | 82 | 83 | 64 | 66 | 107 | 194 / 186 / 112 | |
| **B: Opus's labels** (§4 confirmation) | 45–48 | 92 (+14 −4) | 75 (+0 −8) | 65 | **9** | 3 | 85 / 38 / 5 | **pass** |
| **Haiku's labels** (§4b confirmation) | 45–48 | 102 (+21 −1) | 80 (+1 −4) | 84 | **50** | 9 | 102 / 71 / 9 | **pass** |

Over all 768 tasks of seeds 41–44 (train templates in sample for A, labelled by the teacher for B): trial off hidden
634, decoys 552, neutral packets 617 (seeds 41–42: 314/274, as main); A 652 / 548 / 28, planted handed 491 → 405;
B 658 / 540 / 49, planted handed 491 → 466, decoys handed 418 → 64. On seeds 45–48 only the held-out templates were
labelled, so the arms' other templates there (scored 0, no packet) are not a measurement. Opus's labels missed 74 of
27,511 lookups on 41–44 (the two unparsed groups), scored 0.

**Reading it.** The distilled checker separates ordinary items (planted against the rest 0.915) and so silences
neutral pools, but within a pool that holds the fact it cannot tell the fact from its twin, and at a mark that keeps
the twin out it keeps the fact out too (arm A). A judge that can tell them apart turns the same rule into what I1
was after: the packet keeps the fact, loses the look-alike, and stays silent where nothing applies. The hidden gains
(+5 to +21) come from facts at the pool's 6th–15th places entering the packet when items above them fail. Haiku is
more lenient than Opus (41 of 98 held-out decoys yes, against 20), so it removes fewer look-alikes (−16 on fresh
worlds, exactly the bar) but keeps or adds more facts.

## 6. Cost and latency

**Anthropic: $12.9698** on the ledger (`.local/i2/ledger.jsonl`): Opus 5.5 $12.7009 (pilot $0.1594 direct; batches
$2.4138 held-out, $8.1502 train, $1.9774 seeds 45–48 held-out), Haiku 5.5 $0.2689 (batch $0.0858, direct re-runs and
seeds 45–48 $0.1831). **Modal: $0.7722** for the 7 training runs (`modal billing report --for today --json`, by app
id). No live Pi run; nothing else spent.

**Production shape [EST].** The distilled checker is 230 ms of one core a push (int8, 15 pairs) and does not work. The
teacher arms are not CPU checkers: Opus a push is out of the question on cost and latency; Haiku a push is about
$0.0009 direct at this prompt (161 direct calls, $0.1449, groups of about 18 items) and adds a model round trip to
the push (not measured here; D144's reader timings put Haiku 5.5 with effort low at seconds, not milliseconds).

## 7. What would change the answer, and the next step

- **A Haiku check on the push, as a trial (recommended).** D493's result is the first lever in this line of work that
  moves look-alikes out of the packet without moving facts out with them. Before it can ship it needs: a decision
  for a model call on the request path (D4, D5) with a cost estimate in docs/COST-MODEL.md, the check built behind
  `Budget` with a wait and the default's candidates on a miss (D471's shape), Haiku without thinking measured too
  (the shipped reader sends none, D144), and a live Pi run (D257: the packet's facts are what the agent uses).
- **A CPU checker needs data, not size.** In sample a MiniLM learned the distinction; on new templates no model did.
  Generated fact-and-twin pairs over many more templates (the twins differ by the constraint, not the topic) are the
  untested route; train on generated templates, test on these.
- **Limits.** Train suites only; one prompt; the teacher saw each group's items together (the fact beside its twin),
  which a push check would too (it sees the pool), but the Haiku arm's labels came from groups that union three
  worlds' pools, not one push's pool; the oracle arms read labels, so the funnel cannot see their latency. Seeds 45–48
  ran intent inert in both arms.

## Reproduce

```bash
bun run funnel --suite train --seeds 41,42,43,44 --jobs 4 --json .local/i2/base.json -- --neutral \
  --pool-dump .local/i2/pool.jsonl                                                                  # 17 s, $0
bun packages/sim/src/lab/i1-label.ts pairs --pool .local/i2/pool.jsonl --out .local/i2/pairs.jsonl
L="--spend-ledger .local/i2/ledger.jsonl --spend-cap 20 --mode batch"
bun packages/sim/src/lab/i2-label.ts label --pairs .local/i2/pairs.jsonl --out .local/i2/labels-eval.jsonl $L \
  --seeds 41,42,43,44 --split eval                                                                  # $2.41, the gate
bun packages/sim/src/lab/i2-label.ts auc --pairs .local/i2/pairs.jsonl --labels .local/i2/labels-eval.jsonl
bun packages/sim/src/lab/i2-label.ts label --pairs .local/i2/pairs.jsonl --out .local/i2/labels-train.jsonl $L \
  --seeds 41,42,43,44 --split train                                                                 # $8.15
cat .local/i2/labels-eval.jsonl .local/i2/labels-train.jsonl > .local/i2/labels.jsonl
export SSL_CERT_FILE=/root/.ccr/ca-bundle.crt
modal run packages/sim/modal/i1_checker.py --pairs .local/i2/pairs.jsonl --labels .local/i2/labels.jsonl \
  --max-len 256 --run i2-minilm6-w8 --base cross-encoder/ms-marco-MiniLM-L6-v2 --decoy-weight 8 --epochs 5
python3 -I packages/sim/lab/i1/evaluate.py --model .local/i1/models/i2-minilm6-w8 --pairs .local/i2/pairs.jsonl \
  --labels .local/i2/labels.jsonl --n 60
# The funnel screen needs the deleted trial: git checkout 2cc34284, then
python3 -I packages/sim/lab/i1/sidecar.py serve --model .local/i1/models/i2-minilm6-w8 --threads 2 --port 8471 &
python3 -I packages/sim/lab/i1/sidecar.py serve --oracle .local/i2/labels.jsonl --pairs .local/i2/pairs.jsonl \
  --port 8472 &
bun run funnel --suite train --seeds 41,42,43,44 --jobs 2 --json .local/i2/trialB.json \
  --set '{"pushCheck":true,"pushCheckWaitMs":60000}' -- --neutral --checker http://127.0.0.1:8472
python3 -I packages/sim/lab/i1/compare.py --base .local/i2/base.json --trial .local/i2/trialB.json --bar i2
# Seeds 45-48: the same with --seeds 45,46,47,48, pairs45/labels45 (held-out split only); Haiku: --model claude-haiku-5-5
```
