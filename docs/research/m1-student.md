# M1: a distilled "changes the action" student for the push check

Status: 2026-11-11, branch `claude/m1-local-check` (from `main` at 533cc7f8), session M1. Decisions D890–D899. Train
suites only (train1–6); heldout17, heldout18 and heldout19 are not dumped, labelled, run or read. Numbers marked
**[EST]** are arithmetic or judgement; every other number comes from a command in this note. Caps: Anthropic $80
(ledger `.local/m1/ledger.jsonl`), Modal $400. Sections 1–2 were written and committed before any student was
trained.

## 0. Where this starts

- The push check (`pushCheck`, D500; the compare-first form, D527; arm K with the widened pool, D531) is Eden's best
  measured quality lever: **+7.9 hidden points** (+5.3..+10.7, Sonnet-graded, Pi), for +$0.21 per 1,000 tasks and
  +1.06 s a task, because it calls Haiku 5.5 on 0.8 pushes a task.
- The teacher signal exists: Opus 5.5 asked "does this item change what the assistant should do for this request?"
  separates planted facts from their all-clear twins at AUC 0.917 on the 40 held-out train templates (D490).
- A small cross-encoder distilled from it did not transfer: MiniLM-L6 to bge-reranker-v2-m3 (568 M) reached
  0.45–0.55 planted-vs-decoy on new templates, 0.864 in sample (D491, D492). The I2 note's reading: 154 templates with
  one fact-and-twin pair each are too few examples of "constraint against all-clear".
- **The bet here:** a pretrained decoder (Qwen3, 0.6B to 8B, Apache-2.0) has a prior on what a constraint is that a
  reranker lacks, and M2's synthetic-world factory supplies thousands of fact-and-twin pairs across many template
  families. Fine-tuned with LoRA on Modal GPUs, it either learns the distinction on templates it never saw, or the
  line ends here.

## 1. The student and its data (D890)

- **Shape.** Pointwise: one (request, item) pair per forward pass, read through the model's chat template (prompt
  `m1_data.PROMPT`: I2's question and definitions, the user's day, the request fenced, the item's title and first 700
  characters fenced, "Answer yes or no."). Score: log P(yes) − log P(no) at the answer's first token, summed over case
  and leading-space forms. The same score before training gives each base's zero-shot rung. A push scores its pool's
  15 items as one batch. (Listwise would let the student compare the fact with its twin, but a real pool holds one or
  the other, not both.)
- **Training.** LoRA r 16, alpha 32, all linear layers, lr 1e-4 with 5% warm-up and linear decay, effective batch 32,
  binary cross-entropy on the score, planted facts and look-alikes weighted 4, at most 6 other items a group a pass
  (the pools are 90% other). Targets: the construction label (`truth`: planted 1, decoy and other 0), the teacher's
  confidence (`teacher`) or their mean (`mix`).
- **Ladder.** `qwen3-0.6b` (Qwen3-0.6B), `qwen3-1.7b` (Qwen3-1.7B), `qwen3-4b` (Qwen3-4B-Instruct-2507), `qwen3-8b`
  (Qwen3-8B), all Apache-2.0 (servable). Thinking is off in the template.
- **Data.**
  - Train suites: `bun run funnel --suite train --seeds 41-48 -- --neutral --pool-dump` and `i1-label.ts pairs`
    (1,536 groups, 29,712 pairs; the pool dump now carries the task's `today`). Splits: **eval** = I1/I2's 40
    held-out templates (hash of suite and template, share 0.2), all eight seeds: 206 planted, 197 decoys, 6,497 other;
    **dev** = 15% of the other templates by a second hash (24 templates: 136 planted, 141 decoys); **train** = the
    rest (126 templates: 659 planted, 674 decoys).
  - M2's synthetic groups (when they land): whole families by hash, 15% to a synthetic eval split.
  - Opus 5.5 labels (I2's `CHANGES_SYSTEM`, effort low, one Message Batch) on every train-suite group of seeds
    41–48, and on a stratified subset of M2's groups, for the `teacher` and `mix` targets and to measure how far the
    construction labels and Opus agree.

## 2. Pre-registration: the measure and the stop rule (D890)

- **Primary figure:** planted-vs-decoy AUC of the student's score on the **eval** split (40 held-out train
  templates, seeds 41–48), pairs scored one at a time, with a 95% interval from a bootstrap over templates.
  Secondary: planted-vs-other AUC, and the share of decoys rejected at the score that keeps 90% of planted facts.
- **Tuning reads dev only.** Data mixes, targets, epochs and every other choice are made on the dev split and on
  M2's synthetic eval split. The eval split is read once a rung for that rung's chosen run (plus the zero-shot rungs,
  which choose nothing), and every eval read is listed in §4.
- **Stop rule.** If no rung's chosen student reaches **planted-vs-decoy AUC ≥ 0.85** on the eval split (the point
  estimate; on synthetic data alone it does not count), the line stops and is reported. If one does, it is wired as a
  checker behind the `pushCheck` interface with a trial switch `pushCheckLocal` (D112), screened in the funnel by
  D493's packet bar, and measured on Pi under a rule written before that run (§6), against the default and against
  Haiku's push check: hidden facts, decoys handed, neutral packets, concerns, cost, wall.

## 3. The pipeline (D891)

`packages/sim/modal/m1_data.py` (rows, splits, prompt, AUCs, the template-clustered interval; `tests/test_m1_data.py`),
`m1_build.py` (the rows file from pairs, labels and synthetic groups) and `m1_student.py` (Modal: `train` fine-tunes
a base with LoRA and scores dev and eval, `zero` scores a base or a trained adapter; adapters and merged weights stay
on the Volume `eden-checker`; each run's report, held-out scores and a 15-item pool's latency on its GPU come back
to `.local/m1/runs/<run>/`).

## 4. Results

### Zero-shot rungs (eval split, untrained; no choice made)

| Base | planted vs decoy | planted vs other | decoys rejected at 90% planted recall | 15-item pool, L40S/H100 p50 |
| --- | --- | --- | --- | --- |
| Qwen3-0.6B | 0.344 (0.230..0.445) | 0.710 | 4.6% | 75 ms (L40S) |
| Qwen3-1.7B | 0.480 | 0.742 | 6.1% | 142 ms (L40S) |

## Reproduce

```bash
bun run funnel --suite train --seeds 41,42,43,44,45,46,47,48 --jobs 4 --json .local/m1/base.json -- --neutral \
  --pool-dump .local/m1/pool.jsonl                                                              # 31 s, $0
bun packages/sim/src/lab/i1-label.ts pairs --pool .local/m1/pool.jsonl --out .local/m1/pairs.jsonl
python3 -I packages/sim/modal/m1_build.py --pairs .local/m1/pairs.jsonl --out .local/m1/data/train-truth.jsonl
export SSL_CERT_FILE=/root/.ccr/ca-bundle.crt
modal run packages/sim/modal/m1_student.py::zero --data .local/m1/data/train-truth.jsonl --base qwen3-0.6b
modal run packages/sim/modal/m1_student.py::train --data .local/m1/data/train-truth.jsonl --base qwen3-0.6b \
  --run t06-truth-a
bun packages/sim/src/lab/i2-label.ts label --pairs .local/m1/pairs.jsonl --out .local/m1/opus-train.jsonl \
  --spend-ledger .local/m1/ledger.jsonl --spend-cap 80 --mode batch --seeds 41,42,43,44,45,46,47,48
```
