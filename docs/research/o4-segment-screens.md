# O4: the segment redesign's three $0 screens (stop), the path at 1,000 sources re-checked, a flaky test

Status: measured 2026-11-10 on branch `claude/o4-work` (from `claude/lucid-hypatia-v9wqk5` at 985599e3). Decision D750
(a finding; the product is unchanged). Paid spend: $0. Machine: 4 vCPU, 15 GB, Bun 1.4.4, benches one at a time.
Outputs: `packages/sim/lab/o4/`.

## In plain words

- **O2's plan** (branch `claude/o2-plan`, `o2-live-user-plan.md`) proposed a week's rebuild of how a live user is
  held (one compact "segment"), hoping to make a live user 2.5-3 times smaller. It left three cheap checks to run
  first. All three are now run.
- **Verdict: stop. Do not start the week-long build for memory.** Measured, the rebuild would make a live user about
  1.9 times smaller on the simulator's text and about 1.5 times smaller on ordinary prose, not 2.5-3. On a whole box
  with a tenth of users active that is about 1.3-1.5 times more users (arithmetic on measured pieces), and 20,000 a
  box is not reached.
- **Why it falls short of O2's estimate:**
  - O2's index size left out a part the engine cannot drop: each item's own list of words, which it reads on every
    lookup and needs to remove an item. With it, the index shrinks 1.6-1.9 times, not 2.8.
  - Almost a third of today's index at the cap is slack in its "recent items" tier, which today's index could give
    back when idle without any redesign.
  - Compressing item text in groups works 3.2-3.7 times better than today on the simulator's text, but only about 1.3
    times on ordinary prose: the simulator's items repeat each other far more than real text does.
- **What did pass:** searching the compressed index is not slower. It is 0.87-1.00 times today's time with every
  result identical. Speed was never the obstacle; size is.
- **What decides users a box is elsewhere.** A returning user costs 145 ms of CPU to wake, and most of that is
  re-compressing text that was just decompressed. Waking fast would let users be frozen after a minute or two
  instead of 20-30, which cuts the active share directly. That is the lever worth sizing next, and it still needs the
  one number nobody has: what share of real users is active at once.

## 1. Screen 1: postings as varints, searched (`segment-screen.bench.ts`)

`bun packages/engine/bench/segment-screen.bench.ts`: the corpus and queries of `index-memory.bench.ts` (sim world,
title and text as two fields, 4-term queries, k 20). The varint forms are read-only, built in one go; every
implementation answers each query in turn, and each result (docs, scores, coverage, matched) is compared with the
packed index's.

Bytes an item, by part:

| Part | 2,000 items | 3,000 items | 6,892 items |
| --- | --- | --- | --- |
| Packed today: postings (doc numbers and tf) | 316 | 272 | 200 |
| Packed today: key offsets | 49 | 35 | 17 |
| Packed today: forward arena (each doc's terms) | 214 | 186 | 137 |
| Packed today: delta tier | 151 | 222 | 12 |
| Packed today: per doc and term | 46 | 40 | 25 |
| **Packed today: total** | **777** | **755** | **390** |
| Varint, a list per (term, field): postings | 230 | 205 | 136 |
| Varint, a list per (term, field): offsets | 66 | 44 | 19 |
| Forward arena as varint gaps | 116 | 103 | 71 |
| **Varint lists + varint forward arena + per doc and term** | **458** | **392** | **251** |
| The same without a forward arena (what O2 sized) | 342 | 289 | 180 |

The rows in bold are the comparison that counts: 1.7x at 2,000 items, 1.9x at 3,000 (the cap), 1.55x at 6,892. The
bench also prints a list per term with both fields' tf in one byte (O2's form): it is larger here, because 10,440
term frequencies in the first 2,000 items are 15 or more and need an escape.

The delta tier (docs not yet merged into the frozen arrays, 14 bytes a slot against 5) is 20-29% of the index at
2,000-3,000 items. The index could merge it and release its arrays at the idle tick, with no change of layout: about
150-220 bytes an item, a tenth of a live user. Not built.

Search time, interleaved, mean (p50 and p99 are in the output):

| Form | 2,000 items | 3,000 items | 6,892 items | Results differing from packed |
| --- | --- | --- | --- | --- |
| Packed today | 46.8 µs | 75.8 µs | 120.7 µs | – |
| Varint, a list per (term, field) | 43.2 µs (0.92x) | 65.7 µs (0.87x) | 120.9 µs (1.00x) | 0 of 200 |
| Varint, a list per term, two passes | 74.1 µs (1.58x) | 107.3 µs (1.41x) | 197.8 µs (1.64x) | 0 of 200 |
| Varint, a list per term, one pass | 51.4 µs (1.10x) | 75.7 µs (1.00x) | 135.7 µs (1.12x) | 63-65 of 200 |

O2's rule was "under 300 bytes at under 2x the search time, else stop". The search bound holds with room. The byte
bound holds only for what O2 sized (289 at the cap, no forward arena); the index the engine needs is 392.

Not screened: removal and update against immutable lists (tombstones, a merge policy), and doc numbers reused after
a removal (gaps need ascending numbers; the packed index keeps insertion order, which top-k ties follow).

## 2. Screen 2: entries as columns

`… segment-screen.bench.ts columns 3000`, heap in a child process: an entry object, its item object with its own
strings (id, ref, title, url, meta) and a Map by id, against typed-array columns, one byte arena for the strings and
an open-addressed id table. No text, no index, no sketches.

| Shape | Bytes an item |
| --- | --- |
| Objects (today's shape) | 276 |
| Columns and a byte arena | 164 (1.69x) |

O2 hoped for "40-60 against several hundred". The strings are most of it and stay; about 110 bytes an item is saved.

## 3. Screen 3: text in zstd blocks

`… segment-screen.bench.ts text 3000` and `text 3000 --prose` (this repository's research notes cut into 1,100-
character pieces: one author's prose and tables, a stand-in for text not generated from templates; not users' mail).

| Text | Form | Bytes an item | Read one item, p50 |
| --- | --- | --- | --- |
| Sim world (2,087 characters an item) | deflate, each item (today) | 548 | 7.7 µs |
| | zstd, blocks of 16 | 173 | 18.3 µs |
| | zstd, blocks of 32 | 148 | 25.0 µs |
| Notes (1,100 characters a piece) | deflate, each item (today) | 607 | 8.8 µs |
| | zstd, blocks of 16 | 486 | 29.2 µs |
| | zstd, blocks of 32 | 462 | 53.3 µs |

3.2-3.7x on the sim's text, 1.25-1.31x on prose. Reading an item from a block costs 18-53 µs against 8: affordable
(an ask reads tens of items). The sim's figure is not evidence for real users; A14 made the same caution for frozen
blobs.

## 4. What the redesign would give, from these pieces

A live user at the cap is 1,670-1,870 bytes an item of heap (O2). Saved by the redesign, bytes an item: index 363
(755 → 392), entries 112, text 375-400 on the sim or about 120 at the prose ratio.

| | Live heap, bytes an item | Against today |
| --- | --- | --- |
| Today | 1,670-1,870 | – |
| Redesign, sim text | about 800-1,000 | about 1.9x |
| Redesign, prose-like text | about 1,075-1,275 | about 1.5x |
| O2's estimate | 500-700 | 2.5-3x |

On a fleet, O2's formula with a tenth active and frozen users on disk only (0.35 MB, D652), live 6.33 MB resident
today: 0.1 x 6.33 + 0.9 x 0.35 = 0.95 MB a user, about 12,400 users. With the redesign: 0.64 MB (about 18,300) on
sim text, 0.74 MB (about 15,900) at the prose ratio. Arithmetic on measured pieces, not runs; D651's mixed runs read
about 1.4x higher than their pieces. So 1.3-1.5x on the box for a week's work with real risk to exact ranking.

## 5. Where the next factor is

One scratch run (not in the repo) timed the parts of a thaw on the first 3,000 world items: decompress and parse
21 ms, packing each text again 107 ms, tokenizing 42 ms, indexing 33 ms. More than half is deflating text the thaw
has just inflated. O2 screened deferring that pack (1.4-2x on the wait). A thaw near 10-15 ms would need text held
in one form live and frozen and the index's arrays kept in the blob instead of rebuilt: smaller than the segment
(no new search, no tombstones), and it would allow freezing after a minute or two. Its value is the active share it
removes, which no one has measured: a pilot's `EDEN_TRACE=1` log has the event times (`bun run trace-report`).
Read that number before paying for either build. Not built here; reported for a decision.

## 6. The path at 1,000 sources, re-checked

O4's brief gave Eden's path as about 1.5 s a task at ~1,000 sources. That is B1's figure. C4 (D430, D431, in the
integration branch) already moved the ask behind its reads: Pi, 995 noise sources, 1,163 → 62 ms a task, hidden
44/72 → 45/72 ([c4-ask-path.md](c4-ask-path.md)). Re-run on this tree at $0 (`bun run funnel --suite
train1,train2,train3 --seeds 41 --jobs 1 -- --noise-sources 995 --limit 16 --time 1 --source-profile …/direct.json
--push payload --timeline T`, 475 s; `latency-time1.txt`):

| | p50 | p90 | p99 |
| --- | --- | --- | --- |
| observe | 19.1 ms | 32.9 ms | 80.6 ms |
| push | 15.1 ms | 25.1 ms | 53.9 ms |
| ask | 11.2 ms | 16.3 ms | 69.3 ms |

Hidden surfaced 38/48, decoys 39/48 (reader stub). Under 150 ms at p99; no new paid pair was run, since there is no
slower arm left to compare with and C4's pair carries the quality check.

## 7. The flaky test

`push-cut-behind.test.ts` asserted that the push with `pushCutBehind` on sent no more searches than with it off,
counting searches at the first moment the session had nothing in flight. Under load that moment can fall between
two phases of one push (after its first searches, before its probes start): 10 counted in one arm, 12 in the other.
The test now compares what was sent: every (source, query) the push sent with the switch on was also sent with it
off, and no source received the same query twice. Wherever the count is taken, both hold. Test only.
