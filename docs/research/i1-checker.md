# I1: a small checker distilled from Opus, to tell a planted fact from its look-alike

Status: 2026-11-10, branch `claude/i1-checker` (from `claude/lucid-hypatia-v9wqk5`), session I1. Decisions D470–D474.
Train suites only (train1–6); no held-out suite was dumped, labelled or run. Numbers marked **[EST]** are arithmetic or
judgement; every other number comes from a command in this note.

## In plain words

- **The question.** Eden's packets carry look-alikes (decoys) about one per planted fact. Could a small model, trained
  on a strong teacher's judgement of (request, item) pairs, check each candidate cheaply on a CPU and keep the fact
  while dropping its look-alike? The owner asked for Opus 5.5 as the teacher.
- **What was done.** Opus labelled 12,289 pairs from the push pools of train1–6 (seeds 41–43), with the sim's own
  answer kept beside its labels. Five small rerankers were fine-tuned on Modal GPUs and exported to run on a CPU. The
  best one became a trial switch (`pushCheck`) and was screened in the no-model funnel against a bar written before
  the screen, on 40 templates no model had trained on.
- **Answer: no.** The checker learned Opus's judgement well (AUC 0.906 against Opus on the held-out templates; 0.743
  before training), but **Opus itself cannot tell a planted fact from its decoy under the asked question** (AUC 0.548
  held out). The train suites' decoys are mostly the fact's all-clear twin, about the same person, thing and date and
  so relevant (Opus said yes to 273 of 372). The trial missed the bar (hidden +2, decoys +2 of 160), and a pass mark
  picked after seeing the data (0.3) failed its own pre-registered check on fresh worlds (hidden +7, decoys +5): facts
  and look-alikes rise together, as in M3. No live run was made, as the pre-registration said.
- **What did work, and why it is not enough.** The checker is a very good silence switch. On tasks with nothing
  planted, it cut candidates packets from 617 of 768 to 54, and packet bytes overall by about half (the D403 cost
  gap is the packet's bytes). But at the same mark it also took the planted fact out of the packet on about 45% of
  hidden tasks it had been in (held out: 103 → 56). The funnel still counts those as surfaced through the ask, but a
  live agent then has to ask, and D257 showed that costs facts live. Gate-only silence (the default's candidates
  whenever anything passes) failed the same way.
- **Kept.** The labeller, training, CPU sidecar and comparison scripts (lab tooling). The engine switch was deleted
  under D112; its code is in commit fced3789. **Cost: $7.91 Anthropic (Opus 5.5, ledger; $7.70 of it as a Message
  Batch at half price), about $0.40 Modal.**

## 1. Pre-registration (written and committed before the funnel screen, step 4)

**What was found before this was written (steps 1–2 so far).** Opus 5.5 labelled 12,289 (request, item) pairs from
the push pools of train1–6, seeds 41–43 (576 groups, $7.91 Anthropic, ledger). Against the sim's truth it said yes to
413 of 423 planted facts, **273 of 372 decoys** and 338 of 11,494 other items. Its confidence separates planted facts
from other items (AUC 0.986 on the 40 held-out templates) but **not from decoys (AUC 0.548 held out, 0.704 on train
templates)**: the train suites' decoys are mostly the all-clear twin of the fact (the same person, thing and date,
saying it is fine), which the brief's question ("about the same person, thing and date, and bears on it") rightly
calls relevant. So a checker distilled from these labels can at best cut ordinary items and silence pools with
nothing relevant; it cannot be expected to cut decoys. That is the hypothesis the bar tests.

**The checker.** The primary model is the one chosen by step 2's rule: the cross-encoder fine-tuned on Opus's
confidence (`--target opus`) with the best AUC against Opus's labels per CPU millisecond on the held-out templates,
among those within 0.01 AUC of the best. Its threshold is fixed at **0.5** (its score is calibrated to Opus's
confidence). A model trained on the sim's truth (`--target truth`: planted 1, decoy and other 0) is screened as a
secondary arm only: it departs from the brief's teacher, and passing alone it would need its own decision.

**The trial (`pushCheck`, D471).** With the checker answering, the push's candidates are the pool's items (its first
15, bulk mail out, in the pool's order) whose score is at least 0.5, the first `pushCandidates` (5) of them: (a)
items 6–15 that pass enter, (b) items 1–5 that fail leave, (c) no candidates packet when none passes (the checker then
stands in for the constraint-like gate). Everything after (askNudge, the settled cut) is unchanged. On a timeout or
error the default's candidates go out.

**The screen.** `bun run funnel --suite train --seeds 41,42,43,44 -- --neutral` with the trial on against the same
run with it off, task by task. Train templates were in the checker's training set (seeds 41–43), so **the primary
figures are the 40 held-out templates** (`splitOf`, 20% by a hash of suite and template): 160 hidden, 160 control and
160 neutral tasks over the four seeds. The whole of train seeds 41–42 against 314/273 is reported too (in-sample).

**The bar for a live Pi run (step 5), on the held-out templates, all four seeds:** either

1. hidden surfaced **+4 or more** with decoys surfaced **+2 or fewer**, or
2. decoys surfaced **−8 or more** (fewer) with hidden surfaced **−2 or better**;

and in both cases neutral tasks given a candidates packet not more than with the trial off. Recall bought with decoys
one for one (M3's pattern) does not pass. A secondary arm (the truth-trained checker, or a variant of the rule) that
passes where the primary does not is reported as such and is not run live in this session.


## 1b. Addendum, pre-registered before its run: a confirmation of pass 0.3 on fresh worlds

Written after the screen of §4 (the primary failed the bar; a post-hoc pass mark of 0.3 passed it on the same tasks,
0.2 did not) and before this run. A pass mark chosen on the tasks it is judged on is not evidence, so it is checked
once on worlds no step has seen: **the 40 held-out templates on seeds 45–48**, the same arms (trial off; trial on with
the primary checker at `pushCheckPass` 0.3), the same bar (§1). Seeds 45–48 have no replayed intent requests, so both
arms run intent inert (labelled); the comparison is within the run. This decides only whether the note recommends a
live run at 0.3 to a later session: §1's rule stands, and no live run is made in this session either way.

## 2. Data and labels (step 1)

**Pairs.** `bun run funnel --suite train --seeds 41,42,43,44 -- --neutral --pool-dump F` (the shipped default, cards
and intent replayed, no model; 21 s) dumps each task's push pool (up to 15 items, 12.1 on average) in its hidden,
control and neutral worlds. `i1-label.ts pairs` joins the three pools of each (suite, seed, template): 768 groups,
16,290 pairs (565 planted, 493 decoys, 15,232 other). The planted item is in its pool on 565 of 768 hidden tasks; the
checker cannot help the rest. **Split:** 40 of the 192 templates (`splitOf`, a hash of suite and template, 20%) are
held out on every seed: 160 groups, 3,735 pairs over four seeds.

**The teacher.** Opus 5.5 (`claude-opus-5-5`, effort low; thinking cannot be turned off on it) read each group's
request and items, shuffled by a fixed hash, item text fenced as data, under `LABEL_SYSTEM` (`i1-label.ts`): per item,
is it "about the same specific person or organisation, the same thing and the same date or period as the request,
and bears on how the request should be carried out", with a confidence 0–100 and at most 12 words why. A near miss
(a different person, thing or period) is no. The teacher never saw the sim's truth. A 6-group pilot ran direct
($0.2095, about $0.035 a group); seeds 41–43 ran as one Message Batch (570 groups, $7.7007 booked at the batch's half
price, every result booked on the ledger). Seed 44 was not labelled (budget kept for a live run). **12,289 pairs
labelled, 576 groups, 0 parse failures.**

**How the teacher agrees with the sim** (`i1-label.ts score`; yes = confidence ≥ 50):

| Truth | Opus yes | Opus confidence p10 / p25 / p50 / p75 / p90 |
| --- | --- | --- |
| planted | 413 / 423 | 75 / 85 / 90 / 95 / 95 |
| decoy | **273 / 372** | 12 / 40 / 85 / 92 / 95 |
| other | 338 / 11,494 | 1 / 1 / 2 / 4 / 10 |

Its confidence as a score: planted against everything else AUC **0.986** (train and held-out templates alike);
planted against decoys **0.704 on train templates, 0.548 held out**. Read the decoys it calls relevant and they are
relevant: "Vitalis waived commitment, no exit fees" for "Cancel my Vitalis gym membership"; "Council tax monthly
direct debit already set up" is the fact, "Council garden waste debit, not council tax" the decoy (Opus: no, 12);
"Halden Cleaning approved, clear to sign" for signing Halden Cleaning (yes, 95). The train suites' decoys are built
as the all-clear twin of the fact: the same person, thing and date, with the constraint lifted. The question the
brief fixed does not separate them, and no checker distilled from its answers can.

## 3. The checkers (steps 2–3)

`packages/sim/modal/i1_checker.py`: a cross-encoder (`AutoModelForSequenceClassification`, one logit) fine-tuned on
the train templates' pairs, pointwise binary cross-entropy against Opus's confidence (`--target opus`), decoy and
planted pairs weighted 2 as the hard examples, 3 epochs, lr 3e-5 (2e-5 for bge), batch 32, max length 256, on a
Modal L4/A10G/T4 (whichever was free). Exported to ONNX; `packages/sim/lab/i1/evaluate.py` quantizes it to int8
(onnxruntime dynamic) and measures on this container's CPU, one thread, the held-out templates' 2,801 labelled pairs
and the time for one request's first 15 pool items (160 held-out groups).

| Model | params | AUC vs Opus before → after | planted vs rest | planted vs decoy | CPU ms / 15 pairs p50 (p90) |
| --- | --- | --- | --- | --- | --- |
| ms-marco-TinyBERT-L2-v2, int8 | 4 M | 0.728 → 0.857 | 0.861 | 0.428 | **25** (33) |
| ms-marco-MiniLM-L2-v2, int8 | 16 M | 0.722 → 0.871 | 0.861 | 0.413 | 105 (131) |
| **ms-marco-MiniLM-L6-v2, int8** (primary) | 23 M | 0.743 → **0.906** | 0.907 | **0.399** | 278 (370) |
| ms-marco-MiniLM-L6-v2, fp32 | 23 M | 0.743 → 0.900 | 0.903 | 0.407 | 553 (656) |
| bge-reranker-base, fp32 (GPU AUCs) | 278 M | 0.736 → 0.915 | 0.903 | 0.465 | 3,606 (3,930), 20 requests |
| MiniLM-L6, trained on the sim's truth, int8 | 23 M | 0.743 → 0.874 | 0.894 | 0.508 | 308 (378) |
| (Opus itself, for reference) | | | 0.986 | 0.548 | |

By the pre-registered rule (best AUC against Opus per CPU ms among models within 0.01 of the best), only MiniLM-L6
int8 (0.906) is within 0.01 of bge-base (0.915), so it is the primary. Every checker ranks the decoy *above* the
planted fact more often than not (0.40–0.43): it learned that the all-clear twin reads as squarely on topic. The
truth-trained model reaches 0.51 held out against decoys, while in sample it had learned the train templates' twins
(§4: decoys handed 333 → 18 on train templates): the constraint-against-all-clear distinction did not generalise to
new templates. Training took 22–134 s a small model, 894 s for bge-base.

A bug found on the way: the first ONNX export passed the inputs in the tokenizer's order (`input_ids`,
`token_type_ids`, `attention_mask`), while BERT's `forward` takes `attention_mask` second, so the graph's inputs came
out cross-wired; the CPU scores disagreed with the GPU's (AUC 0.44). Swapping the two reproduced the GPU logits to
three decimals; the exporter now orders inputs by `forward`'s signature, the models were retrained, and the CPU AUCs
match the GPU's (TinyBERT 0.858 GPU, 0.859 CPU).

## 4. The funnel screen (step 4)

`pushCheck` (D471, built and since deleted; commit fced3789): with the checker answering, the push's candidates were
the pool's items scoring at least `pushCheckPass`, in pool order, the first 5; none passing sent no candidates packet.
The checker ran as a sidecar (`sidecar.py serve`, two threads), the funnel at `--jobs 2` with `pushCheckWaitMs` 60,000
so every decision was the checker's (636 calls a process, 0 failures; round trip p50 336–347 ms, p90 453–475 ms
under the funnel's own load). `compare.py` against the same funnel with the trial off (seeds 41–42: 314/273, as
main). Held-out templates, seeds 41–44: 160 tasks a variant; "surfaced" is the funnel's (packet or ask), "handed" is
the planted item (decoy) in the candidates packet, "neutral packets" the neutral tasks given one.

| Arm | Hidden surfaced | Decoys surfaced | Planted handed | Decoy handed | Neutral packets | Packet KB (hid/ctl/neu) | Bar |
| --- | --- | --- | --- | --- | --- | --- | --- |
| trial off | 136 | 104 | 103 | 83 | 135 | 222 / 199 / 158 | |
| **primary, pass 0.5** | 138 (+3 −1) | 106 (+2 −0) | 56 | 64 | 10 | 86 / 82 / 16 | **fail** |
| truth-trained, 0.5 | 135 (+3 −4) | 103 (+1 −2) | 27 | 18 | 0 | 70 / 46 / 10 | fail |
| primary, 0.3 (post hoc) | 142 (+7 −1) | 104 (+2 −2) | 83 | 71 | 25 | 120 / 96 / 25 | pass |
| primary, 0.2 (post hoc) | 138 (+4 −2) | 103 (+1 −2) | 86 | 70 | 37 | 153 / 119 / 34 | fail |
| gate only, 0.5 (post hoc) | 136 | 104 | 58 | 65 | 10 | 127 / 124 / 17 | fail |

All 768 tasks a variant, seeds 41–44 (train templates are in sample): trial off hidden 633, decoys 550, neutral
packets 617; primary 650 / 566 / 54 (planted handed 490 → 459); pass 0.3 656 / 569 / 122; truth 648 / 541 / 1;
gate 632 / 550 / 55. Seeds 41–42 against 314/273: primary 323/282, pass 0.3 327/284, truth 321/268, gate 314/273.

**The confirmation (§1b), seeds 45–48, held-out templates, intent inert in both arms:** trial off hidden 82, decoys
83, neutral packets 107; pass 0.3 hidden **89 (+11 −4)**, decoys **88 (+9 −4)**, neutral packets 25: **fails**
(clause 1 needs decoys +2 or fewer). Gate only on the same worlds: hidden 78 (−4), decoys 76 (−7), neutral 13. Over
all 768 tasks of seeds 45–48, pass 0.3 moved hidden +27 and decoys +29.

**Reading it.** Facts the checker pulls into the packet from the pool's 6th–15th places come with their decoys, one
for one, on worlds it was not tuned on: it judges topic, which is what the teacher was asked. Its one strength,
silence on pools with nothing about the request, also silences many pools that hold the fact (planted handed 103 →
56 at 0.5, 58 gate-only): at a mark that silences neutral pools, the checker passes the fact on only about half the
pools that held it in the packet.
The funnel's "surfaced" hides that loss behind the ask path (`askNudge` lists pool items the agent can ask for), but
on Pi the fact then needs the agent's ask, and D257 measured that losing packet facts loses facts live.

## 5. Step 5: not run

The primary failed the bar and the post-hoc mark failed its confirmation, so no live Pi run was made (§1, §1b). The
Anthropic budget left ($12.09 of $20) is unspent.

## 6. Cost and latency

**Anthropic:** $7.9102 on the ledger (`.local/i1/ledger.jsonl`): the pilot $0.2095 (6 direct calls, 4,071–6,171
prompt tokens and 756–855 output tokens each), the batch $7.7007 (570 requests). **Modal:** $0.3981 billed for 11
runs of `eden-i1-checker` in `modal billing report --for today` (bge-base $0.224 of it); a retrain or two may not yet
be in that report.

**Production shape, not built ([EST] beyond the measured ms).** The primary checker costs 278 ms of one core a push
(int8, 15 pairs) on this container's CPU; TinyBERT-L2 25 ms at AUC 0.857. Either is a new runtime dependency
(onnxruntime and a tokenizer) or a sidecar; with the screen failing, neither was justified.

## 7. What would change the answer

- **Ask the teacher the product's question, not relevance.** A label of "does this item change what the agent should
  do (a constraint, a conflict, a reason not to proceed as asked)" is the distinction between the train suites' facts
  and their all-clear twins. The truth-trained checker shows the risk: it learned that in sample and not on new
  templates, so it needs more templates, not more pairs.
- **Keep silence, but only where nothing is on topic.** A pass mark set for the fact's recall (Opus says yes to 98%
  of planted facts) instead of the neutral pools' silence; measure the planted-in-packet count, not "surfaced",
  since the ask path hides the loss in the funnel.

## Reproduce

```bash
bun run funnel --suite train --seeds 41,42,43,44 --jobs 4 --json .local/i1/funnel.json -- --neutral \
  --pool-dump .local/i1/pool.jsonl                                                                  # 21 s, $0
bun packages/sim/src/lab/i1-label.ts pairs --pool .local/i1/pool.jsonl --out .local/i1/pairs.jsonl
bun packages/sim/src/lab/i1-label.ts label --pairs .local/i1/pairs.jsonl --out .local/i1/labels.jsonl \
  --spend-ledger .local/i1/ledger.jsonl --spend-cap 20 --seeds 41,42,43 --mode batch                # ~$7.7
bun packages/sim/src/lab/i1-label.ts score --pairs .local/i1/pairs.jsonl --labels .local/i1/labels.jsonl
export SSL_CERT_FILE=/root/.ccr/ca-bundle.crt
modal run packages/sim/modal/i1_checker.py --pairs .local/i1/pairs.jsonl --labels .local/i1/labels.jsonl \
  --max-len 256 --run minilm6 --base cross-encoder/ms-marco-MiniLM-L6-v2                           # ~2 min GPU
python3 -I packages/sim/lab/i1/evaluate.py --model .local/i1/models/minilm6 --pairs .local/i1/pairs.jsonl \
  --labels .local/i1/labels.jsonl                         # needs onnxruntime, onnx, tokenizers, numpy
# The funnel screen needs the deleted trial: git checkout fced3789, then
python3 -I packages/sim/lab/i1/sidecar.py serve --model .local/i1/models/minilm6 --threads 2 &
bun run funnel --suite train --seeds 41,42,43,44 --jobs 2 --json .local/i1/trial.json \
  --set '{"pushCheck":true,"pushCheckWaitMs":60000}' -- --neutral --checker http://127.0.0.1:8471
python3 -I packages/sim/lab/i1/compare.py --base .local/i1/base.json --trial .local/i1/trial.json
```

## Limits

- Train suites only, one teacher prompt, effort low; Opus's labels were made seeing a group's items together (the
  fact beside its twin), which can only have helped it separate them, and it still did not.
- Seed 44 unlabelled; seeds 45–48 have no replayed intent requests (both arms inert alike).
- The funnel's latency is contended (two funnel processes and the sidecar on four cores); the CPU numbers in §3 are
  one thread, uncontended.
