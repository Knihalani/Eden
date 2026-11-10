# O4: the segment redesign's three $0 screens (stop), the path at 1,000 sources re-checked, a flaky test

Status: measured 2026-11-10 on branch `claude/o4-work` (from `claude/lucid-hypatia-v9wqk5` at 985599e3). Decision D750
(a finding; the product is unchanged). Paid spend: $0. Machine: 4 vCPU, 15 GB, Bun 1.4.4, benches one at a time.
Outputs: `packages/sim/lab/o4/`. Figures here are from the runs after the review's fixes (below).

## In plain words

- **O2's plan** (`docs/research/o2-live-user-plan.md` on branch `claude/o2-plan`) proposed a week's rebuild of how a
  live user is held (one compact "segment"), hoping to make a live user 2.5-3 times smaller. It left three cheap
  checks to run first. All three are now run.
- **Verdict: stop. Do not start the week-long build for memory.** Measured, the rebuild would make a live user about
  2.0-2.4 times smaller on the simulator's text and about 1.6-1.7 times smaller on ordinary prose, against the
  plan's 2.5-3. On a whole box with a tenth of users active that is about 1.35-1.55 times more users (arithmetic on
  measured pieces): 20,000 a box is not reached on prose, and only approached on the simulator's text, which
  flatters it.
- **Why it falls short of O2's estimate:**
  - O2's index size left out a part the engine cannot drop: each item's own list of words, which it reads on every
    lookup and needs to remove an item. With it, the index shrinks about 2.0 times at the cap, not 2.8.
  - Part of today's index is its "recent items" tier, which holds a tenth of the items in a looser form with spare
    room. An idle index could fold it away without any redesign.
  - Compressing item text in groups works 3.2-3.7 times better than today on the simulator's text, but only about 1.3
    times on ordinary prose: the simulator's items repeat each other far more than real text does.
- **What did pass:** searching the compressed index is not slower. The exact form is 0.85-0.97 times today's time
  with every result identical. Speed was never the obstacle; size is.
- **What decides users a box is elsewhere.** Waking a returning user costs 145 ms of CPU by O2's bench. One scratch
  run of mine (not in the repo, heavier items, 203 ms in all) put 107 ms of it in re-compressing text that had just
  been decompressed. Waking fast would let users be frozen after a minute or two instead of 20-30, which cuts the
  active share directly. That is the lever worth sizing next, and it still needs the one number nobody has: what
  share of real users is active at once.

## 1. Screen 1: postings as varints, searched (`segment-screen.bench.ts`)

`bun packages/engine/bench/segment-screen.bench.ts`: the corpus and queries of `index-memory.bench.ts` (sim world,
title and text as two fields, 4-term queries, k 20). The varint forms are read-only, built in one go; every
implementation answers each query in turn, and each result (docs, scores, coverage, matched) is compared with the
packed index's. Two forms: `key`, a list per (term, field) of a varint doc gap and a tf byte, with a Uint32 offset
per key; `term` (O2's), a list per term with both fields' tf in one byte, a Uint32 offset per 16 terms. In `term`
a tf of 15 or more needs an escape (10,440 of them in the first 2,000 items), sized as one more byte each; the
bench's search reads them from a Map, so only its size is modelled.

Bytes an item, by part:

| Part | 2,000 items | 3,000 items | 6,892 items |
| --- | --- | --- | --- |
| Packed today: postings (doc numbers and tf) | 316 | 272 | 200 |
| Packed today: key offsets | 49 | 35 | 17 |
| Packed today: forward arena (each doc's terms) | 214 | 186 | 137 |
| Packed today: delta tier | 151 | 222 | 12 |
| Packed today: per doc and term | 46 | 40 | 25 |
| **Packed today: total** | **777** | **755** | **390** |
| `key`: postings | 230 | 205 | 136 |
| `key`: offsets | 50 | 36 | 17 |
| Forward arena as varint gaps | 116 | 103 | 71 |
| **`key` + varint forward arena + per doc and term** | **442** | **383** | **250** |
| `term` + varint forward arena + per doc and term | 399 | 348 | 231 |
| `key`, no forward arena | 326 | 280 | 178 |
| `term`, no forward arena (the form O2 sized) | 283 | 245 | 160 |

The rows in bold are the comparison that counts: 1.76x at 2,000 items, 1.97x at 3,000 (the cap), 1.56x at 6,892.
`term` is smaller still (2.17x at the cap) but is exact only when searched in two passes, at 1.5-1.6x the time.

The delta tier holds the docs not yet merged into the frozen arrays (334 of 3,000 at the cap, by the reviewer's
probe) at 14 bytes a slot against 5, with spare capacity: of its 222 bytes an item at the cap about 110 is those
docs' content, 90 spare room and 22 a per-term head. Merging it at the idle tick and releasing its arrays would
return about 130-180 bytes an item with no change of layout. Not built.

Search time, interleaved, mean (p50 and p99 are in the output):

| Form | 2,000 items | 3,000 items | 6,892 items | Results differing from packed |
| --- | --- | --- | --- | --- |
| Packed today | 48.7 µs | 72.8 µs | 122.8 µs | – |
| `key` | 44.1 µs (0.90x) | 62.1 µs (0.85x) | 119.1 µs (0.97x) | 0 of 200 |
| `term`, two passes | 76.6 µs (1.57x) | 107.3 µs (1.47x) | 201.2 µs (1.64x) | 0 of 200 |
| `term`, one pass | 53.3 µs (1.10x) | 72.8 µs (1.00x) | 134.1 µs (1.09x) | 63-65 of 200 |

O2's rule was "under 300 bytes at under 2x the search time, else stop". The search bound holds with room. The byte
bound holds only without a forward arena (245-283 for O2's form); the index the engine needs is 348-383 at the cap.

Not screened: removal and update against immutable lists (tombstones, a merge policy), and doc numbers reused after
a removal (gaps need ascending numbers; the packed index keeps insertion order, which top-k ties follow).

## 2. Screen 2: entries as columns

`… segment-screen.bench.ts columns 3000`, heap in a child process: an entry object, its item object with its own
copies of its strings (id, ref, title, url, meta) and a Map by id, against typed-array columns, one byte arena for
the strings and an open-addressed id table. No text, no index, no sketches.

| Shape | Bytes an item |
| --- | --- |
| Objects (today's shape) | 354 |
| Columns and a byte arena | 163 (2.17x) |

About 190 bytes an item saved. O2 hoped for "40-60 against several hundred": the strings' bytes stay.

## 3. Screen 3: text in zstd blocks

`… segment-screen.bench.ts text 3000` and `text 3000 --prose` (this repository's research notes up to O2's, cut
into 1,100-character pieces: one author's prose and tables, a stand-in for text not generated from templates; not
users' mail).

| Text | Form | Bytes an item | Read one item, p50 |
| --- | --- | --- | --- |
| Sim world (2,087 characters an item) | deflate, each item (today) | 548 | 7.6 µs |
| | zstd, blocks of 16 | 173 | 19.2 µs |
| | zstd, blocks of 32 | 148 | 31.1 µs |
| Notes (1,100 characters a piece) | deflate, each item (today) | 607 | 8.8 µs |
| | zstd, blocks of 16 | 486 | 30.1 µs |
| | zstd, blocks of 32 | 461 | 52.6 µs |

3.2-3.7x on the sim's text, 1.25-1.32x on prose. Reading an item from a block costs 19-53 µs against 8: affordable
(an ask reads tens of items). The sim's figure is not evidence for real users; A14 made the same caution for frozen
blobs. What the screen leaves out: today's side counts the deflated bytes only (the reviewer's heap probe read 592
bytes an item with each array's own overhead), every text is deflated as UTF-8 (the cache uses Latin-1 where it
fits and leaves text under 256 characters plain), and the block side counts 4 bytes an item of offsets.

## 4. What the redesign would give, from these pieces

A live user at the cap is 1,670-1,870 bytes an item of heap (O2's figure, in which text is 453 bytes an item on
another sample; the text saving below is measured against 548). Saved by the redesign, bytes an item: index 372
(755 → 383), entries 191, text 375-400 on the sim or about 120 at the prose ratio.

| | Live heap, bytes an item | Against today |
| --- | --- | --- |
| Today | 1,670-1,870 | – |
| Redesign, sim text | about 710-930 | about 2.0-2.4x |
| Redesign, prose-like text | about 990-1,190 | about 1.6-1.7x |
| O2's estimate | 500-700 | 2.5-3x |

On a fleet, O2's formula with a tenth active and frozen users on disk only (0.35 MB, D652), live 6.33 MB resident
today: 0.1 x 6.33 + 0.9 x 0.35 = 0.95 MB a user, about 12,400 users. With the redesign: about 0.61 MB (about 19,200
users) at 2.15x on sim text, about 0.70 MB (about 16,800) at 1.65x on prose. Arithmetic on measured pieces, not
runs; D651's mixed runs read about 1.4x higher than their pieces. So 1.35-1.55x on the box for a week's work with
real risk to exact ranking, and the larger figure rests on the simulator's text.

## 5. Where the next factor is

One scratch run (not in the repo) timed the parts of a thaw on the first 3,000 world items (2,087 characters each;
203 ms in all, against the 145 ms of O2's bench on its own users): decompress and parse 21 ms, packing each text
again 107 ms, tokenizing 42 ms, indexing 33 ms. About half is deflating text the thaw has just inflated. O2 screened
deferring that pack (1.4-2x on the wait). A thaw near 10-15 ms would need text held in one form live and frozen and
the index's arrays kept in the blob instead of rebuilt: smaller than the segment (no new search, no tombstones),
and it would allow freezing after a minute or two. Its value is the active share it removes, which no one has
measured: a pilot's `EDEN_TRACE=1` log has the event times (`bun run trace-report`). Read that number before paying
for either build. Not built here; reported for a decision.

## Review

The reviewer (REQUEST_CHANGES, fixed before this text): the columns screen's "copies" of today's strings were not
copies in JavaScriptCore, so today's side read 276 bytes an item where it is 354; the `term` form was charged 32
bytes for each escaped tf where an inline byte is 1, which had made it look larger than `key`; key offsets were
sized by the df array's capacity, not its terms; the bold totals were hand sums no bench row printed (rows added);
the delta tier was called slack where half of it is content; the prose corpus grew with this note (now the notes up
to O2's); the thaw figures mixed two bases. The verdict stood through all of them, with a thinner margin than the
first draft claimed (2.0-2.4x and 1.6-1.7x, where it said 1.9x and 1.5x).

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
