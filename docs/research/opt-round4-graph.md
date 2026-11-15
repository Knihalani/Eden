# Low-level round 4: the graph and search-index layer

Decisions: D1935-D1938, and D1960 (a follow-up: files made before D1936 moved). A fourth low-level brief (2026-11-15): profile the graph and index layer (packages/graph's
source map: SQLite statements, mentions, outcomes; the sparse index's build, freeze and thaw in
`@eden/primitives` and the engine's cache) on real workloads, and cut what costs, with every answer unchanged to
the order and the float. Other sessions held the engine's ask path, the sync sweep, the servers and the test
suite. No model call and no paid call was made. Every number below comes from a command run in this session on the
shared 4-core VM (load average 2.0-3.4 while it ran); the scripts were scratch files, not kept.

## Method

- **Profiles**: `bun --cpu-prof` of `pipeline.bench.ts` (200 µs samples), `ingest.bench.ts 40 500 shipped` (500 µs)
  and `users.bench.ts 100 500` (1 ms, a file-backed map as the servers keep one), summed by function, self and
  inclusive, and by callee under a frame.
- **Traces**: every public `SourceMap` call the pipeline bench (8,700 calls: 5,238 `sourcesFor`, 2,448 `route`, 942
  outcomes, 72 mention batches) and the users bench at 40 × 500 (240 mention batches of 20,000 items, 80 routes)
  made, recorded with their arguments and replayed on the map before and after, in memory and on a file: the layer's
  own CPU without the rest of the engine's noise.
- **A/B**: separate processes, interleaved and slot-balanced (the arms' order rotates every round), with a
  self-against-self control arm (main's map twice); process CPU (`resourceUsage`, every thread), medians, and the
  paired median of new/main with its range. The whole-bench arms load main's `source-map.ts` through a Bun loader
  plugin in a preload (the same files otherwise), so each round runs the same tree but for the map. Replays ran both
  without and with a forced full GC before each repetition.
- **Oracle**: `source-map.reference.ts` is main's `source-map.ts` (7bca42093) unchanged; `source-map-fast.test.ts`
  runs it beside the new map.

## Profiles before (main 7bca42093)

- pipeline.bench: the map's reads were 3.0% of the process: `sourcesFor` 2.21% inclusive (its `.all()` 2.0% self, a
  query and a row object per source per call), `route` 2.29%, `outcomesIn` 0.73%; `SparseIndex.search` 3.65%.
  Of its 8,673 mention reads (5,238 direct `sourcesFor` calls, the earn rule's holders, one a name; 3,435 inside
  routes), 96.8% asked for a (user, entity) asked before and 87.6% for one asked since the last mention batch (the
  file unchanged between); 275 keys were distinct.
- ingest.bench 40 × 500 shipped: `recordMentionsMany` 9.61% inclusive, of it the batched SQLite upserts 6.34% (5.5%
  native `run`) and `normalizeEntity` 1.73% self; `addFields` 4.45%, `mergeStep` 0.67% self.
- users.bench 100 × 500: `recordMentionsMany` 7.91% (upserts 5.38%); a warm freeze 6.95% (the index's `snapshot`
  9.0% of it, the varint `gaps` 6.9%, zstd 40.1%); a warm thaw 4.10% (`ungaps` 10.3%, `SparseIndex.restore` 1.6%);
  `addFields` 2.79%, `mergeStep` 1.10%, `compact` 0.39%.

## Changes kept

### D1935: the map's reads are memoised, exactly

`sourcesFor` read SQLite for every name of every route, and `route` read the situation's outcomes for every route.
Both now go through memos keyed by scope key first (one user's read never answers another's): the mention rows of
a (user, entity) as the query returns them (count descending, then source id, from `.values()` rather than row
objects) and the outcomes of a (user, situation). They are exact, not timed: every write of a table this connection
makes empties its memo (`flushMentions`, `flushOutcomes`, `correctOutcome`, `forget`, so `importUser`), and for a
file, which a second process may write (D15), `PRAGMA data_version` is read once a `sourcesFor` or a `route` and a
change (another connection committed) empties both. Pending mentions (D1780) are still added at each read, to fresh
row objects (the memo's arrays are never handed out). Each memo holds at most 4,096 keys plus rows, then is emptied
whole: about 0.45 MB of heap when full (2-row keys over 100 users, measured), a process's cost whatever its users.

| Measure | Main | D1935-D1937 | Control |
| --- | ---: | ---: | ---: |
| pipeline trace replayed, in memory, ms CPU (6 rounds, median of 5 reps) | 100.4 | 58.7 [0.606, 0.53-0.66] | 1.020 |
| the same on a file | 109.1 | 70.8 [0.614, 0.53-0.76] | 0.997 |
| the same on a file, a forced GC before each rep | 121.7 | 78.7 [0.620, 0.56-0.89] | 1.003 |
| `sourcesFor` hit, file / memory, µs (5 rounds, 20,000 calls) | 3.9-6.4 | 1.4-2.0 / 0.35-0.68 | |
| `route` of two names over four sources, file / memory, µs | 12.5-16.5 | 3.1-5.3 | |
| pipeline.bench process CPU, ms (8 rounds) | 4,119 | 4,175 [1.016, 0.91-1.12] | 1.068 |

The layer's own CPU on the pipeline's calls fell about 39%; at 3% of the pipeline that is about 1% of the process,
below what the whole bench can resolve on this machine (its control arm read 1.068). A memo miss costs what main's
read did (the same query, arrays in place of objects).

### D1936: the map's tables are WITHOUT ROWID

The three tables had composite text primary keys and a rowid, so SQLite kept every row twice: the table's B-tree
by rowid and the key's automatic index. A new file now makes each table `WITHOUT ROWID` (the key's B-tree alone).
A file made before keeps its rowid tables (`CREATE TABLE IF NOT EXISTS`) and reads and writes as it did: every
statement names its columns, and a user's rows (`exportUser`) are read in key order in either layout
(`source-map-fast.test.ts` runs both layouts beside main's map). No format version: the file has none, and nothing
reads its layout.

| Measure | Main | D1936 | Control |
| --- | ---: | ---: | ---: |
| users trace (40 × 500) on a file: pages / disk written | 1,874 / 28.3 MB | 961 / 14.5 MB | |
| the same, CPU ms (6 rounds; forced GC) | 447.9; 434.7 | [0.809, 0.72-1.17]; [0.842, 0.72-1.07] | 0.908; 0.915 |
| pipeline trace on a file: pages / disk written | 59 / 2.16 MB | 32 / 1.68 MB | |
| `source-map-writes.bench.ts` (6 rounds): file KB | 216 | 112 [0.500, 0.46-0.56] | 1.071 |
| the same: MB written / bytes an upsert | 1.99 / 408 | 1.57 [0.808] / 335 [0.840, 0.71-0.90] | 1.085 / 0.999 |

Half the pages: the file on disk, the page cache a process holds for it, and an in-memory map's heap (every lab
run). The write CPU did not move beyond the control (an upsert is about 2 µs either way; see "Tried"). A file made
before kept its rowid tables until D1960 (below) moved it.

### D1960: a file made before D1936 is moved once, at open

D1936 left every existing file in the rowid layout forever. `migrateLayout` (source-map.ts) now runs in the map's
constructor for every file: when `PRAGMA table_list` shows one of the three tables with a rowid and its columns are
exactly the map's, one `BEGIN IMMEDIATE` transaction creates `<table>_new` WITHOUT ROWID, copies every row by named
columns in key order (`ORDER BY` the key, which the old table's automatic index serves without a sort), checks the
copy's count against a table scan of the old one (`NOT INDEXED`, so a damaged index cannot hide rows), drops the old
table and renames the new one; the layout is read again under the lock, so a second process that moved the file
first leaves nothing to do. Then `VACUUM` in its own transaction (the new tables were written past the old ones'
pages, so the file is larger than before until it is rewritten) and `wal_checkpoint(TRUNCATE)`.

Why this shape and not another:

- **Inside the file, not a copy renamed over it.** `VACUUM INTO` a temp file and an atomic rename measured about the
  same (0.33 s against 0.30-0.31 s at 100k rows, each after the same copy) but is unsafe with another connection
  open: a second mcp-stdio for the same user, an older process during a rolling upgrade, or a reader keeps the old
  inode and its WAL, and its next writes go into a deleted file. In one transaction, every other connection keeps
  its snapshot until it ends and re-prepares its statements on the new schema at its next step (checked: a reader in
  an open transaction across the move and the VACUUM saw its rows unchanged, then the new table).
- **Key order.** The copy read in rowid order (insertion order, random keys) built the new B-tree at random and
  spilled the page cache into the WAL again and again: 117 MB written at 100k rows against 12 MB in key order, at the
  same time.
- **The VACUUM.** Without it the moved file is 1.5x the old one (14.6 against 9.8 MB at 100k rows) until later
  writes fill the free pages; with it 0.49x (4.8 MB), for +0.04 s and +14 MB written once at 100k rows.
- **At open, not in `rehomeSourceMaps`.** The open is the one place every file passes: one process and mcp-stdio
  call no rehome when nothing is stranded, and a router's N children move their own files in parallel. The rehome's
  targets are moved too (`mergeInto` opens each with a `SourceMap` first), before the stranded rows are merged in.
- **Fail open, bounded.** Any failure (the write lock held past `MIGRATE_BUSY_MS`, 250 ms; a read-only connection; a
  full disk; a damaged page; columns that are not the map's, as an October 27 file's `last_ref`) rolls back, logs one
  line and leaves the file as it was, in its old layout, which every statement still reads and writes. A file over
  `MIGRATE_MAX_PAGES` (32,768 pages, 128 MiB) is not moved at open: the move costs about 0.13 ms a page on this
  VM, so the cap bounds an open near 4.5 s, far inside a router child's 30 s start deadline (D172);
  `bun packages/graph/src/migrate.ts FILE` moves a larger one with the server stopped. Nothing is served during the
  move: one process and a router child open the map before they listen or report their port (a router listens once
  every child has), mcp-stdio before it reads stdin.
- **Rollback.** The map before D1936 (the reference) reads and writes a moved file unchanged (the test runs one
  across the move), so a rollback needs nothing.

Measured on a real file: `users.bench.ts 40 500` run on main's map (`source-map.reference.ts`) left 91,440 mention
rows in 7,476 KB. Seven interleaved rounds of each open (scratch script, load average 10-13):

| Open | ms, median (min-max) | Written once (wchar / write_bytes) | File after |
| --- | ---: | ---: | ---: |
| main's map, the old file | 0.39 (0.32-11.9) | 0 / 32 KB | 7,476 KB |
| the new map, the old file (moves it) | 123 (107-160) | 14.1 MB / 10.7 MB | 3,480 KB (0.47x) |
| the new map, a moved file | 0.57 (0.55-0.75) | 0 / 32 KB | 3,480 KB |

The same 30 batches of 2,000 mention upserts (keys drawn from the file's rows, a fifth of them new) then wrote
363.5-365.3 MB on the old file (main's map) and 169.3-174.1 MB on the moved one (the new map), 0.47x, 4 rounds each:
the move's one-time 11-14 MB is repaid within the first batches. Synthetic old files (90% mentions; 5 repetitions):
1,000 rows 15-20 ms, 10,000 rows 28-33 ms, 100,000 rows 0.30-0.31 s, the medians of two runs (2,456 pages; 26 MB written), 1,000,000 rows
3.2-3.6 s (25,084 pages, 100 MB → 48.6 MB; 265 MB written) at a load average of 14.

Exactness and safety (`source-map-migrate.test.ts`, 4-8 s alone at a load average of 18-21): old-layout files of four sizes (a random stream's rows,
and 50, 2,000 and 20,000 rows more, with edge values: 2^53, a real in an integer column, empty and astral text) move
with every row equal (each value `quote`d, so 2 and 2.0 differ, in key order) and the same unordered reads, then
600 random calls answer as main's map on a copy. An error thrown before each of the 15 steps, a SIGKILL of a child
process at each step, and two SIGKILLs sent as the copy and the VACUUM of a 60,000-row file start each leave
`integrity_check` ok, one layout and every row, and the next open moves the file. Under a heavy load the parent's
signal can land after the child has finished: with the test file run six at a time, 5 of 12 runs met it before
the test allowed it (it now checks the file the same way). A file whose write lock another
connection holds waits 250 ms, stays old and answers as main's map through 500 calls; read-only, full
(`max_page_count`), damaged, over the cap and other-columns files are kept with one line and no throw; an old map
and a reader in a transaction open across the move answer as on the copy; a new or moved file is left alone byte for
byte, with no log line. A copy that skipped a row (a temp trigger ignoring one insert, standing in for an index
missing a row) fails the count and rolls back; a file another connection moved between the first look and the lock
is `current`, with nothing done. Eight mutations of `migrateLayout` each fail the file: no transaction (4 tests), no
VACUUM (1), a row dropped from the copy (8), no count (1), no second look under the lock (1), no column check (1), no
cap (1), no short busy wait (1).

### D1937: `normalizeEntity` reads plain names in one pass

An entity was trimmed, lowercased and its whitespace runs replaced, three passes and a regex for every mention.
ASCII with single inner spaces and no control whitespace (89% of the ingest bench's 246,320 mentions) is now
lowercased alone after one scan; anything else goes to the definition (`normalizeEntitySlow`). A mention batch also
dedupes an item's names through one `Set` a call, not an array and a `Set` an item. 0.69x the time a name on the
ingest trace's names (6 interleaved rounds: 112-155 ns before, 74-122 ns after); at 1.7% of ingest that is under
1% of it, inside the ingest bench's noise:

| `ingest.bench.ts 40 500 shipped` (6 rounds) | Main | D1935-D1937 | Control |
| --- | ---: | ---: | ---: |
| process CPU, ms | 5,613 | 5,593 [0.970, 0.88-1.03] | 0.972 |
| µs an item, all threads / main thread | 216.0 / 161.0 | 209.9 [0.963] / 155.0 [0.934] | 0.987 / 0.988 |
| held B/item | 3,335.8 | 3,335.5 [1.000] | 1.000 |

The servers' shape, a file-backed map with many users (`users.bench.ts 40 500`, 5 rounds, under a load average of
19-27 from other sessions' work): nothing moved beyond the control, as the profiles predicted (the map's share there
is the mention writes, whose CPU D1936 does not change).

| `users.bench.ts 40 500` (5 rounds) | Main | D1935-D1937 | Control |
| --- | ---: | ---: | ---: |
| process CPU, ms | 6,924 | 6,707 [0.964, 0.94-1.10] | 0.987 |
| backfill storm, CPU µs an item | 186.9 | 184.7 [0.978] | 1.002 |
| live heap a user, MB | 1.02 | 1.02 [1.000] | 0.999 |
| peak RSS over the backfill / over the thaw (VmHWM after clear_refs), MB | 229.3 / 165.2 | 225.8 [0.969] / 168.3 [1.015] | 0.987 / 1.018 |
| first read after the freeze p50, ms | 7.25 | 5.77 [0.908, 0.53-1.41] | 1.147 |
| first event after the thaw p50, ms | 43.9 | 48.1 [1.114, 0.87-1.30] | 1.027 |

## Exactness

`source-map-fast.test.ts` (2.8 s):

- `normalizeEntity` against its definition on 300,000 random strings (ASCII, every kind of Unicode space, controls,
  accents, `İ`, `ß`, final sigma, astral characters) and on every BMP code unit alone and between letters.
- Random streams of every public call (mentions, outcomes, corrections, `sourcesFor`, `route` with and without
  boosts and Thompson draws, `utility`, `flush`, `forget` of a user or a source, `exportUser`, `importUser` of
  another user's rows, arms), across three users in two tenants, on the new map and main's side by side: 12 seeds ×
  1,500 calls in memory (9,102 answers compared), 2 × 800 on new files, and 2 × 800 on a file main's map made
  (rowid tables, rows in it) against main's map on a copy. Every answer equal (`Bun.deepEquals`, strict), every
  user's rows equal at the end.
- A second connection's commit is seen by the next read (`data_version`), mentions and outcomes; a memo past its cap
  answers as main's map through every emptying, and stays bounded; a caller that changes a returned row changes
  nothing held; a read for one user never answers another's.
- Mutations: dropping the memo's emptying at the mention flush (4 tests fail), at the outcome flush (2), at
  `correctOutcome` (1), at `forget` (3), the `data_version` check (1), or a wrong fast-path condition (control
  whitespace 1, a double space 4, a trailing space 3, Latin-1 as ASCII 3) each fail the package's tests. Emptying in
  `importUser` as well was redundant (`forget` does it) and was dropped.

Behaviour gates on the final tree: eval precision 0.65, recall 0.52, falseFireRate 0; acting 19/28 neutral requests
with packets at 1.18 items, facts 10/11, look-alikes 3/10. Funnel 323/384 hidden, 294/384 decoys, `--baseline`
against main's map (the same tree with main's `source-map.ts`) hidden +0 −0, decoys +0 −0.

## Tried and not kept (D1938)

- **The mention flush's statements** (a micro-benchmark of the users trace's batches, 107,550 upserts in 20
  transactions; interleaved): 32-row `VALUES` statements read 0.838 against a control of the same code at 0.851
  (8 rounds); one `json_each` statement a batch 1.5-2x slower; rows sorted by key before the upserts 1.1-1.5x slower;
  `.get()` and `.values()` in place of `.run()` no better; the scope as an integer (a scope table) no faster and only
  20% fewer pages than WITHOUT ROWID with text. An upsert costs about 2 µs in SQLite's own code whatever the binding:
  the write path stays D1780's one transaction a second.
- **Batching `route`'s names into one `IN`/`json_each` query**: routes averaged 1.41 names (1,624 of one, 774 of
  two); the memo makes the repeat reads free instead.
- **The index's freeze and thaw**: the warm freeze's `snapshot` copies and `gaps`' oversized buffer then `slice`
  (6.9% + 9.0% of a freeze, about 1.1% of the users bench, off the request path in sliced jobs), and `ungaps`
  (10.3% of a warm thaw, 0.4% of the bench): not changed; zstd and JSON are the rest (D1715).
- **`SparseIndex`**: `search` stays as D111 left it (judged near-optimal; dropping its per-posting division changes
  the floats); `addFields` (1.3% self of ingest) allocates one `Uint32Array(F)` a doc, a few ns of a ~250 µs item.
  No primitive changed, so no primitive benchmark was re-run.
