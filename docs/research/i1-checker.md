# I1: a small checker distilled from Opus, to tell a planted fact from its look-alike

Status: 2026-11-10, branch `claude/i1-checker` (from `claude/lucid-hypatia-v9wqk5`), session I1. Decisions D470–D474.
Train suites only (train1–6); no held-out suite was dumped, labelled or run. Numbers marked **[EST]** are arithmetic or
judgement; every other number comes from a command in this note.

## In plain words

(Written at the end; see §6.)

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

## 2. Data and labels

(Filled in below as the work runs.)
