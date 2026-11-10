# I3: a per-push Haiku check in the live loop

Status: 2026-11-10, branch `claude/i3-push-check` (from `claude/lucid-hypatia-v9wqk5` with I2 merged), session I3.
Decisions D500–D504. Train suites only; heldout18 is not run. Numbers marked **[EST]** are arithmetic or judgement;
every other number comes from a command in this note. Sections 1–3 were written and committed before any Pi run.

## 1. What is built (D500, D501)

`pushCheck`, a trial switch (D112, off): with `pushCandidates` and a `checker` dependency, a push whose pool passes
the candidates' constraint-like gate makes **one** budgeted model call over the whole pool (`push-check.ts`) asking
I2's question (D490): does this item change what the assistant should do for this request, or is it consistent
background? The candidates become the pool's items it names, in pool order (bulk mail out), the first
`pushCandidates` of them; a pool it names none of sends no packet. Designed for cost:

- **One call a push, only when the default would hand candidates.** A pool with nothing constraint-like makes no call.
  A settled check answers, with no call, a later pass over items it already read (a `readerPushBehind` second pass).
- **Fixed instructions first** (`CHECK_SYSTEM`, a system block the lab caches: 894 tokens read from the cache a
  call in the pilot below, over Haiku 5.5's 512 minimum), then the day, the request and the items.
- **Item text is data.** The request and each item are redacted (`sanitizeForStore`), made inert and fenced
  (`<item n=…>`, attributes stripped of quotes and line breaks); the instructions say so.
- **Short output, early stop.** The reply lists only the items that change the action (`{"i","why","act":true}`, at
  most 5, why before act); the stop sequence `"act":false` cuts a reply where the model starts writing a rejection.
- **Bounded input:** at most `pushCheckItems` (≤ 20) items of at most `pushCheckItemChars` characters (their most
  relevant sentences, `readerItem`), the request's first 400 characters; output at most 400 tokens.
- **Through `Budget`** (its own, per session and per user-day, as the reader's; reserved at $0.001 a call).
- **Fail open, within today's wait.** A budget refusal, an error, an unreadable reply or no reply within
  `pushCheckWaitMs` (2,500 ms) hands the default's candidates; the call goes on behind and its answer is kept on the
  session for a second pass. The agent's wait is still bounded by the observe's own wait (3,000 ms in Pi and the
  client default); the check sits inside it.

The servers wire it on the reader's model (Haiku 5.5 through OpenRouter) when a key is set and the switch is on.
The lab: `bun run funnel … -- --check live|replay --check-cache F`, and pi-ab arms with `pushCheck` on (`eden.check`
on the ledger, charged to the running task). `i3-regrade.ts` sends `regrade.ts`'s Sonnet regrade as one Message Batch.

## 2. The funnel pilot and the operating point (D501)

Funnel, train seeds 41–42 with `-- --neutral` (1,152 tasks), the default against the default + `pushCheck`, Haiku
5.5 live with thinking off, `pushCheckWaitMs` 2,500 (the shipped wait), compared task by task (`compare.py`):

| Arm | Hidden surfaced | Decoys surfaced | Planted handed | Decoy handed | Neutral packets | Calls | $ a call | in (cached) / out tokens | p50 / p90 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| default | 314 | 274 | 243 | 209 | 309 / 384 | | | | |
| + check, 400 chars × 15 items | 330 (+16 −0) | 284 (+13 −3) | 275 | 122 | 113 / 384 | 944 | 0.000221 | 2,650 (894) / 73 | 892 / 1,209 |

Calls equal the gated pushes exactly (944 = the default's 317 + 318 + 309 candidates packets): second passes cost
nothing. At 0.82 calls a task that is **$0.18 per 1,000 tasks** of check spend, against a promotion budget of $0.10
(agent + Eden). Most of a call is item text (1,756 uncached input tokens), so two cheaper points are screened the
same way: 200 characters × 15 items and 200 characters × 10 items.

**The rule that picks the operating point** (written before either cheaper run was read): the cheapest of the three
whose seeds 41–42 funnel keeps, against the default, (a) hidden surfaced at least +10, (b) decoys handed at most 75%
of the default's, (c) planted handed at least the default's, and (d) neutral packets at most half the default's;
if neither cheaper point keeps all four, 400 × 15. That point is the one the Pi run measures.

## 3. Pre-registration of the live run (D502)

To be completed with the chosen point and committed before the first Pi shard starts.
