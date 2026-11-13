# A specialised store for the source map (2026-11-13, D1720: rejected, SQLite kept)

The question: would a store built for the source map's few shapes (an in-memory map per user with an append-only log
and compaction, say) beat `bun:sqlite` with WAL and `synchronous=NORMAL` (D4, D8, D15) by at least 1.5x on something
that matters: request latency, memory per user, or disk writes, without losing crash safety or tenant/user isolation?
SQLite was the default to beat. Measured first; nothing was built, because nothing measured cleared the bar on terms
worth its cost. The measuring scripts were scratch (not committed); this note says what each did.

## What the request path spends in it

The pipeline bench's workload (`bench/workload.ts`: one user, 1,500 items a source, 2,000 events; the shipped
`DEFAULT_CONFIG`, no model) through a real `ContextPartner` whose `SourceMap` is a file in a temp directory, as the
servers run it, with every public `SourceMap` method wrapped in a timer (nested calls counted once). Bun 1.4.4, 4
cores, without `--smol`. Four runs: three as shipped, one with mentions buffered (the screen under "Disk writes";
its `recordMentionsMany` figures are left out). The table's ranges are over the runs whose per-call lines were
printed (two as shipped and the buffered one).

| Call | Calls | µs a call | ms in all |
|---|---|---|---|
| `route` (a lookup's ranking: one `sourcesFor` a cue entity, one query of the situation's outcomes) | 1,515-1,527 | 36.5-51.7 | 55.8-78.7 |
| `sourcesFor` (the probes' holders, outside `route`) | 1,157-1,196 | 20.3-32.5 | 24.3-38.1 |
| `recordMentionsMany` (a lookup's results, one transaction) | 90-97 | 671-901 | 65.0-81.1 |
| `recordOutcome` (buffered, D4) | 913-956 | 1.6-1.8 | 1.4-1.6 |
| `flush` (the outcomes' transaction) | 17-33 | 75-149 | 1.3-3.7 |

All of it is 3.2-3.7% of the event path in the three shipped runs (131-188 ms of 4.1-5.5 s; the buffered run 2.5%),
and 2.4% with the same map in memory (`:memory:`). A store that cost nothing would make the event path at most
1.04x faster. The heaviest single call, `recordMentionsMany` at 0.7-0.9 ms, is on the slow path once a lookup, not on
`observe`'s fast path.

## Memory per user

200 users × 5,000 mention rows (five sources, entity names of the lab's length), RSS after a full GC, two runs each:
SQLite on a file +12.4 / +12.8 MB in all, 64-66 KB a user (its page cache is bounded and shared by every user of the
process; the rows live on disk); the same rows resident in a `Map` per user (`"entity\0source" → [count, lastSeen]`)
+287.9 / +289.4 MB, 1,474-1,482 KB a user, 23x more. A packed resident layout would shrink that several times and
still hold every row in RAM, where SQLite holds a bounded cache: resident is the wrong direction for memory per user.

## Disk writes

The same 2,000-event run, the process's `write_bytes` (`/proc/self/io`): 9.4-11.1 MB written for 6,632 mention
upserts (about 1.4-1.7 KB each: every commit writes each B-tree page it touched into the WAL, and checkpoints write
them again), leaving a 250 KB database and a 4.2 MB WAL. An append-only log of the same upserts (scope, entity,
source, two numbers, framing) would write about 270 KB, some 35-40x less. This is the one measure where a specialised
store clears 1.5x. It is not taken, for three reasons:

- **The same lever exists inside SQLite (built in D1780).** Buffering the mentions as the outcomes already are (one transaction a
  second; screened by wrapping `recordMentionsMany`) wrote 2.27 MB for the run, about 4x less, with no new store, no
  new recovery code and the same crash bound D4 accepted for outcomes. It is a candidate, not done here: its reads
  must flush first as `outcomes` does, and it changes when a mention becomes visible to another process.
- **What a log would have to rebuild.** Crash safety (fsync policy, a checksum a record to find a torn tail, replay
  and compaction that are themselves crash-safe), two processes on one file (D15's busy timeout exists for
  `mcp-stdio` launched by two MCP clients for one user; a log needs its own cross-process locking and merge), and
  `exportUser`/`importUser` for D992's hand-off. SQLite gives all of it, tested.
- **The volume is small in absolute terms.** About 5 KB of writes an event on this workload, against a machine's
  frozen-user blobs of 1-3 MB each (D425, D862) on the same disk.

## Verdict

Keep `bun:sqlite` (D4, D8, D15). Request latency cannot gain more than 1.04x; a resident store is 23x worse on memory
per user; the disk-write gain is real but most of it is available inside SQLite by batching mentions, which is the
place to start if write volume ever matters.

## Built (D1780)

Mentions are now written behind, one transaction within a second, with reads adding the pending counts. Measured on
the same workload (a scratch harness, interleaved, 3 runs each): 7.58-8.26 MB written on main against 2.21-2.29 MB,
3.6x less in all and 3.8-3.9x per mention upsert (1,330-1,404 B against 356-357 B); `recordMentionsMany` 0.47-0.53 ms
a call → 0.10-0.11 ms. Funnel and eval unchanged. The crash bound and the tests are in D1780.
