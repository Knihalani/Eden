# N4: a stronger agent, and a new user's first minutes

Status: 2026-11-10, session N4, finished. Decisions D520–D524. Every paid call went to the Anthropic API with
`HAIKU_API_KEY` through the lab provider (D97): **Anthropic-direct lab figures**, not the OpenRouter route the servers
ship. Train only (seeds 41–48); heldout18 stays unread. Spend: **$11.63 Anthropic** of $20, **$0 Modal** of $15.

## In plain words

- **Eden helps a stronger agent as much as a weaker one.** With Sonnet 5.5 as the agent, the hidden fact is raised
  in 80% of tasks with Eden against 15% with search tools alone (pooled +65 points, +54..+75, 100 pairs); with Opus
  5.5, 75% against 0% (+76, +64..+88, 50 pairs); Haiku 5.5 on the same tasks, 65% against 4% (+60, +49..+70). A
  stronger agent does search more on its own (Sonnet makes 5.5 search calls a task against Haiku's 1.8) and finds a few
  more of the facts, but most of them are things the request never names, and more searching does not reach those.
  No false concern survived a Sonnet regrade in Eden's arm for any agent.
- **What the packet costs a stronger agent.** The packet is the same ~500 tokens written to the agent's prompt cache
  whatever the model; the price of those tokens scales with the model. Per 1,000 tasks, one request a session, with
  connector calls free: **Sonnet +$0.41 on $9.03 (+4.5%)**, **Opus +$2.41 on $13.73 (+17.5%)**, Haiku +$0.06 on $0.23
  (+28%). Sonnet gets most of the packet's price back because with Eden it makes fewer search rounds (5.6 → 1.7 tool
  calls a task) and writes less. Over a user's day the earlier packets are read back from the cache on every later
  request: +$1.79 (Sonnet, +20%) and +$5.71 (Opus, +41%) per 1,000 tasks, on one day and 16–32 tasks an arm. On
  every per-call connector plan the Eden arm is cheaper in steady state (Sonnet: −$1.27 on Composio to −$143 on
  Zapier MCP per 1,000 tasks). Eden's arm is 1.2–2.5 s faster a task, one request a session.
- **A new user's first minutes: read the backfill four calls at a time (`cardsLanes` 4, now in the default).** The
  card model read one batch of 20 items at a time for a user, about sixteen calls end to end (roughly 1.5 to 2
  minutes at the 5–8 s a call measured). Requests arriving in that window meet cards for only part of the items.
  Sending the batches that are already waiting four at once costs the same calls and reads the backfill in a
  quarter of the time. At the moment one lane has made four calls, four lanes raised **60.4% of hidden facts against
  56.0% (+4.3 points pooled, +1.0..+7.8, 784 pairs, fresh users, seeds 45–48, every card made in-run)**, with no
  confirmed false concern in either arm; two lanes +2.4 (−0.8..+5.7), not enough. 60.4% is what F2 read with every
  card made, so what was left of the gap after `cardsOrder` is closed at that moment.
- **The cheap distilled card model does not help a new user.** Its cards are as good as Haiku's, but cards alone
  for the items the card model has not reached add +1 hidden task of 384 at every point of the backfill (the
  teacher's own cards standing in for it, so this is the most it could add). What a new user is missing is the
  intent requests, which the distilled model writes badly (M2). The endpoint was not deployed.

## 0. Pre-registration

Written before any main-run call. Three probe runs came first (`probe-sonnet`, `probe-opus`, `probe-opus2`: train,
seed 41, hidden, `--limit 1`, 12 task runs each; $0.40 in all) to learn whether the harness could run the models at
all and what a task costs: Sonnet 5.5 about $0.012 a task run, Opus 5.5 about $0.021. No rate from them is quoted
as a result.

### (A) Does Eden still help a stronger agent, and what does its packet cost there?

**Harness.** Pi (`pi-ab.ts`) through `packages/sim/lab/n4/run.sh`: `--config default`, `--tenant-prompt` (D271) in
every arm, `--push payload`, the market `direct` source profile, time scale 1, cards replayed from the three
checked-in files, intent requests replayed (D158). Arms `tools` (the agent with one search tool a source) and `eden`.
**Only the agent's model changes**: `claude-sonnet-5-5`, `claude-opus-5-5`, and `claude-haiku-5-5` on the same tasks
as the reference. Eden's card model, its reader and the grader stay `claude-haiku-5-5`; every concern on a control
task is regraded by `claude-sonnet-5-5` (`regrade.ts --only-concerns`).

**Thinking.** Haiku runs with thinking disabled; Sonnet 5.5 refuses "disabled" and runs `between_tools` (A2). Opus
5.5 refuses both (probed) and runs `adaptive` at effort `low`, the nearest setting it accepts: an Opus row is an
agent that may think, and is labelled so.

**Prices.** Agent cost is each request's own usage priced per token class: Sonnet 5.5 $2/$10 and Opus 5.5 $4/$20 a
million tokens, cache writes 1.25x input, **cache reads 0.05x** on both (the session's brief; not re-read from the
API reference here); Haiku 5.5 $0.10/$0.50, reads 0.1x.

**Runs** (one seed a process, two processes at a time; each with a hard `--budget`):

| Run | Agent | Seeds | Shape | Task runs | Budget a process |
| --- | --- | --- | --- | --- | --- |
| `a-sonnet-short-S` | Sonnet 5.5 | 41–44 | `--variants hidden,control --limit 4` | 4 × 96 | $1.35 |
| `a-opus-short-S` | Opus 5.5 | 41–44 | `--variants hidden,control --limit 2` | 4 × 48 | $1.15 |
| `a-haiku-short-S` | Haiku 5.5 | 41–44 | `--variants hidden,control --limit 4` | 4 × 96 | $0.10 |
| `a-sonnet-long-S` | Sonnet 5.5 | 41, 42 | `--days 1 --day-size 16` | 2 × 2 arms × a day | $0.80 |
| `a-opus-long-41` | Opus 5.5 | 41 | `--days 1 --day-size 16` | 2 arms × a day | $1.30 |
| `a-haiku-long-S` | Haiku 5.5 | 41, 42 | `--days 1 --day-size 16` | 2 × 2 arms × a day | $0.10 |

`--limit N` takes each suite's first N templates, so Opus's tasks are a subset of Sonnet's and Haiku's. The task
counts are set by the $20 cap, not by a power calculation: 96 hidden pairs for Sonnet and 48 for Opus see an effect
the size Haiku shows (about +60 points) and cannot see a few points. The long runs are one day a user: they are
there for the cost of a session whose earlier packets are read back from the cache, and their hidden counts are too
small to carry a quality claim on their own.

**What is read, and the rules.**

1. **Hidden facts**: `eden` − `tools`, paired task by task, short and long pooled (`cl4/pooled.py`, 95% interval).
   "Eden still helps this agent" if the interval's lower bound is above 0. Reported beside the Haiku agent's effect
   on the same tasks and beside the `tools` arm's own rate (how much better the stronger agent searches alone).
2. **False concerns**: control concerns after the Sonnet regrade, both arms. "Not worse" if `eden` raises at most
   one more than `tools` per agent.
3. **Cost**: $ per 1,000 tasks, agent + Eden's per-task calls + grader excluded, `eden` − `tools`, with connector
   calls free and on the per-call plans A8 priced (`pi-cost-report.ts`); the packet's share read by token class
   (cache write, cache read, output). No pass rule: the question is the size and its sign at each price.
4. **Wall** seconds per task, both arms.

A run that stops on its budget is reported with the task runs it finished, paired on those.

No engine change follows from (A) whatever it reads: it is a measurement (D520).

### (B) A new user's first minutes

Written after the $0 screens below were read and before any (B) paid call.

**The gap.** F2 (D482–D483): with a new user's cards made in-run and four of about sixteen card calls made, Pi raised
56.0% of hidden facts with `cardsOrder` against 47.0% without; the same arm with every card made read 60.4% on seed
41. What remains is the items the card model has not reached yet. The enricher reads one batch of 20 at a time for
a user, so the backfill takes about sixteen call times end to end.

**Two levers, both screened at $0 first** (`bun run funnel`, train1–6, seeds 41–42, 384 hidden and 384 control
tasks, cards and requests replayed, `-- --cards-calls N`):

1. **More card calls early: `cardsLanes` K** (a trial switch, D521, off): one user's card calls run in up to K lanes
   while full batches wait. The same batches, the same calls, read in 1/K of the time, so at the moment one lane has
   made N calls, K lanes have made N × K. The lab's `--cards-calls N` gives a stream with K lanes N × K calls.
2. **A card-only model for the rest: `--cards-rest cards`** (lab only): past the cap the calls are answered with
   their cards and no requests. That is M2's distilled model at its best (its cards match the teacher's; its
   requests do not, D446), with the teacher's own cards standing in for it, so the screen is an upper bound on what
   the endpoint could add.

**Rules.**

- **The card-only model.** It buys a Modal endpoint and a live arm only if the screen shows hidden ≥ +10 of 384 at
  cap 4 or cap 8 (D361's noise bar for the intent index). This bar was written after the screen was read (§3); no
  paid call depended on it.
- **`cardsLanes`, live.** Pi (`packages/sim/lab/n4/new-user.sh`), Haiku 5.5 in every role, **no `--cards` file**
  (every card and request made in-run), `--cards-calls 4`, arms `eden` (one lane, 4 calls), `eden~l2` (8 calls) and
  `eden~l4` (16 calls) paired in one process, train, **seeds 45–48** (fresh users, no replay), short
  (`--variants hidden,control`) and long (`--days 2 --day-size 16`). A smoke shard (train1, seed 45, `--limit 4`)
  runs first and is not counted.
- **Promote** `cardsLanes` K into `DEFAULT_CONFIG` (D112) for the largest K of 2 and 4 that passes all of: the pooled
  paired hidden effect against `eden` (short and long, `cl4/pooled.py`) is ≥ +2.0 points with its 95% interval's
  lower bound above 0; control concerns after a Sonnet regrade are up by at most 1.0 point; at $0 with every card
  made the funnel with K lanes reads hidden ≥ 312 and decoys ≤ 276 with card calls up by no more than 5% (read
  already in §3: it does). Otherwise the switch is deleted with its code and tests.
- A lane adds no call, so the per-user cost question is whether the calls are the same; the live run reports each
  arm's card calls and spend a user, and the measured latency of a card call (the ledger's `latencyMs`), from which
  the backfill's wall time is one lane's calls × that latency ÷ K.

## 1. (A) Results: a stronger agent

Run 2026-11-10 on this branch's tree (commit 7f549ecb plus the lab-only price lookup fix), `packages/sim/lab/n4/run.sh`,
local, two processes at a time. No run stopped on its budget; no task errored. Summaries: `packages/sim/lab/n4/a-*`.

### Hidden facts (Haiku-graded; `a-*-pooled.txt`, `a-*-short-cost.txt`, `a-same-tasks.txt`)

| Agent | Short: `tools` | Short: `eden` | Long (one day a user): `tools` → `eden` | Pooled `eden` − `tools` (95%) | Pairs |
| --- | --- | --- | --- | --- | --- |
| Haiku 5.5 | 4/96 (4.2%) | 62/96 (64.6%) | 0/4 → 2/4 | **+60.0 points (+49.0..+70.0)** | 100 |
| Sonnet 5.5 | 14/96 (14.6%) | 77/96 (80.2%) | 2/4 → 4/4 | **+65.0 points (+54.0..+75.0)** | 100 |
| Opus 5.5 (adaptive, effort low) | 0/48 (0.0%) | 36/48 (75.0%) | 0/2 → 2/2 | **+76.0 points (+64.0..+88.0)** | 50 |

On Opus's 48 tasks (the first two templates a suite): Haiku 0/48 → 28/48 (58.3%), Sonnet 3/48 → 37/48 (77.1%), Opus
0/48 → 36/48 (75.0%).

- **Rule 1 holds for both stronger agents**: the interval's lower bound is far above 0. Eden's effect is not smaller
  with a stronger agent; it is the same size or larger.
- **The stronger agent does search better on its own, a little.** Sonnet makes 5.5 search calls a hidden task against
  Haiku's 1.8 and finds 14.6% of the hidden facts against 4.2%. Opus at effort low makes 2.6 and finds none of 48.
  The hidden fact is, by the suites' construction, something the request does not name; more searching for what the
  request names does not reach it.
- **With Eden the stronger agent uses what it is handed better**: 80.2% and 75.0% against Haiku's 64.6% from the
  same packets (Eden's side is identical: Haiku cards, replayed).

### False concerns (`a-*-pooled.txt`, Sonnet regrade of every concern)

Control and neutral tasks, short and long: Haiku graded 3 concerns with Eden for the Sonnet agent (1 of 100 control,
2 of 24 neutral), 0 for Opus (62 tasks), 0 for Haiku (124); with tools alone 1, 1 and 0. **After the Sonnet regrade
Eden's arm has 0 in every agent**; the tools arm keeps 1 (Sonnet agent, neutral). Rule 2 holds.

### Cost: $ per 1,000 tasks, agent + Eden (`a-*-cost.txt`, `a-*-tokens.txt`)

Connector calls free ("first-party"), steady state (the one-time backfill is $0.0018 a user in these runs, cards
replayed):

| Agent | Short `tools` | Short `eden` | Δ | Long `tools` | Long `eden` | Δ |
| --- | --- | --- | --- | --- | --- | --- |
| Haiku 5.5 | 0.225 | 0.287 | **+0.062 (+28%)** | 0.148 | 0.245 | +0.097 (+65%) |
| Sonnet 5.5 | 9.032 | 9.437 | **+0.405 (+4.5%)** | 8.860 | 10.646 | +1.786 (+20%) |
| Opus 5.5 | 13.726 | 16.132 | **+2.406 (+17.5%)** | 13.875 | 19.580 | +5.705 (+41%) |

The agent's bill by token class, `eden` − `tools`, $ per 1,000 tasks (`tokens.py`; its totals equal the cost
report's):

| Agent, shape | Requests a task | Cache write | Cache read | Output | Total |
| --- | --- | --- | --- | --- | --- |
| Haiku short | −0.30 | +0.066 (+532 tok) | −0.008 | +0.003 | +0.062 |
| Sonnet short | −0.58 | +1.379 (+551 tok) | −0.155 | −0.812 | +0.405 |
| Opus short | −0.71 | +2.318 (+464 tok) | −0.300 | +0.401 | +2.406 |
| Haiku long | −0.09 | +0.040 (+323 tok) | +0.023 (+2,278 tok) | +0.019 | +0.082 |
| Sonnet long | +0.03 | +0.965 (+386 tok) | +0.738 (+7,378 tok) | +0.063 | +1.762 |
| Opus long | 0.00 | +2.740 (+548 tok) | +1.772 (+8,861 tok) | +1.180 | +5.685 |

- **The packet is the same ~500 tokens whatever the agent** (A30's finding holds): about 460–550 tokens more
  written to the cache a task. At Sonnet's price that is $1.38 per 1,000 tasks, at Opus's $2.32, at Haiku's $0.07.
- **What it buys back differs by agent.** Sonnet searches a lot when left alone (5.6 tool calls a task against 1.7
  with Eden), so with Eden it makes 0.58 fewer model requests a task and writes 81 fewer output tokens: $0.81 back
  on output and $0.16 on reads, leaving +$0.41 (+4.5%). Opus at effort low searches less alone (2.7 calls), saves
  requests but writes slightly more output with the packet in hand, and keeps the whole write: +$2.41 (+17.5%).
- **Over a day the packets are read back.** Each later request of the day re-reads the earlier packets from the
  cache: +7,400 to +8,900 cached tokens a task. At 0.05x that is $0.74 (Sonnet) and $1.77 (Opus) per 1,000 tasks; at
  0.1x it would be twice that. The long runs are one day and 16 to 32 tasks an arm: read the direction, not the
  third digit.
- **Relative to the agent's own bill, Eden is cheapest on Sonnet** (+4.5% short), dearer on Opus (+17.5%), and
  dearest on Haiku (+28%), because Haiku's bill is so small that 500 tokens show.

With connector calls priced per plan (`a-*-cost.txt`; market list prices as A8 assumed them), steady state, `eden` −
`tools`, short:

| Agent | Composio | Unified.to | Arcade.dev | Pipedream | Zapier MCP |
| --- | --- | --- | --- | --- | --- |
| Sonnet 5.5 | −1.27 | −3.77 | −55.3 | −66.5 | −143.4 |

The Sonnet agent alone makes 5.57 connector calls a task; with Eden 1.70 of its own and none of Eden's in the
task's window (payload notices). On every per-call plan the Eden arm is cheaper in steady state; the one-time backfill
(18 connector calls a user in these runs, spread over 4 tasks a user) brings the all-in figure to +$0.12 on
Composio and below zero on the rest. The Opus and Haiku rows are in their files.

### Wall

| Agent | Short p50 `tools` → `eden` | Long p50 |
| --- | --- | --- |
| Haiku 5.5 | 3.27 → 1.98 s | 1.04 → 1.35 s |
| Sonnet 5.5 | 8.37 → 5.85 s | 7.13 → 5.83 s |
| Opus 5.5 | 7.90 → 6.68 s | 6.06 → 6.74 s |

One request a session, Eden's arm is 1.2 to 2.5 s faster for every agent (fewer search rounds). Over a day the
Haiku and Opus arms are 0.3 to 0.7 s slower (16 to 32 tasks; not a settled sign).

## 2. (B) Results: a new user's first minutes

### The $0 screens (`bun run funnel`, train1–6, seeds 41–42, 384 hidden and 384 control tasks)

Hidden surfaced / decoys surfaced, by how many card calls each world's card model was given:

| Card calls | 2 | 4 | 8 | 12 | 16 | all |
| --- | --- | --- | --- | --- | --- | --- |
| One lane | 229 / 234 | 259 / 248 | 272 / 252 | 290 / 265 | 314 / 273 | 314 / 274 |
| + cards only for the rest (`--cards-rest cards`) | 230 / 236 | 260 / 250 | 273 / 254 | 291 / 265 | | |

- **The curve is close to a line**: each card call is worth about five hidden tasks of 384 until the backfill is
  read (a train world needs at most 16 calls). At the moment one lane has made 4, two lanes stand at 272 and four
  at 314.
- **Cards without requests add +1 hidden task at every cap, and up to +2 decoys.** The bar was +10: the card-only
  model fails it, so no endpoint was deployed and no live arm run (D523). The items a new user cannot yet find are
  missing their intent requests, not their cards.
- **`cardsLanes` leaves the finished backfill as it was**: with every card made, 2 and 4 lanes read 314 / 274, the
  same 768 task rows as one lane; card calls 386 and 388 against one lane's 384 and 392 on two runs (the count moves
  with machine load: 382–392 over every run of either). With the cap scaled (2 lanes at 8 calls, 4 at 16) the rows equal one lane's at 8 and
  16. On the promoted tree the default reads 314 / 274, 382 calls.

### Live (Pi, Haiku 5.5 in every role, seeds 45–48, every card made in-run; `b-pooled.txt`, `b-*-cost.txt`)

`new-user.sh`, `--cards-calls 4`: `eden` has one lane and 4 calls a user, `eden~l2` two lanes and 8, `eden~l4` four
lanes and 16 (it made 15.7 a user: some users need fewer). The smoke shard (`b-smoke-45`) stopped on its $0.20
budget after 49 task runs and is not counted.

| Arm | Short: hidden raised | Short: control concerns (Haiku) | Long (2 days a user): hidden |
| --- | --- | --- | --- |
| `eden` (1 lane, 4 calls) | 430/768 (56.0%) | 2/768 | 11/16 |
| `eden~l2` (8 calls) | 449/768 (58.5%) | 1/768 | 11/16 |
| `eden~l4` (16 calls) | 464/768 (60.4%) | 3/768 | 11/16 |

| Pooled, paired against `eden` (784 hidden pairs) | Hidden | Control and neutral concerns after the Sonnet regrade |
| --- | --- | --- |
| `eden~l2` | +2.4 points (−0.8..+5.7) | 0 in both arms of 880 |
| `eden~l4` | **+4.3 points (+1.0..+7.8)** | 0 in both arms of 880 |

`eden~l4` − `eden~l2`: +1.9 (−1.4..+5.1). Per seed (short), `eden~l4` − `eden`: +5.7, +1.6, +2.6, +7.8.

- **The rule.** Four lanes pass every clause (effect ≥ +2.0 with the lower bound above 0; concerns not up; the $0
  funnel unchanged with card calls not up). Two lanes fail the first (the interval reaches below 0). **`cardsLanes`
  is 4 in `DEFAULT_CONFIG` (D522)**, in part `cards`.
- **The one-lane arm reads 56.0%, F2's figure for the same arm on seeds 41–48, and four lanes read 60.4%, F2's
  figure for every card made (seed 41).** At the four-call moment the remaining gap is closed; what is then left
  between in-run cards and the replayed, topped-up cards (64.6% for the Haiku agent in §1, on other seeds and a
  quarter of the templates) is the tenth of items a single pass of the card model leaves without requests (A22),
  which no order or lane reaches.
- **The long runs cannot see it**: 16 hidden pairs, 11 raised in every arm.
- **Cost.** The agent's bill is the same ($0.256, $0.257, $0.258 per 1,000 tasks, short). A lane adds no call: the
  arms differ in card spend only because the cap lets them make 4, 8 and 16 of the same ~16 calls ($0.0014 a call,
  about $0.022 a user for the whole backfill, 754 calls over 48 users in `eden~l4`). In production every arm makes
  them all; lanes only move them earlier.
- **Time.** A card call took p50 8.0 s and p90 16.9 s in these runs (669 calls, the ledger's `latencyMs`, up to 36
  users' calls in flight at once; M2 measured 5.4 s alone). A sixteen-call backfill is then about 86–128 s on one
  lane and 22–32 s on four. That window is what the lever shortens; a user with ten times the items has ten times
  the window.

## 3. What changed

- `packages/engine`: `cardsLanes` (config, `CardEnricher.lanes`, `drainLanes`, `UserCards.spawn`/`flying`), 4 in the
  default, 1 in part `cards` (`docs/profiles/minus-cards.json`); `cards-lanes.test.ts`. One lane is `drain` itself,
  untouched, so `minus-cards`-style single-lane behaviour and its timing are as before.
- `packages/llm`: `AnthropicPrice.cacheRead` (a cache read's share of the input price; 0.05 on Sonnet 5.5 and Opus
  5.5), used by `anthropicCost`. Lab pricing only: the servers call OpenRouter.
- `packages/sim` (lab): an Opus 5.5 agent runs `adaptive` at effort `low` (`anthropicThinkingOff`); pi-ab's
  `--cards-calls N` gives a stream with K lanes N × K calls; the funnel's `--cards-rest cards`; `lab/n4/` (`run.sh`,
  `new-user.sh`, `tokens.py`, the summaries).

## 4. Decisions

- **D520** finding: Eden's lift holds with Sonnet 5.5 and Opus 5.5 as the agent; the packet's cost by agent price.
- **D521** trial `cardsLanes` (entered 2026-11-10).
- **D522** `cardsLanes` 4 promoted into `DEFAULT_CONFIG` the same day on the pre-registered rule; 2 fails it.
- **D523** rejected: a card-only (distilled) model for the rest of a new user's backfill; the endpoint not deployed.
- **D524** lab tooling: the Opus agent's thinking setting, per-model cache-read prices, the cap scaled by lanes,
  `--cards-rest`.

## 5. Next most valuable step

The stronger agents use a handed fact better than Haiku does (80% and 75% against 65% from the same packets), and
Sonnet's `tools` arm shows what an agent that searches hard costs: the cost case for Eden is strongest exactly where
the agent is dear and thorough. The measurement to make next is the long horizon for a stronger agent with enough
tasks to read (this note's long runs are one day): whether the earlier packets read back all day (+$0.74 to +$1.77
per 1,000 tasks at 0.05x) are worth keeping in the transcript, which D336's `+ephemeral` layouts answer for Haiku
and nobody has run on Sonnet.

## 6. Spend

`packages/sim/lab/n4/spend.txt` (the ledger summed by run): Sonnet agent $4.25 (short 3.578, long 0.675), Opus agent
$3.47 (2.886, 0.588), Haiku agent $0.14, probes $0.40, new-user runs $3.34 (short 2.937, long 0.224, smoke 0.177),
Sonnet regrades $0.014. **Total $11.63.** Modal: nothing was started.

## 7. Reproduce

```bash
cat packages/sim/lab/cards/cards-v2.jsonl packages/sim/lab/cards/cards-train.jsonl \
  packages/sim/lab/cards/cards-train-4344.jsonl > .local/n4/cards-all.jsonl
L=packages/sim/lab/n4/run.sh; R=.local/n4/runs; S="--variants hidden,control"
$L claude-sonnet-5-5 a-sonnet-short-41 tools,eden --seeds 41 $S --limit 4 --budget 1.35        # and 42, 43, 44
$L claude-opus-5-5 a-opus-short-41 tools,eden --seeds 41 $S --limit 2 --budget 1.15            # and 42, 43, 44
$L claude-haiku-5-5 a-haiku-short-41 tools,eden --seeds 41 $S --limit 4 --budget 0.1           # and 42, 43, 44
$L claude-sonnet-5-5 a-sonnet-long-41 tools,eden --seeds 41 --days 1 --day-size 16 --budget 0.8   # and 42; opus 41
python3 -I packages/sim/lab/cl4/pooled.py eden tools $R/a-sonnet-short-4{1,2,3,4} $R/a-sonnet-long-4{1,2}
bun packages/sim/src/lab/pi-cost-report.ts $R/a-sonnet-short-4?.json
python3 -I packages/sim/lab/n4/tokens.py sonnet $R/a-sonnet-short-4{1,2,3,4}
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results $R/a-sonnet-short-41.json \
  --graders claude-haiku-5-5,claude-sonnet-5-5 --only-concerns --spend-ledger .local/n4/ledger.jsonl \
  --spend-cap 20 --spend-headroom 0.1 --run-label regrade-a-sonnet-short-41 --out $R/a-sonnet-short-41.regrade.json
python3 -I packages/sim/lab/realuse-3/pi/concerns.py eden tools $R/a-sonnet-short-4{1,2,3,4} $R/a-sonnet-long-4{1,2}
# (B) at $0, then live. On the final tree the default has four lanes: one lane is --set '{"cardsLanes":1}'.
bun run funnel --jobs 4 --set '{"cardsLanes":1}' --json OUT.json -- --cards-calls 4 [--cards-rest cards]
git checkout d79c09ad  # the tree the live run used: cardsLanes a trial at 1, so `eden` is one lane
N=packages/sim/lab/n4/new-user.sh
$N b-short-45 --seeds 45 --variants hidden,control --budget 1.5                                # and 46, 47, 48
$N b-long-45 --seeds 45 --days 2 --day-size 16 --budget 0.5                                    # and 46, 47, 48
python3 -I packages/sim/lab/cl4/pooled.py 'eden~l4' eden $R/b-short-4{5,6,7,8} $R/b-long-4{5,6,7,8}
```

## 8. Caveats

- Train only, Haiku-graded hidden facts (concerns Sonnet-regraded). The Sonnet and Opus samples are a quarter and an
  eighth of the templates on four seeds, sized by the budget; they see an effect of tens of points, not a few.
- **Opus ran with adaptive thinking at effort low** because it accepts nothing lower; Sonnet and Haiku ran with
  thinking off. Opus's `tools` arm made fewer searches than Sonnet's (2.7 against 5.6 a task); at a higher effort it
  may search more, cost more and find more alone.
- The 0.05x cache-read price for Sonnet 5.5 and Opus 5.5 is the session brief's figure, not re-read from the API
  reference. At 0.1x the long-run gaps would be about $0.74 (Sonnet) and $1.77 (Opus) per 1,000 tasks larger.
- The long runs are one day a user (16–32 tasks an arm, 2–4 hidden): direction only.
- **`cardsLanes` was measured with a call cap standing in for time**: K lanes got K times the calls, on the
  assumption that a call takes as long with three others in flight for the same user. Requests were not interleaved
  with card calls in real time, and the provider's rate limits were not approached. In production the benefit lasts
  only for the backfill's window (a minute or two for a 300-item user) and for bursts of new items.
- Four lanes mean up to four card calls in flight for one user and up to four reservations against the user's day
  at once (`estimatedCallUsd` $0.003 each against $0.25): a storm of new users puts four times the concurrent calls
  on the card model's endpoint for a quarter of the time.
- Near a user's day cap four lanes make fewer calls than one: lanes in flight hold their estimates, so the refusal
  that drops what waits comes up to three calls earlier (the reviewer's probe; docs/COST-MODEL.md).
- The reviewer found two defects in the lanes path after the live run (items queued as the last lane ended could
  wait for the user's next enqueue; a follower of another lane's batch was dropped when its own lane's call threw)
  and one duplicate-call window during a retry. All three are fixed with tests. In the live runs 2 of 1,442 card
  calls ended in an error (the ledger), so at most those two batches could have dropped a waiting follower.
- The card-only screen used the teacher's cards for the distilled model's: an upper bound, not a run of the model.
