# Architecture

```
            agent (tenant's)                                 Eden context partner
 ┌─────────────────────────────┐   events    ┌──────────────────────────────────────────────────────────┐
 │ user msg / agent msg / tool │ ──────────▶ │ server (HTTP API, MCP ask_context)                        │
 │ call / tool result / external│            │   │                                                       │
 │                             │ ◀────────── │   ▼                                                       │
 │ prompt ← withContext(inj)   │  injection  │ engine: ContextPartner                                    │
 │ tool:   ask_context(q)      │ ◀─answer─── │   observe ─▶ cue ─▶ FAST: item cache (BM25) ─▶ confident? │
 └─────────────────────────────┘             │                     │ no                       │ yes → inject│
                                             │                     ▼                                     │
                                             │          SLOW (background): route (source map) ─▶ sources  │
                                             │                ─▶ cache ─▶ score ─▶ confident? inject      │
                                             │                ─▶ borderline? judge if wired ─▶ inject      │
                                             │                ─▶ acts? model reader (budget) ─▶ push       │
                                             │                ─▶ queue; delivered at the next event       │
                                             │   usage inference ─▶ sourceMap.recordOutcome (learning)   │
                                             └──────────────────────────────────────────────────────────┘
                                                  │ read-only            │ ZDR routing
                                                  ▼                      ▼
                                       user's sources (MCP)       OpenRouter (Haiku 5.5): cards,
                                                                  intent, reader; no judge wired
```

## Packages

| Package | Role |
|---|---|
| `packages/protocol` | Wire types (`AgentEvent`, `ContextItem`, `Injection`, `AskRequest`…), ids, input validation. |
| `packages/primitives` | Benchmarked building blocks: hashing, tokenizer + interner, multi-pattern matcher, top-k, BM25F sparse index, S3-FIFO cache, deadline, singleflight, GCRA, circuit breaker, AIMD limiter, histogram, reply stripping and near-duplicate sketches, calibration and certification statistics, Thompson sampling, budgeted packing, worker pool (D25, D26) ([research/primitives.md](research/primitives.md)). |
| `packages/redact` | The secret gate (salvaged): gitleaks rules plus extras, prefiltered by one Aho–Corasick pass; the rules that backtrack in JavaScript and every allowlist run on RE2 (re2js, D24). Runs on everything stored, indexed or sent to a model. |
| `packages/sources` | `Source` interface; `McpSource` (any MCP server's read tools, read-only enforced; arguments from the tool's schema when no mapping is given; an optional fetch tool that reads one record by id, D35, not called by the engine since D121 deleted the fetch refresh; reconnects after a dropped connection, re-checking read-only, and waits 30 s after one that closes within 5 s of connecting; reads every page of `tools/list`); `StaticSource`; `QueryPlanner` (what each lookup sends to each connector, learned per user; D28, on by default in the server since D33); `SourceFanout`: per-source deadlines, coalescing, a result cache that serves stale on failure, rate limits, circuit breakers and adaptive concurrency, redacting before anything is held. A call is admitted only when every guard allows it, so a skip spends no rate token and no half-open probe; a failure of our own redaction says nothing against the source; a breaker ignores reports from calls allowed before it last opened. A search or re-read returns at its deadline even when the source ignores its signal (the call is abandoned, its permit settled); a lookup waits for its on-demand listing only until its deadline. |
| `packages/graph` | The source map (what is left of the knowledge graph after D225): which sources mention which entities, and learned usefulness per situation. SQLite. |
| `packages/llm` | `Model` interface, OpenRouter client (ZDR, no data collection), pricing, `Budget` (per session and per user-day) and `TenantSpend` (one cap per tenant per UTC day across roles), `FakeModel`. |
| `packages/engine` | `ContextPartner`: cues, a per-user BM25F item cache (title, body), near-duplicate suppression, ledger, two-speed pipeline, the default's parts (`DEFAULT_CONFIG`, `PARTS` in `parts.ts`, D112), an optional model judge, usage inference, traces; span tracing of every phase in wall and CPU time, off by default (`spans.ts`, `onSpan`, `config.spans`; content-free; an observability toggle, not a product switch, D121; [research/moon-telemetry.md](research/moon-telemetry.md)). Each event is tokenized once, into a per-session vocabulary. |
| `packages/server` | HTTP API (tenant API keys, per-tenant rate limit: `EDEN_TENANT_RPS`, `EDEN_TENANT_BURST`), the multi-process router (`EDEN_PROCESSES`, default the core count, D163, D178), `?shadow=1` on events and pending for a trial that injects nothing (nothing learned from it, D282), MCP server
exposing `ask_context` (it moves to a new session after 2 h with no ask or at UTC midnight, ending the old one once its asks in flight return, D281), config, wiring; an optional worker pool that redacts lookup results (`EDEN_GATE_WORKERS`, D26). Runs `DEFAULT_CONFIG` (D112; `EDEN_ENGINE_CONFIG` overrides keys, D103). Model roles (`models.ts`): with `OPENROUTER_API_KEY`, cards and intent (background, price-routed) and the ask-time reader (request path) run on `EDEN_MODEL` (default `anthropic/claude-haiku-5.5`, D12's ZDR routing), each with its own `Budget`, all of a tenant's roles under one cap per UTC day (`EDEN_MODEL_USD_PER_TENANT_DAY`, default $25); no judge is wired. Without a key no role is built and the same default runs its no-model path. |
| `packages/client` | SDK for agent builders: `EdenClient` (fail-open) and `withContext` for message lists. |
| `packages/eval` | Scenario harness over 31 hand-written scenarios (docs/research/eval-suite.md): precision, recall, false-fire rate, overall and per category; a privacy check (planted secrets, inert framing); direct asks; model calls and cost per turn, latency. |
| `packages/sim` | Simulation: generated worlds and sessions with fact-level ground truth, connectors that behave like real ones, an oracle judge, and the real server under simulated agents over HTTP ([research/simulation.md](research/simulation.md)); the connector lab, open-source MCP servers over seeded backends in isolated containers ([research/connector-lab.md](research/connector-lab.md)). Not product code. |
| `examples/personal-agent` | A minimal agent loop wired to Eden. |

## Identity and isolation

Tenant (our customer) → user (their end user) → session (one conversation or task run). The API key fixes the tenant.
Every cache, source-map row and budget is keyed by `tenant/user`; session state by `tenant/user#session`. Nothing
crosses a user boundary. Cross-user learning, if ever added, may share only content-free aggregates
(see [DECISIONS.md](DECISIONS.md) D9).

### Several processes (D113, D163, D178)

Every piece of per-user state lives in memory in the process that serves the user, so one process uses one core.
With `EDEN_PROCESSES=N` (N > 1; unset, the core count capped at 64, D178; 1, or a one-core machine, is one
process and no router) `main.ts` starts the router
(`packages/server/src/router.ts`): one Bun.serve front and N child server processes, each `main.ts` again. Each
request goes to child `hash(tenant/userId) mod N`, the tenant from the API key and `userId` from the body (one
`JSON.parse`, 0.27 µs for a 131-byte event and 0.7 ms for a 1 MB items body in `router.bench.ts`), so a user always
reaches the same child. The router keeps no per-user state.
Each child has its own source-map file (`source-map.<i>.db`: one SQLite writer per file) and holds 1/N of every
per-tenant cap: the request rate and burst (`EDEN_TENANT_RPS`, `EDEN_TENANT_BURST`) and the daily model spend
(`EDEN_MODEL_USD_PER_TENANT_DAY`). The caps are split, not shared, so a tenant whose users hash unevenly meets its
cap sooner on the busier child, and since the default N is the core count, a tenant with one user gets 1/N of each
cap ($6.25 a day, 50 rps, burst 100 on 4 cores): raise its caps or run `EDEN_PROCESSES=1`. The default count
also honours a cgroup v2 CPU quota (`machineCores`), but containers should set `EDEN_PROCESSES` explicitly; each
process costs about 67 MB idle (docs/INTEGRATION.md, "Processes and per-tenant caps"). A child that is down gives its users 503 (never 500) while the others serve, and
is started again after 1 s (doubling to 30 s while it keeps failing); its users' in-memory state starts over, as
after any restart (D8). `/healthz` on the router is 200 while at least one child is up (its body's `up` below
`processes` means degraded: alert on that) and 503 only when none is, so a load balancer never pulls every user for
one child's share; use it as the readiness check.

Changing N reshuffles users: most land on another child, where their in-memory state (cache, sessions, budgets)
starts over, as after a restart, and the learning their old child wrote to its source-map file is no longer read.
Those rows still hold the user's entity names, so `/v1/forget` goes to every child, each deleting the user's rows
from its own file; the caller gets the owning child's answer, or 503 (retry) when any child could not forget.
Files that no process of the new N opens (`source-map.db` when N > 1, `source-map.<i>.db` for i >= N, every
`.<i>` file when N is 1) are merged at start, before any child opens a file: each user's rows move into the file of
the child that now serves them (counts add up) and the stranded file is deleted. A stranded file that cannot be read
stops the start, since a file left behind would hold rows forget never reaches. D163 makes N > 1 the default only
once `router.bench.ts` shows at least 1.5x the events per second of one process at the same observe p99 on 4 cores,
on the merged tree (a trial in DECISIONS.md).

`router.bench.ts` serves one in-process StaticSource, so it measures little of what real users cost. The same gate
on simulated users (`packages/sim/src/lab/router-sim.bench.ts`: the shipped `buildPartner` over per-user connectors
with REALISTIC or market latency at time scale 1, sync on, 400 users, median of 3, 4 cores; D172's outcome) gave the
router over 4 children 5.96x one process at p99 <= 100 ms on REALISTIC (4,410 against 740 events/s, lowest 5.94x)
and 3.36x on the market `hosted` profile (4,126 against 1,229, lowest 3.20x); the hop alone costs nothing measurable
(router over 1 child 0.98-1.05x). Memory is the price: each child keeps its own heap, and its users' state grew it
by about 650 MB for about 100 users, against about 1,350 MB for all 400 in one process (RSS end minus start; every
process also held about 490 MB of sim worlds that a real server does not). Size a box by children, not by users.

`POST /v1/usage` (D326) reports a tenant's day: model spend and calls against the cap, requests by route, users held
(frozen ones apart) and items; the router sends it to every child and sums the answers. Per-tenant spend caps are
divided by N in each child (D163), as is the rate limit (the spend leases of D327 were deleted by D817).

## The two speeds

**Fast path** (every event, no network call and no model call, a few ms; it may write learning outcomes to the local
SQLite source map): build a cue (entities, content terms, situation), look it up in the user's item cache, and
deliver only if an item names a cue entity as whole words, covers most of the query, and holds at least two of its
terms (D6: `confidentScore` > 1 by construction, since idf-weighted coverage is at most 1, plus an entity bonus).
An item a recent tool result or agent message holds whole is never pushed (an ask still returns it), and bulk mail
is never pushed without a model (D34). A cached copy older than two hours is never delivered from here: its cue goes
to the slow path, which delivers the source's current copy when its live search returns it (and the cached one if it
does not: a source down, or a search that no longer finds the item; D40). No item is re-read through `fetch` (D121).

**Slow path** (background; at most one per session at a time): rank the user's sources with the source map, search the
top few live (each under its own deadline), cache the redacted results, record entity mentions, and re-score. A
confident item is delivered with no model. Borderline candidates go to a model judge only when an embedding wires one
and its budget allows; the servers wire none (D112). With no judge, no budget, a failing model call (D41), or a verdict
cut off at its token cap (D45),
Eden first grounds the request in the items' structure (D44, `grounding.ts`): who takes part (`meta.people`, from
attendees, senders and recipients) and when it starts (`meta.start`). A full name the request acts on matches a
participant by identity; a request about meeting someone takes only an event with them, any other one also needs a word
of its topic; days the request names ("this Sunday", "next week", "12 November"), resolved at the user's own UTC offset
(the one most of their events carry), select the events on them (an event's day is the date its start was written
with, except that a start in UTC at a user with another offset is read at theirs: 23:30Z on the 6th is the 7th at
+01:00), and "the next X" (an event: "the next call") the earliest upcoming. A question about nothing but a time is sent as a listing of those days (`SearchQuery.window`, no
words) to the sources that list by time (`Source.listsByTime`: an event range, not a mail filter), skipping the planner,
and grounds that day's events. `ask` grounds the same way. Failing that, the best candidate alone is delivered if it
holds three or more query terms and scores at least 0.8 (coverage plus the entity bonus; D36). The result is returned
directly if the caller passed `waitMs` and it landed in time; otherwise it is queued and delivered with the next event
(or via `/v1/pending`).

**A request made while the slow path is busy**: one slow path runs per session, so a request the fast path did not
answer while another lookup (a slow source, the reader) is still running is traced `silent` / `slow path busy` and not
looked up; its cue stays out of cooldown, so the same request made again finds it. The one-slot queue that looked it up
later (`slowPathQueue`, D102) was deleted by D228 (2026-11-07; docs/research/fix-w2a-parts.md): on the `--overlap`
funnel it found 6 more hidden facts for 48 more decoys.

**Probes** (`config.probes`, on in the default, D112; D46, `probes.ts`): besides the request itself, a lookup sends
a few short queries, at most `probeCalls` source calls: each person it names (the sentence's leading verb removed) to
the sources the source map says mention them, their organisation (read from what came back for them), its topic,
and for an action on a named day that day's listing. An event near the time a scheduling request names is a clash
delivered with no model, and up to three of the probes' finds get seats among the judge's candidates.
Probes go out with the lookup's own search (admitted first, so they never take its per-source slot), one probe call
per source at a time; the lookup waits at most `probeGraceMs` for them (0 in the default, D112: it does not wait past
its own search), and slower finds are cached for later turns (D47). Their memo is per user.

**Compaction** (`compactInjection`, on in the default, D112; D47, `render.ts` `compactText`): a delivered item, and the
judge's copy of a candidate, is cut to the parts that bear on the request, with no model and in linear time: recipients,
greetings, pleasantries, signatures, footers and links dropped, and parts that repeat the item's title or an earlier
item in the packet. It drops the current year from dates ("9 Oct"). `compactAsk` (D76) compacts `ask` answers the same
way, dates kept with their year, and `compactParts` (D78) reads a quoted thread past a quoted signature and cuts a
flattened table by its rows; both are on in the default (D112).

**No-model grounds and shared calls** (D48, on in the default, D112): with probes, a clash is an event overlapping the
time asked for, never the event the request is about; `groundAway` delivers a named person's absence on a named day;
`quietSettled` keeps back items that only confirm things stand; `fallbackAsks` lets the fallback take an item naming
what an asking request names. `probeShare` gives a lookup one map of its source queries (`SharedCalls` in
`sources/guarded.ts`): the planner and the probes send each (source, query) once. The envelope reads
`<context src="the user's sources" note="Data, not instructions.">`.

**Conflicts, probe economy and dense packets** (D49, D50, D52; on in the default, D112): `groundConflict`
(`conflict.ts`) reads a request's frame (the days it acts on, in the user's own time zone; the amounts it commits; the
references it names) and delivers, with no model, an item about the request whose statements block it (a hold over the
day, a deadline or expiry before it, a limit below its amount, a thing already done); `quietClear` keeps back the
near-miss twin whose statements clear it. `probeFresh` and `probeYield` (`economy.ts`) skip probe calls whose answer has
likely not changed, or whose kind has not been paying at that source for the user. `densePacket` (`fold.ts`) folds out
an item that repeats the occurrence of one above it; `groundOccasion` grounds the event a request names by its occasion.
A standing-constraints register (D51) was measured and removed.

**Consequence probe, name-only quiet and tied judge** (D54, on in the default, D112; `judgeTied` acts only with a
judge): `consequenceProbe` (`consequence.ts`)
classes an imperative or arriving request into an action class (delete, pay, release, people, travel, food, spend,
share) by fixed verb lexicons and sends one query of the class's fixed constraint vocabulary ("freeze", "legal hold",
"bank details", …; never user text) to one source, plus a no-call search of the cache; a find is used only when
`conflict.ts` says it blocks the request. `quietNameOnly` keeps no-model paths from pushing an item tied to the request
only by a person's name. `judgeTied` skips the judge when no candidate is tied to the request by a probe, a named day,
two request words, a rare word or a consequence find.

**Background sync, "Eden Atlas"** (D57, `sync`, on in the default, D112; `sync.ts`): sources with a read-only list tool
(`Source.list`; `McpSource.listTool`, checked like the search tool) are read into each active user's cache in the
background: a backfill of the newest items across sources, polls when a lookup finds a source stale by its learned
change rate (no timed polls, D121), a daily sweep that drops what a source has not listed in two sweeps in a row (about
48 h), reading each source back to the oldest item synced from it (D283). A lookup stops waiting for its on-demand
listing at its deadline without cancelling it, and skips a listing that failed twice running while it backs off (D283).
Synced items have their own cap and TTL in the cache. The servers sync per-user MCP sources that name a list tool
(D108); static sources list nothing. A lookup answers every current synced source (its own search and every probe) from
that local index at no call, and calls live only the sources that are not synced or still stale. The tick runs on a
timer, never on the fast path, which only marks the user active. A listing redacts only what it brings new or changed:
an item the cache holds whose raw copy hashes the same on what the gate reads (wyhash over the clipped fields,
per-process seed) gets the held redacted copy back (`ItemCache.reuseFor`, `SourceFanout.list`'s `reuse`), so a sweep of
an unchanged source costs about a tenth of what it did (`packages/engine/bench/ingest.bench.ts`, docs/TESTING.md). A
poll lists `syncPageSize` (100) items a page, as backfill and sweeps do, and an on-demand poll reads at most
`syncCatchupPages` (2) pages. With `syncPollPageSize` (D101; 5 in the default, D112; 0 = off) a poll's first page is
twice what the source's learned change rate expects since its last poll, at least that size and at most `syncPageSize`;
while no page reaches what was already synced, the next tops the items asked up to the next multiple of `syncPageSize`
(5, then 95, then 100). A poll then lists no more items than full pages would and catches up as far, in at most one more
call (an on-demand poll: one to three calls, against one or two). Backfill and sweeps keep `syncPageSize`. `SyncStats`
counts the items listed (`demandItems`, `backgroundItems`) beside the calls.

**Many sources** (A1, D261–D265, all in the default; docs/research/a1-scale.md). A user's newest `syncMaxItems` are
kept across all their sources, so with many busy connectors a source's synced copy can be cut to its newest few items.
Such a copy (`Sync.complete` false: its backfill stopped at the user's cut before its listing ended, or a trim dropped
some of its items) does not answer for its source (`syncLocalComplete`, D264): the source is searched live like an
unsynced one, so what is older than the cut is still found. The push does not wait for that search
(`pushCutBehind`, D405, D406): it answers a cut copy from what is held, the search runs behind, and what it stores
reaches the agent through the poll's follow-ups. Nor does an explicit ask (`askBehind`, D430, D431): its lookup runs
behind as the push's does, it waits `askBehindWaitMs` (0) for that work, answers from what is held and names the
sources still being read (status "searching", never an all-clear), and what they then store that it would cite goes
out as a packet at the next take. Which cut copies are read live at all is learned (`sourceYield`, D505, D509;
`source-yield.ts`; docs/research/n1-calls.md): each source keeps a run of the live reads it answered since one of its
items last reached the agent. A copy whose run has reached `sourceYieldRun` (4) gets no search behind, no probe and
no on-demand poll for a request that has no strong evidence for it: it answers from what is held, and an ask gives
it the status "unsearched" and says so, never an all-clear. Runs halve every week, so sources are tried again. And
a source earns its reads (`sourceYieldEarn`, D600, D603; docs/research/o1-earn.md): a copy none of whose items has
ever reached the agent is read live only on strong evidence, a name its items mentioned or a word of the request
that at most `sourceYieldRare` (2) of the user's sources hold (`RareTerms`: one table a user of which few sources
hold each listed word, at most 1 MB); a name more than `sourceYieldNames` (4) sources mention is strong only for a
source with an item used; and a source a request reads nothing live of is not marked used by it
(`sourceYieldEngage`: no deep copy, daily sweep or card call on its account). With about 1,000 sources this took
Eden's connector calls from 23 to 5.5 a task one request a session and from 7.3 to 2.4 over a user's days, hidden
facts level (D603; measured before `pushOpen`, and the merged default's $0 screen reads 29.4 → 3.8); the pooled rates it replaced (D505) are deleted. A lookup polls at most its
`syncPollWidth` (8) best-routed
stale sources (D263); a warm source past them answers from its copy as it stands, as under `syncPollBehind`. Routing
(`SourceMap.route`) adds, per source, log2(1 + its items among the request's 40 best matches in the user's own index)
(`routeLocalHits`, D265), so a request that names no one still reaches the sources whose items share its words. The
backfill reads 8 sources' pages at once, newest unread first (`syncBackfillLanes`, D262); first pages sized to a
source's share of the cap were measured and deleted (D262). With no more sources than the lookup searches, and none cut,
none of this changes anything.

A user the sync has not seen is backfilled from their first event (`syncKick`, D751, D753, in the default since
D755): the step starts at once, off the event's path, is taken up again as soon as its call budget, a guard or a
back-off allows instead of at the sync's next tick, and reads 32 sources at once as a pool; at most four users'
kicked steps run at once, a tick leaves a user alone while they wait for a kick turn, and the ticks (60 s on the
servers)
remain behind them. A first page that failed once
is tried again after 1.5 s. Measured on new users, full strength comes at about 25 s instead of 180 s with five
sources and at about 45 s instead of past 300 s with 1,000; with an agent, hidden facts raised ten seconds after
connecting go from 34.9% to 65.1% (docs/research/o4-new-user.md). Without the switch the backfill starts at the
next tick and every stop waits for the tick after.

A13 (D320–D324, all in the default; docs/research/a13-scale.md) adds what a user with many sources needs past A1. A
source a lookup routed to on evidence of its items (a name it mentioned, or the request's words among its held items:
`Sync.engage`) is one the user uses. Such a source's copy, if the cap cut it, is read again from the top, two pages a
tick, up to half `syncMaxItems` (`syncEngagedDeep`, D323), and the user's trim keeps the items of used sources before
any other's, so the user's own mailbox is whole and answers from the index instead of a handful of its newest items
among 1,000 connectors' newest. Each source keeps a vocabulary sketch of everything the sync listed from it (a Bloom
filter, 128 B to 4 KB, `sketch.ts`), kept after the trim; routing adds, per source, log2(1 + the request's terms the
sketch holds, each weighted by how few sources hold it) (`routeSketch`, D322). A sketch match routes a search but does
not by itself make a source used. For a user with more than 32 synced sources, the card model reads only items of used
sources or items naming a name the user's own requests named; the rest wait, uncovered, and are read when their source
is first used (`cardsSourceAware`, D320). After the backfill the sync keeps to its cap: sweeps and background polls store
no dated item older than the user's cut (the copy is then cut), the user's items are trimmed back to the cap at 1.5x it,
and a sweep stops once it has listed every id it holds for the source (`syncKeepCut`, D321). The daily sweep still lists
every source once a day (deletes need it): about 1,000 listing calls a user a day at 1,000 sources (D324).

A21 (D356, in the default; docs/research/a21-scale.md) sweeps a source the user does not use, and whose connector can
find an item by id (`Source.fetchesById`: an MCP connector with a get tool), once a week instead
(`syncUnusedSweepMs`); any other keeps the daily sweep. What
the skipped sweeps would have vouched for is checked at delivery instead: a copy older than `syncSweepMs` of a source
whose daily sweep was skipped, or such a source's copy the last sweep did not list, is `doubted`, so every delivery and citation
re-reads it by id first (D126, D211). A copy no re-read confirms is not delivered and makes its source's sweep due at
the next tick. At 1,000 sources the sweep falls from ~1,114 to ~282 listing calls a user a day; a five-source user uses
all their sources and keeps the daily sweep.

**Change notifications** (D125, `syncPush`; `Source.notifies`, `ContextPartner.sourceChanged` and `sourceItems`,
`POST /v1/sources/changed` and `/v1/sources/items`, the client's `sourceChanged`/`sourceItems`): a source whose
integrator forwards the provider's change notifications is not polled on its learned change rate. A notification marks
it behind (`Sync.changed`, O(1)), and the next lookup that reads it polls it once, however many notifications came
first. A notification that carries the changed items passes the secret gate and is stored as synced, with no call.
Every notification (with `syncPush` on) also drops the source's held search pages, synced or not (D148).
Such a source is otherwise polled only by the daily sweep and after `syncPushMaxStaleMs` (24 h) with no notification,
the bound on a lost one. Sources that do not notify are polled as before.

**Freshness at delivery** (D126, `verifyDelivery`, in the default, with `verifyTimeoutMs` 1.5 s; `partner.ts`
`verifyItems`, `checkAhead`, `deliverChecked`; `SourceFanout.fetchChecked`). Every slow-path, reader
and `ask` delivery goes through `deliverChecked`: an item whose read began before its source last signalled a
change (`Sync.signalledSince`, a `syncPush` signal that does not say which item changed) is fetched again by its ref
first, in parallel. A read's start is a mark, not a time (D133): every lookup, probe, re-read and sync page takes
`Sync.mark()` (a count of signals) before its call and stores it with its copies (`ItemCache.readMark`), so a signal
that lands while a call is on the wire doubts what it brings, and items a notification carried, or a poll the signal
started, do not. Since D192 (`readerVerifyAfter`, on in the default; it reopens D134) nothing is re-read beside the
reader's call: a delivery re-reads only the items it cites, after the reader named them, so a doubted delivery waits
for its re-read, and the up-to-3 speculative fetches per reading (`checkAhead`, `VERIFY_AHEAD`) are gone (Pi: 1.6-2.6
fewer fetches a task). With the switch off, `checkAhead` runs only once the reader will be called (D134). A changed
copy is stored
and delivered instead; one the source no longer has (`gone`, only from a source with `Source.fetchReportsGone`) is
dropped from the cache and left out; one that cannot be checked is delivered as held, except in an ask's answer
(D211): there a re-read that failed with a plain error, or that our own guard skipped in ordinary use (a busy permit,
the rate limit's normal spend), is tried once more, and a copy still not confirmed is left out and named in the answer;
a re-read refused by an open breaker or by a rate limit the connector's 429 pushed back is not tried again and is left
out at once (D232). A source with no fetch tool, or whose null proves nothing, is still cited as held; such a null
("unverifiable", a reply that lacked the record) stands for the user until the source signals again or 10 minutes
pass (`unverifiable`, D298), so later deliveries and other sessions do not fetch it again for the same answer; an MCP
error result (`FetchErrorResult`, "error-result") is unverifiable too but never held. With no signal nothing is
re-read: a copy's age alone is no doubt (re-reading by age was measured live and deleted, D126), and a silent source's
changes arrive through polls and the daily sweep. The fast path, which may not call a source, sends a doubted item to
the slow path. Deletion notifications (`ContextPartner.sourceRemoved`, `POST /v1/sources/removed`) drop items at once;
a deleted item, from a notification or a re-read, is also dropped from the fan-out's held search pages
(`SourceFanout.dropResults`, as on every signal) and kept out of the cache for 10 minutes (`ItemCache.removeItems`'
hold), so a page read before the deletion cannot bring it back. A re-read that is on the wire when a deletion
notification lands does not revive the item (`recheck` checks `ItemCache.isHeldGone` before storing): it counts as
gone.
The re-reads are traced as "verify" decisions with their `sourceCalls`, and their wait is a "verify" span (A18).
A notice that names the refs it changed without their content (`ContextPartner.sourceRefs`, `POST /v1/sources/refs`,
D347) doubts only those items: each is fetched in the background (two at a time, `REF_TIMEOUT_MS` 5 s, a guard's skip
or a plain error tried again) and stored as synced under its call's read mark; until its read lands the item is in
doubt and a delivery waits on that read (`refreshing`, no second call, at most `verifyTimeoutMs`). A ref that cannot
be read turns the notice into the plain signal.

**Poll behind the lookup** (D65, `syncPollBehind`, on in the default, D112; with `sync` and `syncOnDemand`): without it,
a lookup that finds a synced source stale waits for that source's on-demand poll (`sync.freshen`, one or two listing
calls; up to three with `syncPollPageSize`), which was most of Eden's time on the agent's critical path in ALL (p50 503
ms where it ran). With it, every warm synced source answers the event's lookup from the index as it stands and the poll
runs behind; the critical path then holds no source call for a synced source, current or polling behind. If the poll
stores anything, the lookup is made again on the fresh index once both are done (after any lookup still in flight) and
what it delivers is queued for the agent's next request: after a delivery, or with a model, only what is sure or
grounded (so it makes no judge call); after silence with no model, as the lookup would have decided. The first answer
can carry a copy the poll then finds edited; the ledger records each delivered item's words with the flag, and the
follow-up delivers the corrected copy (the departure from D40 is that the old copy went out first).
`ObserveResult.pending` stays true while a poll or follow-up is running. Since D431 the agent's `ask_context` does not
wait for the poll either (`askBehind`, above); with the switch off it does. The reader's push does not
(`readerPushBehind`, below). A lookup has one deadline, `sourceTimeoutMs` (1.5 s) from
when its sources are resolved (D140): the on-demand poll, the live search, the planner's cascade and the probes share
it, so with `askBehind` off (D430) a listing that hangs and the search after it hold an ask back about 1.5 s before
the reader starts, not 3 s; with it on (the default) the ask waits for neither.
With under 50 ms left, the live search is skipped and each chosen source reports "timeout" (no call). A source whose
on-demand poll ran out of time is not polled again by a lookup for the next `sourceTimeoutMs`: it is searched live.

**Revisions of what the agent was handed** (D205, `revisionNotice`, on in the default, part `freshness`): every packet
the agent takes and every ask answer records in the session's ledger the version of each item whose line it rendered
(`Ledger.noteShown`, past the not-twice cooldown). When a sync poll, a notice's items or a re-read stores one of those
items with other words, each live session of that user that holds an older version gets an "updated:" packet with
the new copy, once per revision, queued for its next take. A packet still queued when its item is revised is checked
when the agent takes it: a copy the cache has since replaced is followed by an update (D232); a packet withdrawn
untaken (the push's second reading) announces nothing. A change notice for a source a live session holds a copy
from is polled at once in the background (one listing call, at most one at a time and 30 s apart per user and
source), so the packet is usually queued before the agent's next request; nothing on the observe path waits for it.
Without it, a fact the agent already holds stays in its transcript in the old version (docs/research/fix-s7-revisions.md).
Since D342 (`revisionDiff`, part `freshness`) an update also names the times and dates the session was shown for the
item that the new version no longer has ("…; this version replaces it; no longer: 09:30"): the ledger keeps every
handed version's times (`Ledger.seenTimes`, `timesOf`, no model).

**No re-show across requests** (D340's trial, deleted by D380): the not-twice ledger (D13) keeps a push candidate
back within its cooldown even when the agent took it for an earlier, unrelated request of the session; a fresh paired
run did not show re-showing it better (docs/research/a26-reshow.md).

**New items against what the agent already acted on** (D301, `planConflict`, on in the default, part `plans`): each
session keeps the cues of its last 12 listed-verb requests the push ran for (the acting requests; a push opened on
the request's shape, D702, is not kept). Items the sync stores after
that (a poll, a notice's payload) wait, per session, for its next take (`takePending`, or an observe that starts no
push): there each is checked against those requests by `candidatesOf`'s rule (among the first `pushCandidates` of the
request's ranked pool, bulk mail out, the pool holding something constraint-like, cards included, which by then have
been made), and one that qualifies, and that no packet has handed the session, is queued as a packet naming the
earlier request (`PLAN_LEAD` and the request's own words, quoted on one line, double quotes made single), whatever
the agent asks now. A copy a change signal has put in doubt waits for a later take (D126). Index lookups only, no
source or model call (under 3 ms a take in the $0 screen); once per item per session (`planSent`;
docs/research/a9-ahead.md).

**Deleted by D112:** `decideConflict` (D67), `judgeBehind`, push relaying (`syncPush`, `sourcePushes`,
`sourceChanged`, D66) and the other switches D112 lists. The candidates' facts (`decide.ts`) still reach the lab only
through the content-free `PartnerDeps.onCandidates` hook; the engine decides nothing from them.

**Knowledge graph** (D58, `graph`, `graphMerge`, `kg.ts`): deleted by D225 (2026-11-07;
docs/research/fix-w2a-parts.md): no measured value on train with the paid reader replayed, while it cost ingest CPU and
memory per synced item. The source map (`packages/graph`) is a different thing and stays.

**Anticipation** (D60, `anticipate`, `anticipate.ts`, `IntentPatterns`): deleted by D227 (2026-11-07;
docs/research/fix-w2a-parts.md): no measured value on train with the paid reader replayed. A draft the user is still
typing (`user_message` with `draft: true`) is ignored: no session is opened for it.

**Implication cards** (`cards`, on in the default, D112; D59, `cards.ts`,
[research/moon-cards.md](research/moon-cards.md)): items new to a user's cache, looked up or synced, that pass a
no-model deontic prefilter are queued for a `CardEnricher` (`PartnerDeps.cards`), which reads them ten per call
through the model, under its own per-user-day `Budget`, into small validated cards (constraint kind, actions from a
fixed vocabulary, entities, span, limit). At request time, with no model, the request's actions (fixed lexicons) and
frame (`conflict.ts`) are matched against the cards of cached items: a match is a candidate and a judge seat, and with
`groundConflict` the best violated card is delivered (grounded "card"). The card's own statement never reaches the
agent. The servers' `buildPartner` wires the enricher on `EDEN_MODEL` when `OPENROUTER_API_KEY` is set (D112);
without a key the part is inert and the no-model paths answer.

**Card economy** (D66, `cardsEconomy`, on in the default, D112, with `cards`; docs/research/econ-background.md): the
enricher reads fewer items with the same prompt. A strict prefilter cuts legal-disclaimer and notification-settings
footer blocks (from their first words to the end of their paragraph, so a constraint written after one is still read)
and does not read a reply's or forward's subject; items of one user that say the same deontic sentences under the same
subject (reply prefixes, greetings and footers aside, none dated relative to their message) share one card, the subject
included because the model reads it for the card's entities; twenty items go per call. The card maker's
`OpenRouterModel` may route by price (`sort: "price"`, still ZDR); a batch cut off at the output cap, which price
routing makes more frequent, is sent once more with default routing (`CardMakerOptions.retry`) under its own
reservation.

**The moonshots together** (D62, [research/moonshots.md](research/moonshots.md); all in the default since D112): the
parts compose. With
the sync, synced sources answer the lookup's search and every probe locally, and the cards cover every synced item;
card matching runs on the slow path after the lookup's items are cached. Every subsystem reports into the engine's
spans (`sync.freshen`, `sync.list`, `cards.match`, `cards.make`), and the Pi harness's timeline reads the same spans.
The knowledge graph (D58) and anticipation (D60) were deleted by D225 and D227 (2026-11-07;
docs/research/fix-w2a-parts.md).

**Deleted by D112:** the bridging query (`bridgeQuery`, `bridgeQuestions`, D89) and the constraints digest
(`constraintDigest`, D90) with its route `/v1/digest`; the client's `health()` calls `/v1/whoami`, which checks the
key, tenant and ids and changes nothing.

**The ask-time reader** (`askReader`, on in the default, D112; D95, `reader.ts`). An `ask` about an action (or one
asking what blocks, limits or allows it, or made after a request that acts) is answered as usual, and then, before
rendering, one budgeted model call (`AskReader`, its own `ReaderMaker`, model and `Budget`) reads the first
`askReaderPool` (15 in the default) distinct candidates of the ask's ranking (its pool in order, then the rest it
scored), each rendered compactly (`readerItem`: title, source, date, sender, the `askReaderItemChars` (240) characters
of its parts that bear most on the request, its card's fields), all redacted and fenced as data. It
returns the items that block, limit or change the request or show it done, each with a kind and a ≤ 15-word bearing
(`parseReader` validates both); those lead the answer, marked "Eden's reader: <kind>: <bearing> |", and the usual items
fill the seats left. An explicit ask waits at most `askReaderWaitMs` (2.5 s); late, over budget, failed or
unreadable, the answer is the usual one, and a late call still fills the cache. Verdicts are cached per user and session
by a hash of the request and the pool; any `forget` of the user or a source drops them. It is wired by the embedder
(`PartnerDeps.reader`): the servers wire it on `EDEN_MODEL` when `OPENROUTER_API_KEY` is set (D112), the lab's funnel
with `--reader`; without it the part is inert and the ask is the no-model one. Its spend is the
ask's: `AskResponse.costUsd` and the "answer" trace include the reader's call (`readerCalls`, `readerCostUsd` name that
part), counted once, by the read that made it (0 for a cached verdict and for a read that joined a call in flight). A
late call is not the ask's (its `costUsd` 0, `usedModel` false): when the call the ask started lands, the reader books
it and the engine emits a "reader-late" trace with its cost and one model call, even if the session has closed, so the
traces sum to the reader's spend. A call its `Budget` refused reports the outcome "budget" (`onReader`), not "none"; the
reader's `Budget` is its own, ended with each session, and a default `new Budget()` stops it after 20 reads a session
(`callsPerSession`), so an embedder sizes it for long sessions. In the servers it also shares the tenant's daily cap
with the card calls (`TenantSpend`, D112).

The reader's prompt v5 (D96) has the model label every item that looks relevant, a lookalike included, writing what the
item means before deciding whether it is about the same thing and binds. With `askReaderDrop` (on in the default), the
items it rejected by name leave the ask's answer; an item it flagged never does. A drop that would empty the answer is
made only when the reader was shown every candidate the ask had (none cut by `askReaderPool` or the prompt's 60-item
cap; D114): otherwise "Nothing in the connected sources" would be a false all-clear over items it never read (D93's
guard). A source outage is the other false all-clear (D127, audit 2026-11-05 `ask-false-all-clear`): an ask says
"Nothing in the connected sources." only when every source it chose answered (ok, cached, stale, or from the synced
index); otherwise its answer names the sources that failed (error, timeout, circuit open, busy, limited, throttled:
the connector's own 429, worded "rate-limited", D212), or, with `askBehind` (D430), the sources whose poll or live
search was still running when it answered ("searching": "Still reading …: anything there that fits follows as a later
packet"), and says it is not an all-clear, and `AskResponse.sources` carries each chosen source's status. With `readerPush` (on in the default), a
user request that acts is read the same way when it is observed, as an ask of the engine's own, and the items the reader
flags are queued as a proactive packet, so an agent that never calls `ask_context` still gets the reading. **Since D237 the default does not call the reader there or on an ask (`pushCandidates` 5, CL6):** the push hands
the agent the first five items of the pool the reader would have read (the ask's order, bulk mail out), each a focused
excerpt, after a fixed line of Eden's own saying they may bear on the request and must be checked against its who,
what and when first; a pool with nothing constraint-like (`readerGate`'s test) gets nothing (no note: D237 did not
build it, D257 deleted the push's other one). When no handed item holds the request's named person or thing and,
if it names one, its day (`settle.ts`, no model), the line adds a nudge to call `ask_context` with those specifics, and
an ask in that request also lists the pool's deeper items that hold one of them (`askNudge`, D317: hidden +9.2 points
on Pi, through the agent's asks); since D461 only when the pool past the handed items holds such an item
(`askNudgeDeep`: 0.062 fewer asks a task, targeted hidden not lower). When the request names a person, thing or day and
a handed item settles it, the push
hands only the first two, through the first that settles it (`pushCandidatesSettled` 2, D404: fewer packet tokens
written to the agent's prompt cache, hidden facts not lower, A30). An ask answers in rule order with no reading. The
candidates need no
reader, so a server with no model key runs them too (D276). `ContextPartner.explain` returns a session's last 32
traces for `POST /v1/explain` (D277), each with `explainTrace`'s sentence; content-free like every trace (D56).
**The push check (`pushCheck`, D500–D504, a trial, off; `push-check.ts`)** puts one budgeted model call on the push:
when the gate passes, the model reads the pool (at most `pushCheckItems` items of `pushCheckItemChars`, fenced as
data) and names the items that change what the agent should do; the candidates become those, in pool order, and a
pool it names none of sends no packet. It runs on the reader's model through the `checker` dependency, waits at most
`pushCheckWaitMs` (a miss, an error or a refusal hands the default's candidates; a late answer is traced
"check-late" and kept for a second pass), and costs the push about 0.8 s on the agent's path (i3-push-check.md).

Trial `pushWiden` (D511, off; with I3's `pushCheck` trial) adds items no lexical rank reached (a `widen` dependency's
nearest items, raw intent hits) to what the push check reads, sharing its wait; only the check can hand them
(docs/research/n2-recall.md: it pays only behind a check that thinks, which is too slow and dear as measured).
Three more trials shape that call (N5, D527–D536, all off; docs/research/n5-widen-check.md): `pushCheckForm` 2 asks
for a compare-first reply (per listed item, what its point applies to, what of the request's own it lands on or
"none", then the verdict), which keeps look-alikes out with no thinking at the same price and wait a call;
`pushCheckAnchored` makes the call only when a constraint-like pool item names one of the request's anchors (about
three pushes in ten, else the default's candidates with no call); `pushCheckSilent` off leaves the default's
candidates when the check names nothing.
`pushCandidates: 0` (the part `candidates` out) restores the reader's push and asks described here. Its question
is the message's first 10,000 characters (an ask's cap), and its read is traced as decision "reader-push" with its model
call and cost, and its lookup's `sourceCalls`. A trace's `sourceCalls` count only calls a connector received: a search
that joined another lookup's call in flight (the push and the slow path search the same words at once), was answered by
the fan-out's cache, or was refused by a guard is none (`reachedSource`), and a planner's cascade counts each call it
sent, so a task's traces sum to its connectors' count. `readerGate` (D99, on in the default) skips the call when no
candidate could constrain the request (no card of a constraint kind, state change or thing done, and no constraint
wording, `mayConstrain`; bulk mail never counts); with `readerGateVisits` (on in the default, D124) an arranged visit or
a request that someone be in ("he'll come thursday between 8 and 12", `arrangedVisit`) also opens it. `readerPushWaitMs`
bounds how long `observe` waits for the push, within the caller's own wait (0 measured badly: the reading must land
before the agent answers). With `readerPushBehind` (on in the default, D112; with `syncPollBehind`) the push's own
lookup does not wait for the sync's
poll: it reads the index as it stands, and if the poll stores anything the push is ranked again on the fresh index
with no new source call and read again (a reader cache hit when its pool is unchanged); a packet the first reading
queued and the agent has not taken is replaced, its ledger entries restored. The push itself is not cut at
`askReaderWaitMs`: it waits for
the reading (bounded by the reader's model call and the session's close), and `observe` reports `pending` while it runs.
The reader's reply stops at the first entry the model says is not about the request's own thing (`readerStopEarly`,
D240, a `"same":false` stop sequence): binding entries come first, so what is cut is the later look-alikes'
rejections; the stopped entry is read as rejected.
With `readerReuse` (on in the default, D193), an `ask` made before the next user message and read against the push's
own request (not an ask that acts on its own) takes the push's verdict on the items both pools hold unchanged, with no
reader call of its own (`Session.pushRead`); it was read against the user's request, not the agent's question. A push
with no verdict, or one that flagged an item changed since it read it, leaves the ask to read; one still out past the
ask's wait leaves the ask answered without the reader.
Its packet is queued only if the session is still open and no newer user message has arrived; the agent's own events in
between (tool calls, its replies) do not make it stale.

**The push for any request (`pushOpen`, O3, D702, D706; in the default since D710).** `observe` starts the push only
for a request whose verb `isImperative` lists, a gate from the reader's paid push. With `pushCandidates` and no
`pushCheck`, a message that does not open as a question, a remark or a statement (`isOpenRequest`) starts it too: no
model call, the candidates' own gate unchanged, and no acting request recorded for plan alerts
(docs/research/o3-push-open.md).

**The intent index** (`intent`, needs `cards`, on in the default, D112; D87, D109, `intent.ts`,
[research/edge-intent.md](research/edge-intent.md)). The background card call also writes, per item, up to four requests
the item would change, in a user's words (validated, at most 120 characters each, redacted); items the card prefilter
rejects are read for their requests only, and with `cardsLean` (D125) only when a person wrote them recently: not
automated mail (`automated`: a no-reply or list sender, a bulk category or footer) and dated within `cardsLeanDays`
(7 since D244; 30 before) or upcoming; constraint-worded items are read whatever their sender or age, and first
(`cardsOrder`, D482, D483: what waits for the card model is read best first, so a new user's early requests meet cards
for the items most likely to bear on them; equal-score hits keep the order their items came in; `cardsLanes` 4, D521,
D522: up to four of a user's card calls run at once while full batches wait, so the backfill is read in a quarter of
the time for the same calls). They live in a per-user BM25 index apart
from the item text, keyed by content hash and dropped with the card. At request time, with no model, the request's words
are searched in it: the best hits join the lookup's candidates and one judge seat, and are fused into an `ask` by
reciprocal rank after the verdict hits. An intent hit alone is never a no-model delivery. A hit whose item holds a
constraint card (any kind but `none`) counts from a lower coverage floor (`intentCardCoverage`, 0.1, against 0.2), and
up to `intentCardHits` (4) such hits the `intentHits` cut left out (read 3x as deep) are kept after the others
(`intentByKind`, D200, `keepIntents`).

**Deleted by D112:** guarded asks and answer-shaped packets (`askGuard`, `packetBearing`, D88)
and the ALL5 preset (D92) with every other named preset; the lab's presets are only `default`,
`minus-<part>` and `minus-all`.

**Checking an action** (`checkAction`, HTTP `POST /v1/check`, client `check`) takes the agent's tool call before it
runs and answers `proceed` or a `finding` in the usual data envelope; the same call made again after a finding proceeds
(the agent's informed choice). What the integration does with a finding is its own: `heldResult` in the client is one
choice (hold the call and return the finding as the tool's result). The client's `check` fails open (an error, a
timeout, a 4xx or 503, or an answer of another shape is `proceed`); the route answers 400 for a malformed call and 503
when the engine fails. Its one check is the party check below; the action firewall that also read the call's grounds
(`actionCheck`, D69) was deleted by D815 (code in commit b4848545).

**The party check** (`partyCheck`, on in the default, part `parties`; D375, D376, `parties.ts`,
[research/a25-action-guard.md](research/a25-action-guard.md)) is what `checkAction` runs. Every injection handed to the agent (`handOut`) and every ask answer has its email addresses and
bank account details noted as digests in the session (`Session.packetParties`, ≤ 256, each with the cited item that
held it; in packets, account digits count only after their label). A call whose arguments (all but `NOT_PARTY`'s
fields: amounts, dates, titles, subjects, descriptions) add such an identifier that the session's latest user message
does not name and that is no correspondent of the user's (`ItemCache.isCorrespondent`: on a party line in the header
block of a cached item, or at a non-free-mail domain on such lines of two items; the item that showed it vouches only
for its own From line) is answered with a finding in the data envelope naming the identifier and the item's title and
asking the agent to confirm with the user; a call to the same tool adding the same parties again proceeds. With only this check on, a call in a session Eden
handed no identifier proceeds without opening a session. No model, no source call: about 8 µs to read a 1.2 KB packet,
and the user's address tally takes about 26 ms to build at 1,500 items, once, then follows each item stored or removed.

**Ask** always searches (live, or a current synced source locally with D57; more sources), ignores the not-twice
ledger (the agent asked), and returns the cited items as they are, with no model call composing an answer: the asker
is a model and reads them directly (D43; `askWithModel` and `EDEN_ASK_MODEL` were deleted by D112). The one model call
an ask may make is the reader's (above). The ask is part of the design, not a fallback for a thin packet: a packet
that also carried the candidates the gate held back, so the agent could answer without asking, was measured and
rejected (D70, [research/econ-oneturn.md](research/econ-oneturn.md)). The agent's own question reaches items the
request's words did not, and the agent raised a delivered fact more often when it could still ask.
`askVerdicts` (D73: an ask that gathered the lookup's rule-path candidates and led with their verdicts) was deleted
by D226 (2026-11-07; docs/research/fix-w2a-parts.md): with the paid reader replayed it read 2 hidden more for 4 decoys
more, no benefit under D3. With `askDedup` (D77, on in the default) each session keeps `Session.shown`: the words its
packets and answers showed the agent, per item id and version (at most 64 items, never shared across sessions or
users), so a later answer says an unchanged item by its new parts only, or "(shown above)"; an item whose words
changed at its source counts as not shown. Shown is recorded when an injection is handed out (`handOut`: observe's
reply, `takePending`, the ask's own answer), not when a packet is built (audit 2026-11-05
`ask-shown-before-handed-out`): a packet still queued in `s.pending` was shown nothing, so an ask before `takePending`
says its items in full, and drops the queued packet only when it cited every one of its items. A new delivery path
hands out through `handOut`; noting shown at build brings back an ask's "(shown above)" for items the agent never got.
`askRank` and `rankTies` (D82), `supersede` (D81), `askContext` (D83) and their composition ALL4 (D84) were deleted by
D112 (no measurement favoured them on).

## Learning loop

When an injection is handed to the agent, it records its distinctive tokens (tokens the session had not seen). A
later agent message or tool call that repeats them marks the injection *used*; an injection with no sign of use within
`usageWindowTurns` is *unused*. Feedback may arrive after the session ends: each user's recorded outcomes outlive
their sessions (bounded), so it can still correct them.
Each outcome updates a Beta posterior per (user, situation, source) in the source map, which routing reads. Explicit
feedback from the integration (`/v1/feedback`) overrides the inference, correcting an outcome already recorded (D18).

## Session lifecycle

Sessions live in memory, capped per tenant and dropped when idle. Each owns an AbortController: session_end,
eviction and `forget` abort in-flight lookups and model calls, and nothing is cached, learned, charged or queued for a
closed session afterwards (D17).

The item cache (`cache.ts`) is bounded per user and per tenant, and also in time: an unref'd timer (`expireEveryMs`,
default 10 minutes, 0 off) runs `ItemCache.expireIdle`, which sweeps every user's expired items (a lookup's past
`ttlMs`, 24 h; a synced one past `syncTtlMs`, 7 days) and drops each user left with none (unless they made a probe
within `ttlMs`), through the same `onDropped(scope, null)` hook as `forget`, so their cards go too. Reads already
skipped expired items, so no answer changes; resident memory follows the users active within the time to live rather
than every user seen since the process started. The timer runs on the cache's own clock (the last `put`'s `now`
moved on by wall time since), so a simulation on an injected clock expires on its own time. The timer holds its cache
only through a `WeakRef`, so a cache nobody closes (labs build one per task) is still collected, and its timer stops.
A user's vocabulary releases each term no live item holds once the index compacts it away (`releaseTerms`, on in the
default, D112), so its term ids follow the live items without a rebuild.
Each cached item's text is held deflated (`CacheLimits.packText`, on by default, D188; `packed-text.ts`): the stored
copy's `text` is a getter that decodes it, with a 256-entry memo of recent decodes that `forget` and `removeItems`
clear. Index and tallies are built from the plain text before it is packed; a refresh with the same words
keeps the held bytes. Sim-world text, where one arrow or dash makes a whole JS string two bytes a character, costs
about 1.6x less heap per synced user, for 1.2-1.3x the backfill CPU.

A user neither read nor written for `freezeIdleMs` (30 minutes, at least two expiry ticks) is frozen at the next
tick (D325, `FrozenUser`): their entries and tallies become one zstd-compressed JSON blob in memory (D8: never on
disk) and their vocabulary, index, sketcher and entry objects are let go. Metadata reads (`revision`,
`syncedCount`) answer from the frozen record; any other read or write thaws the user into the same state (items in
the same order, docs indexed in their old insertion order so ties rank as before, the same revision, tallies,
probes and sketches), so every answer is the same (`cache-freeze.test.ts` compares a freezing cache with a twin
that never freezes). On the timer, freezes and the expiry of frozen users run as background jobs of one slice
scheduler (`ItemCache.pump`: a few milliseconds of work per event-loop turn, one job at a time); the partner's
`observe`, `ask` and `checkAction` first await `cache.ready(scope)`, which thaws a frozen user as an urgent job of the
same scheduler, so a burst of returning users queues instead of stalling every other request. Figures:
docs/research/a14-scale-users.md.

Two frozen forms (D860-D862, docs/research/p6-scale.md). A user idle two minutes (two one-minute expiry ticks) is
frozen *warm*: the blob keeps each item's deflated text bytes as they are and the user's vocabulary and index as
arrays (`Vocab.snapshot`, `SparseIndex.snapshot` after `compact`, postings as varint gaps), so a thaw copies instead
of tokenizing, indexing and deflating every item (10-20 ms at 3,000 items against 150-300). Per-item deflate shares
no words across items, so a warm blob is about twice a compact one on prose; a user still idle at `freezeIdleMs` (30
minutes) is thawed and frozen again *compact*, the one zstd stream above. A live user idle through a whole tick
interval has its index compacted first (D861: the delta tier merged and its spare room let go, 0.5-1 MB at the
cap).

An operator may opt in to persisting frozen users (D425-D427, `persist.ts`; `EDEN_PERSIST_FROZEN_DIR` and
`EDEN_PERSIST_KEY`): each freeze also writes the blob, with the sync's state for the user (`SyncManager.snapshot`),
AES-256-GCM to one file per user under a keyed-hash name, and a thaw deletes it. A restarted process reads a user
back on first use (`ItemCache.load`, from `peek`, `touch` or `ready`), thaws them in slices, and restores their sync
state (`SyncManager.restore`), so their sources are polled for what is new instead of backfilled; copies of notifying
sources are re-read before delivery, as after a signal (D426). Off, nothing is written. Figures:
docs/research/c3-persist-frozen.md.

Dates in items are read the same on every host: `parseWhen` (`grounding.ts`) reads a zone-less date or date-time (a
`Date:` header without a zone, a calendar start with no offset, "14 Oct 2026") as UTC, not the server process's local
zone, and leaves strings with a zone ("Z" in either case, "+01:00", "GMT+1") and ISO bare dates to `Date.parse`. An
offset counts only right after a time, so the year in "14-Oct-2026" is not read as "-2026". A zone name outside the
RFC 2822 set ("CEST") does not parse at all: `parseWhen` gives NaN and the sent time and card date fall back to the
item's `updatedAt`. A mail's sent time (`sentAt`), the date in a card prompt (`datedOf`, and so its replay hash), an
event's start (`startMs`) and the order of a day's events (`ItemCache.timed`, unparseable starts last) all go through
it. Tests run with TZ=UTC (`scripts/test-preload.ts`);
`tz.test.ts` checks the same answers under Asia/Tokyo and America/Los_Angeles.

## The proxy (D280)

`@eden/proxy` (`bun run proxy`) is an OpenAI-compatible endpoint in front of the agent's model for agents that cannot
add the SDK: it turns each chat request's new messages (by content, so compacted and sliding histories work) into
events through `@eden/client`, inserts the turn's packets with `withContext`, and streams the upstream's answer back.
It fails open under one deadline per request (the observe's wait plus 800 ms), keeps per-conversation state in memory
(bounded, keyed by user and session), and off loopback needs its own key (`EDEN_PROXY_KEY`), since it holds the
tenant's. A shadow mode reports and decides but injects nothing. `POST /v1/messages` (Anthropic's Messages API, D653)
runs the same logic on the conversation read as chat messages; a packet goes back as a text block of its user message.

## What is deliberately missing (see ROADMAP.md)

Per-user MCP connections with OAuth and a token vault; persistent session state;
streaming delivery; a richer graph (entity resolution, relations, freshness);
learned situation classification; per-agent (not just per-user) learning; multi-machine deployment (the router,
D163, spreads users over processes on one machine; its rate and model-spend caps are split per process).
