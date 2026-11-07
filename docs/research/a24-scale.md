# A24: smaller idle users, and the storm fix shipped

Status: measured 2026-11-07 on branch `claude/a24-scale4` (from `claude/lucid-hypatia-v9wqk5` at 8066c473), A14's two
open levers ([a14-scale-users.md](a14-scale-users.md)). Decisions D370–D374. Paid spend: $0 (every figure is a
no-model run). Machine: 4 vCPU Xeon, 15 GiB, Bun 1.4.4, `BUN_OPTIONS` and `OPENROUTER_API_KEY` unset; benches run one
at a time with nothing else on the box.

## In plain words

- **A frozen user now costs half the memory.** When a user goes idle their items are packed away (D325), but the
  background sync still kept one string for every item it had synced, about 250 KB a user at the 3,000-item cap. Those
  ids now live in compact typed arrays (`IdSet`, D371): **a frozen user's resident memory falls from 1.86 to 0.94 MB**.
  A live user is unchanged (their ids are the same strings the cache already holds).
- **The fix for cold-start storms now ships (D328 promoted by D370).** When hundreds of users connect at once, their
  first pages of mail used to be processed back to back while every other request waited (warm users' p99 ~0.9 s).
  Storing one page per turn of the event loop fixed that, but made the paid card writer call the model on smaller
  batches (+27% calls). The card writer now waits briefly for pages still queued before it calls, so its batches fill
  up again: **card calls on the funnel 446 (default before) → 376 (new default)**, the same 2,091 items carded, every
  hidden fact and decoy unchanged task by task. During a 200-user storm, warm users' p99 is **48 ms against 1,180 ms** without it (the storm itself takes 9%
  longer).
- **Storing a page per turn also lowers memory.** Settled RSS with three users in four frozen fell from 6.6–6.7 MB to
  5.15 MB a user (two runs each). Most of that is the storm fix (the garbage of one page is collected before the next
  arrives), a little is the compact ids.
- **Together: a 4-core 16 GB box holds ~2,280 users at the cap instead of ~1,760, and hosting falls from ~$84 to ~$65
  per 1,000 users a month** (same assumptions as A14; A14's own figures were 1,920 and $77 from a base run that
  measured 6.12 MB where today's base runs measured 6.63 and 6.72: RSS varies by several percent run to run).
- **A measurement correction (D372).** On Bun 1.4, `heapUsed` already includes typed arrays and Buffers; `external`
  counts them a second time. A14's "heap + external" figures (and D329's reason for them) double-counted: a synced
  item is ~1,880 B of heap, not 3,200. Machine sizing was always on RSS, so the users-per-box figures stand.

## 1. The sync's ids (D371)

### What a frozen user still held

A scratch probe (30 users x 3,000 sim-world items, everyone frozen, then each structure dropped in turn and the heap
measured after a full GC) found 270-272 KB a user in the sync's per-source id sets (`SourceSync.ids`, 3,000 strings
of ~15 characters: ~91 B an id), 2-8 KB in the rest of the sync, and the cache's frozen record (the zstd blob, ~296
KB; counted twice in A14's heap + external, see D372). The sweep's `seen` set, `missed` and the pushed-id map are empty
between sweeps.

### `IdSet` (`packages/primitives/src/idset.ts`)

An insertion-ordered string set with `Set<string>`'s semantics (add, has, delete, size, clear, iteration in insertion
order, deletes during iteration skipped, a re-add after delete moves to the end) held in typed arrays: one byte arena
(Latin-1 code units one byte; any other code unit three bytes behind an escape), a start offset, a 32-bit hash and a
live flag per slot, and an open-addressed table of 16-bit entries (32-bit past 65,534 slots) kept at most three
quarters full. Deleted slots are reclaimed by the next `add` that needs room once they are half the slots, never while
an iterator is open. `idset.test.ts` runs it against `Set<string>` over 60,000 random operations (ASCII, Latin-1, the
escape byte itself, surrogate pairs, the empty id), deletes and adds during iteration, ids of 15,000 characters, and
the switch to a 32-bit table.

`bun packages/primitives/bench/idset.bench.ts` (300 sets of 3,000 ids built from strings nobody else holds, as a
frozen user's are; after a full GC):

| 300 sets x 3,000 ids | `Set<string>` heapUsed | `IdSet` heapUsed | `Set` RSS | `IdSet` RSS |
|---|---|---|---|---|
| Short ids (`mail:u12-345`, 13-15 characters, the benches') | 89.0 B/id | **37.2 B/id** (2.4x) | 146 B/id | 53 B/id |
| Long ids (30 characters, Gmail-like refs) | 101.2 B/id | **58.9 B/id** (1.7x) | 132 B/id | 86 B/id |

`external` (counted inside `heapUsed`, D372): 13.3 and 25.5 B/id for the `Set`, all of the `IdSet`'s 37.0 and 58.7.
Speed on one 3,000-id set of long ids, p50 (two runs on the idle box; the second shown):

| Operation | `Set<string>` | `IdSet` |
|---|---|---|
| `has`, present | 7.8 ns | 91.6 ns |
| `has`, absent | 11.3 ns | 87.1 ns |
| `delete` + `add` (the sync's re-order of a stored item) | 40.8 ns | 274.2 ns |
| Iterate all 3,000 | 5.36 µs | 230.8 µs (184.1 in the first run) |

`IdSet` is slower on every operation (it encodes and hashes the id on each call, and iteration makes a string per
id); the sync's per-item cost is 0.3 µs against ~140-215 µs of backfill CPU per item, so the trade is memory.

The sync calls `has` once per listed item that is older than the user's cut (`syncKeepCut`) and iterates its ids for
completeness (memoised per cache revision), the trim, the sweep's end and the backfill's rate estimate: ~0.2 ms a
3,000-id source per walk, against ~0.14 ms of backfill CPU per synced item.

In `sync.ts` the change is the field's type and comment, its constructor, the two helpers' parameter types and the
import; D370 adds `pending()` and a counter beside `turn`.

### users.bench (D325's phases, 200 users x 3,000 sim-world items, 4 waves)

`bun packages/engine/bench/users.bench.ts 200 3000 --world --waves=4 [--no-freeze] [--config=…]`; per user, memory
after a full GC above the empty process; RSS once it stops falling. "Base" is the base commit's engine with this
branch's bench (which reports `heapUsed`, `external` and RSS each on its own and takes `--config`).

| Tree | Three quarters frozen: heapUsed | external | RSS | All frozen: heapUsed (non-blob) | RSS |
|---|---|---|---|---|---|
| Base (run 1) | 2.78 MB | 1.85 MB | 6.63 MB | 0.54 MB (255 KB) | 1.87 MB |
| Base (run 2) | 2.79 MB | 1.85 MB | 6.72 MB | 0.54 MB (255 KB) | 1.86 MB |
| `IdSet`, turns off | 2.73 MB | 1.93 MB | 6.58 MB | 0.41 MB (127 KB) | 0.94 MB |
| `IdSet` + turns (the new default), run 1 | 2.71 MB | 1.91 MB | 5.16 MB | 0.41 MB (128 KB) | 0.92 MB |
| `IdSet` + turns, run 2 | 2.71 MB | 1.91 MB | 5.15 MB | 0.41 MB (127 KB) | 0.95 MB |

Nobody frozen (`--no-freeze`, one run each): base 5.38 MB heapUsed, 9.47 MB RSS; new default 5.39 MB heapUsed, 7.81
MB RSS. A live user's heap is the same: the cache's entries hold the same id strings the sync's `Set` held, so only the
`Set`'s own table goes, and the `IdSet`'s arrays take about as much.

Thaw, freeze and events are unchanged: first read after a freeze 110 ms p50, 156 ms p99 (base) against 109 and 156;
sliced thaw of all 200 at once 23.5 s and 23.0 s, worst loop stall 85 and 99 ms.

## 2. The card drain gathers (D370), and D328 promoted

### Why D328 cost card calls

`CardEnricher.drain` starts one microtask after an `enqueue` and calls the model with whatever is queued, up to a
batch (20 items in the default, `cardsEconomy`). With pages stored back to back, the items of every page that arrived together are queued before it runs; with
one page per turn, it runs after the first page and calls on that page alone, then on what landed during that call.

### The fix

`CardEnricher.gather` (set by the partner when `syncIngestTurns` is on) returns a promise that resolves one loop turn
after the last page now waiting its turn has been let through (`SyncManager.pending`), or null when none waits. A drain
with less than a batch (20 in the default) queued waits on it, again and again, until it has a batch, nothing waits, or `GATHER_MS` (250
ms of wall time) has passed: the queue of turns is the process's, and in a storm it does not empty for minutes. With
nothing waiting there is no extra await on the drain's path (an extra hop there moved the default's cards before,
CL3).

### Quality and card calls

`bun run funnel --jobs 4` (train, seeds 41-42, 768 tasks, reader stub, cards and intent replayed); card calls are the
`merged cards use` line.

| Arm | Hidden | Decoys | Card calls | Items sent | Carded | vs base, task by task |
|---|---|---|---|---|---|---|
| Base (default before) | 314/384 | 273/384 | 446 | 6,604 | 2,091 | – |
| `syncIngestTurns` alone (D328 before this note: no gather) | 314 | 273 | 567 | 6,604 | 2,091 | +0 −0, +0 −0 |
| **New default** (turns + gather), two runs; on the merged tip | 314 | 273 | **376**, 376; 377 | 6,604 | 2,091 | +0 −0, +0 −0 |
| New default with `syncIngestTurns: false` | 314 | 273 | 446 | 6,604 | 2,091 | +0 −0, +0 −0 |

Card replay: 2,357 replayed and 114 uncovered (no cached card) in the base and in the new default. Fewer calls for
the same items means fuller batches (17.6 items a call against 14.8; the default's limit is 20, `cardsEconomy`):
the limit is unchanged, so a call is never larger than before, only more often full. `bun run eval` on the new default: precision 0.5909,
recall 0.52, falseFireRate 0 (as before).

### The storm

`bun packages/engine/bench/storm.bench.ts 200 1000 --config=…` (20 warm users sending an event every 10 ms, open loop,
while 200 new users with three 20-80 ms connectors each are synced from cold), three runs each, median (min-max):

| | Storm wall | Warm users' `observe` p99 | max | Loop stall max |
|---|---|---|---|---|
| `syncIngestTurns: false` (the default before) | 45.4 s (43.8-45.6) | 1,180 ms (1,144-1,193) | 1,277 ms (1,271-1,320) | 1,572 ms (1,495-1,623) |
| **New default** | 49.4 s (47.8-49.6) | **48 ms (47-52)** | 79 ms (67-86) | 266 ms (213-285) |

The box ran slower today than in A14 (35.4 s storms, 932 ms p99, same command); the storm takes 9% longer with
turns here, 3% there. D328's trial bar (p99 under 100 ms at 200 users) holds.

The storm bench wires no card model; with one, a cold user's partial batch waits at most 250 ms before its call.

## 3. Users per machine and hosting cost (D373)

A14's assumptions unchanged: 75% of RAM for user state, one process per core at ~70 MB, the busiest of 4 children
1.024x the mean (1.093x of 16), a quarter of users active within 30 minutes, sim-world text, AWS on-demand m7i.xlarge
$147.17 a month and m7i.4xlarge $588.67 (A14's sources, not re-checked). Per-user RSS: the mean of the runs above.

| At the cap, three quarters frozen | RSS a user | 4 cores, 16 GB | 16 cores, 64 GB | $ / 1,000 users a month (4 c) | (16 c) |
|---|---|---|---|---|---|
| Base (today's runs) | 6.68 MB | 1,757 | 6,584 | $83.8 | $89.4 |
| `IdSet` alone | 6.58 MB | 1,782 | 6,679 | $82.6 | $88.1 |
| **New default** (`IdSet` + turns + gather) | **5.16 MB** | **2,275** | **8,525** | **$64.7** | **$69.1** |
| Everyone frozen, base | 1.87 MB | 6,288 | 23,563 | $23.4 | $25.0 |
| Everyone frozen, new default | 0.94 MB | 12,475 | 46,750 | $11.8 | $12.6 |

Arithmetic: 4 cores (0.75 x 16,384 − 4 x 70) / 1.024 / MB; 16 cores (0.75 x 65,536 − 16 x 70) / 1.093 / MB. A14
reported 6.12 MB for the base (1,920 users, $76.8); today's two base runs gave 6.63 and 6.72 on the same command, so
the before/after here compares runs made back to back today. CPU at 2,275 users: 0.131 events/s a user (RealUse-1 E)
is ~300 events/s, inside the 3,200-3,800 a 4-core box serves at a 100 ms p99. Model spend is separate
(docs/COST-MODEL.md); with a key, card calls fall with D370 (446 → 376 on the funnel, −16%).

## 4. The heap figure (D372)

`bun -e` scratch, Bun 1.4.4: 1,000 `Uint8Array(100_000)` raise `heapUsed` by 95.4 MB and `external` by 95.4 MB (RSS
+99.4 MB); zstd Buffers likewise. Clearing 30 frozen users' cache records freed 287 KB a user of `heapUsed` and 287 KB
of `external`, for a 296 KB blob. So `heapUsed` is the JS heap including typed arrays' stores, and `external` is a
subset of it, not an addition. A14's heap + external double-counted every typed array: its 9.18 MB live user is
~5.4 MB of heap (this note's `--no-freeze` rows), its 3,208 B an item ~1,880. D329's statement that `heapUsed` leaves
out typed arrays is wrong on this runtime; its rule to size machines on RSS stands, and RSS was what A14 sized on.
`users.bench.ts` now prints the three on their own.

## 5. Fixes from the review of A14 (D374)

The coordinator passed on an independent review of A14 and asked for the small fixes, each with a test that fails
without it:

- **Thaws only where items are read.** `observe` thawed a frozen user before looking at the event's kind, so a
  `session_end` or a draft (which read nothing) unpacked a whole user; they now start no thaw, but wait on one an
  earlier event of the user already waits on (`ItemCache.pendingThaw`): the first version skipped the wait, and the
  branch's reviewer showed a `session_end` then ran before its session's earlier message and closed the session under
  it (`cache-freeze.test.ts` now holds that case). `/v1/pending`
  (the take checks new items against the session's plans) and `/v1/forget` for one source (it drops that source's
  items from the cache) read items synchronously, which thawed in one ~110-190 ms block at the cap; they now await
  `partner.ready`, as `/v1/sources/removed` did. A18's `/v1/sources/refs` (D347) answers at once and reads the named
  refs in the background: each read now awaits `cache.ready` before the drop or store it leads to, and checks a removal
  that landed meanwhile after that wait, so a user frozen while a fetch was on the wire thaws in slices.
- **Fan-out copies.** The router sends `/v1/usage` and `/v1/forget` to every child; each child's copy spent a token
  of that child's divided rate limit, and a child that answered 429 was counted as down. A copy (the router's header,
  honoured only in a router child and only on the two routes the router copies) now spends no token and is not
  counted.
- **Spend leases (D327, trial).** A child whose lease came back 0 asked the router again at every tally and every
  `/v1/usage` read (94 asks in the test's run); it now remembers the day is all granted until the next UTC day.
- **The reviewer of this branch** found three low issues, fixed: a forgotten user's drain waited out its 250 ms
  gather (now ends at once), `IdSet`'s shared lookup scratch kept its largest size forever (now shrinks back to 4 KB),
  and an iterator stepped by hand and never finished stops compaction (documented). Its funnel runs gave 377, 376 and
  376 card calls: the gather's cap is wall time, so a batch's cut can move by one under load.

## Not done

- **Dropping a frozen user's ids altogether** (rebuilding them from the frozen record on thaw): the sync and the cache
  would have to agree on which items each source owns while the user is frozen, a change across most of `sync.ts`
  that A21 is also changing now. What is left of the sync for a frozen user is ~110 KB of `IdSet` at the cap.
- **The blob itself** (296 KB a frozen user, 101 B an item of sim text; ~590 B an item on real prose by A14's
  estimate) is now most of a frozen user. A dictionary trained per tenant, or zstd at a higher level, would be the
  next lever; not measured.

## Reproduce

```bash
unset BUN_OPTIONS OPENROUTER_API_KEY
bun packages/primitives/bench/idset.bench.ts
bun packages/engine/bench/users.bench.ts 200 3000 --world --waves=4 [--no-freeze] [--config='{"syncIngestTurns":false}']
bun packages/engine/bench/storm.bench.ts 200 1000 [--config='{"syncIngestTurns":false}']   # 3 runs each
bun run funnel --jobs 4 --json base.json            # on the base commit
bun run funnel --jobs 4 --baseline base.json        # this branch; card calls: "merged cards use"
bun test ./packages/primitives/src/idset.test.ts ./packages/engine/src/sync-turns.test.ts ./packages/engine/src/cards.test.ts
bun run eval
```
