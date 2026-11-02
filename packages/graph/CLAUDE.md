# @eden/graph

The source map, layer 1 of the knowledge graph: per user, which sources mention which entities, and how useful each
source has proven in each situation (a Beta posterior per user, situation and source, D13, D18, D23). Routing reads
it to ask the few sources likely to know. SQLite via `bun:sqlite` (D15). One file: `src/source-map.ts`.

(The per-user graph over cached items, D58, is the engine's `kg.ts`, in memory; it is not this package.)

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
- Statements go through `db.query` (prepared-statement cache): re-preparing per call was 5% of end-to-end CPU
  (`packages/engine/bench/pipeline.bench.ts`).
- Exploration (Thompson draws) decides which sources are queried, never whether anything is injected (D23).
- Explicit feedback corrects a recorded outcome (`correctOutcome`, D18).

## Test

```bash
bun run test:pkg graph          # ~0.3 s
```

Tests use an in-memory database or the preload's temp `EDEN_HOME`; the server's default file is
`$EDEN_HOME/source-map.db` (`EDEN_SOURCE_MAP`).

## Where next

`docs/ARCHITECTURE.md` "Learning loop"; `packages/engine/src/usage.ts` (where outcomes come from);
`packages/sources/src/planner.ts` (the planner's store lives here).
