# @eden/graph

The source map, layer 1 of the knowledge graph: per user, which sources mention which entities, and how useful each
source has proven in each situation (a Beta posterior per user, situation and source, D13, D18, D23). Routing reads
it to ask the few sources likely to know. SQLite via `bun:sqlite` (D15). One file: `src/source-map.ts` (and its
oracle, `src/source-map.reference.ts`; `src/migrate.ts`, the operator's command for D1960's move of a large file).

(The per-user knowledge graph over cached items, D58, was the engine's `kg.ts`, since deleted; it was not this package.)

## What it holds, and what it must not (D8)

- Entity names of persistable kinds, source ids, item refs, counts, outcome tallies, and the query planner's
  per-shape counts (`PlannerStore`). **No item content**, no quoted phrases: content lives at the source or in the
  engine's short-lived in-memory cache. A new column that could hold text needs a decision and a PRIVACY.md update.
- Every row is partitioned by `scopeKey` (tenant/user); no query crosses it (D9). Add a cross-user test with any new
  table or query.

## Rules that apply here

- **Fast path may write here** (D4): outcomes are written behind (buffered, one transaction within
  `OUTCOME_FLUSH_MS` or at 256 rows; every read flushes first) with WAL and synchronous=NORMAL, about 2 µs per outcome
  instead of an fsync per commit. Keep new writes on that path; do not add a synchronous commit per event.
- **Mentions are written behind too (D1780):** summed in memory per (user, entity, source), one transaction within
  1 s (`MENTION_FLUSH_MS`) or at 4,096 distinct rows. Reads of mentions (`sourcesFor`, `route`) add the pending
  counts and must not flush (a flush a route would batch nothing); `exportUser`, `importUser`, `forget` and `close`
  flush first, and an `exit` listener writes every open file-backed map at a normal exit. What a process that dies
  loses is never a written row, at most the buffer: a second's mentions plus a refused batch kept for the retry (at
  most `MENTION_RETAIN_ROWS`, 16,384, then dropped and counted). A signal with no handler skips the `exit` listener,
  so an entry point that holds a file-backed map closes it on SIGTERM, SIGINT and SIGHUP (`main.ts`, `mcp-stdio.ts`;
  `mcp-stdio.test.ts` signals one after an ask). A write that fails is logged and counted, never thrown into a
  lookup. A new read of the `mention` table either merges `this.mentions` or flushes first. Disk writes on the
  pipeline workload: 3.6x less (7.6-8.3 MB → 2.2-2.3 MB; `packages/engine/bench/source-map-writes.bench.ts`). A test
  of two processes contending must call `flush()` itself, or nothing is written until exit.
- `busy_timeout` is 2 s: two processes may share a file (mcp-stdio launched by two MCP clients for one user), and
  without it one failed in the constructor with SQLITE_BUSY (`source-map.test.ts`, the two-process test).
- Statements go through `db.query` (prepared-statement cache): re-preparing per call was 5% of end-to-end CPU
  (`packages/engine/bench/pipeline.bench.ts`). The two hot reads are held as fields (`mentionRead`, `outcomesRead`).
- **Reads are memoised, exactly (D1935).** `sourcesFor`'s file rows per (user, entity) and `route`'s outcomes per
  (user, situation) are kept (scope key first; at most 4,096 keys plus rows each, about 0.45 MB, then emptied whole).
  Every write this connection makes to `mention` or `utility` empties that memo, and a file's `PRAGMA data_version`,
  read once a `sourcesFor` or `route`, empties both when another process committed. A new statement that writes
  either table clears its memo (`clearMentionMemo`, `clearOutcomeMemo`), or reads go stale; a new read of either
  table goes through the memo or reads the file as it is, never a memo with a caller's edits (rows are copied out).
- **Tables are WITHOUT ROWID in a new file (D1936), and a file made before is moved once at open (D1960)**: half
  the pages and about half the disk writes. `migrateLayout` runs in the constructor for every file: one transaction
  (`<table>_new`, copy by named columns in key order, count checked, drop, rename), then `VACUUM`. A file it cannot
  move (locked past `MIGRATE_BUSY_MS`, read-only, full, damaged, other columns, over `MIGRATE_MAX_PAGES`) keeps its
  rowid tables with one log line and works unchanged, so no statement may depend on a rowid or on which layout a file
  has. A new table or column joins `TABLES`, `TABLE_SQL`, `COLUMNS` and `KEY_COLUMNS` (the move refuses a table whose
  columns differ, so an added column must also teach it the old set). Never move a file by renaming another over it:
  a second connection (mcp-stdio for the same user, an older process) would keep writing the old inode.
  `source-map-migrate.test.ts` stops the move at each step (a throw, a SIGKILL) and checks one layout and every row;
  `bun packages/graph/src/migrate.ts FILE` moves a file over the cap with the server stopped.
- `normalizeEntity` reads plain ASCII names in one pass (D1937); `normalizeEntitySlow` is the definition.
- `source-map.reference.ts` is the map before D1935-D1937, unchanged: the oracle `source-map-fast.test.ts` runs
  beside the map on random call streams (in memory, new files, a moved old-layout file, two connections; the streams
  are `source-map.fuzz.ts`, shared with `source-map-migrate.test.ts`, which also runs an old file it could not
  move). A change to an answer of the map changes both, or the test fails; docs/research/opt-round4-graph.md has the
  measurements.
- Exploration (Thompson draws) decides which sources are queried, never whether anything is injected (D23).
- Explicit feedback corrects a recorded outcome (`correctOutcome`, D18).
- **SQLite stays (D1720, docs/research/source-map-store.md).** A specialised store (a resident map per user with an
  append log) was measured and rejected: the map is 3.2-3.7% of the event path, SQLite holds 64-66 KB a user
  against 1.47 MB resident, and the disk-write gain a log would bring (35-40x) is mostly available by batching
  mentions as outcomes are (done in D1780).

## Test

```bash
bun run test:pkg graph          # ~4-9 s by load (the fuzz in source-map-fast and source-map-migrate, in parallel)
```

Tests use an in-memory database or the preload's temp `EDEN_HOME`; the server's default file is
`$EDEN_HOME/source-map.db` (`EDEN_SOURCE_MAP`).

## Where next

`docs/ARCHITECTURE.md` "Learning loop"; `packages/engine/src/usage.ts` (where outcomes come from);
`packages/sources/src/planner.ts` (the planner's store lives here).
