# N3: late packets, plan alerts at scale, earlier packets shortened, a late re-invitation to ask

Status: measured 2026-11-10, branch `claude/n3-long` (from `claude/lucid-hypatia-v9wqk5` at 3e10a6fe). Decisions
D515–D519. **No default changed and no product code changed:** three trials were opened, failed their rules and were
deleted with their code and tests (the code is in commit e1f9b213); plan alerts were measured at scale and stand.
**Spent: $3.72 Anthropic** (`packages/sim/lab/n3/spend.txt`), about $0.5 of Modal credits (estimate).
Train only (`heldout18` is unread and stays so). Paid calls: Anthropic only, the Modal Secret `HAIKU_API_KEY`,
`claude-haiku-5-5` in every role, `claude-sonnet-5-5` only to regrade, lab provider (D97): **Anthropic-direct lab
figures**. Caps: Anthropic $10, Modal $15.

## In plain words

- **Plan alerts work at scale (H2, D516).** When a fact arrives after the agent has answered, Eden's alert makes
  the agent bring it up later that day in **40% of cases (153 of 380) against 15% (62 of 420) without the alert and
  1% (8 of 891) for the agent alone**: paired **+26.9 points (+14.6..+39.1)** on 279 pairs from eight users.
  False alarms on look-alikes: Haiku graded 19 against 7; Sonnet confirmed **0 against 1**. The agent's bill rises
  8.8% on days where every request's fact arrives late (bound: 10%). No loss by the rule, so nothing was tuned. The
  run is partial: each shard stopped at its $0.30 cap with about half its days done (my cap was too low).
- **A wait for Eden's late finds does reach the agent, and is not worth its time (H1, D515, deleted).** With 1,000
  sources, waiting before the request that follows a tool result put a follow-up packet in front of the agent in 12
  of 216 tasks (0 without). None of those packets held the task's hidden fact; hidden facts moved +1.4 points
  (−4.2..+6.9); and the agent waited **+746 ms a task** (+621..+869; bound: 300 ms), most of what C4 saved. With
  five sources nothing runs behind an ask: 25 waits of 0 ms, no packet.
- **Shortening earlier packets loses the facts they carry (H3, D517, deleted).** Over a day the agent raises a
  hidden fact from a packet it was handed at an **earlier** request half the time (16 of 32). With every earlier
  packet shortened that fell to 2 of 33 and hidden facts fell **16.0 points** (−23.3..−8.1 by day); shortening only
  packets the answer had used: 9 of 34, −7.4 points (−15.1..+0.9). The saving was small: cache reads fell but the
  cache writes rose by two thirds as much (40-request days: −$0.0045 per 1,000 tasks for all, −$0.0115 for used, both
  intervals reaching zero by day; eight-day users: +$0.002 and −$0.002).
- **A re-invitation to ask late in the day is ignored (H4, D518, deleted).** From a day's fifth request on it was in
  the agent's context in 346 requests; the agent asked 16 times against 12 without it (of 568 requests each), and
  on 40-request days not once in either arm. Hidden facts from request five on: +1.3 points (bound: +3.0).
- **A finding about the lab (D519).** An arm that did nothing (the wait with five sources) still differed from its
  twin over two users' eight days: asks +0.060 a task and $ +0.015 per 1,000 tasks, both intervals excluding zero
  even with whole days resampled. A day's requests share one transcript; with two to four users, `--days` intervals
  are too narrow to act on alone.

## 0. Pre-registration (committed and pushed before any paid call)

### The four problems

1. **Follow-up packets never reach the agent live.** `askBehind`'s follow-up was taken in 0 of 432 tasks
   ([c4-ask-path.md](c4-ask-path.md)); B1's items found behind arrive after the agent's first model call
   ([b1-scale-path.md](b1-scale-path.md)). What was read before writing this: the lab's Pi harness
   (`transformContext` → `takePending`) and the proxy (`eden.pending()` in every request) **already** take what is
   queued before every model request, not only at a user message. The packet is missed because the request after
   an `ask_context` result starts as the result lands, before the reads behind have stored anything, and that
   request is usually the turn's last. So the lever is a wait at that take, not more takes.
2. **Late facts are raised in a later reply 7 of 16 times** ([a29-heldout17.md](a29-heldout17.md),
   [a9-ahead.md](a9-ahead.md), `planConflict`, D301), and M1's eight-seed run had no `--late` arm.
3. **Token gap over days:** +$0.026 per 1,000 tasks is earlier packets read back from the transcript
   ([a30-token-gap.md](a30-token-gap.md), D403); D336 keeps them because dropping them rewrote the cache and lost
   their facts.
4. **Asks stop after about four requests of a day** ([a17-long-quality.md](a17-long-quality.md)).

### Trials (D112: each a switch, off; promoted or deleted with its code and tests by the rule below)

|     | Switch                                                                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H1  | `takeSettleMs` (engine, 0 = off; trial value 1,500)                    | `ContextPartner.settled(session)`: resolves when the session's work behind (an ask's reads, the push's poll and cut searches) is done, or after `takeSettleMs`. The harness awaits it before a model request **that follows a tool result in the same turn**, then takes what is queued. No wait before a turn's first request or when nothing runs behind                                                                                                                                                   |
| H2  | none (measurement of `planConflict`, D301)                             | `--day 6 --late` on eight seeds                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| H3  | harness layouts `+compact`, `+compactUsed` (as `+ephemeral` was, D336) | An earlier request's packet is replaced in place, once, at the next request, by its short form (the envelope, one fixed line of Eden's, each item line cut to 72 characters). `+compact`: every packet. `+compactUsed`: only a packet whose words the agent's answer to that request repeated (two words of five letters or more that the request did not hold, or one token of four or more characters with a digit). A packet changes at most once, so from the next request on the prefix is stable again |
| H4  | `askReinvite` (engine, off)                                            | From a session's fifth request on, when the handed candidates do not settle the request's anchors (`settle.ts`, D316's test, whether or not `askNudgeDeep` finds more in the pool), the candidates' lead ends with a short line (`ASK_REINVITE`) in place of `ASK_NUDGE`. It invites an ask and says nothing against the candidates or the ask (D257, D335)                                                                                                                                                  |

H1 and H3 are built lab-first: the proxy and `@eden/client` get the behaviour only on promotion, in the same branch.

### Runs (Pi on Modal, `lab_fanout.py`, the M1 recipe: default config, `--tenant-prompt`, payload notices, direct

profile, time scale 1, replayed cards and intent for seeds 41–44, in-run for 45–48)

| Run                   | Shape                                                                                            | Arms                                                                    | Seeds |
| --------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ----- |
| `n3-late` (H2)        | `--day 6 --late`, hidden and control                                                             | `tools`, `eden`, `eden~minus-plans`                                     | 41–48 |
| `n3-days` (H3, H4)    | `--days 8`                                                                                       | `tools`, `eden`, `eden+compact`, `eden+compactUsed`, `eden+askReinvite` | 41–44 |
| `n3-long` (H3, H4)    | `--days 3 --day-size 40 --mix 1:1:3` (A17's stress days)                                         | `eden`, `eden+compact`, `eden+compactUsed`, `eden+askReinvite`          | 41–42 |
| `n3-settle` (H1)      | one request a session, `--noise-sources 995`, `--limit 6`, hidden, control, neutral (C4's shape) | `eden`, `eden~settle` (`takeSettleMs` 1,500)                            | 41–42 |
| `n3-settle-days` (H1) | `--days 8`, five sources                                                                         | `eden`, `eden~settle`                                                   | 41–42 |

At most two Anthropic shards at a time. Concerns (control and neutral answers Haiku graded as raising something,
and `--late` false alarms) are regraded by `claude-sonnet-5-5`; only confirmed ones count. Cost is reported on
market.py's connector plans (`pi-cost-report.ts`). Intervals: paired bootstrap 95%, 5,000 draws, clustered by
template where `bench_report.py` reads the shape, else by task with the user as the cluster for `--days`.

H1 short horizon is the 1,000-source shape because only there do reads run behind an ask (five sources fit the
sync cap: nothing is cut, C4 §3). H4 has no short-horizon run: with one request a session the switch cannot fire;
the funnel must be identical with it on (checked at $0). H3 has none either (one request: no earlier packet).

### Rules, fixed now

- **H1 `takeSettleMs`: promote** only if all hold on `n3-settle`: packets taken at a request after a tool result
  rise above the default's count; hidden facts paired ≥ 0.0 points; Sonnet-confirmed concerns up by at most 1.0
  point; Eden's time on the agent's path (the wait counted) up by less than 300 ms a task on the 1:1:8 mix; and on
  `n3-settle-days` hidden paired ≥ −2.0 points with wall not up by more than 0.2 s a task. **Else deleted.**
- **H2: a loss** is any of: late corrections (eden − minus-plans, hidden) with an interval that reaches 0;
  Sonnet-confirmed false alarms (control) up by more than 2.0 points; agent $ per task up by more than 10%.
  With no loss nothing is tuned. With a loss, one tuning trial is named in a decision and not run here unless the
  caps allow a fresh pre-registered pair.
- **H3: promote one layout** (into the proxy's `keepPackets` and `withContext`'s guidance) only if, for that
  layout: agent $/1k paired below zero with its interval below zero on `n3-long` and not above zero on `n3-days`;
  hidden facts paired ≥ −2.0 points pooled over both runs; and facts raised from a packet handed at an earlier
  request not lower by more than 2 tasks pooled. If both pass, the one with the larger saving. **Else both deleted.**
- **H4 `askReinvite`: promote** only if, pooled over `n3-days` and `n3-long`: hidden facts at requests 5 onward
  paired ≥ +3.0 points and all hidden ≥ 0.0; asks a task at requests 5 onward up; Sonnet-confirmed concerns up by at
  most 1.0 point; agent $/1k up by at most $0.010. **Else deleted.**
- A promoted switch needs `bun run check` green, `bun run eval` at 0.65 / 0.52 / 0 and the funnel at 314 / 274.
- No arm, seed, metric or threshold above changes after the first paid call; anything added later is labelled
  exploratory.

**Amendment before any measured run (2026-11-10).** A ten-request local smoke of the harness (`n3-smoke`,
`n3-smoke2`, $0.026, counted in the spend) showed the first build of `+compact` re-writing the whole day to the
cache on every request (cache writes 6.1k → 14.3k tokens): pi-ai's only moving cache entry ends at the last
message, after the request's full packet, so it never matches once that packet is shortened. Both compact layouts
therefore also put a cache breakpoint on the last assistant message before the request (`priorTurnBreakpoint`), as
`+ephemeralBp` did on the user turn (D336). No arm, seed, metric or threshold changed.

## 1. What was built, and deleted

All four ran from commit e1f9b213 (the Modal image is built from the commit).

- `takeSettleMs` (engine) and `ContextPartner.settled(ref)`: a bounded wait on `Session.behind`. The Pi harness
  awaited it in `transformContext` when the last message was a tool result, as an `eden.settle` span on the path.
- `+compact`, `+compactUsed` (`packet-layout.ts`: `compactPacket`, `packetUsed`, `keptForm`,
  `priorTurnBreakpoint`), applied when a request's packets join the day's transcript.
- `askReinvite` (engine): `ASK_REINVITE` in the candidates' lead from `Session.requests` ≥ 5, on D316's test.

Each had unit tests (engine 1,154 passing with them). After the rules below, all of it was removed: the tree's
`packages/*/src` is the base's. What stays is the analysis in `packages/sim/lab/n3/` (D519).

## 2. H2: plan alerts at scale (`n3-late`)

`--day 6 --late`, train, seeds 41–48, `tools`, `eden`, `eden~minus-plans`; 384 tasks an arm a seed. **Partial:** I
set $0.30 a shard and a whole shard costs about $0.48, so each stopped with its later days unanswered (516–563 of
1,152 results a shard are cap errors). Counted here: a planted request that was answered and whose every later
reply that day was made (`late.py`); the rest are left out (eden 1,757, minus-plans 1,671, tools 1,106 results).
The cut falls on the later days of each suite's stream in every arm; pairs need both arms whole.

| Arm                | Hidden: raised later | Control: raised later (Haiku) | Sonnet-confirmed | Plan packets | Agent $/1k tasks |
| ------------------ | -------------------- | ----------------------------- | ---------------- | ------------ | ---------------- |
| `eden`             | 153 / 380            | 19 / 391                      | 0                | 1,107        | 0.2537           |
| `eden~minus-plans` | 62 / 420             | 7 / 478                       | 1                | 0            | 0.2323           |
| `tools`            | 8 / 891              | 7 / 900                       | 0                | 0            | 0.2093           |

Paired, template-clustered (`late.txt`, `late-sonnet.txt`):

- eden − minus-plans, late corrections: **+26.9 points (+14.6..+39.1)**, n 279, 74 templates (task-level
  +20.1..+33.7). A9 measured +35.1 (+25.2..+45.0) on two seeds.
- false alarms: +3.3 points (+0.3..+6.8) as Haiku graded; Sonnet regraded every reply Haiku called an alarm (33)
  and confirmed 1, in the minus-plans arm: **−0.3 points (−1.1..0.0)**.
- agent $ a task: +$0.0204 per 1,000 (+0.0113..+0.0289), **+8.8%**. Against `tools`: corrections +40.8 points
  (+30.9..+50.9), $ +17.7% (on these days every request's fact arrives late).

**Rule:** interval above zero, confirmed false alarms not up, cost under +10%: **no loss, nothing tuned (D516).**
The cost clause passed narrowly, and 60% of late facts are still not raised: the lever left is uptake of the alert,
not its trigger (1,107 packets were taken).

## 3. H1: a wait for the work behind (`n3-settle`, `n3-settle-days`)

1,000 sources, train, seeds 41–42, 216 tasks an arm (`settle-995.txt`, `a8/pair.py`):

| Arm           | Hidden  | Asks | Waits (tasks) | ms a wait | Packets taken after a task's first request | `ask-behind` packets | Eden on the path, mix | Wall, mix |
| ------------- | ------- | ---- | ------------- | --------- | ------------------------------------------ | -------------------- | --------------------- | --------- |
| `eden`        | 40 / 72 | 158  | 0             | –         | 12                                         | 0                    | 94 ms                 | 2.53 s    |
| `eden~settle` | 41 / 72 | 150  | 110 (109)     | 1,211     | 24                                         | 14 (in 12 tasks)     | 840 ms                | 3.26 s    |

Paired: hidden +1.4 points (−4.2..+6.9); Eden on the path **+746 ms** (+621..+869) on the 1:1:8 mix; wall +722 ms
(+499..+938); mix $/1k −0.020 (−0.042..+0.003); connector calls −0.92 (−3.24..+1.29). Concerns: Haiku 2 against 1,
Sonnet-confirmed 1 against 0 of 144. The 12 tasks with a follow-up: 4 hidden, 2 control, 6 neutral; in none did
the packets cite the planted item, and none of the 4 hidden ones was raised. Connector plans (mix, steady, $ per
1,000 tasks): Composio 13.08 → 12.73, Zapier MCP 1,082.6 → 1,059.5 (`cost-settle-995.txt`).

Five sources, `--days 8`, users 41–42 (`settle-days.txt`): 25 waits of 0.0 ms, no packet taken after a first
request in either arm: inert, as C4 §3 predicted.

**Rule:** packets taken rose (0 → 14) and hidden is not worse, but the path grew by 746 ms against a bound of 300:
**deleted (D515).** The follow-up is still plumbing that carries nothing the agent lacks: what the reads behind
find that matters has been handed by the push. The proxy and `withContext` were not changed (they already take
what is queued on every request).

## 4. H3: earlier packets shortened (`n3-days`, `n3-long`)

Eight-day users 41–44 (480 tasks an arm) and 40-request days, users 41–42 (240). `days-8.txt`, `days-40.txt`,
`days-pooled.txt`, `tokens-8.txt`, `tokens-40.txt`, `day-cluster.txt`.

|                                                           | `eden`          | `+compact`                        | `+compactUsed`             |
| --------------------------------------------------------- | --------------- | --------------------------------- | -------------------------- |
| Hidden raised, pooled (n 94)                              | –               | −16.0 points (−23.3..−8.1 by day) | −7.4 (−15.1..+0.9)         |
| Raised from a packet handed at an earlier request, pooled | 16 / 32         | 2 / 33                            | 9 / 34                     |
| Raised from this request's packet, pooled                 | 39 / 48         | 39 / 48                           | 40 / 47                    |
| Agent $/1k, 40-request days                               | 0.2742          | −0.0045 (−0.0198..+0.0147 by day) | −0.0115 (−0.0277..+0.0086) |
| of it cache reads / writes                                | 0.1242 / 0.0647 | −0.0371 / +0.0239                 | −0.0278 / +0.0162          |
| Agent $/1k, eight-day users                               | 0.2350          | +0.0024 (−0.0152..+0.0175)        | −0.0015 (−0.0163..+0.0108) |
| Input tokens a task, eight-day users                      | –               | −1,933                            | −1,410                     |
| Concerns, Sonnet-confirmed (of 626)                       | 2               | 2                                 | 1                          |

Task-level, the `+compactUsed` saving on 40-request days excludes zero (−0.0183..−0.0045); by day it does not.

**Why the saving is small.** A shortened packet changes the prefix once, so the request after it re-writes that
packet, its request and the answer to the cache at 1.25x where the kept layout reads them at 0.1x. Even with a
breakpoint before the request (without it the whole day was re-written, see the amendment), two thirds of the read
saving goes back out as writes.

**Why the facts go.** The ledger does not hand an item twice in a session (D13), so a fact that bears on a later
request is in the transcript only where its packet stands; cut to 72 characters it is a title. `+compactUsed`
keeps unused packets and still loses 7 of the 16: a fact the agent mentioned once is needed again.

**Rule:** hidden pooled ≥ −2.0 points and earlier-packet facts within 2 tasks: both layouts fail both;
`+compact` also fails the saving. **Both deleted (D517).** D336 stands: packets stay in place, whole.

## 5. H4: a re-invitation to ask (`n3-days`, `n3-long`)

`reinvite.txt`, `days-pooled.txt`:

| From request 5 on                                                     | `eden`   | `eden+askReinvite`        |
| --------------------------------------------------------------------- | -------- | ------------------------- |
| Eight-day users: asks / requests                                      | 12 / 352 | 16 / 352                  |
| 40-request days: asks / requests                                      | 0 / 216  | 0 / 216                   |
| Requests with the invitation in context (the default: with the nudge) | 147      | 346                       |
| Hidden raised, paired (n 79)                                          | –        | +1.3 points (−7.6..+10.1) |

All hidden +2.1 points (−5.6..+8.5 by day), agent $/1k +0.0005, concerns Sonnet-confirmed 2 against 1 of 626. The
default's own nudge is in context 147 times from request five on and gets 12 asks; in the first four requests the
agent asks 0.27 times a request (41 of 152).

**Rule:** hidden from request five on ≥ +3.0 points and asks up: neither. **Deleted (D518).** By then the
transcript shows the agent answering from packets alone, and one more line of Eden's does not change that habit.
What carries the later requests is the packet and the earlier packets (section 4), so the place to gain is what
the push hands, not the ask.

## 6. Day-level noise (D519)

`eden~settle` with five sources is the default with a 0 ms wait that took no packet. Paired against `eden` over two
users' sixteen days (232 tasks): asks +0.060 a task (by day +0.009..+0.129; by task +0.030..+0.095), agent $/1k
+0.0152 (+0.0032..+0.0293 by day), hidden +8.7 points (0.0..+20.0). So over days an arm can differ from its twin
by this much with nothing changed. `day-cluster.py` resamples whole days; its intervals are 1.5–3 times wider
than the task-level ones for $ and asks, and still too narrow with two users. No decision above rests on a
difference of that size: the trials fail on effects several times larger, or on missing their bound.

## 7. What is left

- **Uptake of plan alerts** (60% of late facts not raised with the alert taken). Not tuned here: the rule found
  no loss. A trial would change the alert's wording or repeat it once, and needs `--late` with a cap of $0.55 a
  shard.
- **The token gap over days** is not closed by layout. What remains is the packet's own size (D258, D259, D273
  measured its cuts) or fewer packets on requests that need none.
- **The follow-up packet** stays as correctness plumbing (C4); no lever was found that makes it carry a fact.

## 8. Final tree

`packages/*/src` is identical to the base (3e10a6fe): `git diff 3e10a6fe -- packages` shows only
`packages/sim/lab/n3/` and three `CLAUDE.md` notes. On it, 2026-11-10: `bun run check` green (2,517 tests);
`bun run eval` precision 0.65, recall 0.52, falseFireRate 0; `bun run funnel --jobs 4` hidden 314/384, decoys
274/384. The reviewer subagent was not run: no engine, client or proxy source differs from the base. Not done: the
$0 funnel check of `askReinvite` named in section 0 (the switch was deleted on its live result; with one request a
session `Session.requests` never reaches 5, which its unit test covered).

## Reproduce

```bash
python3 -m venv .venv-modal && .venv-modal/bin/pip install 'modal[api-proxy-support]==1.6.3'
export SSL_CERT_FILE=/root/.ccr/ca-bundle.crt EDEN_COMMIT=e1f9b213
F="modal run packages/sim/modal/lab_fanout.py --preset bench-tools"
$F --seeds 41-48 --cap 2.4 --run n3-late --args '--conditions tools,eden,eden~minus-plans \
  --variant-config {\"minus-plans\":{\"planConflict\":false}} --day 6 --late'      # a whole run needs --cap 4.4
$F --seeds 41-44 --cap 1.6 --run n3-days --max-streams 10 \
  --args '--conditions tools,eden,eden+compact,eden+compactUsed,eden+askReinvite --days 8'
$F --seeds 41-42 --cap 1.0 --run n3-long --max-streams 8 --args '--conditions \
  eden,eden+compact,eden+compactUsed,eden+askReinvite --days 3 --day-size 40 --mix 1:1:3'
V='--variant-config {\"settle\":{\"takeSettleMs\":1500}}'
$F --seeds 41-42 --cap 0.4 --run n3-settle-days --max-streams 4 --args "--conditions eden,eden~settle $V --days 8"
$F --seeds 41-42 --cap 1.2 --run n3-settle --max-streams 36 --suites train1,train2,train3,train4,train5,train6 \
  --suites-per-shard 3 --args "--conditions eden,eden~settle $V --noise-sources 995 --limit 6 \
  --variants hidden,control,neutral"
N=packages/sim/lab/n3; S() { $N/stems.sh "$1" | tr '\n' ' '; }      # shard outputs as STEM.json / STEM.tl
python3 -I $N/late.py eden 'eden~minus-plans,tools' $(S n3-late)
for s in 41 42 43 44 45 46 47 48; do python3 -I $N/late-copy.py .local/n3/runs/n3-late-train-$s.json copy-$s.json; done
#   then regrade.ts --results copy-$s.json --graders claude-sonnet-5-5 --only-concerns --out R/n3-late-train-$s.json
python3 -I $N/late.py --sonnet R eden 'eden~minus-plans,tools' $(S n3-late)
P="--pair eden,eden+compact --pair eden,eden+compactUsed --pair eden,eden+askReinvite"
python3 -I packages/sim/lab/a17/days.py $P $(S n3-days) $(S n3-long)
python3 -I $N/tokens.py eden $(S n3-long); python3 -I $N/settle.py $(S n3-settle)
python3 -I $N/day-cluster.py eden,eden+compact eden,eden+compactUsed eden,eden+askReinvite -- $(S n3-days) $(S n3-long)
```

`reinvite.txt`, `concerns.txt` and the mix lines of `settle-995.txt` came from one-off scripts over the same files
(not kept); the pre-registered seeds, arms and rules are section 0.
