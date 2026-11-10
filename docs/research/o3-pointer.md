# O3: naming what was handed earlier (`pushPointer`)

Status: 2026-11-10, branch `claude/o3-k-behind`, session O3. Decision D708. Train suites only; heldout18 is not
dumped, labelled or run. Paid calls go to Anthropic directly with `HAIKU_API_KEY` through the lab (D97):
**Anthropic-direct lab figures**. Numbers marked **[EST]** are arithmetic or judgement; every other number comes from
a command in this note or the note it names.

## 0. Why

Over eight users' days (o3-push-open.md §7, the `eden` arm, 101 hidden tasks, Sonnet-graded) the planted item reached
the agent at its own request in 52 tasks (47 raised), **only at an earlier, unrelated request that day in 37 (12
raised)**, and never in 12. A constraint-worded item ranks for many of a day's requests, so it is handed early, where
the candidates' lead tells the agent to ignore what does not fit; at its own request the not-twice ledger (D13)
keeps it out of the packet and the agent rarely goes back to it. 28 of those 37 tasks still got a candidates packet
at the fact's own request; 9 got none.

Two earlier trials sent the item again: `pushReshow` (D340: +6.8 points, −0.5..+14.1, then +2.7, −1.8..+7.3 on fresh
users; deleted by D380 on one Sonnet-confirmed concern against none) and the check-gated `pushCheckReshow` (D512:
−10.9 against the check alone, n 46). `pushReshow` re-sent only items that passed the constraint test, and most
planted facts carry no constraint card or wording (packages/engine/CLAUDE.md, `planConflict`).

## 1. What is built (D708; a trial, off)

`pushPointer`: with `pushCandidates`, the items among this request's candidates that the agent was handed before this
request began (a ledger entry from an earlier turn) are named in the packet's lead after `POINTER_LEAD`, by title and
source, at most three, in rank order: "Already sent to you earlier in this conversation and ranking for this request
too (read them again above and judge them the same way): "…" (gmail); …". No item text is sent twice (D13 stands for
content), no constraint test narrows them, no model call and no wait are added. When the request has no new
candidate, the names go as a packet with no item of its own. A title is source text: one inert line, cut to 80
characters, its double quotes made single, inside the data envelope (as D301 quotes a request).

## 2. Pre-registration (committed before the first call of the run below)

- **Run:** pi-ab `--days 8`, the bench recipe, arms `eden` and `eden~P` (`pushPointer`), one user a process, one at
  a time. **Stage 1:** users w41–w56 (16 users; cards and intent replayed for w41–w44, made in-run after).
  **Stage 2:** users w57–w72, only if stage 1's hidden difference is at least +3.0 points and its interval reaches
  zero; the rule is then read on all 32.
- **Grades:** every hidden answer and every control or neutral concern regraded by Sonnet 5.5 (`i3-regrade.ts`).
  Hidden with whole users resampled (`n5/days_hidden.py`); cost and wall paired by task, clustered by user
  (`n5/mix.py --days`).
- **Rule:** `pushPointer` goes to the owner's delegate for the default only if hidden raised is at least **+4.0
  points** with the user-resampled interval's lower bound above 0; Sonnet-confirmed concerns (control and neutral)
  are not up; total cost rises by at most **$0.20 per 1,000 tasks**; wall by at most **0.1 s** a task. Otherwise it
  is deleted with its code and tests.
- **Also reported, no bar:** of the hidden tasks whose fact was handed only earlier, in how many the pointer named
  it, and how many of those were raised; pointers a task by kind.
- **Budget [EST]:** stage 1 $2.2 (runs $1.9, regrade $0.3); stage 2 the same.
