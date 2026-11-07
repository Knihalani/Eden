# B1: Eden at 1,000 sources, part 6 (the push stops waiting on live searches)

Status: measured 2026-11-07 on branch `claude/b1-scale-path` (from `main` at 0fbd9f73, PR #232), A28's next step
([a28-scale.md](a28-scale.md), D391). Decisions D405–D407. Paid calls: Anthropic API only, `HAIKU_API_KEY`,
`claude-haiku-5-5` in every role, `claude-sonnet-5-5` for the concern regrade, lab provider (D97),
`OPENROUTER_API_KEY` unset, own ledger (`.local/b1/ledger.jsonl`, hard cap $1.5): **Anthropic-direct lab figures**.
**Spent: $0.3756.** Every other figure is a $0 run. Machine: 4 vCPU, 15 GiB, Bun 1.4.4. Summaries of every run are in
`packages/sim/lab/b1/`.

## In plain words

- **The problem.** At ~1,000 connected sources Eden spent ~2.2 s of every task on the agent's path (5 sources:
  ~17 ms). A28 showed why: the push (what Eden injects when the user sends a request) waited for live searches of
  synced copies that the user's item cap had cut (D264 searches such a copy live, so older items are still found).
  Each of those is a connector round trip, and the push waited for the slowest.
- **What changed (D405, promoted by D406: on in the default).** The push no longer waits. It answers a cut copy from
  what Eden already holds, starts the same live search in the background (same query, same query planner, same
  deadline), and when that search stores something new, the push's existing follow-ups run on the refreshed index:
  the lookup's follow-up (`afterPoll`) and the push's second reading (`readerPushBehind`), which replaces a packet
  the agent has not taken yet. The agent gets the result at its next take, re-checked like any delivery. An explicit
  `ask_context` is unchanged: it still searches a cut copy live.
- **What it did, live (Pi, train, seeds 41–42, 216 tasks an arm, paired):**
  - **The push: 1,154 → 39 ms a task.** Eden's whole time on the agent's path: **2,603 → 1,582 ms a task**
    (paired −1,021 ms, −1,146..−895). What is left is the agent's own asks (~1.5 s), which keep D264.
  - **Hidden facts raised: 45/72 → 51/72** (paired +0.083, +0.014..+0.167). Not worse; better, because the agent's
    first model turn starts ~1.1 s sooner with the packet from what is held and the rest follows.
  - **Connector calls not up:** on the 1:1:8 mix 44.8 → 43.6 a task (paired −1.2, −3.4..+1.0); hidden tasks +3.2
    (a background find triggers the follow-up's on-demand poll), control and neutral fewer.
  - **Cost down:** $0.819 → $0.734 per 1,000 tasks on the mix (first-party connectors; the agent's own tokens, as the
    agent waits less); on Zapier MCP $1,233 → $1,203.
  - **False concerns, Sonnet-regraded:** control 1 → 0, neutral 0 → 0 confirmed.
- **At $0** (funnel, 995 noise sources): hidden 77 → 77 (seed 41) and 76 → 77 (seed 42), decoys 69 → 69 and 64 → 64,
  connector calls a task flat. With connector latency (`--time 1`, train1–3): the observe 657 → 21 ms p50, the push
  704 → 13 ms p50, the same 33 hidden items delivered, 2 of them now after the agent's first model call (next take)
  rather than before it. With five sources nothing changes (no copy is cut): the usual funnel 314/273 and `bun run eval`
  (0.65/0.52/0) are as on main.
- **The CPU and memory A28 saw are mostly the lab (D407).** pi-ab runs every world of a seed at once (6 suites ×
  3 variants = 18 streams in one process), and each stream builds its own 995 simulated noise connectors: 995 of them
  alone hold **495 MB of heap (705 MB RSS)**, measured. 18 of them are ~9 GB of A28's 10.1–10.6 GB heap. One Eden
  user with 1,000 sources is not a 10 GB process.

## 1. The change

`pushCutBehind` (D405), in `searchLive`, only on a lookup that does not wait for its poll (`behind`: the push's slow
path and its reader/candidates pass under `syncPollBehind`, `syncOnDemand`): `localOf` admits every warm copy, cut or
whole, and collects the cut ones. The routed sources among them answer the lookup from the index; `searchCutBehind`
sends the live search D264 would have waited for, through the planner's cascade (`PlannedSource`, the lookup's
`SharedCalls`, its deadline), stores what it returns (`store`, the lookup's read mark), traces its calls when it
settles ("cut search behind", so traces still sum to what the connectors received), and joins `cue.polled`: if it
stored anything new, `afterPoll` and `pushAgain` run once more on the index it refreshed. A follow-up (`cue.followUp`)
starts no second search. The probes keep D264 (they search a cut copy live and are not waited for, `probeGraceMs` 0).
An explicit ask never passes `behind`, so D127 (an ask answers only from a current, whole copy) and D264 stand there.

The first build sent the background search with the raw query, not through the planner: the planted ISA statement in
train1 came back empty (the planner's shapes find what the request's words alone miss) and the funnel lost one hidden
fact and two decoys. Sent through the planner, the funnel is identical task by task to the default on seed 41.

Unit test: `push-cut-behind.test.ts` (4 sources, every copy cut, searches of 300 ms): off, the observe waits ≥ 270 ms;
on, under 150 ms; the old fact is still stored and delivered, connector searches not more, the background calls
traced, and an ask still finds the fact.

## 2. $0 screens

`bun run funnel --jobs 2 --suite train1..6 -- --noise-sources 995 --limit 16` (time 0):

| Seed | Arm             | Hidden | Decoys | Calls a task (2 shards) | Against default            |
| ---- | --------------- | ------ | ------ | ----------------------- | -------------------------- |
| 41   | default         | 77/96  | 69/96  | 49.8 · 47.2             | –                          |
| 41   | `pushCutBehind` | 77/96  | 69/96  | 49.5 · 46.2             | +0 −0, decoys +0 −0        |
| 42   | default         | 76/96  | 64/96  | 51.1 · 47.6             | –                          |
| 42   | `pushCutBehind` | 77/96  | 64/96  | 50.6 · 46.7             | hidden +1 −0, decoys +0 −0 |

The defaults match A21's baselines (77/69, 76/64).

Latency, `-- --noise-sources 995 --limit 16 --time 1 --source-profile direct.json --push payload --timeline`, seed
41, `latency-report.ts` on train1–3 (the trial's six-suite run was killed by the OOM killer in train4 while two
funnels and a Pi run shared the box; the default's run finished):

| Arm             | observe p50 / p90 / p99 ms | push p50 / p90 / p99 ms | ask p50 / p90 ms |
| --------------- | -------------------------- | ----------------------- | ---------------- |
| default         | 657 / 1,510 / 1,521        | 704 / 1,505 / 1,524     | 1,332 / 1,509    |
| `pushCutBehind` | 21 / 39 / 85               | 13 / 29 / 73            | 1,428 / 1,510    |

Rerun of the trial on train1–3 alone (`--json`, no timeline), against the default's six-suite run's train1–3 tasks:
hidden delivered 33 → 33 and control decoys 33 → 33 of 48; delivered before the agent's first model call 33 → 31
(two arrive at the next take); ask-cited 37 → 37 (hidden); funnel ms a task p50 1,131 → 26.

## 3. Live: Pi, train, seeds 41–42 (one arm per process)

`pi-ab --noise-sources 995`, train1–6 split in halves (train1–3, train4–6: one arm and half a seed per process, ~7.7 GB
RSS), `--limit 6`, hidden/control/neutral, `--push payload`, direct profile, time scale 1, the shipped default against
the default with `pushCutBehind` on, Haiku in every role, cards replayed. 216 tasks an arm, paired by task
(`a8/pair.py`, `b1/path-pair.py`).

| Arm             | Hidden | Concerns control / neutral (Sonnet-regraded) | Eden calls a task (mix) | Push (observe) | Eden on the path | Mix $/1k first-party | Mix $/1k Zapier MCP |
| --------------- | ------ | -------------------------------------------- | ----------------------- | -------------- | ---------------- | -------------------- | ------------------- |
| default         | 45/72  | 2 / 1 (1 / 0)                                | 44.77                   | 1,154 ms       | 2,603 ms         | 0.819                | 1,233.44            |
| `pushCutBehind` | 51/72  | 1 / 1 (0 / 0)                                | 43.57                   | 39 ms          | 1,582 ms         | 0.734                | 1,202.81            |

Paired, trial − default (bootstrap 95%): hidden +0.083 (+0.014..+0.167); control −0.014 (−0.069..+0.028); neutral
+0.000; connector calls on the mix −1.19 (−3.41..+0.98), hidden +3.18 (+0.78..+5.88); mix $/1k −0.085
(−0.108..−0.062); Eden's path −1,021 ms (−1,146..−895). Per-run reports: `pi-base-*.txt`, `pi-cut-*.txt`.
"Eden on the path" here sums Eden's spans on the path lane (observe and each `ask_context`) per task; pi-ab-report's
own column for seed 41's first half reads 2,241 → 1,242 ms. The agent's wall p50 fell 6.00 → 5.03 s
(`pi-cost-*.txt`). Priced on market.py's connector plans (list prices, assumed), mix steady, $ per 1,000 tasks:

| Plan              | default  | `pushCutBehind` |
| ----------------- | -------- | --------------- |
| First-party APIs  | 0.819    | 0.734           |
| Composio          | 15.15    | 14.71           |
| Unified.to        | 36.65    | 35.68           |
| Arcade.dev        | 478.58   | 466.66          |
| Pipedream Connect | 574.13   | 559.84          |
| Zapier MCP        | 1,233.44 | 1,202.81        |

## 4. What is left

- **Trace sums (review).** With `probeGraceMs` 0 a lookup's trace counts its probes' calls before they settle, so a
  probe that joins another call in flight is counted by both lookups (on main too; with the switch on, the cut
  sources' probes now overlap the background search more often): in a 4-source unit probe traces summed 16 against 12
  connector calls off, 20 against 8–12 on. Every call figure above counts calls at the connectors (the funnel's
  "connectors received", Pi's `eden.source` spans), not traces; the funnel's cross-check matched exactly in both arms
  at time 0. Counting probe calls as they settle is a follow-up.

- **The ask.** The agent's `ask_context` still waits on D264's live searches and its poll (~1.5 s a task here). An ask
  that waited on the push's own background search instead of searching again would need D127's "local" status to
  stay honest for a copy searched with another query; not built.
- **The lab's memory.** pi-ab could share one set of noise connectors per seed across its streams (they are a pure
  function of world and seed) to run a whole seed per process again.

## Reproduce

```bash
unset BUN_OPTIONS
F="bun run funnel --jobs 2 --suite train1,train2,train3,train4,train5,train6"
$F --seeds 41 --json n995-41.json -- --noise-sources 995 --limit 16     # and 42
$F --seeds 41 --set '{"pushCutBehind":false}' --baseline n995-41.json -- --noise-sources 995 --limit 16
P=packages/sim/lab/before-after/market-profiles/direct.json
bun run funnel --suite train1,train2,train3,train4,train5,train6 --seeds 41 --jobs 1 --set '{}' --json t1.json \
  -- --noise-sources 995 --limit 16 --time 1 --source-profile $P --push payload --timeline t1.jsonl
bun packages/sim/src/lab/latency-report.ts t1.jsonl
R=packages/sim/lab/b1/run.sh; C="--limit 6 --variants hidden,control,neutral --noise-sources 995 --budget 0.3"
SUITE=train1,train2,train3 $R b1-base-41a eden~off --seeds 41 $C --variant-config '{"off":{"pushCutBehind":false}}'
SUITE=train1,train2,train3 $R b1-cut-41a eden --seeds 41 $C
# and 41b (train4,5,6), 42a, 42b; then
S=.local/b1/runs
python3 -I packages/sim/lab/a8/pair.py base=$S/b1-base-41a:eden,... cut=$S/b1-cut-41a:eden~cut,... --pair base,cut
python3 -I packages/sim/lab/b1/path-pair.py base=$S/b1-base-41a,... cut=$S/b1-cut-41a,...
bun packages/sim/src/lab/pi-cost-report.ts $S/b1-base-41a.json ...   # and cut
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results $S/b1-cut-41a.json --graders claude-sonnet-5-5 \
  --only-concerns --spend-ledger .local/b1/ledger.jsonl --spend-cap 1.5 --spend-headroom 0.1 --out $S/regrade.json
```

The runs above were made before the promotion, as `eden` (switch off, the default then) and `eden~cut` (switch on);
after D406 the same pair is `eden~off` and `eden`, as written above.

## Spend

| Run                                     | $                                 |
| --------------------------------------- | --------------------------------- |
| default, seed 41 (halves) / 42 (halves) | 0.0431 + 0.0503 / 0.0441 + 0.0542 |
| `pushCutBehind`, seed 41 / 42           | 0.0414 + 0.0447 / 0.0394 + 0.0516 |
| Sonnet regrades (concerns only)         | 0.0070                            |
| **Total (ledger)**                      | **0.3756**                        |
