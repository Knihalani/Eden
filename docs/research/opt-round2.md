# The second low-level round: what the first left, ranked by share

Decisions: D1910–D1918. The owner's brief of 2026-11-14: a second deep, low-level optimisation pass over the parts
of Eden the first round (D1880–D1889, [engine-lowlevel.md](engine-lowlevel.md); D1890–D1894,
[infer-lowlevel.md](infer-lowlevel.md)) did not cover, ranked by measured share first, with every output unchanged.
No model call and no paid call was made. Every number below comes from a command run in this session on the shared
4-core VM with other agents' work beside it (load average 1.3 to 3.5 over the session).

## Method

- **Profiles**: `bun --cpu-prof` (200 µs samples for the pipeline, 500 for ingest, 1 ms for users), summed by
  function, self and inclusive, and by callee under a frame (a scratch script over the `.cpuprofile`, not kept).
- **A/B**: each change alone against the tree before it, in separate processes, interleaved (A B, B A, ...), the
  bench process's own CPU time (`resourceUsage().cpuTime`, every thread) reported beside wall and the bench's own
  figures; medians, and the paired median of B/A in brackets with its range. Kept only when measured faster.
- **Anchors**: `pipeline.bench.ts` (6,000 items, 2,000 events, 300 asks), `ingest.bench.ts 40 500 shipped`,
  `users.bench.ts` (100 or 200 × 500; `--cards` with the stub card maker for the card queue), `live-heap.bench.ts`.
- **Oracles**: every rewrite keeps the code it replaced as a reference in the source or the test, and a differential
  test fuzzes the two (named per change below); each was checked by mutating the new code.
- **Behaviour gates**: `bun run eval` and the funnel against main's rows (end of this note).

## Profiles before (main 4f6837b58)

pipeline.bench (8,898 samples): self `focusCount` 7.8%, the bench's own workload build 4.1%, `SparseIndex.search`
2.8%, `noteShown` 2.0%, `tokenizeInto` 2.0%, the conflict lists' regexes 1.1-1.9% each, `mentions` (probes) 1.6%,
`assess` 1.3%. Inclusive: `ask` 40.1%, `observe` 32.4%, `renderPacket` 16.2%, `searchLive` 16.2%, `grounded` 13.0%,
`conflicts` 11.3%, `pick` 9.6%, `assess` 9.5%, `rank` 8.1%.

ingest.bench 40 × 500 shipped (8,835 samples): self `deflateSync` 13.9%, `stopwordAt` 10.7%, `sketchTerms` 10.3%,
`inflateSync` 5.8%, `extractTypedEntities` 5.4%, `tokenizeInto` 5.0%, the secret gate's `scan` 4.3%. Inclusive: the
sync's `store` 85.3%, `onStored` 28.4%, `put` 26.8%, `sketchTerms` 21.3%, `extractTypedEntities` 16.4%, `packItem`
15.5%, redaction 10.5% (packages/redact, out of this brief's scope), `recordMentions` 7.4% (its SQLite flush 4.6%),
`unpack` 7.5% (2.8% the sweep sketching held copies, 3.0% `onStored` reading copies `put` had just deflated).

users.bench 200 × 500 (25,597 samples at 1 ms): the first event after the thaw was 17.0% of the whole run, in
`ItemCache.dated` reading every item's date facts from text (`dayFactsOf` 14.7%: `namedOf` 7.0%, `spanFactsOf`
5.4%); its p50 was 35.4 ms a user. With `--cards` (60 × 500): `ownText` 6.6% inclusive, called three times an item by
the card queue; enqueue, ordering and draining together under 0.5%.

live-heap.bench (12 × 3,000, 20 sources, prose): index 829 B/item (37%), item objects 704 (deflated text), vocabulary
342, entry objects 112, the items Map 77, the sync's `IdSet` 36, sketch 28, rare terms 28. At the users bench's shape
(40 × 500, 3 sources): index 763, items 687, vocabulary 531, entries 112, rare terms 98 B/item.

## Changes kept

Each row is the change alone against the tree before it (D1910 also re-run against main's render.ts), medians of
interleaved rounds, paired median of B/A in brackets with its range.

| Decision | Change | Measured |
|---|---|---|
| D1910 | `pick`'s focus count: `indexOf` of each focus word with a neighbour test, not a scan of every word (render.ts) | pipeline 8 rounds: process CPU 3,959 → 3,785 ms [0.943, 0.86-1.02]; ask p50 2,016 → 1,747 µs [0.878, 0.80-0.97]; observe p50 105.3 → 103.4 µs [0.967]; `focusCount` 7.8% → 1.8% self; alone on 2,000 recorded calls 3.0x (786 → 222-273 ms) |
| D1911 | `sketchTerms` asks `stopwordAt` only where `STOP_FNV` marks the word's hash (text.ts, sketch.ts) | ingest 6 rounds: CPU 6,349 → 5,866 ms [0.926, 0.87-1.04]; backfill 199.1 → 182.3 µs/item [0.939]; CPU 249.5 → 233.3 µs/item [0.932] |
| D1913 | `packItem` seeds the decode memo with the text it packed (packed-text.ts) | ingest 6 rounds: backfill 195.9 → 179.1 µs/item [0.939, 0.88-0.97, every round]; main thread 188.5 → 173.8 µs/item [0.944]; held 3,300 → 3,283 B/item |
| D1915 | The card queue reads the strict own text once for the prefilter and the sentence key (cards.ts) | users 60 × 500 `--cards`, 4 rounds: storm CPU 292.1 → 286.6 µs/item [0.970, 0.94-1.01]; storm wall 7.49 → 7.16 s [0.965, 0.93-0.98, every round] |
| D1916 | `SPAN_HINT`'s month alternative and `MONTH_DAY` tried only where a month's letters start (days.ts, day-facts.ts) | `dayFactsOf` 28.0 → 17.8 µs/item on workload text (4 rounds); users 100 × 500, 4 rounds: first event after the thaw p50 32.1 → 28.6 ms [0.891, 0.83-0.90, every round]; `SPAN_HINT` alone 11.6 → 5.0 µs, `MONTH_DAY` 6.4 → 3.8 µs |

Oracles and mutations: `render-focus.test.ts` (D1884's scan verbatim; 40,000 fuzzed parts and focus sets, 5,000
random code-unit strings; the right-boundary test, the surrogate fallback and the fallback's focus list each fail it
when broken); `text-fast.test.ts` (every stopword marked, the `sketchTermsSplit` fuzz; a shifted mark fails it);
`packed-text.test.ts` (a fresh copy is in the memo and reads its own text); `cards-own.test.ts` (the two readings
before, kept in cards.ts as `*Before`, on the eval's items and 4,000 fuzzed mails, plain and packed; a dropped footer
cut fails it); `day-hints.test.ts` (the patterns themselves on the eval's texts and 60,000 fuzzed strings; three of
four mutations fail it, the fourth, resuming one unit early, is equivalent: the boundary test already drops a month
inside a match's last word) and `day-facts.test.ts`'s pre-D1721 oracle. D1916 leaves the date facts as they were, so
`PERSIST_FORMAT` stays 6; none of the changes touches a persisted shape or a model-facing byte, adds or removes an
`await`, or changes a tie order. The only state touched is the existing decode memo (D1913: the same entries, keyed
by bytes, emptied by `clearDecoded`).

## Tried and not kept

- **D1912, libdeflate for packed text**: 17% faster deflate alone at the same size, but ingest 6 rounds read CPU
  [0.985, 0.91-1.09], backfill [0.977]: inside the noise. Its inflate was slower than zlib's (14-17 against 8 µs).
- **D1914, a one-word path in `extractTypedEntities`**: exact, but 17.71 → 17.42 µs a text alone [0.984, 0.84-1.34]
  and ingest [1.009]: the capitalised-run pattern is the cost, not the split and join after it.
- **D1917, an in-place JS xxHash32** so `sketchTerms` makes no string a word: matches Bun's on 200,000 random words, but 18-21
  against 14-16 µs a text: the native hash of a short string beats the JS loop more than the slice costs.
- **D1917, one-class lookahead prefixes** on the month patterns (`(?=[adfjmnos])`): no faster (`MONTH_DAY` 6.3 → 8.1 µs):
  the cost is attempts that start on a month's letters inside words and on "to", not the alternation's first test.
- **D1918, a `datesOf` memo per statement**: its spans and limits depend on `now` continuously (the nearest year, an open
  start), so a hit needs the same instant; not built. `assess` stays the largest engine item (9.5% inclusive).
- **D1918, `Entry.synced` in the literal**: an 11-field literal holds 144 B, the same as 10 fields with `synced` added
  later (JSC's literal capacity has room): no heap cut.
- **D1918, the live heap** (1.56 MB/user at 200 × 500): the index (763-829 B/item) is D1730's, the deflated text is D188's
  and D998's, the vocabulary D998's L2; no further cut was found that D998's rejected ideas (C6, card state frozen)
  and D1715/D1730 leave open.
- **D1918, sync and sources**: the fan-out's own guards (breaker, limiter, histograms) are 0.3% of ingest, `IdSet` 0.4%,
  rare terms 0.8%; redaction is 10% (packages/redact, another session's). The sweep's re-sketch of held copies
  (sketch 20.6% of ingest, 3.7% of it inflating them) stays: skipping it needs per-item state (engine-lowlevel.md).
- **D1918, packages/graph**: `recordMentions` is 7.9% of ingest, two thirds of it the SQLite upserts D1780 already batches a
  second; multi-row statements were not built (the row work is SQLite's).
- **D1918, packages/primitives**: the tokenizer (2-5% self) is one fused pass over code units with folding, two hashes and
  the interner; nothing cheap was left to take, so no primitive changed and none of their benchmarks needed a rerun.
- **D1918, the client SDK**: `observe` 2.63-2.80 µs and `ask` 2.83-3.01 µs a call with a stub `fetch` against 1.04 µs for
  the stub alone; the proxy and the Python client were not changed (their per-call work is the round trip).

## End to end

Main (4f6837b58) against this branch, every changed source file swapped, interleaved in separate processes (load
1.3-3.5).

- `pipeline.bench.ts`, 8 rounds: process CPU 4,532 → 4,139 ms [0.962, 0.85-1.13]; ms/event 1.15 → 1.13 [0.958];
  ask p50 2,294 → 1,947 µs [0.840, 0.70-1.22], ask p99 9,673 → 8,764 µs [0.968, 0.52-1.67]; observe p50 116.5 →
  114.3 µs [1.038, 0.90-1.10], observe p99 3,889 → 4,166 µs [1.080, 0.84-1.56]. The observe figures do not move
  beyond their spread (no change here is on the fast path but the packet's focus count); the tails swing ±50% run to
  run on this machine.
- `ingest.bench.ts 40 500 shipped`, 4 rounds: backfill 192.9 → 181.1 µs/item [0.954, 0.88-0.98]; sweep 45.0 → 41.3
  µs/item [0.967, 0.75-1.22]; CPU 245.5 → 226.8 µs/item [0.957, 0.87-0.98]; main thread 190.8 → 174.5 µs/item
  [0.944, 0.86-0.97]; process CPU [0.951]; memory held 3,300 → 3,283 B/item, released 2,056 → 2,080 B/item [1.003].
- `users.bench.ts 200 500`, 3 rounds: storm CPU 194.9 → 182.2 µs/item [0.935, 0.93-0.96]; RSS a user live 1.59 →
  1.56 MB [0.976], frozen 0.78 → 0.77 MB [0.986]; heap a user live 0.87 MB and frozen 0.44 MB both; the thaw (first
  read) p50 3.12 → 3.25 ms [1.017, 0.98-1.07], p99 12.96 → 10.33 ms [0.797]; first event after the thaw p50 31.3 →
  27.5 ms [0.879, 0.83-0.93], p99 44.1 → 43.2 ms [0.920]; process CPU 30.7 → 28.7 s [0.938, 0.94-0.97]. Blobs 786
  B/item (the branch's profiled run; main's was 786 too). Memory per user did not move beyond noise: no change here
  cuts live heap (see "Tried and not kept").

## Profiles after (this branch)

One profiled run each, same intervals as before.

- pipeline.bench: 8,898 → 7,606 samples (the whole process, workload build included). Self: the workload build 3.7%,
  `SparseIndex.search` 3.6%, `tokenizeInto` 2.1%, the conflict lists' regexes 1.9-2.0%, `noteShown` 1.9%,
  `focusCount` 1.8% (7.8% before), `mentions` 1.7%, `assess` 1.4%. Inclusive: `ask` 37.9% (40.1%), `observe` 35.6%,
  `searchLive` 17.1%, `grounded` 12.9%, `conflicts` 11.4%, `renderPacket` 10.7% (16.2%), `rank` 9.2%, `assess` 9.1%,
  `pick` 4.0% (9.6%). The next levers are `assess`'s per-request reading (`dateVerdict`, `analyse`'s misses) and the
  index's search: none above 4% self.
- ingest.bench: 8,835 → 7,024 samples. `stopwordAt` 10.7% → 2.4% self, `inflateSync` 5.8% → 3.4% (`unpack` 7.5% →
  4.2% inclusive: the sweep's re-sketch of held copies is what remains), `deflateSync` 15.0%, `sketchTerms` 17.5%
  self (20.2% inclusive: its loop now carries what `stopwordAt` did), `extractTypedEntities` 16.8%, `put` 30.3%,
  `onStored` 25.1%, `recordMentions` 7.6%.
- users.bench 200 × 500: 25,597 → 23,552 samples; `dayFactsOf` 14.7% → 12.7% (`namedOf` 7.0% → 5.4%,
  `spanFactsOf` 5.4% → 4.8%); `deflateSync` 12.1%.

## Behaviour gates

- `bun run eval` (no model): precision 0.65, recall 0.52, falseFireRate 0; acting 19/28 neutral requests with
  packets at 1.18 items, facts handed 10/11, look-alikes handed 3/10: main's figures.
- Funnel (`--jobs 4`, the default, shipped coverage, train seeds 41-42): main 323/384 hidden, 294/384 decoys; this
  branch 323/384 and 294/384, `--baseline` against main's rows hidden +0 −0, decoys +0 −0.
- `env -u OPENROUTER_API_KEY CHECK_COLD=1 FORMAT_COLD=1 bun run check` on the final tree (see the PR-less push).

## Pitfalls (also in packages/engine/CLAUDE.md)

- The scratchpad directory is shared between concurrent sessions on this machine: one overwrote this round's A/B
  script mid-run. Keep scratch files in a subdirectory of your own.
- A worktree with `node_modules` symlinked from the main checkout resolves `@eden/*` to the main checkout's packages
  (each package's `node_modules/@eden` links are relative to where they really are): mirror each package's
  `node_modules` as a directory whose `@eden` links are relative again, or a change to primitives, graph or sources
  is silently not what runs.
