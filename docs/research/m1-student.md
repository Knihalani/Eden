# M1: a distilled "changes the action" student for the push check

(This M1 is the 2026-11-11 student session; docs/research/m1-lab-scale.md is an earlier, unrelated M1.)

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

## 2b. Pre-registration: the funnel screen (D895), written before it ran

The chosen student is the 8B rung (`t8b-truth-a`), served by `m1_serve.py` (H100, the prompt head shared across a
pool's items). Arm: the default + `pushCheck` + `pushCheckLocal` (`pushCheckWaitMs` 60,000, so every decision is the
student's; the rest of the check's rule as I3 shipped it: pool order, first `pushCandidates`, a pool it names nothing
of sends no packet). Against the default, task by task, `bun run funnel --suite train --seeds 41-48 -- --neutral`.

- **Pass mark, on the dev templates only** (24 templates × 8 seeds): of `pushCheckLocalPass` 0.5, 0.2, 0.05 and 0.01,
  the one with the largest (planted handed − decoys handed) on dev; a tie goes to the higher mark.
- **Bar, on the 40 held-out templates, seeds 41–48 (320 tasks a variant), read once:** D493's clauses doubled for
  twice its seeds: decoys handed **32 or more fewer** than the default; planted handed **at most 10 fewer**; hidden
  surfaced **at most 4 fewer**; decoys surfaced **at most 4 more**; neutral tasks given a candidates packet **not
  more**. Every clause must hold. Reported beside it: the same on the in-sample templates (not a test).
- Passing sends the arm to Pi (§6, written before that run); failing stops the line there.

## 2c. Pre-registration: the live run on Pi (D897), written before any shard started

The funnel screen passed (§4). The live question: does the student's check raise the facts the agent states, without
false concerns, inside a wait an interactive agent can take, and how does it stand against Haiku's check?

- **Harness:** Pi on Modal (`lab_fanout.py --preset bench-tools`, the F3/I3 recipe: tenant prompt, payload notices,
  direct profile, Haiku 5.5 agent and grader, cards replayed where covered and made in-run elsewhere), train suites,
  **only the 40 held-out templates** (`--templates`; the student never saw them at any seed), seeds **41–64** (24
  seeds), `--variants hidden,control,neutral`, one seed a shard, the existing `HAIKU_API_KEY` Secret, the checker's
  key as an ephemeral secret. From the commit that holds this section.
- **Arms:** `eden` (the default); `eden~local` (`pushCheck`, `pushCheckLocal`, pass 0.5: the student `t8b-truth-a`
  on one H100 endpoint kept warm for the run, `min_containers` 1); `eden~check` (Haiku's check as N5 left it to
  ship without an embedder: `pushCheck`, `pushCheckForm` 2). Both checks wait the shipped `pushCheckWaitMs` (2,500
  ms); neither widens the pool.
- **Regrade:** every hidden answer and every control or neutral answer the Haiku grader called a concern, all arms,
  by Sonnet 5.5 (`i3-regrade.ts`, one Message Batch a shard); Sonnet's verdict replaces Haiku's where it graded.
- **Outcomes** (each arm against `eden`, and `eden~local` against `eden~check`, paired by task, intervals from
  `bench_report.py`'s template-clustered bootstrap): (1) hidden raised, Sonnet-graded (primary); (2) concerns on
  control and neutral tasks, Sonnet-confirmed; (3) wall p50 and mean, and Eden on the agent's critical path;
  (4) cost: the agent's billed $ per 1,000 tasks, Haiku's check $ per 1,000 tasks, and the student's serving
  **[EST]** from its measured GPU time a call at list price; (5) check calls a task, failures and late answers.
- **Rule.** The student's check is recommended to the owner as a trial to promote with an optional endpoint (§7)
  if, against `eden`: hidden is better (the clustered interval above zero); confirmed concerns are not up (point
  estimate at most +0.5 points); and wall rises at most **+0.3 s** a task on average (N5's target). Against
  `eden~check` it is called **at least as good** if its hidden point estimate is not below Haiku's by more than one
  point. If the hidden clause holds and the wall clause does not, the trade goes to the owner as in D504/D536; if
  hidden is not better, `pushCheckLocal` is deleted at its trial's end (D112).
- **Budget:** Anthropic **[EST]** about $6 for the shards (24 seeds × 360 task runs × $0.0003, cards made in-run for
  seeds 49–64, Haiku's checks) and about $2 for the regrade; cap $14 for this step. Modal: the endpoint's H100 for
  the run's length (about $4 an hour **[EST]**) and the shards.

## 2d. Pre-registration: Pi round 2 (D898), amended before any round-2 run

Written after round 1 (§4d) and amended, before any round-2 choice was read, to the parent's version: the push check
("S", Haiku's compare-first silent check, opened and indirect pushes checked, `pushCheckWaitMs` 1,500) is now in the
default (D828), so the student is measured as a drop-in for S's call, and it must win on cost, not only quality.

- **Arms:** `eden` (the default at the merge, S) against `eden~local` (the default with `pushCheckLocal` on: the same
  rule, the student's scores in place of Haiku's call). Pi on Modal, the 40 held-out templates, **fresh seeds 65–88**,
  hidden, control and neutral, Sonnet-regraded as §2c. Cap $6 Anthropic.
- **Student:** of every run trained in this session, the **cheapest** by $ a check at 50% utilisation on the cheapest
  measured GPU whose 15-item pool p90 is at most 1,000 ms, among runs whose **dev** planted-vs-decoy AUC is at least
  0.85; a tie (within 10%) goes to the higher dev AUC. Its eval figure is then read once, if not read before.
- **Mark:** the most lenient `pushCheckLocalPass` of 0.5, 0.2, 0.05, 0.01 and 0.002 whose dev-template funnel (seeds
  41–48, the merged default as base, the student's scores) hands at most 10% of the default's decoys.
- **Rule (the parent's):** promote the student's check only if, against `eden`: hidden facts are not worse (the
  template-clustered lower bound above **−2.0 points**); Sonnet-confirmed concerns are not up by more than **1 per
  1,000** tasks; and the cost per 1,000 tasks is **lower**, counting the student's serving at **50% utilisation**
  (reported also at 10% and 100%). Wall time against `eden` is reported. Otherwise stop and record it.

## 3. The pipeline (D891)

`packages/sim/modal/m1_data.py` (rows, splits, prompt, AUCs, the template-clustered interval; `tests/test_m1_data.py`),
`m1_build.py` (the rows file from pairs, labels and synthetic groups) and `m1_student.py` (Modal: `train` fine-tunes
a base with LoRA and scores dev and eval, `zero` scores a base or a trained adapter; adapters and merged weights stay
on the Volume `eden-checker`; each run's report, held-out scores and a 15-item pool's latency on its GPU come back
to `.local/m1/runs/<run>/`).

## 4. Results

### 4a. The ladder on the train suites' own labels (D892)

All rungs trained on the train split (126 templates × 8 seeds: 659 planted, 674 decoys, at most 6 other items a
group; 7,329 rows), construction labels, 1 epoch, the settings of §1. Dev: 24 templates (136 planted, 141 decoys).
Each rung's run was chosen on dev (best point; within 0.01 the cheaper), then its eval figure read once.

| Rung | Zero-shot dev / eval | Runs tried (dev planted vs decoy) | Chosen | **Eval planted vs decoy** (95% CI, by template) | planted vs other | decoys rejected at 90% planted recall | train s (GPU) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen3-0.6B | — / 0.344 | truth 0.701, teacher 0.606, mix 0.643 | truth | 0.641 (0.542..0.748) | 0.853 | 23% | 212 (L40S) |
| Qwen3-1.7B | — / 0.480 | truth 0.655 | truth | 0.682 (0.563..0.798) | 0.916 | 26% | 390 (L40S) |
| Qwen3-4B-2507 | 0.750 / 0.714 | truth 0.893, truth 2 ep 0.899 | truth | **0.866** (0.755..0.948) | 0.990 | 54% | 457 (H100) |
| Qwen3-8B | 0.825 / 0.770 | truth 0.919, mix 0.858, truth 2 ep 0.919 | truth | **0.968** (0.920..0.999) | 0.995 | 95% | 598 (H100) |
| (Opus 5.5, I2's prompt, the group shown together) | | | | 0.886 | 0.993 | | |

Eval reads: the four chosen runs, once each, plus the 0.6B truth run's, which printed before the sealing code was in
(it is also the chosen 0.6B run). The 8B at p = 0.5: yes to 147 of 206 planted facts, 8 of 197 decoys, 44 of
6,497 other items. Leakage check: no template name or request is shared between splits; a planted or decoy text
shares a median 12% of its 8-word runs (mostly mail headers) with any training fact or decoy.

**Teacher against construction labels** (train suites, 29,656 pairs labelled): agreement 97.8%, Cohen's κ 0.70; Opus
says no to 191 of 999 planted facts and yes to 123 of 1,011 decoys and 339 of 27,646 other items. Opus's own
planted-vs-decoy AUC: eval 0.886, dev 0.963, train templates 0.951. On the 0.6B and 8B rungs the construction labels
made the better student on dev (§ table), so the ladder trained on them.

### 4b. Latency (D893)

| Build | 15-item pool, p50 | Notes |
| --- | --- | --- |
| CPU, int8 dynamic (torch), 4 threads, Qwen3-0.6B | 8,102 ms | 4,667 tokens a pool; every larger rung is slower: CPU is out |
| L40S, bf16, 0.6B / 1.7B (zero-shot runs) | 75 / 142 ms | one batch, no prefix sharing |
| H100, bf16, 4B / 8B (zero-shot runs) | 142 / 209 ms | one batch, no prefix sharing |
| H100, 8B merged (`m1_serve.py bench`) | 201 ms plain, **121 ms prefix-shared** | prefix scores differ from plain by mean 0.11, max 0.75 log-odds |
| Lab endpoint, client round trip from the cloud container (8B, H100) | 314–415 ms p50, 495–590 ms p90 | network to us-east and Modal's routing included |

### 4c. The funnel screen (D895, D896)

First run (pass 0.05): the check ran on fewer pushes than the default makes: with `pushCheck` on, D702's opened
pushes never start (they would add a paid call), so 27 dev and 23 held-out planted facts the default hands were not
handed at all. A student's check is not a paid call, so with `pushCheckLocal` the opened push runs and is checked
(D896, `push-check-local.test.ts`). The screen was rerun on the fixed tree; the figures below are that run's.

Dev templates (200 tasks a variant), choosing the mark (planted handed − decoys handed; the default's −12): pass 0.5
**95**, 0.2 92, 0.05 92, 0.01 95. Tie → **0.5**.

| Templates (seeds 41–48) | Hidden surfaced | Decoys surfaced | Planted handed | Decoys handed | Neutral packets | Packet KB (hid/ctl/neu) |
| --- | --- | --- | --- | --- | --- | --- |
| dev, 200 a variant | 127 → 133 (+7 −1) | 136 → 136 | 119 → 99 | 131 → 4 | 161 → 2 | 259/250/169 → 110/45/12 |
| in-sample, 1,016 | 613 → 668 (+55 −0) | 606 → 540 | 555 → 644 | 536 → 0 | 813 → 7 | 1,353/1,321/919 → 556/229/63 |
| **held-out, 320 (the bar)** | **168 → 201 (+33 −0)** | **169 → 153 (+0 −16)** | **152 → 176** | **155 → 9** | **252 → 2** | 449/424/274 → 205/72/14 |

D895's bar on the held-out templates: decoys handed −146 (≤ −32), planted handed +24 (≥ −10), hidden +33 (≥ −4),
decoys surfaced −16 (≤ +4), neutral packets 252 → 2: **pass**. The dev loss of planted facts (−20) is one template
for most of it: `isa-allowance-used`, whose fact the student scores −8.9 on every seed.

### 4d. Pi, round 1 (D897's rule): the student's check fails live

Pi on Modal as pre-registered (§2c), commit 29860d5b, 24 shards one at a time, 8,640 task runs, 0 errors, 0 of
about 26,000 agent requests retried on a 429; $3.78 Anthropic. Sonnet 5.5 regraded all 2,880 hidden answers and the
47 concerns ($1.59, 0 failed). Intervals: template-clustered bootstrap (`bench_report.py --sonnet`).

| Outcome | eden~local − eden | eden~check (Haiku) − eden | eden~local − eden~check |
| --- | --- | --- | --- |
| **Hidden raised, Sonnet** (eden 50.9%) | **+2.4 (−3.6..+8.5)** | **+6.9 (+1.5..+12.4)** | **−4.5 (−9.3..−0.3)** |
| Confirmed concerns (control, neutral; 1,920 pairs) | 1 vs 0 | 1 vs 0 | 1 vs 1 |
| Wall mean, s | +0.57 (+0.43..+0.72) | +1.04 (+0.85..+1.22) | −0.47 (−0.59..−0.33) |
| Agent + Eden billed $/1k (serving not counted) | −0.007 (−0.028..+0.012) | +0.181 (+0.145..+0.215) | −0.189 |
| `ask_context` calls a task | +0.30 | +0.25 | +0.05 |
| Eden on the critical path, ms a task | 123 → 499 | 123 → 1,031 | |

Haiku's grade said the same (hidden 54.7%, 57.9%, 61.8%). **Against the rule:** hidden is not better (the interval
holds zero), concerns are not up, the wall clause fails (+0.57 s against +0.3 s), and the student is below Haiku's
check by more than a point. **The student's check fails its live rule.**

**Why the funnel's win did not carry** (each hidden task's packet from the timelines, Sonnet's verdicts):

| Arm | Planted fact in the push's packet | Raised when in it | Raised when not | Hidden pushes silenced |
| --- | --- | --- | --- | --- |
| eden | 607 / 960 | 474 (78%) | 15 / 353 | 1 |
| eden~check (Haiku) | **711** / 960 | 538 (76%) | 17 / 249 | 77 |
| eden~local (student, pass 0.5) | 647 / 960 | 469 (72%) | 43 / 313 | **102** |

The student keeps the look-alikes out and silences neutral requests (packets on 29% of neutral tasks against 99%),
but on these worlds it lets fewer facts in than Haiku: 102 hidden pushes it found nothing in, and 64 fewer facts in
the packet. Its endpoint round trip (p50 274 ms, p90 835 ms from the Modal shards, 0.99 calls a task, 0 failures)
and the asks a silent push prompts (+0.30 a task) make the extra wait.

### 4e. After round 1: the small rungs on M2's data, and the stop (D899)

Ladder B (train suites plus M2's synthetic families; v0 = M2's first 227 worlds, v2 = its corrected final set, 8
groups a family, at most 2 other items a group in training; dev and eval as §4a):

| Run | Data | Dev planted vs decoy | M2 val | Eval (read once) |
| --- | --- | --- | --- | --- |
| s06-a (0.6B) | train + v0 | 0.884 (0.740..0.981) | 0.989 | — |
| v2-0.6b-a (0.6B) | train + v2 | **0.921** (0.806..0.997) | 0.995 | **0.878** (0.792..0.953) |
| v2-1.7b-a (1.7B) | train + v2 | **0.942** (0.870..0.991) | 0.997 | — |

The train-suite-only 8B scored 0.950 (0.931..0.966) on M2's v0 val families it never saw. Small rungs on cheap GPUs
(15-item pool, shared head): 0.6B L4 162 ms, A10G 138 ms; 1.7B L4 262 ms, H100 80 ms. The v0 runs at 1.7B, 4B and
8B and the v2 4B were stopped unfinished (superseded or stopped by the owner).

**Stopped (owner's decision, through the parent, D899):** round 2 (§2d) was cancelled before any shard ran; the
endpoint was stopped. The track moves to a micro CPU checker (§5), with the 8B's scores over M2 v2 as its teacher.

## 5. The micro CPU checker (owner's request; D980–D989)

The owner's goal after the stop: replace Haiku's two pool judgements (the push check S and the ask-time reader) with
one micro CPU model, at most 4 MB and 1 ms a 15-item pool, no model call, distilled from the 8B. The plan (sent to the
parent before any training): shared hashed n-gram and cross features; three candidates (a learned int8 pair table,
M3's binary pair codes, and a pool-set model with one attention layer); a check head and a reader head whose bearing
is the item's own most binding sentence in a template; gates G0 (the teacher against Haiku), G1 (the 52 + 16 short
constraint fixtures, ≥ 97%), G2 (length and format probes), G3/G4 (held-out quality, then agreement), G5 (a Pi pair).

**Teacher scores.** The 8B over M2 v2's train and val pair groups, a scale-to-zero batch job (16 H100 shards, about
17 minutes each, 93,600 items a shard): `eden-synth:v2/pairgroups/{train,val}.t8b.jsonl.gz`.

**G0 (D980).** On M7's recorded calls the 8B agrees with Haiku on 64.7–67.0% of exact item sets and 74.2–77.9% of
speak/silent decisions, against Haiku's own 75.4–78.8% and 90.0–92.5%. Against the sim's truth on the 679 calls of
the 8B's held-out templates, the 8B names the fact about as often (162–174 of 230 against Haiku's 171) and the
look-alike and neutral pools far less (16 of 234 and 2 of 215 at −3.0, against 40 and 40). The gap to Haiku is mostly
Haiku's extra yeses. A quality bar in place of the agreement bar is with the parent.

### 5a. Pre-registration: the micro checker's bar (D981), written before any held-out read

The owner's bar, through the parent: the micro model must be **better than Haiku**, not within its noise, and the
ship decision is a Pi pair. The gates, in order; every number is read on the splits named, no other.

- **Splits.** Train: M2 v2 train (2,880 families, the 8B's scores) and the sim's train-split templates. Selection
  (between candidates and rounds): M2 v2 val **and** the sim's 25 dev templates, reported apart (M6's lesson, D920:
  a model chosen on synthetic val alone did not transfer). Held-out, read once a head: the sim's **40 held-out
  templates** (the 679 recorded Haiku check calls on them, and their pairs) and M2 v2 test, reported apart; the bar
  must hold on the sim held-out.
- **One operating mark, fitted on train only:** on M7's recorded calls of train1–4's train-split templates, the
  lowest score mark at which the model names no more look-alikes than Haiku did and speaks on at most half as many
  neutral pools; the same rule gives the 8B teacher's mark for the comparisons below.
- **G1 (fixtures):** M7's 16 hand-written cases at ≥ 15 of 16; M3's 52 short constraints audited by hand (9 dropped:
  their text as given states no constraint, listed in `fixtures.py`), the remaining 43 at ≥ the teacher's own pass
  rate at its mark; all 52 reported as a length probe. The teacher on the audited 43: 33 at −3.0, 37 at −6.0.
- **G2 (length and format):** on the selection split, the fact shown as title only, one sentence and full, with
  headers stripped and sentences shuffled: the fact-against-look-alike AUC drops by at most 0.03.
- **G3/G4 (offline, held-out, at the one mark):** facts named **≥ Haiku's**; look-alikes named **≤ Haiku's**;
  neutral pools spoken on **≤ 0.5 × Haiku's**; planted-vs-decoy AUC ≥ Haiku's on the same pools (Haiku's from its
  recorded verdicts; the 8B's reported as the teacher's ceiling).
- **G5 (the arbiter), push-check head:** a Pi pair on fresh seeds, the micro model in S's place against Haiku-S on
  main: hidden facts' point estimate **≥ +1 point**, template-clustered lower bound **> −1.5**; confirmed concerns
  and decoys handed no higher; wall time reported (expected about −1 s).
- **Reader head:** the same structure against the Haiku `askReader` (bearing: the item's most binding sentence in a
  template, no model prose), and the agent must still use the fact.
- **Stop:** a head that cannot beat Haiku after two development rounds is reported with its numbers and not shipped.
  If facts land at +0 within noise with precision clearly better, it is reported for the owner's decision.

### 5b. Three rounds, and the stop (D982)

The reader head was dropped before any round (the parent's decision): with `pushCandidates` at 5 the default's
`askReader` makes no call (D236, D237), and the round-1 Pi ledgers hold no reader row; Eden's Haiku spend there was
the check (about $0.20 per 1,000 tasks) and the background cards (about $0.08).

Each round: three candidates (PairHash, BinPair, PoolSet), local CPU, one thread, five epochs, run by Haiku
subagents; selection only (dev = the sim's 25 dev templates and their 414 recorded Haiku calls; M2 v2 val);
the mark fitted on train1–4's train-split recorded calls by D981's rule (the teacher's: −6.37, where it passes 38
of the 43 audited fixtures). Haiku on the dev calls: facts 116/144, look-alikes 36/137, neutral speaks 36/133.

| Round | What it added | Best candidate | Sim dev AUC (fact vs look-alike) | Dev facts / look-alikes / neutral at the mark | G1 m7 · m3r audited |
| --- | --- | --- | --- | --- | --- |
| 1 | hashed n-grams and cross features, distilled on the 8B (M2 one group a family + the sim's train pools) | BinPair, lr 0.01 | 0.60 | 23 / 9 / 11 | 9/16 · 29/43 |
| 2 | date relations, binding and all-clear cues near the request's words, a fact-above-twin margin, sim weight 3 | BinPair | 0.62 | 25 / 11 / 12 | 4/16 · 19/43 |
| 3 | typed normalisation (dates, periods, amounts, names, numbers) and 2,088 new sim pools (train1–4 on 16 seeds, train1r–4r, longtail; no dev or held-out template) scored by the 8B | BinPair | **0.656** | **51** / 24 / 10 | 7/16 · 38/43 |
| 3 | the same | PairHash · PoolSet | 0.61 · 0.62 | 44/15/2 · 34/21/5 | 3/16 · 1/16 |
| 3 | sim pools only | BinPair | 0.54 | 14 / 6 / 7 | 6/16 · 26/43 |

M2 val stayed at 0.83–0.91 in every round; M14 found that item length alone ranks M2's fact above its twin in 94%
of tasks (0.68 on the sim), so part of that is a length cue (the harness now has length-free switches and
length-controlled reads, `twin_all` and `twin_hard`; the runs above still had length features). Sizes 2.4 MB (BinPair
6.3 MB counted at int8, about 1.6 MB packed), 3–5 ms a 15-item pool in Python with its feature extraction.

**Stopped (D982).** After two development rounds and the parent's transfer round, the best micro student names
fewer than half the facts Haiku names on the sim's dev templates at a mark with no more look-alikes: no held-out read
and no Pi pair were made. The 8B teacher stays the only model past Haiku on the sim (D980), and it needs a datacentre
GPU (D893). Kept: the harness (`packages/sim/lab/m1-student/`), the teacher's scores over M2 v2 and M14's rows
(`eden-synth:v2/pairgroups/*.t8b.jsonl.gz`; branch `claude/m1-teacher-logo`, never merged).

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
