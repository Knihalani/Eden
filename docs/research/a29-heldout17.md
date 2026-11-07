# A29: the end-of-day blind check of the default on heldout17

Status: 2026-11-07, branch `claude/a29-heldout17` (from `claude/lucid-hypatia-v9wqk5` at
`ed93f3365e3b8bd1e3539ec1f80063f1a4c89746`). Decisions D395–D399. **Measurement only: no engine file changes.**

## 0. Pre-registration (committed and pushed before any paid call; nothing on heldout17 had been run or read)

**Question.** Does today's shipped default still beat the agent alone on hidden facts, cost and speed, one request a
session and over a user's days, on a suite nobody has run?

**Suite.** `heldout17` (A19, D350): 32 templates, hidden / control / neutral variants, 8 late-arrival templates
(`HELDOUT17_LATE`). Cards and intent replayed (cached for seeds 41–44; cards from `cards-v2` + `cards-train` +
`cards-train-4344`, as RealUse-3 did).

**Harness.** Pi (`pi-ab.ts`), `--config default`, `--tenant-prompt` (D271) in every arm, market `direct` source
profile, `claude-haiku-5-5` in every role (agent, grader, cards, intent, reader), `claude-sonnet-5-5` only to regrade
concerns (`regrade.ts --only-concerns --graders claude-haiku-5-5,claude-sonnet-5-5`). Anthropic only, via
`HAIKU_API_KEY`, `env -u OPENROUTER_API_KEY`, one ledger `.local/a29/ledger.jsonl` with a hard cap of **$6** for the
whole session. One seed per pi-ab process. Script: `packages/sim/lab/a29/run.sh`.

**Arms.**

| arm            | what                                                                         |
| -------------- | ---------------------------------------------------------------------------- |
| `tools`        | the agent alone with its source search tools                                 |
| `eden`         | the shipped default (candidates, askNudge, payload notices in the main runs) |
| `eden+nokey`   | the default on a server with no model key (D291: no cards, no reader)        |
| `eden~nonudge` | the default minus `askNudge` (D316), a variant, run in the same processes    |

**Runs (each once).**

1. Short (one request a session), payload: all four arms, seeds 41 and 42, hidden + control + neutral (96 tasks a
   seed an arm).
2. Long (a user's days), payload: all four arms, users 41 and 42, `--days 2 --day-size 16` (heldout17's 32 templates
   bound a user, as heldout16's did). Backfill per user: `cold-start.ts --suite heldout17 --days 2 --day-size 16`,
   reported apart.
3. Secondary rows on the `eden` arm: short `--push signals` and `--push refs` (D347), seeds 41 and 42 (their
   `eden − tools` pairs use run 1's `tools` arm, cross-run).
4. Late arrivals: `tools,eden`, `--day 4 --late --templates <HELDOUT17_LATE>`, hidden + control, seeds 41 and 42,
   payload, its own row.

If budget or time runs short, runs are dropped in the order 3 (refs), 3 (signals), the `eden~nonudge` arm (it is in
the same process, so it is kept unless the cap forces a rerun without it), 4; runs 1 and 2 are never dropped.

**Metrics.** Hidden facts raised; false concerns on control and neutral tasks, Haiku-graded and after the regrade
(kept when both regraders keep it, Sonnet's verdict counting on disagreement), each read by hand; $ per 1,000 tasks
steady on the assumed 1:1:8 mix (agent + Eden per task + background; backfill per user apart) and with connector plan
pricing (`pi-cost-report.ts`'s rows: first-party, Composio, Unified.to, Arcade, Pipedream, Zapier MCP); wall p50 and
mean; Eden on the critical path (ms a task); connector calls a task. Paired differences with bootstrap 95% intervals
(5,000 draws), as `pi-heldout16.md` did (`arms.py` for the mix pairs, `pooled.py` for hidden and concerns pooled over
short and long payload runs).

**Rules (applied mechanically).** For `eden − tools`, pooled over the short and long payload runs where pooled, else
per horizon:

- Hidden facts: **beats** if the 95% interval is entirely above zero; else **does not beat**.
- False concerns (regraded, control + neutral pooled): **no worse** unless the interval is entirely above zero.
- Cost ($/1k steady, mix): **cheaper** if the interval is entirely below zero, **dearer** if entirely above, else
  **level**, per horizon.
- Speed (wall mean, mix): **faster** if the interval is entirely below zero, **slower** if entirely above, else
  **level**, per horizon.
- The default is **confirmed** if it beats on hidden facts, is no worse on concerns, and is not dearer and not slower
  on either horizon. Otherwise the note says which claim failed; nothing is tuned here.
- `eden+nokey` and `eden~nonudge` are reported with the same pairs (against `tools` and against `eden`); they change
  no default in this session. A result for either would need its own trial.
- heldout16's numbers (cl-results.md, realuse-3/pi-heldout16.md) are compared side by side; differences in
  harness (`--tenant-prompt` was not on in RealUse-3) are named, not adjusted for.

Afterwards heldout17 leaves `UNREAD_BLIND` and is marked read in LAB.md.
