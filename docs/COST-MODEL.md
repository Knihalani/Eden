# Cost model

Input tokens drive the cost, so the design rations them: most turns cost nothing, and a model call sees a bounded
input.

## Prices (verify before relying on them)

`z-ai/glm-5.3-flash` is served by 38 OpenRouter endpoints at different prices (OpenRouter endpoints API, queried
2026-10-27 in the fast-primitives research; [docs/research/fast-primitives.md](research/fast-primitives.md)):

| Endpoint               | Input $/M | Output $/M | Cache read $/M | Note                                               |
| ---------------------- | --------- | ---------- | -------------- | -------------------------------------------------- |
| Z.AI and most US hosts | 0.15      | 0.50       | 0.03           | Z.AI caches automatically                          |
| Relace                 | 0.0513    | 0.0701     | 0.03           | The founder's figure; no `response_format` support |
| Wafer                  | 0.054     | 0.20       | 0.053          | Almost no cache discount                           |
| OpenInference (fp4)    | 0.082     | 0.06       | 0.0064         | Quantized                                          |

Many endpoints are fp4/nvfp4 quantized; whether that hurts judge precision is unmeasured. With default load
balancing, prompt-cache hits are unlikely: caching pays only with sticky routing (a per-user `session_id`, a
byte-stable system prefix). `packages/llm/src/pricing.ts` budgets with the Z.AI list price, the conservative one.
OpenRouter returns the real cost per call (`usage.cost`), and the engine books that.

## Per call (upper bounds from the engine's caps)

| Call                                                                                           | Input bound                                                                                                   | Output bound                        | Cost at $0.15 / $0.50, uncached |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------- |
| Judge                                                                                          | system ≈ 100 tok + window ≤ 4,000 chars (≈ 1,000 tok) + ≤ 6 candidates × ≈ 100 tok ≈ 1,700 tok                | 512 tok, reasoning included (D45)   | ≈ $0.00051                      |
| Ask answer (only with `askWithModel`, off by default, D43)                                     | ≈ 100 + question ≤ 10,000 chars (≈ 2,500) + window ≤ 2,000 chars (≈ 500) + ≤ 20 items × ≈ 170 tok ≈ 6,500 tok | 1,000 tok, reasoning included (D45) | ≈ $0.0015                       |
| Card enrichment (only with `cards`, off by default, D59 proposed; background, never per event) | system ≈ 700 tok + ≤ 10 items × (title ≤ 160 + own text ≤ 900 chars) ≈ 3,400 tok                              | 2,000 tok, reasoning included       | ≈ $0.0015                       |

Card enrichment, measured (docs/research/moon-cards.md, 572 calls on simulated worlds, 2026-10-31): 1,599 input and
677 output tokens per call on average, $0.000181 per call as OpenRouter reported it. One call per ten new items that
pass the no-model prefilter (11-15% of simulated items), each item read once per content hash: about $0.002 per 1,000
items arriving, $0.003-0.004 per user-month at 50 new items a day (at most about $0.013 at list prices). Reserved per
call at $0.002 against its own per-user-day `Budget`.

Card economy (proposed D66, `cardsEconomy`, off by default; docs/research/econ-background.md; in-sample, 2026-10-31):
the strict prefilter and sentence reuse read 74.25 items per simulated user instead of 166.5 (−55.4%) in 12.4 calls
instead of 24.25 (20 items per call), with the same funnel totals (218/19; the track measured 70.25 items and 12.15
calls before the sentence key took the subject in, after review). Per item, OpenRouter's endpoint decides the price:
$0.00013–0.00015 per 20-item call on OpenInference (fp4), $0.00028–0.00031 on Wafer, $0.0004–0.0012 elsewhere. With
`sort: "price"` on the card maker's model (ZDR kept), $0.0000144 per item pooled against $0.0000245 with default
routing (−41%). Together: about $0.0011 per user one-time and per user-month (50 items a day) against $0.0041 (−74%;
the track's $0.0010 was at 70.25 items).
Price routing cut off 40 of 657 items' batches at the output cap in the track's re-card (617 covered against 637 with
default routing); the enricher now sends a cut batch once more with default routing (`CardMakerOptions.retry`), under
its own reservation. At that rate the retries add about 6% of items at the default price, about $0.0001 per user
(arithmetic from the track's numbers, not a live run): about $0.0012 per user in all. A 20-item call's output cap is
4,000 tokens (200 per item past ten) and its reservation $0.003 (about $0.0024 at the cap on the list-price endpoint:
2,400 input tokens at $0.15/M, 4,000 output at $0.50/M). On D64's accounting the benchmark's card share would fall
from $0.156 to about $0.039 per 1,000 tasks, Eden ALL all-in from $0.474 to about $0.36 (an estimate, not a live run).

Sync push (proposed D66, `syncPush`, off by default) adds no model call. In the funnel it takes request-time listing
calls from 5.55 to 0 per task (amortised 6.89 → 1.46, counting the one poll each watch costs when it is declared).
In an arrival simulation with assumed rates (mail 60, chat 150 items a working day), D57's on-demand polling makes
104.7 listing calls per user-day; push with `syncPushGapMs` 30 minutes 80.7, with notices read at every five-minute
tick 151 (the busiest source sets it). Over 7 days, with the pushed sources' sweep every 3 days (D66): D57 111.6, push
with the 30-minute gap 88.4 (−21%).

With `graph` (proposed D58) the judge sees at most `graphSeats` (1) more candidate, about 100 more input tokens per
call at its cap; no other model call is added and the graph makes no source call. Measured in simulation (realistic,
4 seeds, perfect judge): $0.0172 → $0.0178 per 1,000 turns, model calls per turn 0.213 → 0.215.

The action firewall (`actionCheck`, off by default; proposed D69, docs/research/econ-firewall.md) adds no model call
and no source call: each check of an agent's tool call is CPU on what is held (the cache, the probes' memo, the graph,
the cards), 4–5 ms p50 and at most 28 ms per check in the no-model replay of the track's recorded calls (seeds 41–43,
ALL). Its cost is the agent's: a held call costs the agent about one more model request to read the finding and
answer, +$0.3–0.6 per 1,000 such tasks and +5–7 s on them (the track's live runs, in-sample; agent cost over
all tasks, within noise).

These are arithmetic on list prices, not measurements. Output is billed on tokens used, not the cap: a judge verdict
is a few tokens plus low-effort reasoning (about 20 tokens on GLM 5.3 Flash in a probe of three calls).

## Measured so far (tiny samples, not statistics)

- `bun run eval --live`, seed scenario, 8 turns, 2026-10-27: 1 model call, $0.0000162 total
  (`costPerTurnUsd` 0.00000202825), p95 observe latency 767 ms with `waitMs` 2000.
- Live judge in simulation, realistic, seeds 41–43, 2026-10-30 (D45): 0.186 model calls per turn, $0.010 per 1,000
  turns (about $0.000056 per judge call, OpenRouter's reported cost), delivery p95 3.5 s on seed 41 with the judge
  against 11 ms without (docs/research/live-judge.md).
- Server smoke test, one `ask`: $0.000013639431, 1,549 ms end to end, including the OpenRouter round trip.

## Budget defaults (`packages/llm/src/budget.ts`)

20 calls and $0.02 per session; $0.25 per user per day; each call reserved before its real cost is known, at about its
worst case at the cap: $0.0005 for the judge, $0.0015 for a model-composed ask answer (D45). Over budget, the engine
takes the no-model path; it never defers spend.

## How live cost is reported (D71)

OpenRouter spreads one model over many endpoints up to 10× apart in price, and the mix moved with the condition within
one concurrent run (D64's runs: the cheapest fp4 endpoint served 29% of no-tool requests, 21% of the Eden agent's and
9% of the five-tool agent's; docs/research/econ-research.md §1.1). So a live comparison reports agent cost twice: as
billed, which is what a tenant pays, and re-priced at fixed prices (Z.AI's list price and Wafer-us), with each
condition's inferred endpoint mix (`reprice.ts`, printed by `pi-ab-report.ts`). A claim that one condition costs less
holds only if it holds re-priced. Re-priced, D64's Eden agent (ALL) costs 20–23% less than the tools agent ($0.770
against $0.998 per 1,000 tasks at Z.AI list, $0.272 against $0.342 at Wafer-us), where billed it looked equal ($0.318
against $0.320). The grader is reported separately and never counts in all-in. The fixed prices are a snapshot from
2026-10-31.

What a tenant's own agent costs depends mostly on the agent: in D64, 85% of its model time is output tokens, and each
`ask_context` round trip is one more model request. Removing the ask (D70, rejected) saved $0.070 per 1,000 tasks
(−27%) but lost 0.12 of hidden facts raised (in-sample). docs/INTEGRATION.md collects the agent-side levers; they are
unmeasured advice.

## Levers, in order of leverage

1. Fewer model calls: better cheap scoring (M1 tuning), the graph (M3), learned silence. Done so far: ask answers
   without a model by default (D43), which halved model calls per turn in simulation (realistic, perfect judge,
   seeds 31–40: 0.378 to 0.198; cost per 1,000 turns $0.027 to $0.014) with recall, precision and ask retrieval
   unchanged. Grounding the no-model path in people and days (D44) adds no model call: with the perfect judge, model
   calls per turn are identical to main on every mix. A rule that skipped the judge for weak candidate sets was
   measured and rejected
   ([research/model-calls.md](research/model-calls.md)). `judgeTied` (D54, off by default) skips the judge only when
   no candidate is tied to the request (a probe's find, a day it names, two of its words, or one word rare in the
   user's items): simulation, perfect judge, realistic seeds 41–44, on G (D54): model calls per turn 0.253 → 0.212,
   $0.02025 → $0.0170 per 1,000 turns at recall 0.647 → 0.643 ([research/judge-tied.md](research/judge-tied.md),
   before review). With D55's final H: 0.213 model calls per turn, $0.0172 per 1,000 turns, recall 0.645.
   `decideConflict` (D67, off by default; docs/research/econ-decide.md) makes no model call: it re-reads the ranked
   candidates with the engine's own conflict test only when no model decides (+1.6 ms of slow-path CPU per task in
   the track's in-sample funnel, measured before it also ran on the fast path's cached answers), at +0.06 delivered items per hidden task (a few dozen agent input tokens). The logistic
   decision model it was measured beside (+5.5 ms) stays in the lab.
2. Smaller inputs: shorter windows, candidate snippets, prompt-cache-friendly prompt layout (stable system prefix).
3. Cheaper model: a fine-tuned small judge (M6).

Probes (D46, off by default) add no model call but roughly double source calls per lookup in simulation (5.4–5.6 →
11.4–11.8; 8.7–9.1 with `probeWhen: "actions"`), within `probeCalls` (8) per lookup; with a judge, model calls per
turn rise by 0.01–0.03 (more lookups have candidates). For the agent, Eden with probes in place of search tools cost
less per task than the tools did ($0.327 against $0.354 per 1,000 held-out tasks; docs/research/probes.md).

D47 (docs/research/lean-probes.md), simulation, realistic, 4 seeds, perfect judge: compaction lowers model cost per turn
($0.0203 → $0.0180 per 1,000 turns with probes: the judge reads compacted candidates) and the agent's cost per task
(live held-out, $0.407 → $0.392 per 1,000 tasks). `judgeConfident`, off by default, adds a judge call on lookups whose
candidates all scored as sure: model calls per turn 0.21 → 0.28 and $0.0180 → $0.0245 per 1,000 turns with probes and
compaction (about +36%). Live, Eden with probes cost $0.407 per 1,000 held-out tasks against $0.370 for tools (the
agent's tokens fall, 3,045 → 1,714 input, but Eden's judge calls are added).

`packetDates` (D68, off by default) makes no model call and adds no state: it keeps the year compaction dropped and
adds an event's start. In-sample funnel (ALL, cards-v2 replayed, hidden and held-out 1–4, seeds 41–44, this session):
hidden packet bytes 105,331 → 106,993 over 268 tasks (+1.6%, about 6 bytes or 1–2 agent input tokens a task), control
41,560 → 42,495. A start with a time is 35 bytes (about 9 tokens); 14 of 536 tasks have one. The judge's
candidates are compacted without it, so the judge's input is unchanged. With the flag on, each delivery is rendered a
second time without it for usage learning (`usageText`): linear in the packet, no model call.

D73 (proposed, docs/research/gen-tokens.md; `compactAsk`, `askDedup`, `compactParts`, off by default) makes no model
call. No-model funnel, ALL, one ask per task, this session: bytes the agent reads per task 1,528 → 900 in-sample and
1,328 → 801 on dev6a/dev6b (ask answers 1,254 → 625 and 1,195 → 669), every task's delivered and askCited unchanged.
At 4 bytes a token and $0.053 per million input tokens that is about −$0.008 per 1,000 tasks, per read of each
packet and answer (an agent re-sending its context on later turns multiplies it). With `cardsEconomy` card sends fall
54–55% and card calls 48–49% (replayed; about −$0.019 per 1,000 tasks scaled from the measured $0.036, an estimate).
`askDedup` keeps per session the words each item's line showed (at most 64 items).

D48 (docs/research/sharper-grounds.md): shared calls and the topic probe only without people take probes from 11.8 to
7.9 source calls per lookup (simulation; baseline 5.6). `judgeContested` adds judge calls (0.21 → 0.25 per turn),
offset by 200-byte judge candidates: $0.0200 against probes' $0.0203 per 1,000 turns. Live, one run: Eden with D48's
settings $0.357, tools $0.329, Eden beside tools $0.329 per 1,000 held-out tasks; Eden's judge is about $0.034 of that
(live judge funnel). A cheaper judge model (mistral-nemo, $0.0097 per 1,000 tasks) let more decoys through.

D49–D53 (docs/research/combined-config.md): the conflict ground, the probe economy and dense packets add no model call.
With them (D53's configuration), simulation, realistic, 4 seeds, perfect judge: 7.79 source calls per lookup (F 7.86),
model calls per turn 0.253 (0.251), $0.02025 per 1,000 turns (F $0.0200), 433 bytes per needed fact (484). The probe
economy starts cold for each new user, so a user's first lookups make the wider calls `probeYield` sends before it has
learned which to skip (8.4 calls per task in the per-task funnel, which builds a new engine each task). The register's
background sweep (D51) added calls (10.4 per task) and was removed with it.

D57, proposed (background sync, "Eden Atlas", off by default; docs/research/moon-sync.md) adds no model call: the
sync makes listing calls only. With a judge it raises model cost, because the judge sees more candidates: simulation,
realistic, seeds 41–44, perfect judge, $0.0170 (H) → $0.0222–0.0223 (HA, two runs) per 1,000 turns (+31%), at the same input caps
(≤ 6 candidates of ≤ 200 bytes, ≤ 4k characters of window). Source calls fall: 7.78 → 0.86 request-time calls per
lookup, 1.72 with backfill and background amortised; in the per-task funnel, 8.5 → 3.04 per task (4.38 amortised).
A synced user costs about 4 MB of heap per ~1,500 items and ~200 ms of CPU to backfill (`sync-cost.ts`, the sync track's
measurement, not re-run). The combined funnel implies more, about 420 ms per user (16.9 s of extra process CPU over 40
users with ALL), because there the graph and the cards are built on every synced item too (below).

Anticipation (proposed D60, `anticipate`, off by default; docs/research/moon-anticipate.md) adds no model call on any
path: its predictions are fixed linear reads of an event's head, and its prefetches are source calls within
`anticipateCalls` (4 per event, `probeCalls` for a draft) and `anticipateSessionCalls` (24 per session). Measured
in-sample: source calls +1.0% to +3.5% in simulation, +3.9% connector searches per task in the dev funnel with a draft
lead-in; with the perfect judge, model calls per turn 0.213 → 0.226 and $0.0170 → $0.0182 per 1,000 turns (realistic,
seeds 41–44: more lookups reach the judge with candidates).

Combined (proposed D62, docs/research/moonshots.md; one session, in-sample, realistic seeds 41–44, perfect judge
modelled): R (H + `consequenceProbe`, `probeRoles`, `graph`, `graphMerge`, `cards`, `anticipate`) costs $0.0195 per
1,000 turns against H's $0.0170 (+15%), 0.231 model calls per turn (0.213), 7.88 source calls per lookup (7.78; 8.76
with no model); in the per-task funnel 9.94 calls per task against 8.49 (a draft's prefetch and the class query). R +
`sync` (ALL) costs $0.0243 (+43%, the judge sees more tied candidates) at 1.25 request-time calls per lookup, 2.10
with the sync's backfill and background; in the funnel 5.55 request-time calls per task, 6.89 amortised, with 18
listing calls to backfill each simulated user. Cards add the background enrichment above: on the blind suites' new
items this session, 41 calls at $0.000212 each ($0.0087), consistent with $0.003–0.004 per user-month at 50 new items
a day. Process CPU in the funnel (40 simulated users) rises 7.8 s → 24.7 s with ALL. The sync's backfill redacting
and recording mentions for every listed item is about a third of the rise (`sanitize` 2.9 s, `mentions` 2.4 s in the
telemetry spans), and the graph about 35% (the review's runs: ALL 31.5 s, ALL − `graph` 24.3 s; not re-run here).
The graph's build cost, measured after the review (D63; 20 users with full caches of 2,000 realistic items each):
heap 3.38 → 8.16 MB per user and cache-put CPU 120 → 361 ms per 2,000 items, about 48 GB more heap at the cache's
10,000 users per tenant. Request-time engine CPU stays under 1 ms per lookup at p50 for the graph walk and card
matching.

The judge, measured on ALL (D65, docs/research/econ-judge.md; in-sample). On the critical path it adds no facts and
costs time: in the full benchmark (D64), in-sample, paired, eden-judge − eden is −0.026 hidden at +1.10 s and +$0.039
per 1,000 tasks, so the recommended configuration has no judge. `judgeBehind` (off by default, not recommended) moves
it behind the no-model answer, where it can only add. It is one bounded judge call (the judge's caps and `Budget`) on a
lookup whose no-model answer left candidates out:
- funnel, seed 41: 0.93 calls per task, $0.0088 for 134 tasks ($0.066 per 1,000 tasks);
- live, seed 43: 0.90 calls per task, about $0.000024 a call (OpenRouter's reported cost), $0.017–0.022 per 1,000
  tasks against the judge on the path's $0.023.

At 20 tasks a user a day, that is about $0.012–0.040 per user-month. `syncPollBehind` (off by default) makes no model
call and no new poll: the poll a lookup used to wait for runs behind it. When that poll stores something, the lookup
is made again; it decides as a lookup behind a delivery (what is sure or grounded), so with a model configured it
makes no second judge call (a test counts one model call per event, flag on or off). Its synced sources then answer
locally, but sources that are not synced are searched live a second time. The in-sample worlds are static, so that second lookup never ran in any benchmark and its source calls are
unmeasured; in a live mailbox they scale with how often a poll finds something new.

The non-model costs (source API calls, hosting) are not modelled yet. Source calls may dominate for some connectors;
measure them per connector in M2. The query planner (D28), on by default in the server since D33, adds no model call.
After its iterations it makes 1.36–1.47x planner-off's source calls per lookup in the simulation at time 0 and
1.23–1.32x at real pacing (about 5.6–6.2 calls per lookup against 4.1–4.65), and 1.00–1.74 calls per lookup per
connector on the lab's real servers at the current settings; with `maxCalls: 1` it adds none
(docs/research/query-planner-results.md).
