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
| **+ check, 200 chars × 15 items** | **331 (+17 −0)** | 284 (+14 −4) | **275** | **125** | **110 / 384** | 944 | **0.000202** | 2,467 (894) / 71 | 886 / 1,190 |
| + check, 200 chars × 10 items | 323 (+11 −2) | 278 (+9 −5) | 265 | 110 | 104 / 384 | 944 | 0.000151 | 1,993 (894) / 65 | 869 / 1,148 |

Calls equal the gated pushes exactly (944 = the default's 317 + 318 + 309 candidates packets): second passes cost
nothing. At 0.82 calls a task that is **$0.18 per 1,000 tasks** of check spend, against a promotion budget of $0.10
(agent + Eden). Most of a call is item text (1,756 uncached input tokens), so two cheaper points are screened the
same way: 200 characters × 15 items and 200 characters × 10 items.

**The rule that picks the operating point** (written before either cheaper run was read): the cheapest of the three
whose seeds 41–42 funnel keeps, against the default, (a) hidden surfaced at least +10, (b) decoys handed at most 75%
of the default's, (c) planted handed at least the default's, and (d) neutral packets at most half the default's;
if neither cheaper point keeps all four, 400 × 15. That point is the one the Pi run measures.

**Chosen: 200 characters × 15 items** (now the trial's defaults, `pushCheckItemChars` 200, `pushCheckItems` 15). It
keeps all four clauses (+17; 125 ≤ 156.75; 275 ≥ 243; 110 ≤ 154.5). 200 × 10 fails (a) (hidden +9 net). Halving the
characters cut only 183 tokens a call: most items' relevant text is under 400 characters already, so the input is
mostly the items' count, titles and fences. On the held-out templates (D493's primary set, 80 tasks a variant) the
chosen point moves decoys handed 41 → 31 and planted handed 51 → 59. Pilot spend: $0.5446 on the ledger
(`.local/i3/ledger.jsonl`). **[EST]** At 0.82 calls a task and $0.000202 a call the check alone is about $0.166 per
1,000 train-mix tasks, so the cost clause below is expected to fail unless the agent spends less with the check.

## 3. Pre-registration of the live run (D502)

Written and committed before any Pi shard starts.

**Harness.** Pi on Modal (`lab_fanout.py`, the F3 bench recipe: `--config default --tenant-prompt --push payload
--source-profile …/market-profiles/direct.json`, Haiku 5.5 as agent, grader, cards and check, the three checked-in
card files; seeds 45–48 make their cards in-run in both arms), train only, seeds 41–48, from the commit that holds
this section. Arms: `eden` (the default) and `eden~check` (`--variant-config '{"check":{"pushCheck":true}}'`, the
chosen point). Two shapes:

- **Short:** `--variants hidden,control,neutral`, one seed a shard (576 tasks an arm a seed, 36 agent streams: one
  shard at a time under `--max-streams` 60).
- **Days:** `--days 8` (one user a seed, 1:1:8 days of 12–20 requests), `--max-streams 4` (two shards at a time).

At most two Anthropic shards run at once; the existing Modal Secret `HAIKU_API_KEY`; no secret is created.

**Regrade.** Every hidden answer and every control or neutral answer the Haiku grader called a concern, both arms,
both shapes, regraded by Sonnet 5.5 (`i3-regrade.ts`: `regrade.ts`'s prompt and request as one Message Batch).
Sonnet's verdict replaces Haiku's wherever it graded (`bench_report.py --sonnet`); a concern Sonnet clears is not a
concern.

**Outcomes** (eden~check − eden, paired by task):

1. **Hidden** (primary): share of hidden tasks whose answer raises the planted fact, Sonnet-graded, short shape,
   seeds 41–48 (1,536 pairs), interval from a cluster bootstrap over templates (`bench_report.py`). The days shape's
   hidden tasks are reported beside it (same method, fewer pairs), not pooled.
2. **Concerns:** share of control and neutral answers with a (Sonnet-confirmed) concern, short shape, clustered the
   same way; and on the days shape.
3. **Cost:** `pi-cost-report.ts`: agent $, Eden's per-task $ (the check's calls are charged to their task) and
   background, per 1,000 tasks, steady state, on the 1:1:8 mix: **the days shape (a true 1:1:8 user) decides**; the
   short shape weighted 1:1:8 is reported beside it; every total also per connector plan. Agent tokens (input,
   cache reads and writes, output) per 1,000 tasks from the timelines.
4. **Latency:** Eden on the agent's critical path and wall p50/mean (`pi-ab-report.ts`, `pi-cost-report.ts`).
5. **Call rate:** check calls per task by kind; failures, late answers; $ and tokens a call.

**Rule (the brief's):** promote if (hidden better: the clustered interval above zero) **or** (concerns fall
significantly: the clustered interval below zero, with hidden not worse: its point estimate not below −1 point and
its interval's upper end above zero), **and** the days shape's
total $/1k (agent + Eden, steady state) rises by at most $0.10. If quality clears and cost does not, `pushCheck`
stays an off trial and the exact trade (points gained, $/1k added, per connector plan) goes to the owner. If quality
does not clear, the switch and its code are deleted at the trial's end (D112).

**Budget and stop rule.** Anthropic cap $8 for the session ($0.5446 spent on the pilot). **[EST]** short ≈ 9,216
tasks × $0.000316 (F3's per-task figure) + 4,608 × 0.82 checks × $0.0002 ≈ $3.7; days ≈ $0.9; regrade ≈ 3,700
answers × ~$0.0007 (half of A12's $0.0014) ≈ $2.6; total ≈ $7.7. Seed 41 short runs first; if its measured spend
projects the whole plan (with the regrade's dry-run worst case) above $7.4, seeds 45–48 short run `--variants
hidden,control` only (their concern rate then comes from control tasks and the days shape). Modal cap $10.
