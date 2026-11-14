# The engine's hot paths, low level: same outputs, less CPU

Decisions: D1880–D1889. The owner's brief of 2026-11-14: a deep, low-level pass over the engine's hot paths (CPU,
allocation, memory, GC) in `packages/engine`, `packages/primitives` and `packages/graph`, with behaviour unchanged.
No model call was made. Every number below comes from a command run in this session on the shared 4-core VM, with
other agents' benches running beside it (load average 2 to 11 over the session): wall-clock figures moved ±30% run
to run, so each change was measured as interleaved A/B rounds in separate processes (`A` the tree before the change,
`B` with it, alternating which runs first), and the process's own CPU time (`cpuTime.total` of the bench process) is
reported beside the wall figures, since another agent's load moves it far less.

## Method

- **Anchor**: `packages/engine/bench/pipeline.bench.ts` (6,000 items over four instant sources, 2,000 events), which
  now also times 300 `ask` calls after the stream (`--asks=N`, this branch's first commit: the stream's own requests,
  20 asks a session). Its decisions vary run to run on main too (`fast` 606-615, `sources` 3-8).
- **Others**: `ingest.bench.ts` (`--quick`: 40 users × 500 items, core and shipped modes), `users.bench.ts 200 500`
  (with a new `--dated`: a day-naming scan a user before the freeze), and the cache's own tests.
- **Profiles**: `bun --cpu-prof --cpu-prof-interval=200` (500 for the long benches), summed by function, self and
  inclusive, and by caller and callee (a scratch script over the `.cpuprofile`).
- **Behaviour gates, after every change**: `bun run eval` (no model) identical to main's JSON but for its two
  latency fields (precision 0.65, recall 0.52, falseFireRate 0; acting 19/28 at 1.18 items, facts 10/11,
  look-alikes 3/10); the funnel (`--jobs 4`) hidden 323/384, decoys 294/384, `--baseline` against main's rows
  `+0 −0` for both; and a differential test per rewrite against the code it replaced.

## Profile before (main, pipeline.bench, no ask phase)

Self time, top lines (11,175 samples at 200 µs): `render.ts` `pick`'s `score` 4.5%, `assess` 3.4%, the conflict
lists' regexes (four of them 1.7-3.3% each), the bench's own workload build 3.0%, the dates' `DATED` regex 2.8%,
`match` 2.4%, `/[\p{L}\p{N}]+/gu` 1.9%, `replace` 1.8%, xxHash32 1.8%, the index's `search` 1.8%.

Inclusive: `observe` 46.1%, `ask` (the reader push's own ask) 37.5%, `deliver`/`build` 21.0%, `renderPacket` 15.9%,
`pushGate` 15.5% of which `constraintLike` 15.3% (the reader gate lower-casing each candidate's text and running
about a dozen lists over it, every request), `assess` 13.6%, `grounded` 12.5%, `conflicts` 11.6%, `messageParts`
10.7%, `searchLive` 10.0%, `rank` 7.8%, `mayConstrain` 7.6% (plus 6.6% inlined into `constraintLike`), `pick` 6.0%,
`dateVerdict` 5.0%, `datesOf` 4.9%.

The ingest bench's shipped mode (40 × 500, 500 µs samples): `sketchTerms` 32.3% inclusive (18.0% self, `isStopword`
10.5%: a `Set` look-up of every fresh word string), `onStored` 26.7%, `extractTypedEntities` 17.8% (its `isCalendar`
5.1%: two replaces and a split a capitalised word), `deflateSync` 10.0%, `put` 20.4%. The users bench's first
event after a thaw spent 17.1% of the whole bench in `ItemCache.dated` reading every item's date facts again
(`dayFactsOf` 14.6%): D1721's facts were not frozen.

## Changes kept

Each row is the change alone against the tree before it, medians of interleaved rounds (paired median of B/A in
brackets where taken).

| Decision | Change | Measured |
|---|---|---|
| D1880 | `gateOf`: the reader gate's two readings (`mayConstrain`, `arrangedVisit`) once per item object, on its `ANALYSES` entry | pipeline 5 rounds: ms/event 1.577 → 1.405 (−11%); observe p50 110.9 → 113.0 µs |
| D1881 | Packet compaction: each whole-text pass behind an exact precheck (`includes` of what it must match), words by a code-unit scan (`wordsIn`) not `/[\p{L}\p{N}]+/gu`, a part's words read once for the known test and `pick` | pipeline 5 rounds: ms/event 1.486 → 1.348 (−9%), ask p50 5,195 → 3,878 µs (−25%), observe p99 4,757 → 3,875 µs |
| D1882 | The packet's parts of the last 256 items read once (`PARTS_MEMO`, by item object, two readings an item, at most 1,200,000 characters, emptied with the decoded texts) | pipeline 7 rounds: ask p50 3,875 → 3,212 µs (−17%), ms/event 1.297 → 1.239 (−4.5%), CPU 5,266 → 5,070 ms (−4%); memo heap 2.0 MB at 237 items |
| D1883 | `datesOf` skips its four month patterns on a sentence with no figure beside a month's name (`MONTH_DATE`); `DEADLINE` read when a day is first taken | pipeline 7 rounds: ms/event 1.284 → 1.181 (−8%), CPU 5,320 → 5,083 ms (−4.5%) |
| D1884 | The known test and `pick`'s score read a part's words in place (`saysUnknown`, `focusCount`), no string a word | pipeline 7 rounds: ms/event 1.353 → 1.300 (−4%), ask p50 3,036 → 2,814 µs (−7%), CPU −1.4% |
| D1885 | `versionOf` and `timesOf` once per item object (`READINGS`, a `WeakMap`), and a lookup hashes only items the ledger holds a version of (`Ledger.holdsVersion`) | pipeline 9 rounds: ms/event 1.187 → 1.109 [0.923], CPU 4,902 → 4,599 ms [0.929], ask p50 2,810 → 2,458 µs [0.891] |
| D1886 | `sketchTerms` by code unit, `isCalendar` by code unit, `extractTypedEntities`' patterns only where their character is | ingest quick 3 rounds: shipped backfill 250.4 → 213.8 µs/item [0.854], sweep 75.2 → 62.9 [0.797], core backfill 91.1 → 85.7 [0.928]; CPU [0.921] |
| D1887 | `sketchTerms` tests stopwords (`stopwordAt`) and repeats (a stamped hash table of integers) in place, making a string only of a new kept word | ingest quick 3 rounds: shipped backfill 233.3 → 200.2 µs/item [0.858], sweep 64.6 → 47.6 [0.712]; CPU [0.905]; 3,294 → 3,300 B/item held (the table, process-wide) |
| D1888 | A freeze carries each entry's date facts (`FrozenEntry.t`, `FastEntry.t`), `PERSIST_FORMAT` 6 (5 still read) | users 200 × 500 `--dated`, 3 rounds: first event after the thaw p50 35.9 → 11.0 ms [0.319], p99 59.3 → 53.0; first read (the thaw) p50 3.93 → 4.86 ms [1.237, 0.90-1.47]; blob 786 → 785 B/item; frozen heap 0.439 → 0.438 MB/user |
| D1889 | `assess` reads a statement's mark extremes by loops, not spreads into `Math.max` | pipeline 9 rounds (load 5-11): ms/event 1.344 → 1.247 [0.928], CPU 4,555 → 4,253 ms [0.958], ask p50 2,545 → 2,192 µs [0.880] |

Every rewrite keeps its reference: `render.reference.ts` (render.ts before D1881; `render-fast.test.ts` compares
`messageParts`, `compactText` and `renderPacket` on the eval's items and 1,200 fuzzed messages, with every setting,
`known` set and focus, an item edited in place and the memo's bounds), `analyseUnfiltered`-style switches
(`datesFor(…, prefilter)`, `conflict-memo.test.ts`: 40,000 fuzzed sentences of date shapes and near misses, both
vocabularies; `gateOf` against the per-call test on 3,000 fuzzed texts and the eval's), `sketchTermsSplit` and
`isCalendarByPattern` kept in the source, and `extractTypedEntities`' reading before copied into `text-fast.test.ts`
(20,000 fuzzed sentences and random code units each, surrogates included), `readings.test.ts` (5,000 steps over
plain and packed items edited in place), `day-facts.test.ts` (a freeze carries exactly the facts read, warm and
compact, and every answer equals a fresh cache's). Mutations of the prechecks (a wrong `includes`, a dropped
alternative of `MONTH_DATE`, a broken run test) fail these tests.

## Tried and not kept

- **D1882 with one reading an item**: the push's packet passes the year and the ask's does not, so the memo thrashed
  (2,934 of 4,761 readings missed): ms/event 1.312 → 1.337, ask p50 3,942 → 4,119 µs (no gain).
- **D1882 keeping each part's words**: the best timing (ask p50 3,885 → 2,340 µs, −40%; ms/event −8%), but 8.2 MB of
  heap for 207 items (39 KB an item: a string a word). Rejected for memory; the parts and their lower case alone take
  2.5 MB at 256 items, and the character bound keeps the memo near 2 MB whatever the items' size.
- **D1882 without the character bound** (2 readings, 256 items): ask p50 −25%, CPU −11%, 2.5 MB; bounded by
  characters instead, since the cache holds up to 8,000 characters an item (256 × 2 × 8,000 could reach ~10 MB).
- **A `WeakMap` parts memo with no bound**: not built; a heavy user rendered over a day would hold its parts for
  every item rendered (about 10 KB an item on the bench workload).
- **Skipping the sync's re-sketching of unchanged items** (the sweep re-adds every listed item's terms to the
  source's sketch and the rare-terms table): exact only while neither has restarted or renumbered since the items
  were first added, which needs per-item state; not built. D1886/D1887 made the re-sketch itself cheaper instead.
- **Carrying date facts by reading them at ingest**: not built; it moves D1721's lazy read onto every synced item.

## End to end, main against this branch

Interleaved, separate processes (see each file's numbers above for the per-change view).

- `pipeline.bench.ts`, 9 rounds (load 9-11, so the wall figures are noisy; CPU is the steadier figure): process CPU
  6,983 → 4,651 ms [0.668, 0.56-0.75]; ms/event 2.268 → 1.502 [0.705]; observe p50 127.7 → 125.5 µs [0.970], p99
  7,554 → 7,096 µs [0.746]; slow path p99 8,210 → 6,437 µs; ask p50 5,312 → 2,429 µs [0.440], p99 19,579 → 12,534 µs
  [0.745].
- `ingest.bench.ts --quick`, 3 rounds: shipped backfill 284.4 → 230.3 µs/item [0.810], sweep 86.9 → 50.4 [0.556];
  memory 3,294 → 3,299 B/item held (core 3,202 both); process CPU [0.860]. Core mode alone (`40 500 core`, 4 rounds, run
  when the load had fallen): backfill 126.3 → 100.3 µs/item [0.749], unchanged sweep 6.56 → 4.90 µs/item [0.753]; the
  3-round run above under load 11 read the core sweep 5.1 → 8.2, which this run does not reproduce.
- `users.bench.ts 200 500 --dated`, 3 rounds: first event after the thaw p50 37.1 → 10.6 ms [0.281], p99 72.6 → 29.7
  ms [0.394]; first read (the thaw) p50 3.82 → 4.71 ms [1.246]; RSS per user live 1.58 → 1.57 MB, frozen 0.78 →
  0.77 MB; frozen heap 0.438 MB both; blob 786 → 785 B/item; process CPU 44.8 → 33.1 s [0.739]. Without `--dated` (2
  rounds; no facts to carry): the thaw p50 3.93 → 3.98 ms [1.012], first event p50 36.0 → 32.3 ms [0.899], p99 67.9 →
  50.4 ms; RSS per user live 1.63 → 1.57 MB, frozen 0.77 MB both; blob 786 B/item both; process CPU [0.823]. The thaw
  costs about 0.9 ms more (500 items) only when it has facts to restore, against 26 ms less at the first request naming
  a day.

## Profile after (this branch, pipeline.bench with the ask phase)

Both profiles with the ask phase, 200 µs samples, one run each on the same VM back to back: main took 19,391 samples,
this branch 10,526 (0.54x: the whole process, workload build and start-up included). Inclusive share and samples:

| Function | main | this branch |
|---|---:|---:|
| `ask` (the push's and the asks') | 55.6% (10,781) | 41.6% (4,379) |
| `observe` | 28.7% (5,565) | 32.4% (3,410) |
| `renderPacket` | 29.6% (5,740) | 16.3% (1,716) |
| `messageParts` / `readParts` | 18.2% (3,529) | 1.1% (116) |
| `pick` | 10.8% (2,094) | 8.8% (926) |
| `grounded` | 14.0% (2,715) | 13.6% (1,432) |
| `assess` | 13.2% (2,560) | 10.0% (1,053) |
| `datesOf` | 5.1% (989) | 2.6% (274) |
| `pushGate` | 9.3% (1,803) | 1.5% (158) |
| `constraintLike` / `gateOf` | 9.1% (1,765) | 1.2% (126) |
| `searchLive` | 10.6% (2,055) | 15.9% (1,674) |
| `rank` | 6.9% (1,338) | 8.8% (926) |
| `timesOf` | 2.0% (388) | 0.3% (32) |
| `versionOf` | 1.6% (310) | 0.3% (32) |

The top self lines now: `focusCount` 7.1% (the packet's focus count, now the largest single cost of compaction), the
bench's workload build 3.5%, the index's `search` 2.7%, `tokenizeInto` 1.8%, `noteShown` 1.6%, `mentions` (probes) 1.6%,
the turn-time pattern 1.6%. Next levers, not taken here: `focusCount` over the memo's keys could be read once per (item,
focus) pair; `searchLive`'s `store` and `probe` (about 5% together); `grounded`'s conflict test is still 12% of the run,
mostly `assess`'s per-request reading of tied statements.

## After the review (2026-11-14)

- `sketchTerms`' table grew to the longest text it ever read and never shrank: the sync sketches each listed item's
  title and text uncut, so a 16 MB MCP reply left about 200 MB attached for the process's life (extra memory 16.5 MB
  on main, 217.9 MB on the branch, the reviewer's measurement), and the last text's word hashes stayed in it. Now a
  text over `TABLE_MAX_CHARS` (65,536 code units) is read by the split (exact, `sketchTermsSplit`), so the table
  never passes 64K slots (768 KB), and each call zeroes the hashes it wrote. `text-fast.test.ts` reads a
  16M-character text and checks the table's size and that no hash stays; removing either guard fails it.
- Nothing tested that the cache empties `PARTS_MEMO`: `parts-memo.test.ts` now renders a user's items and checks the
  memo is empty after `removeItems`, `forget`, a freeze, `release` and an eviction, one test each; with the five
  `clearParts` calls commented out all five fail.
- D1888's `PERSIST_FORMAT` 6 cuts both ways: a rollback, or a format-5 process on a shared disk or store, deletes
  format 6's files and those users re-sync once (D1888, docs/DEPLOY.md).

## Pitfalls (also in packages/engine/CLAUDE.md)

- Memos are per item object (`ANALYSES`, `READINGS`, `PARTS_MEMO`), never per content (D9); `PARTS_MEMO` is
  bounded and emptied by `clearParts` wherever the cache calls `clearDecoded`.
- A precheck before a pattern must be a necessary condition of every match: widen both together.
- Code-unit scans hand a string with a surrogate to the regex they replace.
- `dayFactsOf`'s output is now in frozen blobs: changing what it computes bumps `PERSIST_FORMAT`.
- The enricher's drain, tie orders and the frozen-user carry rules are untouched: no `await` was added or removed on
  any path, no sort or tie order changed, and a thawed entry differs from before only by holding facts it had.
