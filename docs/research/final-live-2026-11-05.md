# Final live checks of the shipped default, 2026-11-05: Pi and Hermes on Anthropic Haiku

**Pi harness, current default, Anthropic-direct lab transport.** Every model role (agent, grader, Eden's cards,
intent and reader) is `claude-haiku-5-5` through the lab's Anthropic provider (D97), thinking off. The servers ship
the same model family on OpenRouter (D12), so these are lab figures for the shipped configuration, not production
figures. The Hermes runs use the same transport.

## In plain words

- **The default still finds the hidden fact about three times in four on Pi.** Over 128 blind held-out tasks it raised
  77.3% (99/128). The agent alone raised 9.4% (12/128). That is +68.0 points (paired 95% interval +59.4..+75.8).
- **No false concern on Pi.** 0 of 128 look-alike tasks, the same as the agent alone.
- **Nothing measurable changed against the last Pi run of the default** (`direct-4N`, 2026-11-04, before D125–D150).
  That run raised 80.5% (103/128). The difference is −3.1 points, and its paired interval (−10.2..+4.7) includes zero.
  The eden-market-effect note already called that 80.5% a high draw: D125's same-hour rerun of the old default gave
  77.3%, the figure measured here.
- **Hermes holds up.** On Hermes Agent with seeds 41–42, Eden raised 70.3% (45/64) against 4.7% (3/64) for Hermes
  alone, a gain of +65.6 points (+54.7..+76.6). It raised one false concern in 64 look-alike tasks. Hermes alone raised
  none. The interval for that difference is +0.0..+4.7 points. The pre-D125 Hermes run in final-before-after.md raised
  67.2% (86/128) with 0 of 128 false concerns.
- **Cards now cost less than half as much.** Eden's model spend on Pi came to $0.834 per 1,000 tasks: cards and intent
  $0.388, the reader $0.445. The `direct-4N` run spent $1.325: cards $0.896, reader $0.429. Most of the drop is
  D125's `cardsLean`, measured in cost-fixes.md: about 500 cards were made per seed here, against about 1,370 there.
  The reader's cost did not move.
- **Speed is unchanged.** The median hidden task on Pi took 3.29 s, against 3.32 s for `direct-4N`. The difference is
  +0.08 s for `direct-4N` (−0.17..+0.34). Eden held the critical path for 1,727 ms per task on average, against
  1,769 ms before.
- **Spent: $0.516** for all six processes (ledger rows labelled `final-pi-41`..`44` and `final-hermes-41`..`42`). The
  ledger held $7.192 before the runs and $7.726 after, under the $16.7 cap. The extra $0.018 came from other runs that
  shared the ledger at the same time.

## What was measured

**The tree.** Commit `dc0015f20` is a local merge of `audit/2026-11-05-integration` (c11b0289c) with the three
branches that change what ships and had not yet merged:

- `audit/2026-11-05-final1-cards-reasoning-off` (a91636aa7): cards and intent send no reasoning by default (proposed
  D149).
- `audit/2026-11-05-final1-graph-read-chars-1000` (79a583032): the graph reads each item's first 1,000 characters
  (D150).
- `audit/2026-11-05-final1-timed-zone-day` (c98570273): a UTC start falls on the user's local day.

The merges had no conflicts. This branch carries them, so the commit measured is in its history. `--config default`
is `DEFAULT_CONFIG` of that tree.

**Pi.** `pi-ab.ts` on the blind held-out 13 suite, seeds 41–44, one process per seed. Hidden and control variants, 32
of each per seed, with `--time-scale 1`. The `direct` market latency profile
(`packages/sim/lab/before-after/market-profiles/direct.json`) was used, as in `direct-4N`. Card misses were made live
against the replay file `packages/sim/lab/cards/cards-v2.jsonl`. `--budget 0.6` was set per process. The `tools` arm
was not rerun. `--reuse-arms .local/mkt/direct-4N.json` copied it from the `direct-4N` runs of 2026-11-04 (64 results
and 64 timeline lines per seed). `reusableArms` (ab-common.ts) accepted the match: same model, grader, harness version,
prompts hash, seeds, suite, time scale and task wording. Only the `eden` arm was paid for.

**Hermes.** `hermes-ab.ts` at hermes-agent commit 06433066 (its `.venv`), with `--concurrency 3`. The suite was the
same blind held-out 13, seeds 41 and 42, one process each, with `--time-scale 1` and `--config default`. Both arms,
`hermes` and `hermes+eden`, were run live, because hermes-ab has no `--reuse-arms`. It used the sources' default
profiles, with no `--source-profile`, as final-before-after.md's Hermes run did. `--budget 1` was set per process.

**Metering.** Every process ran with `--spend-ledger .local/mkt/ledger.jsonl --spend-cap 17 --spend-headroom 0.3`,
`--run-label final-pi-<seed>` or `final-hermes-<seed>`.

## Pi: held-out 13, seeds 41–44

The run lines (`.local/mkt/final-pi-4N.log`):

| Seed | Spent (agent / Eden / grader) | Runs | Ungraded | overBudget | Hidden raised: eden / tools | False concerns: eden / tools |
|---|---|---|---|---|---|---|
| 41 | $0.0807 (0.0236 / 0.0529 / 0.0042) | 128 | 0 | reader 0, cards 0 | 24/32 / 5/32 | 0/32 / 0/32 |
| 42 | $0.0805 (0.0219 / 0.0546 / 0.0041) | 128 | 0 | reader 0, cards 0 | 26/32 / 0/32 | 0/32 / 0/32 |
| 43 | $0.0771 (0.0205 / 0.0525 / 0.0041) | 128 | 0 | reader 0, cards 0 | 23/32 / 3/32 | 0/32 / 0/32 |
| 44 | $0.0804 (0.0227 / 0.0535 / 0.0042) | 128 | 0 | reader 0, cards 0 | 26/32 / 4/32 | 0/32 / 0/32 |

The table below comes from `pi-ab-report.ts` on the four results files. The `direct-4N` eden row is from the same
report run on `direct-4{1,2,3,4}.json`. Its tools arm is the same 128 + 128 runs as this run's.

| Arm | Hidden raised | False concerns | Hidden wall p50 / p90 (s) | Control wall p50 / p90 (s) | Agent + Eden per-task $/1k hidden / control | Eden per-task $/1k hidden / control | Background (cards) $/1k | Eden on the critical path, mean ms |
|---|---|---|---|---|---|---|---|---|
| **eden (now)** | **77.3% (99/128)** | **0.0% (0/128)** | 3.29 / 6.57 | 5.37 / 7.47 | 0.675 / 0.908 | 0.358 / 0.532 | 0.388 | 1,727 (37%) |
| eden, `direct-4N` (2026-11-04) | 80.5% (103/128) | 0.8% (1/128) | 3.32 / 6.50 | 5.30 / 7.54 | 0.651 / 0.836 | 0.358 / 0.498 | 0.896 | 1,769 (38%) |
| tools (reused) | 9.4% (12/128) | 0.0% (0/128) | 4.75 / 6.96 | 4.68 / 7.34 | 0.353 / 0.356 | 0 | 0 | 0 |

Paired differences (bootstrap 95% interval over tasks; `pi-ab-report.ts`):

| a − b | Kind | Hidden fact / false concern (points) | Wall (s) | Agent + Eden $/1k |
|---|---|---|---|---|
| eden − tools | hidden | **+68.0 (+59.4..+75.8)** | −0.85 (−1.23..−0.47) | +0.322 (+0.263..+0.386) |
| eden − tools | control | +0.0 (+0.0..+0.0) | +0.48 (+0.08..+0.86) | +0.552 (+0.492..+0.613) |
| eden `direct-4N` − eden now | hidden | +3.1 (−4.7..+10.2) | +0.08 (−0.17..+0.34) | −0.024 (−0.080..+0.026) |
| eden `direct-4N` − eden now | control | +0.8 (+0.0..+2.3) | −0.20 (−0.49..+0.11) | −0.072 (−0.133..−0.007) |

Reading:

- **Quality is within noise of the last run.** The −3.1 points against `direct-4N` has an interval that includes zero.
  D125 measured its own change as +0.0 (−4.3..+4.7) on direct and hosted pooled. Its same-hour rerun of the old
  default on direct gave 77.3%, the figure measured here. `direct-4N`'s one false concern
  (`w43:heldout13-control:vendor-bill-correction`) did not recur. The control row's interval (+0.0..+2.3) is that one
  task.
- **The per-task bill rose a little on control tasks.** Agent plus Eden came to +$0.072 per 1,000 control tasks, an
  interval that excludes zero. Eden's per-task part on control rose from $0.498 to $0.532 per 1,000. The ledger has
  441 reader calls here against 424 in `direct-4N`. That could be the freshness re-reads of D126, or noise. It was not
  traced. The background card spend fell by $0.508 per 1,000 tasks, so the all-in cost fell (below).

## Hermes Agent: held-out 13, seeds 41–42

The run lines (`.local/mkt/final-hermes-4N.log`):

| Seed | Spent (agent / Eden / grader) | Runs | Ungraded | overBudget | Hidden raised: hermes+eden / hermes | False concerns: hermes+eden / hermes |
|---|---|---|---|---|---|---|
| 41 | $0.0982 (0.0492 / 0.0416 / 0.0074) | 128 | 0 | reader 0, cards 0 | 23/32 / 1/32 | 1/32 / 0/32 |
| 42 | $0.0992 (0.0488 / 0.0430 / 0.0074) | 128 | 0 | reader 0, cards 0 | 22/32 / 2/32 | 0/32 / 0/32 |

From `pi-ab-report.ts` on the two results files:

| Arm | Hidden raised | False concerns | Hidden wall p50 / p90 (s) | Control wall p50 / p90 (s) | Agent + Eden per-task $/1k hidden / control | Background (cards) $/1k | Eden on the critical path, mean ms |
|---|---|---|---|---|---|---|---|
| **hermes+eden (now)** | **70.3% (45/64)** | **1.6% (1/64)** | 3.26 / 8.31 | 5.69 / 8.85 | 0.638 / 0.760 | 0.371 | 1,274 (25%) |
| hermes | 4.7% (3/64) | 0.0% (0/64) | 4.39 / 5.96 | 4.27 / 7.19 | 0.359 / 0.354 | 0 | 0 |

| a − b | Kind | Hidden fact / false concern (points) | Wall (s) | Agent + Eden $/1k |
|---|---|---|---|---|
| hermes+eden − hermes | hidden | **+65.6 (+54.7..+76.6)** | +0.29 (−0.24..+0.83) | +0.279 (+0.212..+0.349) |
| hermes+eden − hermes | control | +1.6 (+0.0..+4.7) | +1.64 (+1.18..+2.07) | +0.405 (+0.349..+0.461) |

**Against final-before-after.md's Hermes AFTER row** (main at bf2fc13, seeds 41–44, 2026-11-04, the same Hermes
commit and transport, before D125–D150). That run's results files are no longer on this machine, so the comparison
uses its published figures and is not paired:

| | Hidden raised | False concerns | Hidden wall p50 / p90 (s) | Eden on the critical path, mean ms | Reader $/1k | Cards $/1k |
|---|---|---|---|---|---|---|
| Hermes AFTER, 2026-11-04 (4 seeds) | 67.2% (86/128) | 0.0% (0/128) | 3.25 / 8.18 | 1,313 | 0.295 | 0.886 |
| hermes+eden now (2 seeds) | 70.3% (45/64) | 1.6% (1/64) | 3.26 / 8.31 | 1,274 | 0.290 | 0.371 |

**The false concern.** It came on control task `w41:heldout13-control:offer-salary-band`: "Draft the offer letter
for Yasmin Qureshi for the senior PM role at £68,000". Eden injected one item, the salary bands document, which
lists no Senior PM band. The agent noted that £68,000 "may be above it" and that offers above a band need CEO
approval. The grader counted that as raising the planted concern. It is one task in 64, and the interval reaches
+0.0. Over the three Hermes runs of the default on this suite, that makes 1 false concern in 320 control tasks:
0/128 in final-before-after.md, 0/128 in D125's Hermes run, and 1/64 here.

## Eden's cost per 1,000 tasks, by role, from the spend ledger

The rows are summed from `.local/mkt/ledger.jsonl` by run label and role. Each role's sum is divided by the task runs
it served:

- **Pi:** the agent and grader rows are the eden arm only, because the tools arm was reused at $0. That is 256 task
  runs.
- **Hermes:** the agent and grader rows cover both arms, 256 runs. Eden's rows cover the hermes+eden arm only, 128
  runs.

| Run | Agent | Grader | Eden cards + intent | Eden reader | Eden total | Ledger $ (rows) |
|---|---|---|---|---|---|---|
| Pi now (`final-pi-41`..`44`) | 0.346 (eden arm) | 0.065 | 0.388 | 0.445 | **0.834** | 0.3187 (1,319 rows) |
| Pi `direct-4N` (`mkt-direct-41`..`44`) | — (both arms in one label) | — | 0.896 | 0.429 | **1.325** | 0.5431 (2,443 rows) |
| Hermes now (`final-hermes-41`..`42`) | 0.383 (both arms) | 0.058 | 0.371 | 0.290 | **0.661** | 0.1974 (928 rows) |
| Hermes AFTER, final-before-after.md (published) | 0.380 | — | 0.886 | 0.295 | 1.181 | — |

- **Cards and intent are a cold-cache upper bound.** As in every note since D123, they are each world's one-time
  backfill, spread over 64 tasks per seed. A deployment cards each item once in its lifetime.
- **Cards made per seed:** 486, 500, 511 and 506 here (`final-pi-4N.cards.jsonl`), against 1,363 to 1,385 in
  `direct-4N`. The cost per card call was about the same: $0.00045 here (221 calls, $0.0994) against $0.00041 there
  (561 calls, $0.2293). So the saving is fewer items carded, D125's `cardsLean`. D149's reasoning-off adds nothing
  visible here, because the lab's Anthropic card maker already ran with thinking off.
- **The reader is the same model and setting as before:** Haiku 5.5, thinking off, cached system prompt (414,855 of
  1,184,666 input tokens read from the cache). The shipped reader runs on OpenRouter with reasoning "off" after D144.
  That is the same setting on another transport.

## Acceptance checks

| Check | Result | Command |
|---|---|---|
| Ledger rows exist for `final-pi-41`..`44` and `final-hermes-41`..`42` | Yes: 4 roles each, 2,247 rows in all | the ledger sum below |
| Ledger total under $16.7 | $7.726 after the runs | the ledger sum below |
| `0 ungraded` and `overBudget: reader 0` on every seed | Yes, all six processes (the tables above) | `grep -E '^spent\|overBudget' .local/mkt/final-*.log` |

## What this does not show

- **Two Hermes seeds, not four.** The Hermes intervals are wide. The comparison with final-before-after.md is not
  paired, because that run's files are gone, and it covers different seeds (41–44 there, 41–42 here).
- **The tools arm on Pi is reused from 2026-11-04.** That is valid for a paired comparison, because its prompts hash
  was checked. But the agent-alone sample is frozen, not redrawn.
- **The lab transport is not production's.** These figures are Anthropic direct with thinking off. Production uses
  OpenRouter's ZDR route (D12, D95).
- **The control-task reader increase is untraced** (above).
- **A shared machine.** Two processes ran at once on a 4-core box that other agents were also using. Wall times are
  comparable within a run, and only loosely across runs.

## Reproduce

Run from the repository root at `dc0015f20`. `.local/mkt` holds the `direct-4N` results and the shared ledger.

```bash
W=.local/mkt; L="--spend-ledger $W/ledger.jsonl --spend-cap 17 --spend-headroom 0.3"
H="--card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --model claude-haiku-5-5 --grader claude-haiku-5-5"
COMMON="--suite heldout13 --variants hidden,control --time-scale 1 --config default"
C="--cards $PWD/packages/sim/lab/cards/cards-v2.jsonl"
for S in 41 42 43 44; do   # two at a time on a 4-core box
  bun packages/sim/src/lab/pi-ab.ts $COMMON --conditions tools,eden --budget 0.6 --seeds $S $C \
    --cards-out $W/final-pi-$S.cards.jsonl $H $L --run-label final-pi-$S \
    --source-profile packages/sim/lab/before-after/market-profiles/direct.json --reuse-arms $W/direct-$S.json \
    --timeline $W/final-pi-$S --out $W/final-pi-$S.json
done
for S in 41 42; do
  bun packages/sim/src/lab/hermes-ab.ts --hermes-src /home/user/hermes-agent --concurrency 3 $COMMON \
    --conditions hermes,hermes+eden --budget 1 --seeds $S $C --cards-out $W/final-hermes-$S.cards.jsonl $H $L \
    --run-label final-hermes-$S --timeline $W/final-hermes-$S --out $W/final-hermes-$S.json
done
bun packages/sim/src/lab/pi-ab-report.ts $W/final-pi-4{1,2,3,4}.json      # Pi tables
bun packages/sim/src/lab/pi-ab-report.ts $W/direct-4{1,2,3,4}.json        # the direct-4N rows
bun packages/sim/src/lab/pi-ab-report.ts $W/final-hermes-4{1,2}.json      # Hermes tables
```

**The paired comparison with `direct-4N`.** Copy each `direct-4N.json`, keeping only its `eden` results, renamed
`eden~direct`, with no `timeline` or `background` fields. Then run `pi-ab-report.ts` on the four `final-pi` files plus
the four copies. The report pairs a `~variant` condition with its base condition task by task.

**The ledger sums.** Group `.local/mkt/ledger.jsonl` by `run` and `role` and sum `costUsd` (`summarizeLedger` in
`packages/sim/src/lab/spend.ts` does the same grouping).
