# Specialising the per-user search index: which axes can move 10x (2026-11-13, D1730: rejected, a finding)

The question: can Eden's per-user search index (`SparseIndex` in `@eden/primitives`, the `ItemCache` around it) be
specialised for an order-of-magnitude gain on any axis: memory a user, search latency (p50/p99), build, insert and
merge cost, thaw and re-index cost, cold start, or retrieval quality? The bar to ship, set before measuring: at least
3x on a metric that matters (thaw time, memory a user, p99), no regression elsewhere beyond noise, and identical
results (D111). Nothing here clears it, so nothing ships; this note and D1730 are the record, and
`packages/engine/bench/index-axes.bench.ts` is the harness for whoever tries again.

## In plain words

- **The 10x on thaw already exists: it is the warm form (D860).** A user idle under 30 minutes thaws in 10-45 ms
  instead of 84-660 ms (10-15x), because the warm blob carries the index and the deflated texts as they are. What is
  left is the compact form (idle 30 minutes, and every user after a restart), and half of its thaw is not the index: it
  is deflating each item's text again for the live form (D188).
- **Carrying the index in the compact blob** takes the indexing out (thaw 1.6x faster) but makes the blob 35-36%
  bigger, which costs users a box. With the texts' deflate also put off to a background job, the request would wait
  25-34 ms instead of 230-245 (7-9x), still with the 35% bigger blob. Rejected on the size.
- **Memory**: the compacted index is 564-629 bytes an item at 3,000 items; the best compressed layout computed here
  (Elias-Fano doc gaps, tf nibbles, varint forward arena) is 269-340, 1.7-2.1x. The index is about a third of a live
  user, so a user shrinks by at most about a sixth. O4 (D750) measured the same ceiling.
- **Search** is 35-275 µs p50 and 76-594 µs p99 up to the product's cap (7,000 items a user: 2,000 lookups' items
  plus 5,000 synced) and 2.2% of pipeline CPU (`SparseIndex.search` inclusive, 1.8% self, in a `--cpu-prof` of
  `pipeline.bench.ts`, 2,000 events). It reaches milliseconds only at 20,000-100,000 items, which no user can hold.
- **Build** is 1.1-1.8x faster with merges deferred to one at the end, at the sizes users have; 6.2x at 100,000 items,
  which no user reaches.
- **Quality**: eight BM25F parameter variants (field weights, k1, b) on the train funnel and the eval moved hidden
  facts by -2 to +1 of 384 and decoys by -1 to 0; the eval did not move at all. The lexical scorer is not where
  retrieval is lost (D162 found the same).

## Method

`bun packages/engine/bench/index-axes.bench.ts [sizes] [--thaw] [--prose]`. Users of 1,000, 3,000, 7,000, 20,000 and
100,000 items from the sim world (`buildWorld({ seed: 1, noiseScale: 5 })`, 6,892 items; past that the items are
tiled, each copy with a few words of its own so the vocabulary grows), title and text as two fields, weights 2 and 1,
as the cache indexes them. `--prose` takes the repository's docs as item text (items that do not repeat each other).
`--thaw` builds a real `ItemCache` user (synced, `put` in pages of 100) and times the cache's own freeze and thaw steps
and each part of the compact thaw separately, medians of 9. Scratch prototypes (not committed) built on the same
setup: the compact form with the index carried, the index's derived arrays rebuilt from postings alone (checked equal
to `snapshot()`'s), merges deferred during a build (`snapshot()` compared array for array with the incremental
build: identical at 1,000-20,000 items), and the quality screen (a temporary hook in `UserCache` passing the variant's
options; reverted). Bun 1.4.4, 4 cores shared with other sessions, `env -u BUN_OPTIONS`, single runs unless stated:
read differences under 15% as noise.

## Axis by axis

| Axis | Now (measured here) | Best measured or computed | Ratio | 10x? |
| --- | --- | --- | --- | --- |
| Thaw, warm form (idle 2-30 min) | 8.6-44.5 ms (1,000-7,000 items) | the index's share is ungaps and copies, about a tenth | ≤1.1x | no: the warm form is already the 10-15x win over the compact thaw |
| Thaw, compact form (idle 30 min+, restart) | 84-660 ms; 3,000 items: 228-273 ms | index carried: 138-154 ms; plus deflate deferred: 25-34 ms request wait | 1.6x CPU; 7-9x wait | only the wait, and only with a 35-36% bigger blob: rejected |
| Index build (adds, then compact) | 24-80 ms at 1,000-7,000; 285 ms at 20,000; 5.5 s at 100,000 | merges deferred to one: 14-51 ms; 143 ms; 0.88 s | 1.1-1.8x; 2.0x; 6.2x | only at 100,000 items, past every cap |
| Index memory (compacted, held) | 696 / 564 / 373 B an item (world 1,000 / 3,000 / 7,000); prose 711 / 629 / 613 | computed Elias-Fano layout: 331 / 269 / 184; prose 380 / 340 / 332 | 1.7-2.1x | no |
| Memory a live user | 5.6-6.5 MB at 3,000 world items, the index 2.13 MB of it | the index halved | ≤1.2x | no |
| Search, 12 terms, k 24 (an ask) | p50 108-274 µs, p99 247-594 µs (1,000-7,000) | not built (MaxScore); 2.2% of pipeline CPU | – | no: 10x would save under 0.6 ms of a request |
| Search at 20,000 / 100,000 items | p50 0.87 / 5.9 ms, p99 1.8 / 11.3 ms | – | – | relevant only past the caps |
| Churn (remove oldest + add) | p50 4-11 µs, p99 156-544 µs, max 2.5-5.0 ms | D120's sliced merges already | – | no |
| `snapshot` + `restore` | 0.9 ms (1,000-7,000), 4.8 ms (20,000) | – | – | not a cost |
| Retrieval quality (train funnel, eval) | hidden 322/384, decoys 294/384; eval precision 0.65, recall 0.52 | best variant (title weight 3): 323 / 294 | +1 of 384 | no lever |

## 1. Thaw

Where a compact thaw goes (`--thaw`, medians of 9; deflate is `packItem` on every text, index includes tokenizing):

| Items | Text | Compact blob | Warm blob | Compact thaw | Warm thaw | zstd + JSON | Deflate | Tokenize | Tokenize + index |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1,000 | world | 208 KB | 805 KB | 116.7 ms | 10.0 ms | 11.2 | 48.2 | 22.4 | 49.8 |
| 3,000 | world | 390 KB | 1,928 KB | 272.6 ms | 19.4 ms | 20.7 | 141.9 | 60.8 | 93.0 |
| 7,000 | world | 535 KB | 2,799 KB | 383.8 ms | 38.8 ms | 42.1 | 204.1 | 55.4 | 126.2 |
| 1,000 | prose | 383 KB | 892 KB | 84.1 ms | 8.6 ms | 5.5 | 36.9 | 15.7 | 31.6 |
| 3,000 | prose | 1,131 KB | 2,534 KB | 250.3 ms | 21.0 ms | 22.2 | 111.2 | 44.1 | 102.1 |
| 7,000 | prose | 2,755 KB | 5,926 KB | 660.5 ms | 44.5 ms | 49.7 | 330.5 | 128.3 | 307.3 |

So D1715's "the compact thaw is indexing" holds only in part: deflating the texts again is 40-53% of it, indexing
(tokenizing included) 33-47%, zstd and JSON 7-11%. Deflate is real work, not set-up: zlib at level 1 is 3-4x faster
but 33% bigger; libdeflate at level 6 is within noise of zlib (1,647,189 against 1,647,725 bytes for 3,000 world
texts, 76-108 against 107-122 ms), at level 1 about 2x faster for 2% more bytes; zstd level 1 per item 3.4-4x faster
for 8% more bytes (scratch, 3,000 world texts of 2,095 characters on average). None is a change to the index.

**The index carried in the compact blob** (prototype): the vocabulary's terms and the postings only (`keyStart`,
`fDocs` as varint gaps, `fTfs`), since the forward arena, df, lengths and per-doc posting counts can be rebuilt from
the postings in one pass (3.4-3.7 ms at 3,000 items; equal to `snapshot()`'s arrays). One zstd stream over the JSON
and the arrays:

| 3,000 items | Compact blob | With postings + terms | With the whole index | Thaw now | Thaw with the index | Same, deflate deferred |
| --- | --- | --- | --- | --- | --- | --- |
| world | 393 KB | 532 KB (+35.2%) | 624 KB (+58.7%) | 244.8 ms | 154.0 ms (1.6x) | 33.9 ms (7.2x) |
| prose | 1,135 KB | 1,542 KB (+36.0%) | 1,875 KB (+65.3%) | 228.8 ms | 138.2 ms (1.7x) | 25.0 ms (9.2x) |

(The thaw columns sum the parts: zstd and JSON, the vocabulary's restore 2.2-2.8 ms, ungaps 1.1-1.8, derive 3.4-3.7,
entry objects, deflate.) The CPU saved is 1.6-1.7x; the wait could be 7-9x only by also leaving each text plain until
a background job deflates it, which needs no index change at all (that alone halves the wait, 2x) and holds the plain
texts meanwhile (about 6 MB a 3,000-item user, multiplied by every user a restart storm thaws before the jobs run).
The 35% on every compact blob is the regression: compact users are most of a box's frozen users (D862's arithmetic),
and a better coding of the postings would still leave about a quarter. **Rejected.**

**Shared, read-only, mmapped segments** do not apply: blobs are encrypted at rest (D425, the servers' default since
D991), so a thaw decrypts into the process's own memory, and no two users or tenants share an index.

## 2. Build, insert and merge

`SparseIndex` merges its delta into the frozen tier whenever the delta fills (128 docs, then an eighth of the index up
to 512), so building N docs copies every posting about N/512 times past 4,096 docs. Deferring every merge to one at
the end (the delta's capacity set past the build, then `compact`) gives identical snapshots and:

| Items | 1,000 | 3,000 | 7,000 | 20,000 | 100,000 |
| --- | --- | --- | --- | --- | --- |
| Incremental, then compact | 20.7-24.1 ms | 39.0-39.2 ms | 80.2-85.3 ms | 243.5-285.4 ms | 5,498 ms |
| One merge at the end | 12.5-14.4 ms | 28.2-35.0 ms | 48.0-50.7 ms | 113.1-143.3 ms | 882 ms |
| Ratio | 1.7x | 1.1-1.4x | 1.6-1.8x | 2.0-2.2x | 6.2x |

The add itself (counting a doc's terms by field, sorting its unique terms, df) is about 9 µs a doc and stays. At the
sizes users have it would take 10-30 ms off a compact thaw of 230-660 ms, under 10%. Not built.

## 3. Memory

The compacted index as held, and computed sizes of compressed layouts that keep it searchable (a varint or Elias-Fano
list of doc gaps per key, tf in four bits with an escape, a 4-byte offset per used key, the forward arena as varint
gaps, the per-doc and per-term arrays as they are):

| Items | Text | Held: postings / forward / rest = total | Varint layout | Elias-Fano layout |
| --- | --- | --- | --- | --- |
| 1,000 | world | 414 / 228 / 55 = 696 B | 395 B (1.8x) | 331 B (2.1x) |
| 3,000 | world | 334 / 191 / 39 = 564 B | 315 B (1.8x) | 269 B (2.1x) |
| 7,000 | world | 216 / 128 / 29 = 373 B | 210 B (1.8x) | 184 B (2.0x) |
| 3,000 | prose | 370 / 214 / 45 = 629 B | 369 B (1.7x) | 340 B (1.9x) |
| 7,000 | prose | 359 / 217 / 37 = 613 B | 359 B (1.7x) | 332 B (1.8x) |

The forward arena (each doc's sorted terms) is a third of the index and cannot go: removal, `termsOf` and
`containsAll` read it on every lookup (O4 found the same). At 3,000 world items the index is 2.13 MB of a 5.6-6.5 MB
live user, so even the 2.1x layout gives a user about 17% back, and searching it costs more than the typed arrays
(O4's `key` form was 0.85-0.97x the time, its `term` form 1.5-1.6x). Item objects (502 B an item, 24% of the user)
packed as columns would give back at most another sixth; vocabulary 5%. A per-user saving of 3x would need every part
at once, the week-long rebuild O4 (D750) stopped. A dictionary of common words shared across tenants could only take
part of the vocabulary's 5% (and a shared structure keyed by content would need its own isolation review). Not built.

## 4. Search

12-term queries (an ask's request) at k 24 (`ItemCache.search`'s 12 × 2) run 108-274 µs p50 and 247-594 µs p99 from
1,000 to 7,000 items, 4-term queries 35-199 / 76-377 µs, k 400 (`searchIn`'s depth) 175-561 / 263-882 µs. The cap is
7,000 items a user (`maxItemsPerUser` 2,000 plus `maxSyncedPerUser` 5,000), and search is 2.2% of pipeline CPU
(inclusive; 1.8% self). Top-k pruning (MaxScore, block-max WAND) would have to keep D111's exactness (each doc's
contributions summed in the same order into the Float32 accumulator, ties in first-touch order) and saves
little on posting lists this short, and nothing at `searchIn`'s depth of 400; at 20,000 and 100,000 items search
reaches 0.87 and 5.9 ms p50, where it would matter, but no user can hold that many. Not built.

## 5. Quality

A temporary hook passed BM25F options to each user's index (field weights, k1, b per field); the funnel on train
(`bun run funnel --jobs 4 --baseline`, the shipped default, seeds 41-42, reader stub) and the no-model eval, once each:

| Variant | Funnel hidden / decoys (of 384) | Eval precision / recall / false fires | Acting: neutral packets, facts, look-alikes |
| --- | --- | --- | --- |
| Shipped (weights 2, 1; k1 1.2; b 0.75, 0.75) | 322 / 294 | 0.65 / 0.52 / 0 | 19 / 10 / 3 |
| Title weight 3 | 323 / 294 | same | same |
| Title weight 1.5 | 321 / 294 | same | same |
| Title weight 1 | 320 / 293 | same | same |
| k1 0.9 | 321 / 294 | same | same |
| k1 1.6 | 322 / 294 | same | same |
| b 0.3 title | 322 / 294 | same | same |
| b 0.5 text | 321 / 294 | same | same |
| b 0.9 text | 322 / 294 | same | same |

Every variant is within two tasks of the default (the `--baseline` diffs: three variants move nothing, four lose one
or two hidden facts and at most one decoy, title weight 3 gains one hidden fact and swaps two decoys for two others)
and no eval number moves: no parameter of the lexical scorer is a lever, so nothing was tuned. Phrase or proximity
scoring would need positions, about one more varint a posting (the index's size again); with this little sensitivity
to scoring it was not built.

## What would move these numbers, and is not an index change

- **A compact thaw's wait**: putting the texts' deflate after the thaw, as a background job, halves it with no format
  change (the D325 scheduler already slices jobs); it holds plain texts until the job runs, so it needs a bound on how
  many users wait unpacked.
- **A compact thaw's CPU**: a cheaper per-item codec for live text (zstd level 1: 3.4-4x faster to make, 8% more
  bytes on the sim's text) speeds every put and thaw alike; the bytes are a live-memory regression to weigh.
- **Search past the caps**: the measurements above are the starting point if users of 20,000+ items ever exist.
