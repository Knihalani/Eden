# Keeping what Eden delivers current (D126)

Status: 2026-11-05. Measured in the $0 quality simulation (`quality-cli.ts`, 8 users × 20 sessions, 1,210 agent turns,
source-side updates and deletions) and live on the Pi harness (Haiku 5.5 as agent, grader and Eden's roles, blind
held-out 13, seeds 41–44, the direct-API market latency profile, 128 hidden and 128 control tasks per arm). Every
number comes from a command run in this session.

## In plain words

Eden holds copies of the user's items: synced listings, search results, notifications. A copy can go stale two ways:
the item changed at the source (a meeting moved), or it was deleted (a cancelled invite). Before this change, when a
source changed after Eden read it, Eden kept delivering the old copy until a poll or the daily sweep caught up: in the
simulation 7 of 46 delivered updated items still showed the old time, and deleted items were delivered 7 times in
packets and cited 12 times in answers.

What ships:

1. **Deletion notifications** (`POST /v1/sources/removed`, `client.sourceRemoved`, `ContextPartner.sourceRemoved`): an
   integrator that hears "message deleted" forwards it and Eden drops the items at once, for that user only.
2. **Re-read on a change signal** (`verifyDelivery`, in the default): a signal-only notification ("this source
   changed") does not say what changed, so every copy Eden read from that source before the signal is in doubt. Such
   an item is fetched again by its id before it is delivered. A changed copy replaces it; a gone one is dropped and
   not delivered; one that cannot be checked is delivered as held. A reader's likely picks are re-read while the
   reader runs, so the delivery seldom waits on the call.
3. **Honest deletions** (`Source.fetchReportsGone`): only a source that says "null means deleted" can delete an item
   through a re-read. An MCP tool's empty answer proves nothing (wrong argument, permissions, a search-shaped tool),
   so MCP items are deleted only by notifications and the sweep.

What was built, measured and **deleted**:

- **Re-reading by age** (`verifyAfterMs`: any copy older than 10 minutes re-read before delivery). It fixed staleness
  for sources that send no notifications, but live it doubled Eden's connector calls (+4.6 per task) and added 0.33 s
  per task with no measured quality gain. On a per-call connector plan that is the bill D125 had just cut.
- **Age labels** (`packetAge`: "[gmail · as of 3 h ago]" on a doubted copy). No measured help; a slight rise in
  false concerns (+1.6 points, 95% CI 0.0..+3.9).

So a source that sends no notifications is still as fresh as its polls and the daily sweep make it, as before. The
cheapest complete answer is still a notification that carries its items (D125): with it, staleness and deletions in
the simulation fall to 1/38 and 0 with no re-reads at all.

## The simulation ($0)

`bun packages/sim/src/quality-cli.ts --users 8 --sessions 20 --updates 0.6 --deletes 0.05 [--push signals|payload]
[--config …]`: 101 updates and 34 deletions applied, 1,210 turns per arm.

| How changes reach Eden | Re-read | Stale updates delivered | Deleted: in packets / cited | Re-reads per turn |
|---|---|---|---|---|
| No notifications | none | 7 / 46 | 7 / 12 | 0 |
| No notifications | by age (10 min, deleted) | 1 / 45 | 0 / 0 | 1.13 |
| Signals | none (`verifyDelivery` off) | 7 / 44 | 7 / 12 | 0 |
| Signals | **on signal (the default)** | **1 / 43** | **0 / 1** | **0.48** |
| Signals | on signal and by age | 1 / 43 | 0 / 1 | 0.48 |
| Payload (items and deletions) | any | 1 / 38 | 0 / 0 | 0 |

- With signals, re-reading by age added nothing over re-reading on signal (575 checks in both).
- Re-reading by age at 30, 120 and 360 minutes gave the same freshness at 1.08, 0.99 and 0.93 re-reads per turn:
  simulated sessions span days, so most held copies are old by any bound.
- Of the 575 default re-reads: 542 confirmed, 11 changed, 13 gone, 9 failed (a simulated error; delivered as held).
- Signals, default against off: precision 0.588 against 0.576, recall 0.454 against 0.460, false-fire rate 0.008 in
  both; 212 against 216 packets (the gone items no longer go out).
- `bun run eval` and the $0 funnel (train1–6, seeds 41–42) are identical with the part in or out (funnel 214/211,
  `--baseline` diff +0 −0): neither sends a signal, so nothing is re-read.

## Live (Pi, held-out 13, direct-API latency)

Arms in one run per seed, paired by task; the agent-alone arm reused from the market runs. `eden` is the default as
of D125 (no re-reads); the lab world never changes, so a re-read can only cost here, never help. That is the point
of the run: it measures what re-reading costs when nothing is stale.

First run (re-reads awaited at delivery, before `checkAhead`; `.local/fresh/v-4*.json`, $0.52), by age with labels:
hidden facts raised 80.5% → 70.3%, −10.2 points (−15.6..−4.7); wall +0.68 s (+0.40..+0.96); Eden's connector calls
3.78 → 6.82 per task.

Second run (re-reads started beside the reader's call and shared, `checkAhead`; `.local/fresh/w-4*.json`, $0.72):

| Hidden tasks (n = 128) | Default (no re-read) | By age | By age, labelled |
|---|---|---|---|
| Hidden facts raised | 74.2% | 75.0% | 72.7% |
| Paired against the default | | +0.8 (−5.5..+7.0) | −1.6 (−7.0..+3.9) |
| Wall p50 / mean (s) | 3.58 / 4.13 | 3.86 / 4.46 | 3.88 / 4.50 |
| Paired wall | | +0.33 s (+0.04..+0.64) | +0.37 s (+0.12..+0.62) |
| Eden's connector calls per task | 3.77 | 8.44 (4.61 re-reads) | 8.48 (4.77) |

Control tasks: false concerns 0.8%, 1.6% (+0.8, −1.6..+3.1) and 2.3% (+1.6, 0.0..+3.9); wall +0.34 s and +0.43 s.

Run-to-run noise is large: the same default arm raised 80.5% in the first run and 74.2% in the second. Starting the
re-reads beside the reader removed the quality loss within that noise, but not the connector calls or the latency.

## The decision

`verifyDelivery` joins the default as re-read on signal: it costs nothing where no signal arrives, which the live
runs and the funnel confirm, and about 0.5 connector calls per turn where signals do arrive. That is the case where the
simulation shows it fixing 6 of 7 stale updates and every deleted packet. Re-reading by age and the age labels are
deleted with their settings (D112: not neutral at no extra paid cost). Settings left: `verifyDelivery` (on) and
`verifyTimeoutMs` (1.5 s); the part is `freshness` (`docs/profiles/minus-freshness.json`).

## Reproduce

```bash
bun packages/sim/src/quality-cli.ts --users 8 --sessions 20 --updates 0.6 --deletes 0.05 --push signals \
  [--config '{"verifyDelivery":false}']
bun run funnel --jobs 4 --preset minus-freshness --json off.json && bun run funnel --jobs 4 --baseline off.json
# Live: pi-ab.ts --suite heldout13 --variants hidden,control --time-scale 1 --conditions tools,eden,… with
# --source-profile packages/sim/lab/before-after/market-profiles/direct.json (the age arms need the deleted code:
# commit bdb7cd5b2's `verifyAfterMs`/`packetAge`)
```
