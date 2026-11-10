# F2: pruning the intent requests, reaching no-shared-word facts behind a checker, and a card order for new users

Status: in progress, 2026-11-10, branch `claude/f2-quality` (from `claude/lucid-hypatia-v9wqk5` at `0fbbeb56`), session
F2. Decisions D480–D484. Train only (train1–6); no held-out suite was run, and `heldout18` was not touched. Every
number comes from a command run in this session unless marked **[EST]**.

## 0. Pre-registration

### (A) Pruning the intent requests: the $0 bar

Written after the first no-model screen had been read (it had no paid run; the bar is the one A22's D361 sets for any
lever on the intent index, stated here so the later, checker-scored screen is read against the same rule).

- Screen: `bun run funnel` (train1–6, seeds 41–42, 384 hidden and 384 control tasks) with the trial on, on **both**
  draws of the requests (`intent-v2`, shipped; `intent-v2-draw2`, A22's re-draw), each against its own draw's default.
- A rule passes only if, **on both draws**, hidden net ≥ 0 and decoys net ≤ −10, or hidden net ≥ +10 and decoys net
  ≤ +3. D361: the default itself moves 7 hidden and 8 decoys between the draws, and 43 hidden and 34 decoy tasks
  change, so a move under about 10 tasks on one draw is not a result.
- A pass buys a live Pi run (its own rule written before it); a fail deletes the trial (D112).
- The same bar applies to a rule that scores requests with I1's checker, if `claude/i1-checker` lands one.

### (B) Embedding reach behind I1's checker

Not started: `claude/i1-checker` does not exist on the remote at the time of writing. If a usable checker lands
before this session ends, the bar is M3's (D450), read after the checker's filter: the hybrid at k 3 keeps hidden net
≥ +10 at decoys net ≤ +3 in the first five. Otherwise (B) is reported as not run.

### (C) `cardsOrder` live: the rule, written before any paid call

**What is measured.** A new user's backfill fills the card queue faster than the model empties it, so the first
requests meet cards for only part of the items. pi-ab waits for the enrichment to finish before the first request
(`cards.idle()`), so it cannot see the order; `--cards-calls N` (new, lab only) lets each user's card model answer its
first N calls and leaves the rest uncovered. The $0 screen (§2) reads the funnel at N = 1…24 on both draws.

**Live runs (Modal, `lab_fanout.py`, one shard at a time or two).** Pi, `--suite train`, seeds 41–48, one seed a
shard, `--variants hidden,control`, `--tenant-prompt`, `--push payload`, the `direct` source profile, time scale 1,
`claude-haiku-5-5` in every role, **no `--cards` file: every card and its requests are made in-run by Haiku**.

1. Main: arms `eden` and `eden~order` (`{"cardsOrder":true}`), both with `--cards-calls 4`, paired task by task.
   Cap $3.60 ($0.45 a shard).
2. Reference (the gap's other end): arm `eden` with no call cap, seeds 41–42. Cap $1.20. Unpaired with (1): the same
   tasks in another process, so it gives a level, not a paired effect.
3. A smoke shard first (train1, seed 41, `--limit 4`). Cap $0.10.

Anthropic at most $4.90 of the $6 cap; Modal well under $20 (**[EST]** about $0.05 a shard from M1's billing).

**Primary figure.** Hidden facts raised (Haiku-graded), `eden~order` minus `eden` at N = 4, paired by task, pooled
over seeds 41–48, with `cl8/pooled.py`'s bootstrap interval. Secondary: control concerns (Haiku-graded; regraded by
Sonnet only if the rule turns on them), the share of the gap closed = (order − fifo) / (reference − fifo) on seeds
41–42, and $ per 1,000 tasks.

**Rule.**

- **Promote** `cardsOrder` into `DEFAULT_CONFIG` if the pooled paired hidden effect is ≥ +2.0 points with its 95%
  interval above zero, and control concerns are not up by more than 1.0 point.
- **Delete** it if the point estimate is below zero, or control concerns rise by more than 1.0 point with an interval
  above zero.
- **Otherwise** (a point of 0 to +2, or an interval that spans zero): not promoted; the switch stays a trial to its end
  date with the $0 result as its evidence, and the note says the live run could not tell.

The distilled card model (M2) is run through `--cards-endpoint` only if an endpoint is deployed on Modal when the
main run ends; none was when this was written (`modal app list`: every `eden-cards-distill` app stopped or ephemeral).

**Amendment after the smoke shard, before any main-run call.** The smoke (train1, seed 41, `--limit 4`, 16 task runs,
4 streams) spent $0.0260: 16 card calls at $0.0012 each ($0.0195) and $0.0004 a task run. At that rate a main shard
(24 streams, 96 card calls, 768 task runs) costs about $0.43 **[EST]**, so $0.45 a shard would stop shards early. Caps
are now: main $4.40 ($0.55 a shard, run as four fan-outs of two seeds), reference **seed 41 only** $0.65. With the
smoke, at most $5.08 of the $6 cap. The rule and the figures are unchanged; the share of the gap closed is read on
seed 41.
