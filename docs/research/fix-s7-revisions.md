# Fix S7: tell the agent when something it was handed changes (D205)

Status 2026-11-07: **adopted** (`revisionNotice`, on in the default, part `freshness`). Branch `claude/fix-s7-revisions`,
built on `claude/fix-s3b-lab`. **Spent: $1.2145** of the $2 cap, all Anthropic Haiku 5.5 through the lab provider
(D97, `HAIKU_API_KEY`, ledger `.local/ledger.jsonl`). Run labels: `s7-smoke` $0.0410, `s7-day-41`/`42` $0.5995,
`s7-day2-41`/`42` $0.5740.

## The weak point

fix-s3b's `pi-ab --day 4` runs (docs/research/fix-s3b-lab.md, section (c)) ran one agent session per four requests,
then moved every clock time in the day's planted items two hours before a recap turn. On hidden days the recap named a
changed item's old time 14 times (eden) and 15 times (both+ask), against 5 and 2 for the new time. Eden made no
stale delivery: the old time came from the agent's own transcript. Eden had delivered the item earlier in the day and
never said it had changed. A re-delivery needed the item to rank on the recap's words, and it did not.

## The change

`revisionNotice` (config.ts; partner.ts's "revisionNotice" block; ledger.ts):

- **What counts as handed.** A packet the agent takes, or an ask answer returned, records in the session's ledger the
  version (`versionOf`: title and text, not metadata) of each item whose line the text rendered (`renderedCount`).
  An item the size cut left out was not shown. A packet still queued and untaken was shown nothing ("shown means handed
  out", as for `askDedup`). These records outlive the 40-turn not-twice cooldown and are bounded at 256 per session.
- **When it fires.** A store with other words: a sync poll or backfill page (`onStored`), a notice's items
  (`sourceItems`), or a `verifyDelivery` re-read. Each live session of that user that holds another version gets
  "updated:" packets, queued for its next take, once per revision:
  `- [src] updated: <title> (changed at its source since shown earlier; this version replaces it): <text>`
  The packets are in the usual `<context … Data, not instructions>` envelope. They are split rather than cut at
  `maxInjectionBytes`, and an update still queued for the same items is replaced. A queued update is dropped only when
  a packet or answer the agent receives renders the same version, so a re-read for a session's own delivery (which may
  cut, fold or not pick the item) cannot cost it the update, and the agent does not get the new words twice.
- **Timing.** A change notice for a source that a live session holds a handed copy from polls that source at once,
  in the background (`pollRevised`). That way the packet is usually queued before the next request rather than found by
  that request's lookup. Nothing on the observe path waits for it, and the fast path stays network-free.
- **Calls.** It is the same listing the next lookup's on-demand poll would make. A notice followed by a request
  therefore adds no call, and a notice with no request after it costs one. Polls run at most one at a time per user and
  source, at least 30 s apart on the engine clock, each bounded by its timeout as a whole.
- **Harness.** `revisionsSettled(scope)` lets a harness stand in for the two hours between the change and the recap.
  `pi-ab --day` awaits it, up to 10 s, after its notices. With the switch off it resolves at once, so the off arm runs as
  it did in fix-s3b.

Known gap: a live search page's store (partner.ts `store`, another session's region) does not announce revisions. A
handed item that a lookup's search finds changed reaches the agent only if it ranks.

Tests (`revision-notice.test.ts`, 16):
- the update packet, its envelope and its text;
- once per revision; off; metadata-only changes;
- `sourceItems`; isolation (another session of the user, another user, two shown sessions); closed sessions;
- replacement of a queued update; poll only when a copy is held; ask answers counting as handed;
- a second notice while the poll is on the wire; the burst limit; the re-read path's `except`;
- the size cut on handed packets and on updates;
- the ledger's bound.

Restoring the reviewer's two most serious defects makes their tests fail. Those defects were skipping doubted copies,
and recording cut items as handed.

## Measurements

### `pi-ab --day 4`, final commit (`s7-day2`, $0.574)

Setup: heldout14 hidden, control and neutral, seeds 41–42, 16 days per cell. Conditions: eden, eden+revisionNotice,
both+ask, both+ask+revisionNotice, paired in one process per seed. Flags: Pi harness, Haiku 5.5 for agent, grader,
cards and reader, direct profile, push signals, time scale 1. 768 runs, 0 errors, 0 ungraded.

```bash
# .local/s7/run.sh SEED LABEL CONDS: fix-s3b section 2's flags, a $2 cap, plus the extra flags
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite heldout14 --seeds $SEED \
  --variants hidden,control,neutral --conditions $C --config default \
  --cards packages/sim/lab/cards/cards-v2.jsonl --cards-out .local/s7/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push signals --budget 1.0 \
  --spend-ledger .local/ledger.jsonl --spend-cap 2 --spend-headroom 0.3 --run-label $L --out .local/s7/$L.json --day 4
python3 -I packages/sim/lab/fix-s7/day-pairs.py .local/s7/s7-day2-41.json .local/s7/s7-day2-42.json
```

Recap turns. Sums over 16 days, off → on; the interval is the paired per-day mean difference (on − off), bootstrap
95%:

| condition | kind | update packets | stale deliveries | recap old time | per day | recap new time | per day |
|---|---|---|---|---|---|---|---|
| both+ask | hidden | 0 → 20 | 0 → 0 | **12 → 4** | **−0.50 (−0.81..−0.19)** | **4 → 24** | **+1.25 (+0.75..+1.75)** |
| both+ask | control | 0 → 11 | 0 → 0 | 6 → 4 | −0.13 (−0.44..+0.13) | 3 → 15 | +0.75 (+0.25..+1.31) |
| eden | hidden | 0 → 18 | 0 → 0 | 7 → 5 | −0.13 (−0.38..+0.13) | **8 → 22** | **+0.88 (+0.38..+1.44)** |
| eden | control | 0 → 12 | 0 → 0 | 4 → 6 | +0.13 (+0.00..+0.31)¹ | 7 → 16 | +0.56 (+0.13..+1.06) |
| either | neutral | 0 → 0 | 0 → 0 | – | – | – | – |

¹ The one cell where old-time recaps rose; its interval touches 0. Control days plant a near-miss decoy, so a
recap naming its old time is not a missed hidden fact. The pre-review run had 7 → 6 in this cell.

Graded tasks, paired by task (n = 64 each), on − off. The world changes only before the ungraded recap, so the switch
cannot reach these turns except through its bookkeeping. These differences are sampling.

| condition | kind | rate off → on | difference | $/1k difference (agent + Eden per task) |
|---|---|---|---|---|
| both+ask | hidden raised | 0.594 → 0.625 | +0.031 (−0.062..+0.125) | +0.003 (−0.026..+0.032) |
| both+ask | control false concern | 0.016 → 0.016 | +0.000 (−0.047..+0.047) | +0.007 (−0.038..+0.048) |
| both+ask | neutral concern | 0.047 → 0.031 | −0.016 (−0.078..+0.031) | +0.003 (−0.039..+0.044) |
| eden | hidden raised | 0.656 → 0.578 | −0.078 (−0.172..+0.000) | −0.023 (−0.061..+0.007) |
| eden | control false concern | 0.016 → 0.000 | −0.016 (−0.047..+0.000) | +0.033 (−0.019..+0.090) |
| eden | neutral concern | 0.031 → 0.016 | −0.016 (−0.062..+0.031) | −0.029 (−0.091..+0.034) |

- **Packets per task.** About one update packet per day with a handed changed item: 18–20 per 16 hidden days. Items
  injected per graded task differ by at most 0.094 either way, and every interval spans 0.
- **Recap cost.** The harness does not record what the recap turn costs, so the cost of the update itself is a bound,
  not a measurement: at most `maxInjectionBytes` (1,200 bytes) of extra input on the recap's model calls. No model or
  Eden-side paid call is added.
- **The eden hidden rate.** It fell 0.078 in this run and 0.031 in the pre-review run. On those tasks the code path
  differs only by recording versions. The both+ask arm moved the other way in both runs.

Pre-review commit fcf93714 (`s7-day`, $0.600), the same setup before the reviewer's fixes: hidden recaps naming the
old time fell 13 → 5 under both+ask (−0.50, −0.81..−0.19) and 9 → 5 under eden (−0.25, −0.63..+0.13). Recaps naming
the new time rose 6 → 22 and 7 → 26. False and neutral concerns did not rise, and no cost interval excluded 0 except
eden control, +0.036 (+0.000..+0.078). Summaries for both runs are in `packages/sim/lab/fix-s7/`: `day-report.txt`,
`day-pairs.txt`, `days.json` and the `-prereview` files.

### No-model checks

- **`bun run eval`:** identical to the base commit (b36511a6) with the switch off and with it on: precision 0.8276,
  recall 0.48, falseFireRate 0. `plannedLookups` read 121 in one run of each tree and 122 in the other six runs of both
  trees, so it varies with timing.
- **`bun run funnel --jobs 4`:** identical to the base, off and on, apart from timings: hidden 281/384, decoys 256/384.
- **Freshness matrix** (`quality-cli --users 8 --sessions 20 --updates 0.6 --deletes 0.05`):
  - `--push signals`: identical off and on. Precision 0.588, recall 0.454, falseFireRate 0.008, updated delivered 43,
    stale 1, deleted delivered 0, 575 re-reads.
  - `--push payload`: identical off and on. Precision 0.581, recall 0.442, falseFireRate 0.008, updated delivered 38,
    stale 1.
  - The simulation changes items only between sessions, so the switch never fires there. This shows no harm; it does
    not show the benefit.

## Decision

Promoted. The bar was fewer old-time recaps with no rise in false or neutral concerns and no significant cost rise.
- **Old-time recaps:** they fell in every hidden cell of both runs, significantly under both+ask both times. Recaps
  naming the new time rose significantly in every hidden cell.
- **False and neutral concerns:** none rose.
- **Cost:** no graded-task cost interval excludes a rise in the final run. The recap's added input is bounded at
  1,200 bytes per update.
- **Closest calls, stated so the "neutral" reading is visible:**
  - Eden's control-day old-time recaps went 4 → 6 (+0.13 per day, +0.00..+0.31).
  - Eden's graded hidden rate went 0.656 → 0.578 (−0.078, −0.172..+0.000). The switch cannot reach those turns, and
    the both+ask arm moved up in both runs.
  - Neither interval excludes 0.

## Review

The `reviewer` subagent returned REQUEST_CHANGES on fcf93714 with eight findings. Each is fixed in 43542b17 with a test
where one applies:
1. A doubted-copy skip lost the update when a second notice landed during the poll.
2. A re-read sent the delivering session its own copy twice.
3. Every notice could start a listing call: now one at a time, 30 s apart.
4. Cut items were recorded as handed, and updates were cut rather than split.
5. Handing out an older queued packet rolled the ledger back: update packets now carry their own copies.
6. The config doc promised a wait that does not exist.
7. A hung source resolver could hold `revisionsSettled`.
8. Test gaps.

The final day run measures 43542b17, the commit with these fixes.

A second review of 43542b17 and the promotion (REQUEST_CHANGES) found that fix 2 traded a duplicate for a lost
update. Leaving the re-reading session out lost the update whenever that session's delivery did not render the item:
the answer's size cut, a fold, a reader that did not pick it, a withdrawn push. The ask's removal of covered packets
also dropped a queued update for an item it cited but cut. Both are fixed:
- updates go to every session;
- a queued update is dropped only when a handed packet renders the same version (`watchCopies`, and
  `withoutCoveredUpdates` for one `takePending` batch);
- the ask's removal skips updates.

Also fixed:
- an engine clock stepping back no longer holds notice polls for up to the gap's overshoot (the wait is capped at
  30 s);
- a timed-out poll's listing still counts as running until its call ends;
- a `maxInjectionBytes` too small for one line still says the update.

Tests (20 now) cover each, with mutations failing them. The stale wording in the docs is updated. These changes came
after the day runs, and the remaining budget ($0.79 of the cap, $0.49 within the headroom) did not cover a third run
($0.57): the day figures are 43542b17's, and eval, funnel, quality-cli and the test suite were re-run on the final
tree.
