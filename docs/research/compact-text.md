# Compact item text (D188)

Deep audit 2026-11-06, finding F9 stage 2 (`scale-graph-soa-and-compact-text`), after stage 1 (the graph as
struct-of-arrays, D169). It reopened D111's "compressed cold text tier" as a trial and was promoted the same day.

## Why

A JS string is one byte a character only while every character is Latin-1. One typographic character past it (an
arrow, an en dash) makes the whole string two bytes a character. In the sim world (`buildWorld` seed 1, noise scale 5,
6,892 items), 29% of items hold such a character, and the characters past Latin-1 are almost all `→` (14,650 of
15,220), then `–` and `—`. Per item: 1,085 characters, 1,890 B held as strings, 1,090 B as UTF-8, 359 B deflated
(a scratch script over the world's items, run in the session).

Upper bound, before any code: a 40 × 500 `ItemCache` of world items with each cached item's text replaced in place:
3,307 B/item plain, 2,496 UTF-8 as a one-byte string (1.32x), 1,836 deflated (1.80x), 1,355 with no text at all. UTF-8
alone could not reach the 1.5x gate, so the change deflates.

## What

`packages/engine/src/packed-text.ts`: `packItem` returns a copy whose `text` is an own, enumerable getter over
deflated bytes (`Bun.deflateSync`, default level), so reads, spreads, `JSON` and `structuredClone` see the same item.
Latin-1 text is deflated as Latin-1 bytes and decoded with `Buffer.toString("latin1")`; other text as UTF-8 with
`TextDecoder`. Text under 256 characters, or that does not shrink by a fifth, stays a plain string. A 256-entry
process-wide memo of decoded texts, keyed by each item's own bytes, serves repeated reads of one candidate.

`ItemCache.put` indexes, tallies and adds to the graph from the plain copy, then holds the packed copy; `put`
returns the held copies. `CacheLimits.packText` (on by default) turns it off; the ingest and pipeline benches take
`--plain` for the old layout.

The review found two defects, fixed before merge: a refresh with the same words (a lookup's fresh copy, a re-read,
a push) put a plain copy back in place of the packed one (now `repackLike` keeps the held bytes), and text with a lone
surrogate came back from UTF-8 with U+FFFD, so every refresh re-indexed it (such text now stays plain). The memo is
cleared by `forget` and `removeItems`.

One fix during the work: the first version decoded every text with `TextDecoder`. That gives a two-byte string for
any accented Latin-1 letter, and every regex and hash over item text ran slower: `pipeline.bench.ts` 1.17x (eight
interleaved runs, median 0.95 → 1.11 ms/event). Decoding Latin-1 text through `latin1` removed it.

## Measurements (this session, 4-core shared VM)

`bun packages/engine/bench/ingest.bench.ts --world [--plain]`, 200 users × 500 items, shipped mode (memory "raw
released", B/item; backfill µs/item):

| Run | Plain | Compact | Ratio |
|---|---|---|---|
| pair 1 | 3,799 B, 159.4 µs | 2,368 B, 194.8 µs | 1.60x memory, 1.22x backfill CPU |
| pair 2 | 3,953 B, 163.7 µs | 2,543 B, 196.8 µs | 1.55x memory, 1.20x backfill CPU |
| pair 3 | 3,808 B, 172.1 µs | 2,378 B, 200.8 µs | 1.60x memory, 1.17x backfill CPU |
| after review fixes | 3,808 B, 170.9 µs | 2,368 B, 222.1 µs | 1.61x memory, 1.30x backfill CPU |

Core mode (no graph, no `onStored`): 3,145 → 1,692 and 1,847 B/item (1.70-1.86x). Sweeps (an unchanged re-listing)
unchanged, 4-7 µs/item either way. On the bench's own all-Latin-1 workload (no `--world`): shipped 3,457 → 2,635
B/item (1.31x), backfill 200.9 → 247.1 µs/item.

The "raw released" figure is bimodal on this VM in `--quick` runs (the same build reads ~1,940 or ~2,700 B/item from
one run to the next), so compare full-size runs only.

`bun packages/engine/bench/pipeline.bench.ts [--plain]`, eight interleaved runs each on the final tree, ms/event:
plain 0.872-1.025 (median 0.965), compact 0.943-1.075 (median 0.979): 1.01x, inside the 1.1x gate. After the review's fixes, eight more each: plain median 0.920, compact 0.958 (1.04x).

`index-memory.bench.ts` measures the index alone, text excluded; it does not change (415 B/item at 6,892 items).

Quality: `bun run eval` identical but timing (precision 0.8276, recall 0.48, falseFireRate 0; `plannedLookups` reads
121 or 122 from run to run on both trees). `bun run funnel --jobs 4` (train1-6, seeds 41-42, reader stub, intent
replayed) hidden 259/384, decoys 235/384, pool 262/246, `--baseline` against the plain run: hidden +0 −0, decoys
+0 −0.

## Costs left

- Backfill CPU is 1.17-1.30x (the deflate, about 26 µs an item). Sweeps, the common case, are unchanged.
- Each decode is about 7 µs for a 1 KB text; the memo keeps the ask path's repeated reads off that.
- The memo holds at most 256 decoded texts per process (at most about 4 MB at the 8,000-character cap).
- Memos keyed by an item that keep its decoded text (`fold.ts`'s, `conflict.ts`'s) hold a plain copy for items that
  were candidates; they were not changed here.
