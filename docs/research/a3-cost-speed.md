# A3: cost and speed under the candidates default

Status: 2026-11-07, branch `claude/a3-cost-speed` (from `claude/lucid-hypatia-v9wqk5` at `c7cfc8fc9`). Session A3 of
the afternoon audit (docs/research/audit-1107-plan.md). Every paid call went to Anthropic (`claude-haiku-5-5`,
`HAIKU_API_KEY`, the lab provider, D97) on this session's ledger (`.local/a3/ledger.jsonl`, cap $2), so every dollar
figure here is an **Anthropic-direct lab figure** on the **train** suites (in-sample), not the OpenRouter route the
servers ship. Decisions D271–D274. Final figures (§11) are on the tree merged with A4/A6 (`ae5757b75`).

## In plain words

**Final, on the merged tree (§11):** against the agent alone with its own search tools, both given the same tenant
prompt, Eden costs **+$0.047 per 1,000 tasks one request at a time** (+0.029..+0.065) and **+$0.050 over a user's
days** (+0.035..+0.065) in model tokens, is **0.95 s and 0.65 s faster** a task, and raises the hidden fact on 67% of
hidden tasks against 8% (13 of 23 against 1 of 23 over days). **Priced with the connectors' own per-call fees, Eden
is cheaper on every paid plan** (it replaces the agent's 1.0–2.2 tool calls a task with 0–0.16 of its own): over days
−$0.17 per 1,000 tasks on Composio to −$18.7 on Zapier MCP all-in, backfill included (§12). The rest of this section
is the first, pre-merge pass.

- **Why Pi showed Eden dearer one request at a time is now proven, and it was hiding the real gap.** Pi's agent with
  Eden has a fixed prompt of about 500 tokens on the wire; Anthropic caches nothing shorter than 512 on Haiku 5.5. So
  Eden's agent re-wrote its whole prompt on every task while the agent alone (867 tokens) read it from cache. Two
  probe calls per arm show it directly (D271).
- **Given a realistic agent prompt in every arm, Eden costs more than the agent alone, and is faster.** With a fixed
  set of ~550 tokens of a tenant's house rules added to every arm (`--tenant-prompt`), on Pi with payload notices:
  - **one request at a time:** +$0.060 per 1,000 tasks on the 1:1:8 mix (+0.042..+0.078), **0.96 s faster**
    (−1.16..−0.77), hidden facts raised 61% against 10%;
  - **a user over 8 days:** +$0.080 per 1,000 tasks (+0.065..+0.095), **0.42 s faster** (−0.59..−0.26), hidden facts
    15 of 23 against 1 of 23.
  - The extra dollars are almost all **the packet's tokens written to the agent's prompt cache** (about 370 more tokens
    written a task than the agent alone; Eden's own calls cost $0 a task). The house rules also made the agent alone
    terse and less inclined to search (0.76 tool calls a task over days, from 1.6–2.0 in CL8), which is why CL's "Eden is
    cheaper over days" does not survive: that comparison depended on how much the agent alone looks things up.
- **A lab bug made Eden look 650 ms slower than it is over days.** The long-horizon harness signalled a change at each
  day's recap even under `--push payload`; every later packet then re-read its mail items before going out. Fixed
  (the notice now carries its items, as the client sends it): Eden's time on the agent's path over days fell from
  **646 ms to 7.4 ms** a task, and wall time against the agent alone went from +0.25 s to −0.42 s (D272). The CL5–CL8
  long payload runs (and heldout16's long run) carried this overhead.
- **No cheap packet cut is left.** Four ways to send fewer packet bytes were screened at $0 (only anchored packets,
  only anchored items, a constraint-like item among the five sent, filters on ask items): each either cut almost
  nothing, moved the bytes into longer ask answers, or dropped about a quarter of the planted facts the ask finds
  (D273). The packet's bytes are what recall costs.
- **Speed outside the agent is fine.** The server's own time: an ask answers in 5.0 ms at p50 and 30 ms at p99 on the
  shipped synced shape (300 simulated users at real pacing), observe 0.9 ms p50, 12 ms p99. The per-session
  reader-call cap no longer binds: the default makes no reader calls.
- **Hermes could not be run here**: installing the hermes-agent checkout's Python dependencies was refused in this
  container. Its +$0.077/1k (RealUse-3) has the shape found on Pi: more input on every turn, from the packets.

## 1. Ranked cost and latency drivers (per task, under the default)

From the Pi runs below (train1–6, seeds 41–42, `--tenant-prompt`, payload notices; mix = 1 hidden : 1 control : 8
neutral, an assumption). Billed $ per 1,000 tasks, Haiku 5.5 prices ($0.10/M in, $0.50/M out; cache writes 1.25×,
reads 0.1×).

| # | Driver | One request (short) | Over days (long) | Lever |
| --- | --- | --- | --- | --- |
| 1 | Packet tokens written to the agent's cache | Eden writes 865–965 tokens a task vs 318–357 (+$0.07/1k) | 629–651 vs 262–310 (+$0.045/1k) | none without recall loss (D258, D273) |
| 2 | Earlier packets read back on later requests | −$0.01 (Eden makes fewer requests) | reads 5,596 vs 4,396 tokens a neutral task (+$0.012/1k) | none: dropping them breaks the cache prefix |
| 3 | Pi's uncached ~500-token prefix (lab only) | was +$0.07–0.12/1k in writes (CL8's `short-pay-cache.txt`) | n/a (history is cached) | lab: `--tenant-prompt` (D271) |
| 4 | Eden on the agent's path over days (lab only) | 10 ms | 646 ms → 7.4 ms | lab: payload recap notice (D272) |
| 5 | `ask_context` turns | 0.33–0.70 asks a task, 816–964 B each | 0.04–0.05 | D257: discouraging asks lost hidden facts |
| 6 | Eden's own model calls on the path | 0 | 0 | done (D237) |
| 7 | Cards and intent in the background | $0.018/1k (in-run, both seeds) | $0.018/1k | D244 |
| 8 | Server and SDK overhead | ask p50 5 ms, p99 30 ms; observe p99 12 ms | same | none needed |

Output tokens are the largest single share of every arm's bill ($0.13–0.16/1k short), and Eden lowers them (fewer
turns: 1.24–1.51 vs 1.76–1.83 a task short, 1.00–1.05 vs 1.26–1.43 long).

## 2. D260's cache finding, proven (D271)

`packages/sim/src/lab/cache-probe.ts` builds each arm's first request as pi-ab does, lets pi-ai convert it (the
captured body is what Pi sends), counts it with `count_tokens` (free) and sends it twice with `max_tokens` 1, the
second time with another task's user turn, so only the shared prefix can be read. Output in
`packages/sim/lab/a3/cache-probe.txt` (two worlds; the earlier runs of the same probe gave the same second-request
reads):

| arm | tenant rules | count_tokens (prefix + ".") | second request: cache read |
| --- | --- | --- | --- |
| tools | no | 944 | 867 |
| eden | no | 577 | **0** (598–615 written or plain, every time) |
| tools | yes | 1,489 | 1,412 |
| eden | yes | 1,122 | **1,045** |

The eden arm's tools-and-system prefix is 1,045 − 545 ≈ **500 tokens on the wire** (count_tokens adds about 77 tokens
of its own), below Haiku 5.5's documented 512-token minimum, so the breakpoint after the system prompt never caches.
With the house rules both arms' prefixes cache. D260's counterfactual re-priced only Eden's prefix; with the rules in
both arms the agent alone changes too (below), so that counterfactual ($0.362 vs $0.370) is not the comparison.

`--tenant-prompt` (pi-ab) appends `TENANT_GUIDE` (ab-common.ts: style, dates, drafts, privacy and list rules; nothing
about checking the user's data) to every arm's system prompt, and is part of `promptsHash` (no arm reuse across it).
It is an assumed tenant prompt: a different prompt moves both arms differently.

## 3. Pi with the tenant prompt in every arm

`packages/sim/lab/a3/run.sh` (CL8's with `--tenant-prompt`), tools and eden, payload notices, direct market
profile, time scale 1. Ledger runs `a3-short-pay-41/42` ($0.268), `a3-long-pay-41/42` ($0.133), `a3-long3-pay-41/42`
($0.077, eden only, after the D272 harness fix; paired with the earlier run's tools arm, which the fix does not touch).
`a3-long2-pay-41/42` ($0.075) are void: the first version of the fix sent an empty notice (the review found it), so
they measured no recap notice at all (Eden's path 7.5 ms, $/1k +0.074, hidden 14/23).

**Short** (`--limit 12`, hidden, control, neutral; n = 144 a kind; `short-pay-arms.txt`, `short-pay-cache.txt`):

| | tools | eden | eden − tools (paired, 95%) |
| --- | --- | --- | --- |
| hidden raised | 10.4% | 61.1% | +50.7 points (+41.7..+59.7) |
| control false concern | 0.0% | 1.4% | +1.4 (+0.0..+3.5), not regraded |
| neutral any concern | 0.7% | 0.0% | −0.7 |
| $/1k mix (agent; Eden's calls $0) | 0.221 | 0.280 all-in (0.263 agent) | **+0.060 (+0.042..+0.078)** |
| wall mean, mix | 2.97 s | 2.02 s | **−0.96 s (−1.16..−0.77)** |
| turns a task (neutral) | 1.76 | 1.51 | −0.24 |
| tokens written a task (neutral) | 318 | 865 | |

**Long** (`--days 8`: one user per seed, 232 tasks; `long-pay-arms.txt`, `long-pay-cache.txt`, `long-pay-cost-eden.txt`):

| | tools | eden (fixed harness) | eden − tools |
| --- | --- | --- | --- |
| hidden raised | 1/23 | 15/23 | +60.9 points (+39.1..+82.6) |
| control false concern (not regraded) | 0/23 | 1/23 | +4.3 (+0.0..+13.0) |
| $/1k mix | 0.166 | 0.246 | **+0.080 (+0.065..+0.095)** |
| wall mean, mix | 1.75 s | 1.33 s | **−0.42 s (−0.59..−0.26)** |
| Eden on the path | 0 | 7.4 ms | |
| tokens written a task (neutral) | 262 | 629 | |
| agent tool calls / Eden connector calls a task | 0.76 / 0 | 0.05 / 0.16 | |

Before the harness fix (`long-pay-before-fix-arms.txt`): Eden on the path 646 ms (observe 577–809 ms), 2.13 connector
calls a task, wall +0.25 s against tools (+0.08..+0.42), $/1k +0.082 (+0.067..+0.096), hidden 13/23.

## 4. The long-horizon harness signalled under payload (D272)

At each day's recap pi-ab moves the times of the day's planted items and notified Eden with `sourceChanged` (a bare
signal) whatever `--push` said. A signal doubts every copy of that source read before it (`Sync.signalledSince`,
D126/D133), so from the first recap on, every push whose candidates held a mail item re-read it (`verifyItems`, about
two gmail fetches, 600–830 ms) before the packet could go out. Under `--push payload` the harness now sends the moved
items with `sourceItems`, which is what `EdenClient.sourceChanged(sourceId, { items })` sends (the client sends no
signal when the notice carries items), so nothing else is doubted. `signals` keeps the bare signal. The product path is
unchanged: an integration that forwards notices with their items (D210's documented default) never paid this; one that
forwards bare signals pays it on every later delivery from that source, as D245 describes.

Every long payload figure before this (CL5's `--days 8`, CL6–CL8's long runs, RealUse-3's heldout16 long run) carries
the overhead: CL8's long payload run put Eden's path at 648–694 ms a task (`packages/sim/lab/cl8/long-pay-arms.txt`),
not ~10 ms.

## 5. Levers screened at $0 and rejected (D273)

`packages/sim/lab/a3/funnel-screen.txt`. Funnel on train1–6 seeds 41–42 with neutral, the committed reader caches
replayed (0 misses). The planted facts share few words with their requests by design, so every lexical cut that
removes noise removes them too:

- **A packet only when a candidate is anchored** (a whole named entity, the request's people or day, an intent hit):
  323 of 324 neutral packets were anchored; nothing changed.
- **Only anchored items in the packet** (the same, or two shared terms): neutral packet bytes −3%, ask answers +10%
  (`askDedup` says in full what the packet no longer shows); hidden 305 → 307.
- **A constraint-like item among the five sent** (not only in the 15-item pool): neutral packets 324 → 278, bytes
  −16%, ask answers +12%, push-delivered hidden 272 → 267. Projected saving on Pi's long horizon about 40 tokens a task
  (≤ $0.006/1k of the +$0.080), for five planted facts moved from the packet to the ask; the lab's planted facts are
  all constraint-worded, so a real unworded fact would be lost more often. Not run live.
- **Filters on ask-answer items** (entity, probe, two terms or a relative score floor 0.2–0.5): each keeps 219–230 of
  the 303 planted items the ask cited on hidden tasks (−24 to −28%).

The switch for the first two (`pushCandidatesAnchor`) was built and deleted with its code (D112); the third was an
uncommitted screening hack.

Not built, estimated: a shorter `CANDIDATES_LEAD` (290 → ~180 bytes) saves about 25 tokens a packet, ≤ $0.004/1k, and
the lead's wording is what kept look-alikes from being stated (D236); not worth a live arm.

## 6. Speed outside the agent

`bun packages/sim/src/perf-cli.ts steady [--synced]` (300 simulated users at real pacing and REALISTIC source
latency, 90 s, no model key; `packages/sim/lab/a3/perf-steady.jsonl`). `--synced` (new) starts the server with
`--sync on` and backfills the users before the measured run, as the shipped default serves them (296 of the 300
were tracked and warmed; 4 were not), without it the scenario never syncs and every ask is a live fan-out:

| | sync off (the old scenario) | synced (shipped shape) |
| --- | --- | --- |
| ask p50 / p95 / p99 | 568 / 1,253 / 1,495 ms | **5.0 / 10.0 / 30.2 ms** |
| observe p50 / p99 | 0.86 / 6.6 ms | 0.86 / 12.1 ms |
| observe (user message) p50 / p99 | 1.3 / 8.0 ms | 1.8 / 14.9 ms |
| time to context p50 / p99 | 1,725 / 34,891 ms | 3.8 / 39.9 ms |
| lookups' source calls in the measured run (the sync's own polls not counted) | 10,068 | 0 (backfill: 5,356 before it) |

Nothing here is on the agent's critical path at a size worth a lever; the synced run's observe p99 rise (6.6 → 12.1
ms) is the sync's background work sharing the event loop.

The per-session reader-call cap (`DEFAULT_LIMITS.callsPerSession` 20, CL7 §5) no longer binds in the default: the
push and asks make no reader call (D237), and the card enricher reserves each call under its own one-call session.

## 7. Hermes

Not run: `uv sync` of the hermes-agent checkout (commit 06433066) was refused by this container's permission policy.
Read from its source instead: Hermes places a `pre_llm_call` context in the user message (`agent/turn_context.py`,
"so the ephemeral system prompt stays byte-stable"), and the lab plugin appends later packets to tool results, so the
packet is cache-friendly there too. RealUse-3's +1,586 input tokens a neutral task (9,070 vs 7,484) is the packet and
its re-reads across Hermes's 1.9 model calls a task, the mechanism measured on Pi above.

## 8. Decisions

- **D271**: D260's mechanism proven (the eden arm's ~500-token prefix is below Haiku 5.5's 512 minimum); pi-ab gets
  `--tenant-prompt`, and cost comparisons on Pi quote a run with it beside the bare one.
- **D272**: the long-horizon harness sends payload notices under `--push payload`; long payload latencies before it
  carry ~650 ms of re-reads.
- **D273**: four packet- and ask-byte cuts rejected at $0; the switch deleted.
- **D274**: `pushCandidatesCovers` (the lead says the packet is what an ask would return) measured live and deleted:
  no change in asks, cost or time.

## 11. Final runs on the merged tree

Tree `ae5757b75` (A4's no-key candidates, D276; A6) merged into this branch, the same recipe (`--tenant-prompt`,
payload, train1–6 seeds 41–42), with pi-ab now counting Eden's connector calls per stream. Ledger runs
`a3m-short-pay-41/42` ($0.406, three arms: tools, eden, `eden~cov` for D274) and `a3m-long-pay-41/42` ($0.136).
Summaries `packages/sim/lab/a3/merged-*`.

| | short: tools | short: eden | eden − tools | long: tools | long: eden | eden − tools |
| --- | --- | --- | --- | --- | --- | --- |
| hidden raised | 8.3% | 66.7% | +58.3 pts (+50.0..+66.7) | 1/23 | 13/23 | +52.2 pts (+30.4..+73.9) |
| false concern, mix (not regraded) | 0.0% | 1.8% | +1.8 (+0.1..+4.0) | 0.4% | 1.3% | +0.9 (−0.9..+2.6) |
| $/1k mix, model tokens | 0.226 | 0.273 | **+0.047 (+0.029..+0.065)** | 0.189 | 0.239 | **+0.050 (+0.035..+0.065)** |
| wall mean, mix | 2.96 s | 2.01 s | **−0.95 s (−1.13..−0.76)** | 1.92 s | 1.27 s | **−0.65 s (−0.81..−0.49)** |
| turns a task (mix) | 1.81 | 1.47 | | 1.39 | 1.03 | |
| `ask_context` a task (mix) | 0 | 0.62 | | 0 | 0.03 | |
| connector calls a task (mix) | 2.18 | 0 | | 1.04 | 0.16 | |
| Eden's backfill, calls a user | | 18 | | | 18 | |

The false-concern rise one request at a time is the control and neutral answers Haiku graded as a concern (2 and 3
of 144), not regraded; earlier regrades found most such concerns were grader errors (fix-w2b), so read it as
unresolved, not as harm.

## 12. Connector pricing (the owner's instruction)

`pi-cost-report.ts` now prices every connector call per plan (`CONNECTOR_PLANS`, from `before-after/market.py`; list
prices, assumed): the agent's own search tool calls, Eden's calls in each task's window, Eden's background calls
while the user worked, and the one-time backfill per user (booked like cards: in all-in, not steady). eden − tools,
$ per 1,000 tasks on the 1:1:8 mix (`merged-*-cost.txt`):

| plan ($ per 1,000 calls) | short, steady | short, all-in | long, steady | long, all-in |
| --- | --- | --- | --- | --- |
| first-party (0) | +0.038 | +0.049 | +0.048 | +0.050 |
| Composio (0.30) | −0.614 | −0.154 | −0.217 | −0.168 |
| Unified.to (0.75) | −1.594 | −0.458 | −0.615 | −0.496 |
| Arcade.dev (10) | −21.72 | −6.71 | −8.79 | −7.23 |
| Pipedream Connect (12) | −26.07 | −8.06 | −10.55 | −8.69 |
| Zapier MCP (25.8) | −56.10 | −17.38 | −22.75 | −18.74 |

The short runs' all-in is pessimistic for Eden: each of their 36 streams is a separate user whose 18 backfill calls
are spread over only its 12 tasks; the long runs (one user over 232 tasks) are the shape to quote. (The report's
first-party row differs slightly from §11's arms.py figure: the report weights the mix per kind before adding the
background; arms.py adds each run's background per task.) Eden's background sync during the run made no connector
calls in these runs: with payload notices nothing was polled. A signal-only integration would add listings and
re-reads (D245) at its plan's rate, which is where a per-call plan makes D210's payload advice worth money.

A lever that saves tokens by adding connector calls must be judged on these plans: at Composio's $0.30 per 1,000
calls, one extra call a task costs $0.30 per 1,000 tasks, six times Eden's whole token gap.

## 13. First-principles redesigns (the parent's ask)

What a task costs, from §11: the agent's output tokens ($0.08–0.16 of $0.19–0.28 per 1,000), cache writes of what is
new in the prompt, the agent's turns (each `ask_context` costs a model request), and connector calls (§12). Eden's
own spend is $0 a request and ~$0.02 per 1,000 in the background. Five redesigns, estimated:

1. **Eden as the agent's whole retrieval layer** (no source tools; the packet and one ask). Already the `eden` arm:
   it is why Eden is 0.65–0.95 s faster and saves 1.0–2.2 connector calls a task (−$0.2 to −$56 per 1,000 on paid
   plans, §12). Remaining: make it the integration default in INTEGRATION.md's words (a product step, not code).
2. **Packets that make the ask unnecessary** (answer ahead: the push says it is what an ask would return). Tasks with
   an ask cost ~$0.19 per 1,000 more and 1.3 s longer (unpaired, §3), so the ceiling was about −$0.11 and −0.8 s on the
   mix. **Built and measured (D274, `pushCandidatesCovers`): asks 0.615 → 0.600 a task, no change**; the agent asks
   for what the packet does not hold (contact details, the thread), not to re-check it. A real answer-ahead would have
   to predict those working facts; D257 showed that discouraging the ask loses hidden facts.
3. **Zero bytes when nothing binds.** Needs a verdict that rarely misses; four lexical forms failed at $0 (D273), the
   paid reader costs more than the bytes it saves (D237), cards cover 37% of planted facts (A6). Ceiling: the packet's
   writes, about $0.045 per 1,000 over days. Not buildable without a better no-model verdict.
4. **A standing per-user brief in the agent's cached prefix** (refreshed in the background, read at 0.1x). Rejected on
   $0 evidence by A6 (D288): the cards it would be built from cover too little, and a brief that changes busts the
   tenant's cache for every turn after it.
5. **Spend the agent's output less** (75% of its dollars, A6). The tenant prompt alone moved the tools agent from
   $0.37 to $0.22 per 1,000 tasks one request at a time (CL8 vs §3: output 560 → 310 tokens a task). Not Eden's
   lever, but the largest one measured here: INTEGRATION.md's "spend fewer output tokens" is where a tenant saves.

So for cost the remaining Eden-side gap (+$0.05 per 1,000 in tokens) is the price of the packet, and on any per-call
connector plan Eden is already cheaper than the agent alone; for speed Eden is ~10 ms on the path and 0.65–0.95 s
faster than the agent alone.

## 9. Spend

| Run | $ |
| --- | --- |
| cache probes (6) | 0.002 |
| a3-short-pay-41, -42 | 0.268 |
| a3-long-pay-41, -42 | 0.133 |
| a3-long2-pay-41, -42 (void, empty notice) | 0.075 |
| a3-long3-pay-41, -42 | 0.077 |
| a3m-short-pay-41, -42 (merged tree, with D274's arm) | 0.406 |
| a3m-long-pay-41, -42 (merged tree) | 0.136 |
| **Total** | **1.096** of $2 |

## 10. Reproduce

```bash
cat packages/sim/lab/cards/cards-{v2,train,train-4344}.jsonl > .local/a3/cards-all.jsonl
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cache-probe.ts --suite train1 --seed 41 \
  --spend-ledger .local/a3/ledger.jsonl --spend-cap 2 --run-label a3-cache-probe
L=packages/sim/lab/a3/run.sh
$L a3-short-pay-41 payload tools,eden --seeds 41 --variants hidden,control,neutral --limit 12 --budget 0.3   # and 42
$L a3-long3-pay-41 payload tools,eden --seeds 41 --days 8 --budget 0.25                                       # and 42
R=.local/a3/runs
python3 -I packages/sim/lab/cl7/arms.py --arms tools,eden $R/a3-short-pay-41 $R/a3-short-pay-42
python3 -I packages/sim/lab/cl8/cache.py $R/a3-short-pay-41 $R/a3-short-pay-42
bun packages/sim/src/perf-cli.ts steady --synced
```
