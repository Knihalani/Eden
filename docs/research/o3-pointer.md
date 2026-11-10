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

An item whose title the agent has already stated in a message of its own is not named (`saidTitle`: every content
word of the title in one recent agent message; best effort, no model). The lab's Pi harness and the client's
`withContext` report no agent messages, so this is inert in the runs below; the proxy reports them.

## 2. Pre-registration (committed before the first call of the run below)

A first form of this section named a two-arm run on 16 users; it was started, one user finished ($0.09), and it was
stopped unread when the owner's delegate asked for one run that also settles `pushOpen` over days (D709). The
finished user's results are not used.

- **Run:** pi-ab `--days 8`, the bench recipe, one user a process, one at a time, arms `eden`, `eden~O` (`pushOpen`),
  `eden~P` (`pushPointer`) and `eden~OP` (both). **Users w41–w72 (32)**, in two halves (w41–w56, then w57–w72); the
  second half runs only if the ledger's booked total after the first is under $19.5 (the cap is $25); if it is not,
  the rules are read on 16 users and the note says so. Cards and intent are replayed for w41–w44 and made in-run
  after.
- **Grades:** every hidden answer and every control or neutral concern regraded by Sonnet 5.5 (`i3-regrade.ts`).
  Hidden with whole users resampled (`n5/days_hidden.py`); cost and wall paired by task, clustered by user
  (`n5/mix.py --days`).
- **Rule for `pushPointer` (`eden~P` against `eden`):** it goes to the owner's delegate for the default only if
  hidden raised is at least **+4.0 points** with the user-resampled interval's lower bound above 0; Sonnet-confirmed
  concerns (control and neutral) are not up; total cost rises by at most **$0.20 per 1,000 tasks**; wall by at most
  **0.1 s** a task. Otherwise it is deleted with its code and tests.
- **Rule for `pushOpen` over days (`eden~O` against `eden`; D709, replacing o3-push-open.md §6's point-estimate
  clause):** it passes over days if the user-resampled interval's **lower bound for hidden is above −2.0 points**,
  Sonnet-confirmed concerns are not up, cost rises by at most $0.20 per 1,000 tasks and wall by at most 0.1 s. Passing
  here, with D706's pass one request a session, it is promoted into the default; failing, it stays off and is
  deleted at its end date (2026-12-10).
- **Also reported, no bar:** `eden~OP` against each single arm; of the hidden tasks whose fact was handed only
  earlier, in how many the pointer named it and how many of those were raised; pointers a task by kind.
- **Budget [EST]:** $4 a half (runs $3.5, regrade $0.5).
