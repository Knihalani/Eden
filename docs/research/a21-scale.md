# A21: Eden at 1,000 sources, part 3 (the daily sweep, and a live check)

Status: measured 2026-11-07 on branch `claude/a21-scale3` (from `claude/lucid-hypatia-v9wqk5` at 23627660f), A13's
next step ([a13-scale.md](a13-scale.md)). Decisions D356–D358. Paid calls: Anthropic API only, `HAIKU_API_KEY`,
`claude-haiku-5-5` in every role, lab provider (D97), `OPENROUTER_API_KEY` unset, own ledger
(`.local/a21/ledger.jsonl`, hard cap $1.5): **Anthropic-direct lab figures**. **Spent: $0.4105.** Every other figure
is a $0 run. Machine: 4 vCPU, 15 GiB, Bun 1.4.4; the funnels and benches ran beside other work, so their ms are not
latencies. Summaries of every run are in `packages/sim/lab/a21/`.

## In plain words

- **The problem.** A13 left a 1,000-source user's bill dominated by the daily sweep: every source re-listed once a
  day to notice deletions, ~1,100 listing calls a user a day however little changed ($29 a user a day on Zapier
  MCP). A8 tried a weekly sweep (D297) and deleted it: with change notices lost, deleted items reached the agent.
- **What changed (D356, in the default).** A source the user does not use (A13's "used" set: one a lookup routed to on
  evidence) and whose connector can fetch an item by its id (an MCP connector with a get tool wired; one without keeps
  the daily sweep) is swept weekly instead of daily. In return, Eden no
  longer trusts what that saved it: a copy of such a source's item that no listing has seen for more than a day while
  its daily sweep was skipped, or that the last sweep did not list, is re-read by id before it is handed to the agent
  or cited in an answer. Gone: dropped. Changed: the new copy. Could not be confirmed (an MCP "not found" that proves
  nothing, an error): not delivered; after an inconclusive "not found" the source's sweep runs at the next tick.
- **What it saves.** On the day bench (one user, 1,000 sources, items arriving all day), a whole week: background
  listings **1,114 → 282 a user a day**, all connector calls **1,847 → 996 a day (−46%)**, re-reads added **0**. On
  Zapier MCP that is **$47.66 → $25.69 a user a day** ($28.74 → $7.29 for the sweeps alone); on Composio $0.55 → $0.30.
  The bench's deliveries come from used sources, so it has no re-reads to count; what a user pays whose deliveries
  come from unused sources is the worst case below.
- **What it costs in safety: nothing measured.** With 10–30% of change notices lost, deleted items delivered or cited
  are **at or below** the daily sweep's in every arm, including the worst case where no source is ever "used" (every
  source swept weekly): there **0/0 at every loss rate**, against the daily sweep's 0/1, 6/5 and 8/12, with
  deletion-proving and MCP-style sources alike. Stale updates handed over are unchanged in share. The price of that
  worst case is re-reads: 2,301 by-id fetches for 1,096 fewer listings over 16 users × 20 sessions, so a user whose
  deliveries all come from sources Eden counts as unused pays more calls, not fewer. On the 1,000-source bench and on
  every 5-source screen no such re-read happened.
- **Nothing moves for a five-source user**: they use all their sources, so all stay on the daily sweep. The usual
  funnel (314/273), the 995-source funnel (77/69 and 76/64) and `bun run eval` are identical task by task.
- **The live check (D358).** Pi, train, seeds 41–42, one request at a time, payload notices, Eden's arm with 995 noise
  connectors: Eden raised **52/72 hidden facts against the agent alone's 5/72** (the same tasks with five sources:
  57/72), one regraded false concern in 72 control tasks and none in 72 neutral ones. But Eden made **38.9 connector
  calls a task** (the agent alone 3.5; five sources 0.0), almost all live searches of noise connectors whose synced
  copies the cap had cut (D264), and spent **2.3 s a task on the agent's critical path** (five sources: 17 ms), wall
  p50 6.0 s on hidden tasks against the agent alone's 4.7 s. On Zapier MCP that is $1,082 per 1,000 tasks against the agent alone's
  $90. At 1,000 sources the sweep was the background's bill; the request path's live searches are the bigger one.

## 1. The trial and its rule

`syncUnusedSweepMs` (D356; owner A21, opened and promoted the same day, no trials-table row, as D320–D323):

| Piece | Where | What |
| --- | --- | --- |
| The longer sweep | `Sync.step`, `onLongSweep` | Not used (`engage`, D320) and the source can find an item by ref (`Source.fetchesById`, new: true for an `McpSource` with a `fetchTool`, the sim's and static sources; absent, read as `fetchReportsGone`): swept every `syncUnusedSweepMs` (a week). Any other source keeps the daily sweep: its copies could not be confirmed. |
| Which copies are in doubt | `Sync.sweepLapsed`, `Sync.sweepMissed`, `ContextPartner.unswept` | A copy older than `syncSweepMs` of a source whose daily sweep the trial skipped (`skipped`, set at the tick where the daily rule would have swept an active user), or any copy the last complete sweep did not list, of a source that can find items by ref. |
| The re-read | `doubted` → `verifyItems` | The D126 path every delivery already takes (fast path hands doubted items to the slow path; plan conflicts wait); asks strict (D211). |
| Not confirmed | `verifyItems` | An unswept copy whose re-read is not `confirmed` or `changed` is left out (an ask names it: "no recent listing of their source confirms them and they could not be re-checked"); after a null `Sync.sweepSoon` makes its source's sweep due (an error or our own guard's skip does not: the next delivery re-reads it). A plan-conflict packet (D301) holding such a copy waits for a later take, at most until the weekly sweep. |
| Confirmed | `recheck` | Stored (its read time moves, so it is not re-read for a day) and `Sync.vouched` clears a sweep's miss. |

Two first forms were measured and changed before the numbers below:

- **Doubt by the source's last sweep alone** (any source whose last sweep was over a day old) re-read 27 copies of used
  sources after the 5-source user's 20-hour nights (`days-calls --night-h 20`, 0.091 → 0.203 request-time calls a
  request): an idle user's daily sweep waits for them with or without the trial. Only a sweep the trial skipped counts
  now: identical to the daily sweep there (0.091 and 0.897 a request).
- **Not doubting a copy the sweep missed once.** Under MCP-style sources the withheld copy's early sweep missed it
  once (two misses drop an item), and it was then cited: 10% lost, cited 1 → 3. Now a missed copy is doubted until a
  re-read or the second miss settles it: 0/0.

The reviewer's first pass (REQUEST_CHANGES) found that every `McpSource` has a `fetch` method, which answers null to
every ref with no call when no get tool is wired (every shipped connector preset): such a source would have gone weekly
and its older copies would have been withheld, an ask saying "left out" of items that exist. Hence `fetchesById`
(`unused-sweep.test.ts`: such a source stays daily and is cited). It also found the once-missed doubt applied to
sources whose re-read cannot confirm (withheld for nothing; now only sources that can find by ref), a single guard skip
starting a whole sweep (now only a null does), the isolation test using different source ids for the two users, and the
ask's reason for an unswept item ("their source reported changes", which it had not). All fixed; every figure below is
from the fixed code. The 5-source "D356" rows were identical before and after; the `--never-used` rows changed (no
early sweeps after errors: background 214 → 0, re-reads 1,857 → 2,301).

Engagement had to run whenever the trial is on (`engageSources` returned early unless cards or `syncEngagedDeep` were
on); a lookup engages before its delivery is verified, which is why "used now" cannot be the doubt's test.

## 2. Calls per user per day (`source-days.bench.ts 1000 N 10`)

One user, 1,000 sources (the workload's four and 996 noise), sources gaining items all day, a working day of requests
and asks; days 2–8 (a whole weekly cycle; the weekly sweeps all fall on day 8, as every source warmed together). The
bench's sources now have a counted `fetch` (an MCP get tool: a null proves nothing).

| Per user per day, days 2–8 | Sweeps and deep reads | On demand | Searches | Re-reads | All calls | Items listed | Card calls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 300 items a source, daily sweep | 1,114.1 | 229.7 | 503.6 | 0 | 1,847.4 | 114,129 | 223.7 |
| 300 items a source, D356 | 282.4 | 200.7 | 512.7 | 0 | 995.8 | 31,928 | 190.4 |
| 20 items a source, daily sweep | 1,060.4 | 151.1 | 427.4 | 0 | 1,638.9 | – | 99.9 |
| 20 items a source, D356 | 246.0 | 224.9 | 464.0 | 0 | 934.9 | – | 115.6 |

Day 8 at 300 items: 1,041 sweep listings (the week's sweeps). The bench varies a little run to run (an earlier run of
the same code before the review fixes, which do not act here: 283.6, 196.7, 500.3, 980.6). With 20-item sources
on-demand polls rise 151 → 225 a day: a daily sweep's first page also counted as a poll, so without it a lookup polls a stale source
itself. Priced on market.py's `CONNECTORS` (list prices, assumed), 300 items, all calls / sweeps alone:

| Plan ($ per 1,000 calls) | Daily sweep (1,847 calls) | D356 (996 calls) | Sweep listings alone (1,114 → 282) |
| --- | --- | --- | --- |
| First-party APIs (quota only) | $0 | $0 | $0 |
| Composio (overage, 0.30) | $0.55 | $0.30 | $0.33 → $0.08 |
| Unified.to (Pro, 0.75) | $1.39 | $0.75 | $0.84 → $0.21 |
| Arcade.dev (Team, 10) | $18.47 | $9.96 | $11.14 → $2.82 |
| Pipedream Connect (overage, 12) | $22.17 | $11.95 | $13.37 → $3.39 |
| Zapier MCP (10k tasks, 25.8) | $47.66 | $25.69 | $28.74 → $7.29 |

Five sources, real 24-hour days (`days-calls.ts --push payload --ask --night-h 20`, users 41–42, 232 requests, cards
replayed): identical with and without (request-time 0.091 a request, background 11.69 a user-day, 0 re-reads), since
the user uses all five.

## 3. Deleted and stale deliveries under lost notices

`quality-cli.ts --users 16 --sessions 20 --updates 0.6 --deletes 0.1 --jobs 4 --push payload --lost-notices L
--config '{"sync":true,…}'` (128 deletions applied, 213 updates, 2,428 turns). `--never-used` (new, lab only) makes
no source ever "used", so with D356 every source is swept weekly: the worst case. `--null-proves-nothing` makes the
sim sources fetch as MCP does. Deleted delivered / cited, stale / updated handed over, background listings, re-reads:

| Arm | 0% lost | 10% | 20% | 30% | Stale/updated at 30% | Background | Re-reads |
| --- | --- | --- | --- | --- | --- | --- | --- |
| daily sweep | 0/0 | 0/1 | 6/5 | 8/12 | 18/133 | 1,096 | 0 |
| D356 (all five used) | 0/0 | 0/0 | 0/2 | 2/5 | 18/132 | 1,094 | 0–9 |
| D356, `--never-used` | 0/0 | 0/0 | 0/0 | 0/0 | 16/157 | 0 | 2,301–2,330 |
| daily sweep, MCP fetch | 0/0 | 0/1 | 6/5 | 8/12 | 18/133 | 1,096 | 0 |
| D356, MCP fetch | 0/0 | 0/0 | 0/2 | 2/5 | 18/132 | 1,094–1,120 | 0–12 |
| D356, MCP fetch, `--never-used` | 0/0 | 0/0 | 0/0 | 0/0 | 16/156 | 0–79 | 2,199–2,301 |

The daily sweep with `--never-used` reads exactly as the daily sweep. "D356 (all five used)" improves on the daily
sweep because a copy the last sweep missed is now re-read before delivery (a few calls). Precision 0.410–0.430 and
recall 0.513–0.519 across all arms; recall at 30% lost 0.519 → 0.514 in the D356 rows comes from deleted items no
longer delivered. Stale share at 30%: 13.5% (daily), 13.6%, 10.2% (`--never-used`). With no source used, no sweep at
all ran in these users' days (under a week), so the background fell to 0 and every older copy was re-read on
delivery: ~0.95 re-reads a turn, more calls than the 1,096 listings saved. D356 pays only when unused sources' items
are the ones delivered.

## 4. Hidden facts (funnel)

| Screen | Daily sweep | D356 | Task by task |
| --- | --- | --- | --- |
| `bun run funnel --jobs 4` (train, 41–42, 5 sources) | 314/273 | 314/273 | 768 rows identical |
| `--noise-sources 995 --limit 16`, seed 41 | 77/69, 48.5 calls/task, 508 card calls | the same | 192 identical |
| the same, seed 42 | 76/64, 49.5 calls/task | the same | 192 identical |

(A13's own figures, 75/68 and 74/63, are from its tree before later merges.) The funnel is one simulated day, under
the week, so it checks only that nothing else moved. `bun run eval`: precision 0.5909, recall 0.52, falseFireRate 0,
as on the parent tip.

## 5. Live: the 1,000-source default on Pi (D357, D358)

`pi-ab --noise-sources 995` (new, D357) gives Eden's arms 995 noise connectors beside the world's five; the tools arm
keeps the world's sources as its agent's tools. Train1–6, `--limit 6`, hidden/control/neutral, seeds 41–42 (one
process each: two at once ran out of memory), `--push payload`, direct profile, time scale 1, the shipped default
(D356 included; one request at a time, so the weekly sweep never acts), Haiku in every role. `run.sh` in
`packages/sim/lab/a21/`. The 5-source eden arm ran the same tasks for reference.

| Arm | Hidden | Concerns control / neutral (regraded) | Mix $/1k tokens (steady) | Eden calls a task (+ bg) | Eden on the path | Wall p50 (mix) | Backfill a user |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tools (agent alone) | 5/72 | 0 / 0 | 0.387 | 0 (agent 3.49) | 0 | 4.70 s | – |
| eden, 1,000 sources | 52/72 | 1 / 0 (1 confirmed) | 0.794 | 38.85 (+3.05) | 2,258 ms | 6.45 s | 1,004 listings |
| eden, 5 sources | 57/72 | 2 / 0 (2 confirmed) | 0.452 | 0.00 | 17 ms | 3.52 s | 18 listings |

Paired 1,000 − 5 sources (bootstrap 95%): hidden −0.069 (−0.167..+0.028); mix $/1k +0.307 (+0.288..+0.327), all of it
cards for noise items (Eden's background $0.319 against $0.035 a 1k); connector calls +42.6 a task on the mix. Eden
1,000 − tools: hidden +0.653 (+0.542..+0.764), wall +0.62 s (+0.04..+1.23) on hidden tasks, +1.20 s (+0.64..+1.77) on
neutral ones. Eden's calls by kind of source, per task: noise connectors' searches 26.2–26.4, noise listings 5.7–6.1
(on-demand polls), the world's sources' searches 6.5–6.8 (gmail 3.5–3.7). Per user (a world, ~6 tasks an hour
apart): 1,004 listing calls once, then ~42 a task.

$ per 1,000 tasks with the connectors priced (`pi-cost-report.ts`, market.py; steady on the mix, connectors in the
task's window and the background while working; the one-time backfill is on top):

| Plan | tools | eden, 1,000 sources | eden, 5 sources |
| --- | --- | --- | --- |
| First-party APIs | 0.387 | 0.794 | 0.452 |
| Composio | 1.445 | 14.490 | 0.452 |
| Unified.to | 3.032 | 35.033 | 0.452 |
| Arcade.dev | 35.651 | 457.317 | 0.452 |
| Pipedream Connect | 42.703 | 548.622 | 0.452 |
| Zapier MCP | 91.368 | 1,178.624 | 0.452 |

Per user-day **[EST]**: at A8's 14.5 tasks a day, ~42 calls a task is ~610 request-time calls a user a day, beside the
day bench's ~980 (whose asks and requests are its own workload, not these tasks): the two instruments do not share a
workload, so they are not added.

## 6. What is left

- **Live searches of cut noise copies (D264) are now the bill at 1,000 sources** (26 a task live, 2.3 s on the path).
  A cut copy answers nothing for its source, so a lookup routed to it searches it live; the routing that picks noise
  sources (sketch and local-hit boosts, D322, D265) and the poll width (8) set how many. Levers to measure: a lower
  live-search width for sources with no evidence, or answering an unused source's cut copy locally with the sweep's
  sketch as the "maybe" signal. Hidden facts must be watched: D264 bought +15 of 96.
- **Cards for noise items** are 9x the 5-source background spend live ($0.319 against $0.035 per 1,000 tasks).
- **The weekly sweeps land together** (day 8: 1,047 listings) because the sources warmed together; spreading them
  (a per-source offset) would smooth a connector platform's rate limits. Not measured.
- **The worst case's re-reads.** A user whose deliveries come from sources Eden counts as unused pays a by-id fetch
  per delivered item a day (2,301 for 1,096 listings saved over 16 users); the 1,000-source bench never delivers from
  an unused source, so its figures carry no re-reads. The "used" set (64 most recent, on evidence)
  makes that rare at 1,000 sources; it is not measured on real users.
- **A get tool that keeps failing** (timeouts, an open breaker) leaves an unused source's older copies withheld from
  proactive deliveries until the weekly sweep: fail-closed (recall, never a stale copy), not measured. Calling
  `sweepSoon` on "failed" too would bound it at a day (the second review's low finding).
- **MCP connectors without a get tool** (every shipped preset today) keep the daily sweep: the saving needs the
  integrator to wire a fetch tool (`fetchTool`), which D126's re-reads want anyway.
- **One-day live check.** The weekly sweep never acted in the Pi run (one request at a time); its safety rests on
  quality-cli and the unit tests (`unused-sweep.test.ts`).

## Reproduce

```bash
unset BUN_OPTIONS
bun packages/engine/bench/source-days.bench.ts 1000 300 10 [--config='{"syncUnusedSweepMs":0}']   # and 1000 20 10
bun packages/sim/src/lab/days-calls.ts --seeds 41,42 --days 8 --cards .local/a21/cards-all.jsonl --ask --push payload \
  --night-h 20 [--set '{"syncUnusedSweepMs":0}']
bun packages/sim/src/quality-cli.ts --users 16 --sessions 20 --updates 0.6 --deletes 0.1 --jobs 4 --push payload \
  --lost-notices 0.1 [--never-used] [--null-proves-nothing] --config '{"sync":true,"syncUnusedSweepMs":0}'
bun run funnel --jobs 4 --json f5.json
bun run funnel --jobs 2 --suite train1,train2,train3,train4,train5,train6 --seeds 41 --json n995.json \
  -- --noise-sources 995 --limit 16
bun run eval
R=packages/sim/lab/a21/run.sh   # one seed at a time (memory)
$R a21-short-41 tools,eden --seeds 41 --limit 6 --variants hidden,control,neutral --noise-sources 995 --budget 0.6
$R a21-short5-41 eden --seeds 41 --limit 6 --variants hidden,control,neutral --budget 0.3        # and 42 for both
bun packages/sim/src/lab/pi-ab-report.ts .local/a21/runs/a21-short-4{1,2}.json
bun packages/sim/src/lab/pi-cost-report.ts .local/a21/runs/a21-short-4{1,2}.json
python3 -I packages/sim/lab/a8/pair.py n5=S/a21-short5-41:eden,S/a21-short5-42:eden \
  n1000=S/a21-short-41:eden,S/a21-short-42:eden tools=S/a21-short-41:tools,S/a21-short-42:tools \
  --pair n5,n1000 --pair tools,n1000                                            # S=.local/a21/runs
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results S/a21-short-41.json \
  --graders claude-haiku-5-5 --only-concerns --spend-ledger .local/a21/ledger.jsonl --spend-cap 1.5 \
  --spend-headroom 0.1 --run-label a21-regrade-41 --out S/regrade-41.json                     # each run
```

## Spend

| Run | $ |
| --- | --- |
| short, tools + eden, 1,000 sources, seed 41 / 42 | 0.1402 / 0.1471 |
| short, eden, 5 sources, seed 41 / 42 | 0.0608 / 0.0622 |
| regrades (concerns only) | 0.0003 |
| **Total** | **0.4105** |
