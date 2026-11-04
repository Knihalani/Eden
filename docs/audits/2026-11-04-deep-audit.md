# Deep audit follow-up (2026-11-04)

## Final summary (read this first)

This run did not hunt for new problems. It finished the open work from the second audit of 2026-11-03
(docs/audits/2026-11-03b-deep-audit.md). Its ledger records 0 audit rounds and no new findings; all 15 items it
closed came from that earlier audit's briefs. Every number below comes from the run's own records (merge checks and
commit messages) or from `git` on the integration branch. No paid model call was made: every eval, funnel and
benchmark run had `OPENROUTER_API_KEY` blanked.

Terms used once and explained here:

- **Funnel**: the free (no-model) screen of Eden on the training tasks. "Hidden" counts the facts Eden should find;
  "decoys" counts look-alike facts it should not deliver.
- **Eval**: the free scenario test. Precision is how often a delivered item was right; recall is how much of what
  should be delivered was delivered; false fires are deliveries that should not have happened.
- **Switch**: a setting in the engine's configuration that turns a behaviour on or off.
- **Reader**: the small model that reads candidate items before Eden delivers them. Each reader call costs money.
- **Integration branch**: the branch where this run's fixes were merged together and tested as one tree.

### 1. The bottom line

The engine still carried four switches that were off, in no trial, and never helped. Each one, when turned on, left
the funnel score unchanged and only added source calls, reader calls or a decoy. They are now deleted with their code
and tests (decision D121). The cost and audit docs were also brought up to date, so they no longer describe deleted
settings as live. For users, quality is unchanged: the eval and funnel give the same numbers before and after. For
cost and speed, nothing changes in the default, because these switches were off; what changes is that no one can turn
them on by mistake. One quality gap (R3-19, below) was measured but not fixed, because the fix cost more than the bar
set for it; that call now sits with you.

### 2. Scoreboard

The run's ledger lists no "found" or "verified" items (0 rounds), so those columns are 0. "Fixed" means merged into
the integration branch with `bun run check` green. The run's data records the merge checks but not a separate
reviewer verdict per item, so "reviewed" here means the integration merge check, not a reviewer subagent pass.

| Area                                   | Found | Verified | Fixed and merged | Still open |
| -------------------------------------- | ----: | -------: | ---------------: | ---------: |
| Engine switches that never helped      |     0 |        0 |                6 |          0 |
| Docs accuracy (cost model, engine doc) |     0 |        0 |                4 |          0 |
| Audit bookkeeping (open list, ledger)  |     0 |        0 |                4 |          0 |
| Live checks (Hermes)                   |     0 |        0 |    0 (see below) |          1 |
| Quality: landlord mail (R3-19)         |     0 |        0 |     0 (rejected) |          1 |

The 6 engine items are `brief-2-maxRefreshes`, `brief-2-syncTermProbes`, `brief-2-syncEveryMs`,
`brief-2-probeWhen-actions`, `brief-2-spans-unlisted` and `audit-dead-experimental-flags`. The 4 docs items are
`brief-3-engine-claude-test-count`, `brief-3-cost-model-judgeConfident`, `brief-3-cost-model-new2-gate-traffic` and
`docs-cost-model-332-tense`. The 4 bookkeeping items are `brief-4-audit-open-list`, `brief-4-R3-20-ledger`,
`brief-6-branches` and `deferred-audit-section-4`.

Where the data and git disagree:

- The ledger marks `deferred-hermes-live-check` as resolved and also lists the Hermes check as deferred. Both are
  true in a narrow sense: the item was resolved by writing down why it is blocked and the next step (2026-11-03b audit,
  section 6). The check itself has not run, so the table counts it as open.
- The ledger marks `deferred-audit-section-4` as resolved and also lists "open items from section 4 not yet resolved
  by PRs #215-#219" as deferred. Git shows the resolution: section 6 of docs/audits/2026-11-03b-deep-audit.md now
  maps every section 4 item to a decision, a PR or a next step. The items that remain open are the ones in section 5
  below.
- R3-19 is not in the ledger at all, but its branch (`audit/2026-11-04-final2-r3-19-reader-gate-landlord`, 77bc98674)
  is merged. That branch is docs only: it records the rejection (D122) and leaves R3-19 open.

All three work branches are merged into `audit/2026-11-04-integration` (checked with `git branch --merged`).

### 3. What was achieved

Each "before -> after" is the switch turned on against the default, measured free with
`bun run funnel --jobs 4 --set` and `bun run eval` (D121). "Calls/task" is source calls per training task.

| Fix                                              | Measured before -> after (switch on)                                                                                                                                                          | Outcome                                                                                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delete `maxRefreshes` (re-read stale items)      | funnel score unchanged (214/384 hidden, 211/384 decoys); request calls 3.13 -> 4.46 per task (+42%); amortised calls 4.33 -> 5.71 per task                                                    | Removed (D121); `refreshAfterMs` stays                                                                                                                           |
| Delete `syncTermProbes` (rare-word probes)       | score unchanged; hidden delivered 97 unchanged; decoys delivered 72 -> 73; reader calls 658 -> 644                                                                                            | Removed (D121)                                                                                                                                                   |
| Delete `probeWhen: "actions"`                    | score unchanged; request calls 3.13 -> 3.11 per task; reader calls 658 -> 664 (+0.9%, paid)                                                                                                   | Removed (D121)                                                                                                                                                   |
| Delete `syncEveryMs` (timed polls)               | score unchanged; background sync calls 497 -> 46,368; amortised calls 4.33 -> 60.94 per task; sync-econ: 117.7 (poll) vs 267 (timed) listing calls per user-day at freshness 0.9984 vs 0.9983 | Removed (D121); `startSync`'s timer stays for backfill and expiry                                                                                                |
| Keep `spans`                                     | funnel unchanged with it on (214/211, delivered 97/72, 3.13 calls/task, 658 reader calls)                                                                                                     | Kept off by default, recorded as an observability toggle (D121)                                                                                                  |
| Cost model and audit docs brought up to date     | Not a measured change. The gate-traffic rows come from a fresh `gate-traffic.ts` run; old NEW2 rows are labelled history                                                                      | Shipped (docs)                                                                                                                                                   |
| R3-19: let the reader read "arranged visit" mail | missed landlord bindings 0.227 -> 0.000; reader calls 66 -> 72 per 438 simulated messages (+9.1%); reply-pricing gated 4 -> 3; eval and funnel unchanged                                      | Not shipped: over the bar of at most 5 extra calls with no other row moving (D122). Cost if adopted, an estimate: about $0.044 -> $0.048 per 1,000 user messages |

After all merges, on the integration tree:

- `bun run check`: exit 0; 1494 tests pass, 0 fail, in 124 files (main had 1497; the deleted switches took their
  tests with them).
- Eval: precision 0.8276, recall 0.48, false-fire rate 0, false fires 0, model calls per turn 0, secrets leaked 0.
  Same as main.
- Funnel: TOTAL hidden 214/384, decoys 211/384; delivered hidden 97, decoys 72; 3.13 request calls per task; 658
  reader calls. Same as main.
- `packages/engine/bench/ingest.bench.ts` (edited by the engine branch): runs, 118.1 µs per item backfill, 3.4 µs per
  item sweep. There is no before number; it was run only to show the bench still works.

### 4. Decisions made during the run

- **D121**: delete `maxRefreshes`, `syncTermProbes`, `probeWhen: "actions"` and `syncEveryMs`; keep `spans` as an
  observability toggle. Evidence: per-switch funnel and eval runs above, all free. Decision-log row: docs/DECISIONS.md
  line 127.
- **D122**: reject the arranged-visit pattern for the reader gate; R3-19 stays open. Evidence: `gate-traffic.ts`
  (seeds 41-44), eval and funnel on cc668e4df, numbers above. Decision-log row: docs/DECISIONS.md line 128.
- Recorded in the 2026-11-03b audit, section 6 (calls the owner delegated to this run, not new D-numbers):
  answering asks from a stale copy is not adopted; reading on the draft event is not adopted; the merge gate keeps
  running every test (no cached test passes); paid reader screens are deferred.

### 5. What is still open, and why

| Item                                                                                    | Why open                                                                                                         | Next step                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R3-19: the default's reader gate drops the landlord's "engineer comes Thursday" mail    | Rejected by its own bar: the fix costs 6 extra reader calls per 438 messages (bar was 5) and moved one other row | Your call (D122): accept 6 calls per 438 simulated messages, about $0.004 more per 1,000 user messages (estimate), or keep the miss. The bar of 5 was the package's choice, not a measured threshold |
| Hermes live check of the unified default                                                | External action: cloning Hermes needs your approval in a session. Pi was measured (D112)                         | Approve a Hermes checkout; then run `hermes-ab` with D112's conditions (blind held-out 13, seeds 41-42, `--time-scale 1`, Haiku 5.5)                                                                 |
| Paid reader screens ($0.3-0.5 each)                                                     | Needs paid spend beyond this run's budget ($0)                                                                   | Approve a budget; the D117 subset replay answers some screens for free first                                                                                                                         |
| D114 and D119 live measurement                                                          | Needs paid spend                                                                                                 | They ride on the next paid Pi run                                                                                                                                                                    |
| Agent-stream and Hermes request replay (`devloop-ab-request-replay-all-roles`, stage 2) | Waits on the Hermes checkout                                                                                     | One lab package after the Hermes checkout                                                                                                                                                            |
| Old remote branches (41 `origin/claude/r10-*` and `origin/claude/lucid-hypatia-v9wqk5`) | External action: agents do not delete remote branches                                                            | Check each with `git diff origin/main <branch> -- <its files>`, then delete                                                                                                                          |
| Merging this run into `main`                                                            | Not done by this run; the integration branch is local                                                            | Open a PR from `audit/2026-11-04-integration` to `main` (base 39a41c49e, still main's tip)                                                                                                           |

Follow-up, same day (docs/research/live-checks-1104.md): D114 and D119 were live-checked on held-out 13 (D123: the
default holds 73.4% hidden, 0 false concerns). R3-19 was re-measured live on train under the owner's reset bar and
rejected again (D124: hidden 262 → 256 of 384); it stays open.

### 6. Where everything is

- This file: `docs/audits/2026-11-04-deep-audit.md`. The detailed status of every earlier item:
  `docs/audits/2026-11-03b-deep-audit.md`, section 6.
- Integration branch: `audit/2026-11-04-integration` (branched from main 39a41c49e; merges 22c439eee, cc668e4df,
  f4ae3fbd4, then this summary).
- Work branches, all merged into the integration branch:
  - `audit/2026-11-04-final1-engine-dead-switches` (2c6b34be8): the engine change, D121.
  - `audit/2026-11-04-final1-docs-cost-model-and-audit-ledger` (b2f1ef6b4, 243c87b6c): cost model and audit ledger.
  - `audit/2026-11-04-final2-r3-19-reader-gate-landlord` (77bc98674): D122, docs only.
