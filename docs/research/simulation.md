# Simulation: how Eden behaves in a realistic world

What `packages/sim` is, what it measured, what it found, and what it cannot tell us. Every number below came from a
command run on 2026-10-27 on this repository (4 vCPU Intel Xeon @ 2.10 GHz shared cloud VM, Bun 1.4.4); commands are
under [Reproduce](#reproduce). Modelled or assumed inputs are labelled where they appear.

**In one paragraph.** With connectors that behave like real ones (Gmail-style AND search, snippets), Eden gets
**13–20% of needed facts** to the agent before it answers, never more than the 21% the connectors return at all.
With ideal connectors (ranked full-text search) 74% of facts are within reach, and the same engine delivers **24%
without a model and 58–63% with a judge** (modelled: an imperfect one and a perfect one). The judge's own mistakes
then set the false-fire rate: hard false fires are **0.1–0.4%** without a judge or with a perfect one and **2–7%**
with a judge that wrongly picks 5% of candidates. No planted secret ever reached the agent (**0 of 2,160**). Over
HTTP the fast path answers in **under 1 ms at the median, under 5 ms at p99** at production-like load, and under 50 ms
at p99 up to **~1,800 events/s** on one core. The binding constraints are retrieval (query construction per connector,
vocabulary mismatch, bulk mail) and the judge's precision, not speed.

## What is simulated

**A user's world** (`world.ts`), seeded and deterministic: ~1,500 items across five sources (Gmail, Calendar,
Drive/Notion, a CRM, Slack), median 550 characters, p90 3.8 KB. Around 30 *arcs* leave traces across sources the way
life does: a lunch is a calendar event, a scheduling thread in which the friend states a constraint ("I'm vegetarian",
"I can't do anything before 12:15"), and sometimes an invite email; a deal is a CRM record, a pricing thread ("if you
can do 12% off we can sign by…"), call notes (sometimes a "(copy)") and an upcoming call; also trips (airline and
hotel confirmations, a calendar block), Jira tickets (status notifications, a Slack thread with the blocker), vendor
invoices (and payment confirmations), a landlord, a dentist, a gift list, a school trip, a 1:1 agenda. Each arc states
*facts*; every item records which facts it states, so a quoted reply or a synced copy counts the same as the original.

Around the arcs, noise in realistic proportion (~85% of items): newsletters that share vocabulary with work
("pricing", "renewal", client names in the news; some delivered twice), automated notifications with legal footers,
promotions, unrelated threads among the same colleagues and clients, calendar holds, generic docs, CRM accounts with
no story. People stress entity matching: two Sams and two Danas on different sides, nicknames (Alexander/Alex), names
that are words (Will, Rose, May), very short names (Al, Bo, Jo), accents (Zoë Müller, José García, Łukasz Nowak).
Emails have greetings, sign-offs, corporate signatures, confidentiality footers, "Sent from my iPhone", quoted history
(85% of replies keep it) and forwards. Four secrets per user (a Stripe key, an AWS key pair, a GitHub token, a Wi-Fi
password) and three prompt-injection emails are planted.

**Connectors** (`sources.ts`), two presets and a variant:

| Preset | Search | Body | Latency (assumed) | Errors |
|---|---|---|---|---|
| `IDEAL` | ranked BM25 over title and body, every source | full | none | none |
| `REALISTIC` | Gmail and Slack: every term must match, newest first; Calendar: every term, within −7…+60 days; Drive: ranked; CRM: record names | Gmail 300-char snippets, Drive 500 | log-normal, medians 180–450 ms | 0.3–0.5%, 429 past 5–10 req/s per user |
| `REALISTIC_ENTITIES` | as `REALISTIC`, but the integrator searches by the cue's entities when it has any | | | |

The latency and error figures are assumptions, plausible for third-party APIs in the same region; they are inputs to
vary, not measurements of any provider.

**Sessions with ground truth** (`sessions.ts`). A session is one to four tasks as a personal agent sees them: the
user asks (reschedule, prep for a call, reply about pricing, when's my flight, status of OPS-142, did we pay the
Hooli invoice, when's the boiler engineer coming…); the agent may call its own tool first (40% by default; its result
carries one needed item); it answers, mentioning the details it has (which drives Eden's usage learning); the user
may follow up ("make it 30 mins later instead") or say thanks. Interleaved: requests the user's data cannot help
with ("write a haiku"), new people and places ("book a table at Kiln with Hannah"), passing mentions of known people
("Jamie says hi"), and inbound events ("New email from Sam Ortiz: can we get on a call about the contract?"). How the
user refers to the subject is varied and recorded: full name, first name (sometimes shared), nickname, role ("my
landlord"), organisation, ticket id, or topic alone; 20% of messages are all lowercase and 5% carry a typo.

Every turn is labelled: `need` (facts that should arrive, and others that may), `context` (inside a task, nothing
new needed: deliveries count only if relevant), `silent` (nothing should arrive), or `silent/soft` (a passing mention:
a delivery is unhelpful, reported apart from hard false fires).

**The integration** follows the client SDK's documented loop: observe every event, then collect the returned
injection and anything pending before the agent's next model call. Simulated time advances by realistic agent pacing
(model think time ~2.5–3 s, tool calls ~0.6 s, ~20 s until the user's next message, hours between sessions, so cache
TTLs apply).

**The judge.** The OpenRouter key available in this session has a $0.01 lifetime limit, which the first live run
exhausted (`403 Key limit exceeded … does not reset`), so no live-model numbers are reported. In the model's place,
an *oracle judge* (`judge.ts`) reads the engine's real judge prompt, maps candidates back to world items, and answers
with the JSON the engine parses: **perfect** (picks every relevant candidate, nothing else: the ceiling of the model
path) or **noisy** (picks a relevant candidate with p 0.85 and an irrelevant one with p 0.05: assumed figures for a
cheap model). Its cost is priced at the default model's list price ($0.15 / $0.50 per M tokens). These are models of
a judge, not measurements of one.

**Metrics** (`quality.ts`), fact by fact: precision (delivered items relevant to their turn), *lenient* precision
(also counting items about the task's person or organisation, e.g. an unrelated thread with the same client), recall
(needed facts delivered for their turn), in-time recall (arrived before the agent's answer), coverage (the agent had
the fact by its answer, from Eden or its own tools), hard and soft false-fire rates, redundancy, noise share,
injection size, a retrieval funnel (needed fact in the cache, returned by a source, shown to the judge or decided
without it, delivered), `ask()` recall@5 and MRR, privacy (planted secrets in anything delivered, injection items
delivered and whether wrapped as inert data), cost, and breakdowns by task, reference style, ambiguity and session
ordinal.

## Quality

20 users × 20 sessions × 3 seeds per row (2,511 needed facts, 1,500–2,200 silent turns); 95% Wilson intervals.
"Available" is the share of needed facts in the cache or returned by a source for the turn; "judged" the share shown
to the judge or delivered without it. Judges are modelled (see above).

| Connectors | Judge | Precision | Recall (in time) | Hard false fires | Available | Judged |
|---|---|---|---|---|---:|---:|
| ideal | none | 0.543 [0.518–0.567] | 0.236 [0.220–0.253] | 0.004 [0.002–0.008] | 0.74 | 0.24 |
| ideal | noisy | 0.685 [0.669–0.700] | 0.584 [0.564–0.603] | 0.069 [0.058–0.081] | 0.73 | 0.62 |
| ideal | perfect | 0.794 [0.780–0.808] | 0.633 [0.614–0.652] | 0.004 [0.002–0.008] | 0.74 | 0.63 |
| realistic | none | 0.585 [0.550–0.620] | 0.128 [0.116–0.142] | 0.001 [0.000–0.003] | 0.21 | 0.13 |
| realistic | noisy | 0.626 [0.599–0.652] | 0.191 [0.176–0.207] | 0.020 [0.014–0.027] | 0.21 | 0.20 |
| realistic | perfect | 0.746 [0.721–0.770] | 0.201 [0.186–0.217] | 0.001 [0.000–0.003] | 0.21 | 0.20 |
| realistic, entity queries | none | 0.549 [0.520–0.578] | 0.168 [0.154–0.183] | 0.001 [0.000–0.003] | 0.40 | 0.17 |
| realistic, entity queries | noisy | 0.651 [0.630–0.671] | 0.324 [0.306–0.343] | 0.032 [0.025–0.041] | 0.40 | 0.34 |
| realistic, entity queries | perfect | 0.751 [0.731–0.769] | 0.341 [0.323–0.360] | 0.001 [0.000–0.003] | 0.40 | 0.34 |

Recall equals in-time recall in instant runs; with real-time pacing they differ by under a point (Timeliness below).
The tables below this one (breakdowns, lenient precision, timeliness, sensitivity) come from runs made before a final
fix to the oracle's matching of same-titled replies, which moved the judge rows above by 1–2 points; read them to that
precision.

| Connectors | Judge | Lenient precision | Soft fires (passing mentions) | `ask` recall@5 | `ask` MRR | `ask` empty | Judge cost per 1k turns |
|---|---|---:|---:|---:|---:|---:|---:|
| ideal | noisy | 0.833 | 0.466 | 0.857 | 0.578 | 0.000 | $0.028 |
| ideal | perfect | 0.919 | 0.288 | 0.857 | 0.577 | 0.000 | $0.028 |
| realistic | noisy | 0.810 | 0.224 | 0.642 | 0.508 | 0.175 | $0.018 |
| realistic, entity queries | noisy | 0.820 | 0.391 | 0.795 | 0.565 | 0.073 | $0.021 |

Injections carry 1.3–1.8 items, 460–680 bytes at the median and 1.0–1.2 KB at p95 (the 1,200-byte cap). Each
lookup asks ~4 sources; 36–54% of the items they return state a fact. Privacy across all 27 runs: **0 of 2,160
planted secrets** appeared in any injection or `ask` answer; **5** prompt-injection emails were delivered, all inside
the data-not-instructions envelope.

**What limits recall.** The funnel says where facts are lost:

- *Retrieval, with real connectors.* AND-semantics search over Eden's multi-term cue mostly returns nothing: only 21%
  of needed facts are returned or cached, against 74% with ranked search; searching by entities alone recovers to
  40%. No judge can deliver what never arrived: on realistic connectors a perfect judge lifts recall from 0.128 to
  0.201, on ideal ones from 0.236 to 0.633.
- *The judge*, once retrieval works. Without a model the engine delivers only what clears the confident threshold
  (24% of facts with ideal connectors); a judge more than doubles that. Its false picks are the false fires: a judge
  that picks 5% of irrelevant candidates gives 6.9% hard false fires, concentrated where a turn has a cue but needs
  nothing (new people and places 43 of 380 turns, requests the data cannot help with 49 of 670). Judge precision
  matters as much as recall.
- *Vocabulary mismatch*, with any connector. Recall by task (ideal, noisy judge): "anything for Maya's school
  trip?" **0.06** (the teacher's email never names Maya), "how's the data migration going?" **0.20** (the blocker
  message names the ticket, not the topic), "which hotel in Lisbon?" **0.20**, "status of OPS-142?" **0.23**, "draft a
  reply about the discount" **0.46** (the email says "12% off").
- *Bulk mail crowds out personal items.* Newsletters repeat "flight", "hotel", city and client names; 10–23% of
  delivered items are noise, and a 4x larger mailbox lowers ideal-connector precision from 0.652 [0.623–0.679] to
  0.606 [0.577–0.634] and recall from 0.560 to 0.513 (one seed).
- *Passing mentions* of known people ("Jamie says hi") trigger a delivery 17–47% of the time.

Where the words line up, Eden does well (ideal, noisy judge): "when's my lunch with X" 0.91, rescheduling 0.75, the
dentist 0.75, invoice amounts 0.76, inbound meeting and invoice emails 0.69. By reference style: first name 0.71,
full name 0.59, nickname 0.59 (n=27), organisation 0.56, topic 0.52, role 0.47, ticket id 0.23. Role references have
the best precision (0.84): "my landlord" maps to one thread.

**Across sessions.** With a judge, recall rises over each user's sessions (ideal, noisy judge, mean of three seeds:
first, middle, last third 0.522 / 0.598 / 0.603), while each lookup keeps asking 3 sources: the cache warming up fits
this; a change in routing does not show.

**The agent's own tools** (ideal, noisy judge, one seed). Coverage (the agent had the fact by its answer from any
route) rises from 0.599 with no agent tool use to 0.703 at 40% and 0.835 at 80%, while Eden's recall stays at
0.56–0.59; 10–12% of what Eden delivers duplicates what the agent already had.

### Timeliness

Real-time runs at time scale 0.1 (source latency, judge latency and agent pacing all one tenth; times below are
converted back to real time), 12 users × 10 sessions, noisy judge:

| Connectors | Integration `waitMs` (real) | Recall | In-time recall | Time to context p50 / p95 (real) |
|---|---:|---:|---:|---:|
| realistic | 0 | 0.164 | 0.160 | 2.0 s / 5.8 s |
| realistic | 2,000 | 0.172 | 0.172 | 0.6 s / 2.0 s |
| ideal | 0 | 0.521 | 0.517 | 2.0 s / 6.4 s |
| ideal | 300 | 0.521 | 0.521 | 2.0 s / 4.2 s |

A slow-path result lands within the agent's own think time in almost every case, so waiting inside `observe` buys
little: in-time recall moves by under a point. `waitMs` 0 is right for integrations.

## Findings fixed in this change

The simulation found four engine problems; each is fixed with a test that fails without the fix.

1. **The source fan-out ran on the wall clock while the rest of the engine ran on the injected clock.** Rate limits,
   result freshness and breakers ignored `PartnerDeps.now`: 12 questions spread over 12 simulated minutes were rate
   limited at 10. The partner now passes its clock to `SourceFanout`.
2. **Mentions were counted per sighting.** Every lookup that returned an item recorded its entities again, so an item
   returned by ten lookups weighed ten times in routing. Mentions are now recorded when an item enters the user's
   cache or its words change, and written with each source's items before the engine yields (a session closing
   between two sources must not leave cached items whose mentions never land; review finding).
3. **Re-indexing unchanged items.** `ItemCache.put` re-tokenized, re-indexed and re-sketched every returned item,
   though most lookups return items the cache already holds; an item with the same words is now only refreshed
   (taking the new copy's url, metadata and timestamp). With (2) and (4), this took the saturation point from ~2,840
   to ~3,320 events/s; writing mentions per source rather than once per lookup brought it back to ~3,000
   (Performance).
4. **Per-user memory.** Each user's cache preallocated a 4,096-term vocabulary and a sketcher with 96 KB of
   per-text scratch; the scratch is now shared by all sketchers (reading it after another sketcher's `load` throws)
   and the vocabulary starts at 256 terms. Heap per warm user: ~340 KB → ~165 KB.

The dedup benchmark shows no consistent speed change from (4) across three before/after rounds (16 KB load: before
103–145 µs, after 101–134 µs); quality metrics are unchanged within one fact in 178.

Harness bugs found and fixed on the way, kept here because each one first looked like an engine result: the slow path
cut off by sessions ending at simulated time 0 (recall under-counted); the simulated token bucket converting time
the wrong way; simulated connectors' linear scans running inside the server process (a third of its CPU);
generator-side session building stalling the load generator; harness setup counted as engine latency; arrival
rounding that made coverage lower than recall; and, found by review, an oracle judge that answered with line numbers
instead of candidate numbers and missed titles containing " — " (it understated every judge row and led to a wrong
first conclusion, "not the judge"), and that read its labels after its latency sleep.

## Performance

The real server (`createHandler` and `ContextPartner`, file-backed source map, 10 tenants) runs in its own process
(`server.ts`) over simulated connectors; simulated agents drive it over HTTP through the real client SDK
(`load.ts`: observe every event, then collect pending). Every report includes the load generator's own CPU and
event-loop lag, so a generator-bound run shows as one; none of the runs below were. The simulator's 20 worlds and
connector indexes occupy ~620 MB of the server's heap at zero users; memory figures below are differences from that.

**Calibration.** The same server answered 59,000–71,000 `/healthz` requests/s (16–64 concurrent) and 41,000
`/v1/pending` requests/s (256 concurrent) from one client process: HTTP is not the limit anywhere below.

**Production-like load** (`steady`): 300 users at real pacing, real (simulated) connector latency, 90 s, final code:
38.9 events/s (86 requests/s), no failed calls, server CPU 8.2% of one core, event-loop lag p99 1.2 ms.

| Call (client-side, over HTTP) | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|
| `observe`, all events | 0.88 ms | 1.65 ms | 3.56 ms | 62 ms |
| `observe`, user message | 1.09 ms | 1.82 ms | 4.06 ms | 62 ms |
| `pending` | 0.42 ms | 0.84 ms | 2.19 ms | 21 ms |
| `ask` (searches live; connector latency dominates) | 572 ms | 1,390 ms | 1,502 ms | 1,502 ms |

Inside the server (handler entry to response, 45 s run), per event kind at p50 / p99: user message 0.47 / 1.11 ms,
external 0.60 / 2.24 ms, tool result 0.35 / 0.98 ms, tool call 0.26 / 0.52 ms, agent message 0.24 / 0.74 ms,
session start 0.19 / 0.74 ms, session end 0.06 / 0.42 ms, pending 0.04 / 0.15 ms. (Clients saw `session_end` take
~9–12 ms at p50 although the server spent 0.06 ms on it; the gap is outside the server's handler and its cause was
not established. Connection reuse after the agent's long idle gap is a guess, **unverified**.)

Time to context for turns that needed it: p50 1.39 s, p95 3.88 s; 8.9% of need turns had their fact before the
agent's answer (realistic connectors, no model). With a model stand-in (`--model fake`: log-normal latency, median
900 ms, assumed; real token counts at list price): 565 judge calls for 3,517 events, $0.0288, about **$0.008 per
1,000 events**; `ask` p50 rises to 1,476 ms; `observe` is unchanged (p99 4.1 ms): the model is off the fast path.

**Saturation** (`ramp`): pacing and connector latency compressed 10x, so each simulated user sends ten real users'
traffic; users double every 20 s; tenant rate limits lifted to find the server's own limit (final code):

| Users | Events/s | `observe` p50 | p99 | Server CPU | Lag p99 | Failed |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 115 | 0.81 ms | 4.3 ms | 19% | 2.2 ms | 0 |
| 400 | 464 | 0.61 ms | 10.5 ms | 29% | 2.8 ms | 0 |
| 800 | 915 | 0.58 ms | 7.5 ms | 47% | 5.1 ms | 0 |
| 1,600 | 1,788 | 0.76 ms | 43 ms | 76% | 19.9 ms | 0 |
| 3,200 | 3,210 | 30 ms | 441 ms | 105% | 59 ms | 0 |
| 6,400 | 3,324 | 496 ms | 802 ms | 108% | 164 ms | 13% (SDK timeouts) |

One server process on one core sustains **~1,800 events/s with p99 under 50 ms**, and saturates at ~3,300 events/s
(before the fixes above: p99 71 ms at 1,600 users, saturation ~2,840). After the review fixes (mentions written per
source) a second ramp gave 1,792 events/s at p99 20 ms and saturation at ~3,000 events/s (3,200 users: 2,971
events/s, p50 73 ms; 6,400 users: 3,052, 21% SDK timeouts). At the steady scenario's per-user rate (0.13
events/s while active), 1,800 events/s is ~14,000 concurrently active users per core. With the default per-tenant
limit (200 requests/s, burst 400; ~2.2 requests per event with the SDK's loop) one tenant gets ~90 events/s, about
700 concurrently active users: in the first ramp, with ten tenants at the default, 39% of calls failed open (429) at
1,600 requests/s in total. Size `EDEN_TENANT_RPS` per tenant from its user count.

At saturation (profile taken before the fixes), the server's CPU went to the lookup path: the source map's SQLite
(~16%: per-sighting mention upserts and several routing queries per lookup), storing items (~12%), redaction (~8%),
entity extraction for mentions (~6%). The first two were what fixes 2 and 3 removed.

**Memory** (`memory`): heap after forced GC, after each new user ran three sessions:

| Users | Heap, before the fixes | Heap, final | Per added user, final |
|---:|---:|---:|---:|
| 0 | 625 MB | 623 MB | |
| 250 | 722 MB | 679 MB | 223 KB |
| 500 | 806 MB | 719 MB | 163 KB |
| 1,000 | 980 MB | 806 MB | 173 KB |
| 2,000 | 1,318 MB | 970 MB | 164 KB |

**Soak** (`soak --minutes 20`): 300 users for 20 minutes with the server clock at 144x (48 simulated hours: cache
TTLs, idle sessions, daily budgets turn over): no failed calls, `observe` p99 stable, lag p99 1.1–1.4 ms, CPU 11% →
7%. Heap after GC went from 677 MB to 732 MB, 34.5 MB in the first simulated day and 18 MB in the second: slowing,
not flat. The largest per-user bound left is the vocabulary rebuild threshold (`MIN_VOCAB_REBUILD`, 50,000 terms a
user, several MB with term strings), which a real, ever-growing mailbox would reach and this 48-hour run did not.

**Faults** (`faults`): 300 users at real pacing; Gmail down (503) for 30 s, Drive 5x slower for 30 s, the CRM limited
to 0.2 requests/s per user (429s) for 30 s. Gmail returned 217 errors and the CRM 199 429s; none reached the agent:

| Window | Events | Worst 5 s `observe` p99 | Failed calls | In-time recall |
|---|---:|---:|---:|---:|
| before | 443 | 4.9 ms | 0 | 0.101 |
| Gmail outage | 982 | 7.4 ms | 0 | 0.069 |
| between | 500 | 3.2 ms | 0 | 0.147 |
| Drive 5x slower | 957 | 5.0 ms | 0 | 0.062 |
| between | 485 | 3.3 ms | 0 | 0.081 |
| CRM 429 storm | 992 | 8.7 ms | 0 | 0.110 |
| after | 496 | 7.8 ms | 0 | 0.139 |

Faults cost recall while they last (windows hold 100–250 need turns, so read the column as indicative) and never
latency or errors at the edge.

## What to do next, by expected effect

1. **Query construction per connector** (M2). With AND-search connectors only 21% of needed facts are reachable;
   searching by entities alone reaches 40%, ranked search 74%. Short queries per connector (an entity plus one or two
   key terms, several queries instead of one, `OR` where the connector's syntax has it) are the largest lever found.
2. **Vocabulary mismatch.** "Discount" vs "12% off", a topic vs the ticket key, a child's name absent from the
   school's email: lexical retrieval cannot bridge these. Candidates: query expansion from the user's own vocabulary
   (the source map knows which entities co-occur), a learned sparse or small embedding model offline over cached
   items, or a budgeted model rewrite of the cue on the slow path (with a cost estimate, per the model-last rule).
3. **Demote bulk mail.** Newsletters and notifications are 15–23% of what is delivered and crowd out travel and
   personal facts. Signals connectors provide: list headers, no-reply senders, whether the user ever replied.
4. **Judge precision.** Once retrieval works the judge more than doubles recall, and its false picks become the false
   fires (2–7% with a judge that wrongly picks 5% of candidates); passing mentions of known people trigger deliveries
   17–47% of the time. Measure the real model's pick accuracy (it could not be measured here) and give the judge a
   stricter bar for turns that name no task.
5. **Learning**: routing asks the same number of sources throughout; recall rises across sessions as the cache warms.
   Explicit feedback would let routing learn faster than inferred usage does.
6. **Bound per-user vocabulary growth** below 50,000 terms, and cache the source map's routing reads in memory.

## What this cannot tell

- **Text written by templates.** The world's wording comes from the same project as the engine; it is varied
  (quotes, signatures, paraphrase, typos, lowercase), but a model-written corpus would be a stronger test. The plan
  was to render the world with the live model; the key's $0.01 limit stopped it (and every live-model number).
- **The judge is modelled**, not measured: the perfect judge bounds the model path, the noisy one assumes accuracies.
- **Connector behaviour and latency are assumptions** about real APIs, chosen to be plausible. In accelerated soak
  runs the simulated connectors rate-limit on real time while the engine runs on the accelerated clock.
- **One world shape**: one persona (a partnerships lead with a family), ~1,500 items; real mailboxes are larger
  (the 4x-noise run is the only probe of that).
- **Ramp compression**: each simulated user sends ten real users' traffic; memory per real user is the memory
  scenario's figure, not the ramp's.
- **One machine**: the load generator and the server share 4 vCPUs.

## Reproduce

```bash
bun run sim -- --profile realistic --users 20 --sessions 20 --seed 1 --judge noisy   # quality, JSON report
bun run sim -- --profile ideal --users 12 --sessions 10 --judge noisy --time 0.1     # timeliness (real time / 10)
bun run sim:perf steady                     # also: ramp [--tenant-rps 100000], memory, soak [--minutes 20], faults, cold
PROFILE=/tmp/prof bun run sim:perf hot --tenant-rps 100000                          # server CPU profile at saturation
```

Profiles: `ideal`, `realistic`, `entities`; judges: `none`, `noisy`, `perfect`; `--noise 4` for a larger mailbox,
`--tool-rate` for how often the agent fetches context itself, `--model fake` for a model stand-in in perf runs,
`--updates R` for items that change at the source between sessions (stale cached copies, [refresh.md](refresh.md)).
