# Eden Atlas: background connector sync into a per-user local index (track sync, proposed D56)

Every number below comes from a command run in this session on the final tree (branch `moon/sync`), with no model
unless a judge is named. The simulated judge is the quality runner's oracle ("perfect"), not a live model; the funnel
suites are in-sample (hidden, heldout, heldout2, heldout3, heldout4, seeds 41–44); held-out 5–8 were not read or run.
Live spend: $0 (no OpenRouter call was made). Timing numbers come from a 4-CPU machine shared with six other agents and
are noisy; CPU time is given where it matters.

## Why

Eden asks connectors at request time: each lookup sends its own search to three routed sources plus up to eight probe
calls (people, organisation, topic, day), 7.8 calls per lookup in the realistic simulation with configuration H (D55),
8.5 per task in the funnel. The `--sync` oracle (every item preloaded, no calls counted) showed that coverage alone is
worth something (in-sample: 128 → 147 delivered, 21 → 18 decoys) and that most of what is still missed is the
semantic gap, not coverage. A user's mail, calendar, chat, docs and CRM are a few thousand items: small enough to hold
locally, where every probe is free.

## What was built (all behind `sync`, off by default)

1. **`Source.list(scope, cursor, limit, signal) → {items, next}`** (`packages/sources/src/source.ts`): a recent-first
   page of everything the source holds for the user. Optional.
   - `McpSource` takes an operator-named `listTool`, checked exactly like the search and fetch tools (`readOnlyHint`
     or `trustedReadTools`; a tool that fails fails the connect and no tool is called, D7 unchanged). Without an
     `args` function its arguments come from its schema (`mapListArgs`: a page token by known names, `cursor`,
     `pageToken`, `starting_after`…, or an integer offset Eden advances itself; a page-size argument; operator
     `fixed` values; a required argument it cannot fill fails the connect). The next cursor is read by a fixed set of
     key lookups (`nextCursorOf`: top level, or one holder such as Slack's `response_metadata` or GraphQL's
     `pageInfo`; `has_more: false` ends; cursors over 2,048 characters are refused). An error result throws, so a
     failed page is never read as an empty listing.
   - `SourceFanout.list` admits each page through the same per-(user, source) breaker, AIMD concurrency limit and
     serving rate limit as a search, and redacts the page before returning it (D10).
   - `SimSource.list` pages the connector's items newest first, with the profile's latency, rate limit, faults and
     error draws, and counts its calls apart (`stats.lists`).
2. **`SyncManager`** (`packages/engine/src/sync.ts`), one per partner, per user and source:
   - **Backfill** of the newest `syncMaxItems` (3,000) across the user's sources: pages are read from the source whose
     read items reach least far back (a recency merge), so a busy mailbox does not crowd out a quiet calendar; past the
     cap the oldest are trimmed, and a source whose unread items are all older than the oldest kept is done.
   - **Learned staleness.** Each source's rate of new or changed items is a Gamma posterior, seeded from the recency of
     what the backfill read (items updated in the last week per hour) and updated by every poll (changes over hours
     watched, two-week memory). A source's synced copy is *current* while the chance that anything changed since its
     last poll is below `syncStaleChance` (0.15) and the poll is at most `syncMaxStaleMs` (6 h) old. In the simulated
     worlds that makes mail (about one item an hour) stale after ~10 minutes and a CRM after hours.
   - **Polls**: newest first until a page holds an item already synced and unchanged. On demand (`syncOnDemand`, on
     with `sync`): a lookup that finds a synced source stale polls it (one call, at most `syncCatchupPages` pages
     inside the lookup's deadline, the rest in the background) and then answers it locally. Timed polls every
     `syncEveryMs` while the user is active are available and off (0) by default: measured below, they cost far more.
   - **Sweeps** every `syncSweepMs` (24 h) per active user re-list the source; an item it no longer lists is dropped
     from the cache (delete propagation). A failing sweep drops nothing.
   - **Budgets**: `syncCallsPerMin` (30) per (user, source) of its own (GCRA), on top of the fan-out's guards;
     background pages leave the serving rate limit two tokens of headroom; failures back off 30 s doubling to 30 min.
   - **Bounds and retention**: users per tenant (`syncMaxUsersPerTenant`, 1,000; the least recently active stops being
     synced), ids per source, and users idle `syncDropMs` (7 days) are dropped with their synced items. `forget` drops
     the user's (or source's) sync state, and a page that lands after it stores nothing (checked by object identity,
     so a user forgotten and back at once is not fed the old page). Everything is keyed by tenant/user.
   - The tick runs off the fast path: `startSync()` puts it on a one-minute timer (the server does this when built with
     `sync`), simulations call `tick()` on their own clock. On the fast path the partner only records that the user
     is active (`track`, O(1), no I/O).
3. **Cache** (`cache.ts`): synced items are flagged; they have their own cap (`maxSyncedPerUser`, 5,000) and TTL
   (`syncTtlMs`, 7 days, refreshed by re-listing), so lookups never evict what the sync holds nor the sync what lookups
   brought. A lookup's copy of a synced item keeps it synced. `searchIn` answers a query for chosen sources:
   every word, newest first (as a mail or chat search does), or ranked.
4. **Request time** (`partner.ts`): with `sync`, a lookup first polls stale synced sources (on demand), then answers
   every *current* synced source from the local index: the lookup's own search, every probe (people, organisation,
   topic, day, roles, consequence) and the topic of an ask. Only sources that are not synced, or still stale, are
   called live, with the planner and the probe economy as before. Local answers cost no call and are outside
   `probeCalls`. The fast path keeps D40's rule (it delivers only what was read within `refreshAfterMs`), so synced
   items that were read longer ago go through the slow path, where the judge, when there is one, rules on them: the
   first version exempted current synced items, and the fast path then delivered 311 items at 0.57 precision past a
   perfect judge (judge precision fell to 0.875); with the rule kept, it is 0.952.
5. **Harnesses**: the funnel runs the real `SyncManager` when its config has `sync` (backfill from half an hour before
   the first task, then a tick every five simulated minutes between tasks) and prints a `sync:` line with backfill,
   background and on-demand calls apart, and the amortised total; `--time 1` runs the connectors at real latency.
   The quality runner does the same and adds a `sync` block; its `callsPerLookup` is request-time calls (searches,
   fetches, on-demand polls), never background ones, and lookups answered wholly locally count as lookups.

Two more flags were tried: `syncWide` (probes of a synced source go to every synced source) and `syncTermProbes`
(each rare request word alone, as a local probe). Both stay off: +1 and +2 funnel deliveries, and `syncTermProbes`
raised the judge's cost 9% for +0.004 perfect-judge recall. `syncLocalAll: false` (ranked local answers) changed nothing
measurable. Newest-first ordering of local answers mattered: ranked by score, 148 delivered; newest first, 153.

## Results

Configurations: **H** (D55). **HA** = H + `sync`, `consequenceProbe`, `probeRoles` (the latter two cost no call when
their sources are synced). Sync defaults as above.

### Funnel, no model, in-sample suites, seeds 41–44 (268 hidden + 268 control tasks)

| config | delivered | decoys | request calls/task | of which on-demand polls | amortised calls/task (+ backfill, background) |
|---|---|---|---|---|---|
| H | 128 | 21 | 8.5 | – | 8.5 |
| H + `--sync` oracle (no calls counted) | 147 | 18 | 6.3 | – | – |
| H + `sync` | 153 | 18 | 3.03 | 2.92 | 4.37 |
| H + `sync` + `consequenceProbe` | 169 | 18 | 3.03 | 2.92 | 4.38 |
| **HA** | **172** | **18** | **3.04** | 2.92 | **4.38** |
| H + `consequenceProbe` (no sync) | 137 | 21 | 8.8 | – | 8.8 |
| H + `sync`, stale sources live (`syncOnDemand: false`) | 152 | 18 | 6.04 | 0 | 7.39 |
| H + `sync`, timed polls every 15 min | 148 | 18 | 0.07 | 0.07 | 21.53 |

Per suite (delivered/decoys), H → HA: hidden 24/4 → 30/4, heldout 26/1 → 30/0, heldout2 28/3 → 38/0, heldout3 24/7 →
38/6, heldout4 26/6 → 36/8. Backfill: 18 listing calls per user (about 1,500 items at 100 per page); in the funnel each
suite, seed and variant is a new user, so backfill is amortised over about 6.7 tasks, which is the worst case.

The real sync beats the oracle (172 against 147 delivered, same 18 decoys): local probes cost nothing, so every probe
runs on every synced source with no `probeCalls` cut, and the consequence probe, which D55 left off for its calls,
is free. With H's flags off (`{}`) the funnel and `bun run eval` are unchanged (eval JSON equal to the base tree's
except latency fields; funnel H 148/128/21 at 8.5 calls on both trees).

The H+sync target written for this track (≥ 200 delivered at ≤ H's decoys) was set on 488 tasks that include the blind
held-out suites; on the in-sample suites the comparable bar is the oracle's 147, which HA passes by 25.

### Realistic simulation, 4 seeds (41–44), planner on

| config | judge | recall | precision | soft fire rate | request calls/lookup | total calls/lookup | bytes/needed fact | model $/1k turns |
|---|---|---|---|---|---|---|---|---|
| H | none | 0.407 | 0.639 | 0.086 | 7.76 | 7.76 | 469 | 0 |
| HA | none | 0.423 | 0.605 | 0.121 | 0.86 | 1.72 | 518 | 0 |
| H | perfect | 0.645 | 0.952 | 0.045 | 7.78 | 7.78 | 432 | 0.0170 |
| HA | perfect | **0.779** | **0.952** | 0.017 | **0.86** | 1.72 | 421 | 0.0222–0.0223 (two runs) |

Total calls include backfill and background (0.85 per lookup, nearly all backfill) and on-demand polls (0.84 per
lookup). HA answers 4.98 of the 5 sources per lookup locally. Zoo-a and zoo-b (connector search semantics
reshuffled): H perfect recall 0.613 and 0.738 at 7.55 and 7.84 calls per lookup; HA gives 0.779 at 0.86 on both, the
same as realistic, since local answers do not depend on how the connector searches (only on what its listing returns).

With a judge, HA raises recall by 13 points at equal precision and a lower soft fire rate; the judge sees more
candidates, so model cost per 1,000 turns rises 31% ($0.0170 → $0.0222–0.0223). With no model, recall rises 1.6 points
but precision falls 3.4 points and the soft fire rate rises 3.5 points (the mean of four per-run rates, each over a
handful of soft turns: H 0, 0.2, 0.143, 0 against HA 0.167, 0.133, 0.095, 0.091, so a few events; hard false fires
stay 0 in both). The no-model loss comes from more confident and
conflict-grounded deliveries (no-model "sources" path 371 → 394 items at 0.57–0.58 precision, conflict ground 72 → 104
at 0.82 → 0.64): local probes reach every synced source, so more items qualify. This needs the decision D56 records.

**Staleness**, realistic with `--updates 0.3` (140 source-side updates over the 4 seeds): stale copies delivered, H 2
(no model) and 5 (perfect judge), HA 3 and 5, `syncStaleChance` 0.5 3 and 5 (with 0.67 instead of 0.84 on-demand
polls per lookup). In the funnel (a static world) `syncStaleChance` 0.3 and 0.5 cut on-demand polls from 2.92 to 2.00
and 1.65 per task with no change in deliveries; a static world cannot show their cost, so the default stays 0.15.

### Delivery latency (connectors at real latency, `--time 1`)

Funnel, suites hidden and heldout, seeds 41–42, 88 tasks each (wall time of `observe` with the slow path waited for up
to 3 s; noisy machine): H p50 766 ms, p90 1,503 ms, p95 1,505 ms, mean 853 ms, 8.6 calls per task; H + `sync` +
`consequenceProbe` p50 507 ms, p90 1,171 ms, p95 1,318 ms, mean 583 ms, 2.82 request calls per task. A lookup now
waits for at most one listing call per stale source (in parallel) instead of a search and up to two rounds of probes.

### Cost of holding it (`packages/sim/src/lab/sync-cost.ts`)

Twelve simulated users backfilled (17,861 items): heap +48.7 MB, about 4.0 MB per user of ~1,490 items (about 2.7 KB
per item: text, index, sketches, source-map mentions), and 196–201 ms of CPU per user's backfill (redaction,
indexing, mention extraction). At the 3,000-item cap, about 8 MB per active user: a process holding 1,000 synced users
needs about 8 GB, so `syncMaxUsersPerTenant` and `syncDropMs` must be sized to the host.

## Amortisation

On-demand polling costs at most one listing call per stale source per lookup, and nothing while the user is idle;
timed polls cost calls whether or not anyone asks (in the funnel, one task an hour: 20 background calls per task; in
the realistic simulation, 7.6 per lookup against 0.85). Demand-driven polling is the right default for agents that
look up a few times an hour; timed polls pay only where lookups are far denser than a source's changes. The backfill
(18 calls per user here, about 30 at the 3,000 cap) is paid once per user per `syncDropMs`, plus a sweep a day per
active source.

## Risks and limits

- **No-model precision.** HA's no-model precision is 3.4 points under H's (soft fires +3.5 points). With a judge it is
  equal and recall is far higher. A deployment with no model should weigh that.
- **Staleness is learned, not known.** Between polls a source is trusted on its learned rate; a burst of changes after
  a quiet spell is missed until the next poll (at most `syncMaxStaleMs`). Edits to old items that do not move them to
  the top of the listing are seen only at the next sweep.
- **Listing semantics.** The poll assumes a recent-first listing. A list tool ordered otherwise needs a sweep to catch
  changes; one that pages inconsistently under concurrent change can skip items until the next sweep.
- **Memory and retention** (above): synced content is held in memory only (D8's spirit), for up to `syncTtlMs` per
  item and `syncDropMs` per idle user; more content is held than lookups alone would hold (D8 capped 2,000 items for
  24 h). Nothing synced is written to disk; the source map records mentions of persistable kinds only, as before.
- **Simulation limits.** The simulated worlds hold about 1,500 items per user and change only by `--updates`; real
  mailboxes are larger, so the cap and the recency merge matter more than here. No live or Pi-harness agent run was
  made (live budget $0).

## Reproduce

```bash
H='<D55 H JSON>'; HA="$(echo "$H" | sed 's/}$/,"sync":true,"consequenceProbe":true,"probeRoles":true}/')"
bun packages/sim/src/lab/hidden-funnel.ts --suite hidden,heldout,heldout2,heldout3,heldout4 --no-record --config "$HA"
bun packages/sim/src/lab/hidden-funnel.ts --suite hidden,heldout --seeds 41,42 --time 1 --no-record --config "$HA"
for j in none perfect; do for sd in 41 42 43 44; do
  bun packages/sim/src/quality-cli.ts --profile realistic --seed $sd --planner --judge $j --config "$HA"
done; done
bun packages/sim/src/lab/sync-cost.ts
```
