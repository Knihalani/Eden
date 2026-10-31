# Anticipation: context ready before the request (track moon/anticipate, proposed D60)

Eden waited for a request before it looked anything up, so the request paid for every source call on its critical
path (about 0.7 s at the median and 1.5 s at the 95th percentile in the real-time funnel below), and the request's
wording fixed what was searched. Anticipation reads each event of a session for what the agent will need next and
fetches it in the background, so that when the request arrives its slow path is mostly a cache hit and, with no model,
the answer can go back on the observe call itself.

All numbers below come from commands run in this session on 31 October 2026, on a 4-CPU machine shared with six other
agents: wall times are noisy, CPU times are given beside them. Everything is in-sample (dev suites `hidden`,
`heldout`, `heldout2`–`heldout4`; the realistic, zoo-a and zoo-b simulations). The blind suites were not read or run.
No model was called: live spend $0.

## What it does (flag `anticipate`, off by default; `anticipate.ts`, `Partner.anticipate|prefetch|early`)

1. **Read every event, with no model.** A user message, a draft the user is still typing (new: `user_message` with
   `draft: true`), a tool call, a tool result or an arriving message is read over its first 600 characters
   (`predict`, linear, hostile-input tested): the names it mentions (`cleanEntities`, at most two), the days it
   schedules (`timeWindow`, only when it schedules: `isScheduling`), its action class (`consequence.ts`, for an
   imperative or an arriving message), and the names that followed that intent before for this user
   (`IntentPatterns`: intent → names in the titles of what was delivered after it, per user, bounded to 16 intents ×
   8 names, 10,000 users per tenant, dropped on `forget`, a name used after two sightings). From a tool's output only
   people the user's items have as parties are taken (`ItemCache.isPerson`), never the user (`selfOf`); a request's own
   names are its lookup's to probe and are not prefetched again in the session.
2. **Prefetch in the background**, one prefetch per session at a time (the latest waiting event replaces older ones),
   through the probes' own code (`probe`, with options): person, organisation and day probes, and the action class's
   constraint vocabulary (the consequence probe's query, once per class per session). Its answers land where the
   request's own probes look: the probe memo and the probe economy (`ProbeEconomy.answered`). Budget: a draft's names
   are the request's own, so a draft gets `probeCalls` (8); any other event `anticipateCalls` (4); a session
   `anticipateSessionCalls` (24) in all. With `probeShare`, a prefetch caches and records a source's whole answer (the
   planner's page of 8), so it can answer the planner's query for that name too.
3. **At the request.** Its probes reuse any answer a source gave the same query within `probeMemoMs` (no call); the
   planner's per-name query is answered from the same record (`seedShared`); a probe still running from a prefetch is
   waited for at most `probeGraceMs`; the action class's finds are read from the cache with no call (so the
   consequence ground of D54 works off the critical path, whatever `consequenceProbe` says).
4. **Decide from what is held (no model only).** Before the slow path, the request is ranked over the cache with the
   prefetched finds as probe finds (`early`): what is sure, else what the request's structure grounds (conflict,
   clash, absence, occasion, participant; never the fallback; never a stale copy) is delivered on the observe call
   itself. The slow path still runs behind it and adds only what is sure or grounded (`served`).
5. **With a judge, the slow path always decides.** A warm cache made the fast path deliver a lone sure item before
   the live search could add the second that makes it the judge's call (perfect-judge precision fell 0.952 → 0.878 in
   the first run); now with a model the request skips the fast path and `early`, and anticipation only makes its
   slow path cheaper.

Every flag off, the eval JSON equals the base (diffed, latency fields excluded). A draft is ignored with the flag off
(no session is opened). Ablation keys: `anticipateOff` "serve", "class", "learn", "names", "days", "tools".

## Simulation assumption: the lead-in

Neither the hidden suites nor the generated sessions carry anything the user typed before sending, so the request's
own first clause (to its first comma, sentence end, dash or "and/but/so": `sim/src/drafts.ts`) is sent as a draft
before it ("clause"), or, harsher, its first half by words ("half"). At `--time 0` the request follows once the
prefetch has finished (typing takes seconds, a prefetch milliseconds of CPU); at `--time 1` the request follows 1.5 s
later in real time (funnel) or log-normal 1.5 s (simulation, `--typing-ms`). A chat UI that streams its input box is
needed in production for the draft channel; without one, anticipation still runs on tool events and requests (rows
"no lead-in").

## Results

Recommended configuration: H plus `{"anticipate":true}` (row "H+A"). Funnel = dev suites, no model.

### Funnel, 12 seeds (41–52), `--time 0` (804 hidden + 804 control tasks)

| Config | Lead-in | Returned | Delivered | Decoys | Connector searches / task |
|---|---|---|---|---|---|
| H | (ignored) | 434 | 381 | 64 | 9.23 |
| H+A | clause | 467 | 410 | 64 | 9.59 (+3.9%) |
| H+A | half | 470 | 412 | 62 | 9.71 (+5.2%) |
| H+A | none | 442 | 398 | 58 | 9.76 |

Of the 474 planted items H+A delivered (clause, hidden and control), 369 had been prefetched before the request and
463 came on the observe call itself. Ablations (12 seeds, clause, build F before the page-size change, which delivered 416 / 64): class vocabulary off 405 / 70 decoys; learning off
416 / 64 (no measurable effect: in the funnel each user sees each template once). Seeds 41–44 alone: H 148/128/21,
H+A clause 154/132/21. "Connector searches" are counted at the connector: the engine's own trace count (`calls` in
the funnel table) undercounts a lookup's probes that finish after its grace, and counts every prefetch call, so it
overstated the cost (8.50 → 9.24 per task).

### Funnel, real time (`--time 1`, connectors at their realistic latencies, seeds 41–44, 268 + 268 tasks)

| Config | Delivered | Decoys | Planted delivery p50 / p95 (ms, wall) | Observe p50 / p95 | Searches / task | CPU (user+sys) |
|---|---|---|---|---|---|---|
| H, clause lead-in | 111 | 16 | 708 / 1,502 | 699 / 1,502 | 8.98 | 19.1 s |
| H+A, clause lead-in | 127 | 20 | 3.4 / 1,214 | 396 / 1,289 | 9.51 | 23.6 s |
| H, no lead-in | 103 | 18 | 717 / 1,503 | 719 / 1,502 | 9.02 | 18.0 s |
| H+A, no lead-in | 107 | 16 | 754 / 1,504 | 705 / 1,503 | 9.36 | 19.3 s (F build) |

With a draft, 146 of 147 delivered planted items came back on the observe call, 114 of them prefetched; the median
delivery is the time to decide from the cache. The 95th percentile is the requests that still need their live search
(sources at 1.5 s timeout). Without a lead-in there is no latency gain: a request's own event is too late to prefetch
for. CPU for the whole run rises about 24% (prefetches and the decision from the cache). The no-lead-in H+A row is the
build before the final page-size change (F); the others are the final build.

### Simulation, no model and perfect judge, 4 seeds (41–44), `--drafts clause`, time 0

| Mix | Judge | H recall / precision / soft | H+A recall / precision / soft | Source calls (total) |
|---|---|---|---|---|
| realistic | none | .407 / .639 / .086 | .424 / .642 / .057 | 15,827 → 16,160 (+2.1%) |
| realistic | perfect | .645 / .952 / .045 | .654 / .972 / .017 | 15,906 → 16,064 (+1.0%) |
| zoo-a | none | .400 / .637 / .090 | .415 / .635 / .074 | 15,362 → 15,894 (+3.5%) |
| zoo-a | perfect | .613 / .954 / .050 | .635 / .970 / .017 | 15,445 → 15,736 (+1.9%) |
| zoo-b | none | .435 / .627 / .178 | .448 / .631 / .119 | 16,036 → 16,347 (+1.9%) |
| zoo-b | perfect | .738 / .969 / .033 | .733 / .978 / .017 | 16,040 → 16,119 (+0.5%) |

No hard false fires anywhere. Model calls per turn with the perfect judge: realistic 0.213 → 0.226, $0.0170 → $0.0182
per 1,000 turns (+7%; more lookups reach the judge with candidates); zoo-a 0.214 → 0.223; zoo-b 0.248 → 0.250. Bytes
per needed fact (perfect): 432 → 427 realistic. Of must facts delivered (realistic, no model), 237 of 321 were in an
item the session had prefetched, 203 came on the observe call. Without drafts (realistic): .410 / .629 / .086 no model,
.662 / .968 / .017 perfect.

Ablations on the realistic mix (build F, before the page-size change; no model / perfect recall): all .429 / .645;
class off .431 / .647; learning off .432 / .642; serve off .420 / .645; tool events off .428 / .633; names and days off
.408 / .650. The names a draft carries do the work; the class read pays in the funnel (+11 deliveries of 804) and not
in the simulation, whose world has few constraint notices; learning shows nothing measurable in either.

### Latency tier (bench.ts `--latency` shape: realistic, 3 users × 6 sessions, real time, seeds 41–44, `--drafts clause`)

| Judge | H delivery p50 / p95 (ms) | H+A delivery p50 / p95 | H recall | H+A recall |
|---|---|---|---|---|
| none | 2,723 / 5,367 | 498 / 5,023 | .338 (47/139) | .388 (54/139) |
| perfect | 3,153 / 33,767 | 3,089 / 37,699 | .460 (64/139) | .518 (72/139) |

Per-seed percentiles averaged over 4 seeds; small samples (139 must facts). Without `waitMs` the harness collects a
slow-path delivery after the agent's next pause (about 2.5 s), so H's median is the pause; H+A's median is a
delivery made on the observe call. With a judge nothing changes on the critical path (by design, step 5). Process CPU
over the four seeds: none 19.8 s → 20.3 s, perfect 19.5 s → 20.2 s.

## Cost

No model call is added (none on any path; nothing for docs/COST-MODEL.md beyond a note). Source calls: +1 to +3.5%
in simulation, +3.9% at the connector in the funnel with a clause lead-in, +5.2% with a half-sentence one. The judge
is reached a little more often with a model (above).

## Risks and limits

- The latency win needs a draft channel (an input box streamed to Eden); tool events and arriving messages alone
  gave recall (+4 to +17 deliveries in the funnel) but no latency.
- Deciding from the cache can deliver an older copy than the live search would (bounded by D40's two hours) and
  cannot see a fresher "resolved" note the live search would have quieted (`quietClear`); decoys stayed flat (64 → 64
  clause, 62 half) in the funnel.
- A wrong draft (half a name, a different person) spends probe calls on names the request never uses; the session
  and per-event budgets bound it.
- Changing the order of source-map sampling and economy records perturbs later lookups: individual tasks churn in
  both directions (12-seed totals above are the honest comparison, not per-task diffs).
- Learning of intent → names showed no measurable effect in-sample; it is kept, bounded and per user, behind
  `anticipateOff: ["learn"]`.
