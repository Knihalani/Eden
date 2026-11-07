# A14: many users per server

Status: measured 2026-11-07 on branch `claude/a14-scale-users` (from `claude/lucid-hypatia-v9wqk5` at 598bd6ebe).
Decisions D325–D329. Paid spend: $0 (every figure is a no-model run). Machine: 4 vCPU Xeon (`nproc` 4), 15 GiB,
Linux 6.18.44, Bun 1.4.4, `BUN_OPTIONS` and `OPENROUTER_API_KEY` unset. The 1,000-sources-per-user question is A13's;
this note is about many users.

## In plain words

- **The old users-per-machine figure was for half-empty users.** RealUse-1 sized a 4-core 16 GB box at 5,100-7,400
  users from simulated users synced to a few hundred items. A real mailbox fills the sync's cap of 3,000 items, and
  there a user costs about **9.2 MB** of memory (resident, measured), not ~2 MB. The benches also undercounted: the
  heap figure they print leaves out typed arrays, which hold most of a user's index and all compressed text (a synced
  item is 3,200 B with them, 1,900 without). At the cap, one 4-core 16 GB box holds about **1,280** users, not
  5,000-7,400 (D329). Memory, not CPU, still decides: those users send about 170 events a second against a capacity
  of 3,200 or more.
- **Idle users are now frozen (D325, shipped).** A user nobody has read or written for 30 minutes is packed into one
  compressed block in memory (never on disk) and unpacked, exactly as they were, on their next request. Every answer
  is the same; the cost is about 0.1 s added to that user's first request after a pause (at 3,000 items), done in
  small slices so other users' requests do not wait behind it. With three users in four idle (a steady state), memory
  per user at the cap falls from 9.2 to **6.1 MB**: **1,280 → 1,920 users** on a 4-core 16 GB box, **4,800 → 7,200** on
  16 cores and 64 GB, and hosting falls from **$115 to $77 per 1,000 users a month** (AWS on-demand prices below).
  The simulated text compresses better than real mail; on real English prose the gain would be smaller (about 1.27x,
  an estimate).
- **A cold-start storm used to freeze everyone else's requests for a second.** When hundreds of users connect at
  once (a restart, a deploy, Monday morning), their first pages of mail arrive together and are processed back to back
  while every other request waits: warm users' events took **0.93 s at p99**. Storing one page per turn of the event
  loop (D328) brings that to **38 ms**, for 3% longer storms. It stays a switch, not the default, because it makes the
  paid card writer work in smaller batches (+28% card calls on the funnel for the same items).
- **Operators can now see and cap a tenant across processes.** `POST /v1/usage` (D326) gives a tenant's spend, calls,
  requests and users today, added up over every process. Behind a switch (D327), a tenant's daily model budget is
  shared out by the router instead of cut into equal slices per process, so a tenant with one busy user can use most
  of their cap, not a quarter of it (on 4 cores), and never more than all of it (except that a process restarted
  mid-day may spend its first small slice, an eighth of the cap's quarter on 4 cores, once more).
- **What is left:** a frozen user still keeps ~200 B an item of sync bookkeeping (the ids of what was synced) live; a
  restart still re-reads every user's sources (state is in memory only, D8); the storm fix needs a card writer that
  does not follow store timing before it can ship.

## What limits users per machine

| Limit | Measured | Binds? |
|---|---|---|
| Memory per synced user at the cap (3,000 items, sim-world text) | 9.16 MB RSS settled (9.18 MB heap + `external`), `users.bench.ts 200 3000 --world --waves=4 --no-freeze` | **yes** |
| Memory at 500 items (RealUse-1's partly synced users) | 1.55 MB RSS (1.34 heap + external), `users.bench.ts 400 500 --world --waves=4 --no-freeze` | |
| CPU per event | ~1 ms (RealUse-1 E); a 4-core box serves 3,200-3,800 events/s inside a 100 ms p99 | no: 3-25x headroom |
| Backfill CPU per synced item (redact, index, pack, mentions) | 138-153 µs (users.bench, instant sources) | cold starts |
| Cold-start storm: other users' p99 | 932 ms (storm.bench, 200 users x 1,000 items) | yes, during storms |
| Router balance (`childFor`), busiest child / mean, 10,000 users | 1.014-1.024 over 4 children, 1.051-1.093 over 16 (uuid and `user-<i>` ids) | ~2-9% headroom |
| Per-tenant spend cap split across processes | each child holds cap/N (D163) | for tenants on few users |

The biggest number in the table is what a user costs at the sync cap, so the work went there.

## D325: freezing idle users

### Design

`ItemCache` counts expiry ticks (`epoch`, every 10 minutes on its timer). A user read or written is marked seen at the
tick; one not seen for `freezeIdleMs` (30 min: three ticks, never fewer than two, so 20-30 minutes after the last use)
is frozen at that tick
(`FrozenUser`): its entries (the item as JSON sees it, text decoded; fetch time, read mark, class, raw hash, sketch
and its insertion sequence `Entry.seq`) and its party and offset tallies become one JSON string compressed by zstd at
level 3 (Bun 1.4's `zstdCompressSync`), kept in memory. The vocabulary, index, sketcher, entries and item objects go.
`revision` and `syncedCount` read the frozen record; every other read thaws.

Thawing rebuilds the user exactly: entries in their `items` order (the eviction order and both class lists), docs
indexed in their old insertion order (the index feeds equal-scoring candidates to its top-k in insertion order, so
ties rank as before), the same revision (so what is derived from the items, such as the sync's completeness memo,
stays valid), probes, tallies in their map order (`selfOf` picks the first of tied names) and sketches. Vocabulary ids
and doc numbers are new, as after the existing `rebuild`: nothing outside holds them across calls.

Two costs needed engineering, because at the cap a freeze takes ~21 ms and a thaw ~107 ms of CPU:

- **Slices.** On the timer, freezes (and the expiry of a frozen user whose items aged out: thaw, sweep, freeze again)
  are background jobs of one scheduler (`pump`): one job at a time, generator steps of 64 entries, the event loop
  given back every 5 ms. `observe`, `ask` and `checkAction` first await `cache.ready(scope)`, which queues the user's
  thaw as an urgent job of the same scheduler. With one job per turn, a burst of returning users queues instead of
  spreading: the first version gave each thaw its own slice per turn, and 20 returning users stalled the loop 397 ms.
- **zstd over the whole user.** On 500 workload items the blob was 270 B an item at 3.3 µs an item to compress,
  against 464 B at 42.7 µs for deflate at its default level (scratch measurement, `.local/a14/prof.ts`). Per item,
  zstd was ~2x faster than deflate but 4-7% larger, so the cache's own packed text (D188) stays deflate.

A read or write while a freeze is under way drops the freeze; a read before a queued thaw's turn thaws at once (the
same state; only the wait moves). A lab that never reaches its 10-minute timer never freezes, so the funnel and the
eval are unchanged by construction.

### Exactness

`cache-freeze.test.ts` runs a freezing cache and a never-freezing twin through the same 60 steps (puts of new, changed
and unchanged copies, removals with holds, sync drops, probes, expiry, eviction past both caps, a fifth of items with
identical bodies so scores tie), freezing between steps, and compares every read: `search`, `searchIn` (scored and
all-terms), `timed`, `hits`, `isRare`, `selfOf`, `offsetOf`, party counts, probes, revision, synced count. Two
mutations were checked to fail it: indexing in `items` order instead of insertion order, and a reordered party tally.
Also tested: isolation (D9; two users of one tenant and the same user id in another tenant, forget of a frozen user),
the drop hook on a frozen user's expiry, metadata reads not thawing, a sliced burst, a freeze dropped by a write, and
the partner thawing through `ready`. Two runs of the partner itself differ with wall-clock timing (background slow
paths settle at different points, even with the core configuration), so exactness is held at the cache.

### Numbers

`users.bench.ts 200 3000 --world --waves=4` (200 users at the cap, sim-world text averaging 1,090 characters; users
arrive in 4 waves and each earlier wave goes idle and freezes before the next, so a quarter are active at the end).
Memory is per user, JS heap plus `external` after a full GC, and RSS once it stops falling.

| 200 users x 3,000 items | Heap + external | RSS |
|---|---|---|
| Nobody frozen (`--no-freeze`: the tree before D325) | 9.18 MB (3,208 B/item) | 9.16 MB |
| A quarter active, three quarters frozen | 4.63 MB | **6.12 MB (1.50x less)** |
| Everyone frozen | 0.87 MB (blob 101 B/item; the rest 598 KB/user) | 1.84 MB |

| 400 users x 500 items | Heap + external | RSS |
|---|---|---|
| Nobody frozen | 1.34 MB | 1.55 MB |
| A quarter active | 0.73 MB | 1.14 MB (1.36x less) |
| Everyone frozen | 0.12 MB (blob 112 B/item) | 0.42 MB |

RSS stays above the heap once some users are frozen: freed memory between live users is not all given back.

**Text caveat.** Sim-world and workload text is generated from templates and compresses far better than real mail.
On real English prose (the repo's own docs cut into 1,500-character items, 500 a user) the zstd blob is **592 B an
item** against 101 for sim-world text. At the cap that adds about 1.5 MB to a frozen user, which would make the
steady state about 7.2 MB a user and the gain about **1.27x** (arithmetic on the measured blob, not a run). Real mail
has headers, signatures and quoted replies that compress better than prose, so the real gain is likely between the
two.

Thaw and freeze, same runs: a user's first read after a freeze took 107 ms p50, 157 ms p99 at 3,000 items (36 µs an
item); 0.1 ms with no freeze. Freezing took 21 ms a user. All 200 frozen in slices took 8.5 s with the loop's worst
stall 60 ms; all 200 thawing at once took 23.5 s with the worst stall 81 ms (100 ms in an earlier run) and p99 20 ms.
The first event per user afterwards (fast path) was 8.2 ms p50 either way.

### Known costs

- A returning user's first request waits for their thaw (~0.1 s at the cap) once per pause of 20-30 minutes or more
  (a user last seen during a 10-minute tick freezes two or three ticks later).
- A frozen user is thawed (queued, in slices) by anything that reads their items: their requests, a change
  notification or removal for one of their sources (`syncPush`, on in the default), a due daily sweep, or a backfill;
  each keeps them live for another 20-30 minutes. The steady state above assumes idle users' sources are quiet; a
  user whose mailbox notifies every few minutes never stays frozen. The review found these paths thawing at once
  inside the read; they now await `ready` as the requests do (`cache-freeze.test.ts`).
- The sync's weekly drop of a user idle for `syncDropMs` (7 days) reads their items, which thaws them at once
  (synchronously, ~0.1 s at the cap), once a week per such user.
- A frozen user keeps ~600 KB of state outside the cache at 3,000 items, mostly one string per synced item: the
  sync's per-source id sets (`SourceSync.ids`) and similar bookkeeping (`bun:jsc` `heapStats`: 1.8 strings per item
  left after freezing 30 users). Compacting those (hashed ids, or ids read back from the frozen record) is the next
  memory lever; it touches most of `sync.ts`.

## D328: storing a storm's pages one per turn (trial)

A background sync page (backfill, sweep, timed poll; never a lookup's on-demand poll) awaits `SyncManager.turn`
before it is redacted and stored: each turn resolves one turn of the event loop after the previous one, so pages are
processed one per turn, in arrival order, with requests, timers and I/O run between them. `SourceFanout.list` takes the
optional `turn` and awaits it only when given (an extra await there has moved the funnel before).

`storm.bench.ts 200 1000`: 20 warm users (200 items each) send a `user_message` due every 10 ms (open loop: latency
from when it was due) while 200 new users with three 20-80 ms connectors each are synced from cold. Three runs each,
median (min-max):

| | Storm wall | Warm users' `observe` p99 | max | Loop stall max |
|---|---|---|---|---|
| Default | 35.4 s (34.7-36.6) | 932 ms (916-934) | 1,053 ms (1,042-1,072) | 1,311 ms (1,156-1,342) |
| `syncIngestTurns` | 36.6 s (35.6-37.6) | **38 ms (38-40)** | 57 ms (52-69) | 203 ms (202-235) |

Quality: `bun run funnel --jobs 4 --set '{"syncIngestTurns":true}' --baseline <default>`: hidden +0 −0, decoys +0 −0
(305/384, 267/384), the same 2,091 items carded and 6,582 sent, but **549 card calls against 428**: the card drain
batches whatever is stored when it runs, and pages now land one per turn. Card calls are the paid background role,
so under D112 the switch is not promoted; the next step is a card drain on its own timer, after which the trial is
measured again (trials table).

## D326, D327: usage and spend caps across processes

`POST /v1/usage` answers the key's tenant: `modelUsd`, `modelCalls`, `capUsd` (what this process may spend), requests
by route today, `users`, `frozenUsers`, `items`, `syncedUsers`; the router sends it to every child and adds the
numbers (`processes`, `processesDown`). Counts and dollars only.

`EDEN_SPEND_LEASES=1` (trial): each child starts a tenant's day with cap/(4N) and asks the router's ledger for chunks
of cap/(4N) once under half a chunk is left. `spend-lease.test.ts`, $25 a tenant over 4 children: one busy child spent
$20.31 (the cap less the other three children's unused starts) against $6.25 with the divided cap; four busy children
together stayed within $25. The IPC round trip between a real router and its children is exercised only up to the
children's starts (`router-processes.test.ts`): without a model key nothing spends, so no grant is asked for in a test.
Not promoted: no paid run was made, and tenants spread over many users gain nothing.

## Users per machine and hosting cost, before and after

Assumptions (labelled): 75% of RAM usable for user state (GC headroom, OS); one server process per core at the idle
RSS the server notes measured (~70 MB each); the busiest child holds 1.024x the mean on 4 children and 1.093x on 16
(10,000 users, measured above); a quarter of users active within 30 minutes (the waves steady state; real activity
varies by product and hour); sim-world text. Per-user RSS from the tables above.

| | Per user | 4 cores, 16 GB | 16 cores, 64 GB |
|---|---|---|---|
| At the cap, before (D325 off) | 9.16 MB | **1,280** | **4,800** |
| At the cap, after | 6.12 MB | **1,920** | **7,180** |
| At the cap, after, real-prose estimate | ~7.2 MB | ~1,630 | ~6,100 |
| 500 items, before | 1.55 MB | 7,570 | 28,350 |
| 500 items, after | 1.14 MB | 10,290 | 38,550 |

Arithmetic: 4 cores: (0.75 x 16,384 − 4 x 70) / 1.024 / per-user MB; 16 cores: (0.75 x 65,536 − 16 x 70) / 1.093 /
per-user MB. CPU at those counts: 0.131 events/s a user (RealUse-1 E) gives 250 events/s for 1,920 users and 1,350 for
10,290 on 4 cores, inside the 3,200-3,800 the router serves at a 100 ms p99.

Hosting, at AWS on-demand Linux prices in us-east-1 (m7i.xlarge, 4 vCPU 16 GiB, $0.2016/h; m7i.4xlarge, 16 vCPU 64
GiB, $0.8064/h; 730 h a month; listed by DoIT, Holori and Devzero, 2026-11-07, not checked against AWS's own page):

| $ per 1,000 users a month | 4 cores ($147.17/month) | 16 cores ($588.67/month) |
|---|---|---|
| At the cap, before | $115.0 | $122.7 |
| At the cap, after | **$76.8** | **$82.0** |
| 500 items, before | $19.4 | $20.8 |
| 500 items, after | $14.3 | $15.3 |

Model spend (cards and the reader, with a key) is separate: docs/COST-MODEL.md.

### p99 and storms

- Steady load: unchanged by these decisions (RealUse-1 E: `observe` p99 ~9 ms over HTTP at real pacing).
- A returning user's first request after 30 minutes idle: +107 ms p50 at the cap (their thaw); others' loop stall
  during a burst of 200 thaws at most 81-100 ms.
- Cold-start storm, per process: 2.3-2.5 users a second at the cap and 13.9-14.6 at 500 items with instant
  connectors (backfill CPU bound: 138-153 µs an item); 5.5-5.7 users a second at 1,000 items with 20-80 ms
  connectors. A 4-core box restarting with 1,920 users at the cap needs about 1,920 x 3,000 x 150 µs / 4 ≈ 3.6 minutes
  of all four cores; meanwhile requests wait up to ~1 s at p99, or ~40 ms with D328.
- Restart: state is in memory only (D8), so a restart is that storm, and with a key every re-stored item can be
  carded again. Persisting frozen blobs (encrypted, operator opt-in) would turn a restart into thaws, but writes item
  content to disk, which D8 forbids today; it needs its own decision.

## Not done, with why

- **Sharing immutable structures across a tenant's users.** What is shared is content (an item two users both
  received), and D9 allows sharing only content-free aggregates; the content-free per-user structures (vocabularies,
  term statistics) differ per user and are a small share of a user (the index and text dominate).
- **A new per-user index format.** The packed index (D111) is already compact; at the cap the live user is mostly
  index, text and entries, which freezing removes for idle users. A struct-of-arrays entry table (fix-s5's next
  lever) would save ~130 B an item for live users only.
- **Cold tier on disk.** D8 (above).
- **10,000 users through `sim:perf`.** Its server never starts the sync (RealUse-1 E's caveat), so it measures
  unsynced users; `users.bench.ts` measures synced users through the shipped wiring instead. Not extended.

## Reproduce

```bash
unset BUN_OPTIONS OPENROUTER_API_KEY
bun packages/engine/bench/users.bench.ts 200 3000 --world --waves=4 [--no-freeze]   # ~2.5 min each
bun packages/engine/bench/users.bench.ts 400 500 --world --waves=4 [--no-freeze]
bun packages/engine/bench/storm.bench.ts 200 1000 [--config='{"syncIngestTurns":true}']   # ~1 min each, 3x
bun run funnel --jobs 4 --json base.json
bun run funnel --jobs 4 --set '{"syncIngestTurns":true}' --baseline base.json   # card calls: "merged cards use"
bun test ./packages/engine/src/cache-freeze.test.ts ./packages/server/src/spend-lease.test.ts
bun run eval
```
