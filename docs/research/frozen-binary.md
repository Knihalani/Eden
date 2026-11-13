# A binary layout for frozen users (2026-11-13, D1715: rejected)

The question: would a binary layout specialised to a frozen user's structures (typed arrays written as they are,
strings once, varints) beat the two forms the cache writes now (D325, D860, D862), the compact one (zstd-3 of the
`FrozenBody` JSON, item text inside) and the warm one ("EDF2": zstd-3 of a JSON head and the index's arrays, then each
item's deflated text bytes as they are)? The bar set before measuring: thaw p50 at least 1.5x faster, or the blob at
least 25% smaller, with neither worse; plus a differential round trip on every eval request. Encryption and the file
format around the blob (D425) were out of scope and unchanged. Nothing here is product code: the measurements ran on
scratch scripts over the cache's own freeze and thaw steps, and only this note and D1715 are committed.

## Method

Users built from the sim world's items (`buildWorld({ seed: 1, noiseScale: 5 })`, as `users.bench.ts --world`), and
again with the docs' prose as item text (`--prose`: items that do not repeat each other); 100, 500 and 3,000 items a
user (a light user, a median one, the sync cap's heavy one), all synced. `ItemCache.put`, then the cache's private
`freezeSteps(u, warm)` and `thawSteps(f)` run to completion, 9 times each; medians. Bun 1.4.4, 4 cores, without
`--smol`. The thaw was then split (zstd alone, `JSON.parse` alone) and profiled (`bun --cpu-prof`, 100 warm thaws of
3,000 world items).

## Where the time and bytes go now

| Items | Form | Blob | B/item | Freeze ms | Thaw ms | of which zstd | of which JSON.parse |
|---|---|---|---|---|---|---|---|
| 100 world | compact | 12.1 KB | 123 | 2.02 | 7.88 | 0.18 | 0.63 |
| 100 world | warm | 48.3 KB | 495 | 1.55 | 1.42 | 0.13 | 0.44 |
| 500 world | compact | 47.1 KB | 96 | 6.06 | 25.71 | 0.52 | 1.96 |
| 500 world | warm | 215.9 KB | 442 | 2.66 | 2.46 | 0.37 | 0.94 |
| 3,000 world | compact | 249.5 KB | 85 | 57.14 | 188.12 | 3.50 | 15.36 |
| 3,000 world | warm | 1,226.3 KB | 419 | 19.31 | 18.07 | 2.24 | 7.22 |
| 100 prose | compact | 39.0 KB | 399 | 2.54 | 10.28 | 0.34 | 0.50 |
| 100 prose | warm | 82.3 KB | 843 | 2.31 | 2.23 | 0.29 | 0.73 |
| 500 prose | compact | 183.6 KB | 376 | 14.31 | 40.23 | 1.03 | 1.80 |
| 500 prose | warm | 428.0 KB | 876 | 5.30 | 4.83 | 0.78 | 1.92 |
| 3,000 prose | compact | 1,119.3 KB | 382 | 101.42 | 268.64 | 9.63 | 15.40 |
| 3,000 prose | warm | 2,503.3 KB | 854 | 25.52 | 18.53 | 2.75 | 4.74 |

- **The compact thaw is indexing, not reading.** zstd and `JSON.parse` are 7-10% of it (3,000 world: 18.9 of 188 ms);
  the rest is deflating each text again and tokenizing and indexing every item. No layout of the same contents moves
  that: carrying the index is what the warm form already does.
- **The warm blob is its texts.** At 3,000 world items: the deflated texts 997 KB of 1,247 KB (80%), the index's
  arrays about 144 KB, the JSON head 106 KB after zstd; with prose 1,739 KB of 2,552 KB (68%).
- **The warm thaw's parts** (profile, setup included): `JSON.parse` 27%, zstd 11%, `ungaps` (the postings' varints)
  9.5%, UTF-8 decode 4%, the vocabulary's restore 3.3%, `packedFrom` 2.9%. Even a parse that cost nothing would leave
  the thaw about 1.4x faster at best; a binary decode still makes every string the JSON makes.

## Two layouts screened

Both encode the same objects the JSON holds (checked by a round trip) and go through zstd-3 like it.

**A, a string table and row records** (every distinct string once, records of varint indexes and numbers): larger than
the JSON after zstd everywhere, by 6.0-9.9% on the compact world body (−0.1 to 2.6% prose) and by 34-54% on the warm
head. zstd already finds the JSON's repeats; varint indexes into a table are what it cannot shrink. Decode against
`JSON.parse`: compact 3,000 world 4.69 against 10.45 ms (5.8 ms off a 188 ms thaw, 3%), warm 3,000 world 3.57 against
5.98 ms (2.4 ms off 18 ms, 1.15x), slower than the JSON at 100 warm items.

**B, columns** (each field its own stream, strings inline, numbers as zigzag varints of the delta from the entry
before, the streams concatenated, one zstd): smaller, by far less than the bar.

| Items | Form | JSON part after zstd | Columns after zstd | Change of the whole blob | zstd + parse: JSON | Columns |
|---|---|---|---|---|---|---|
| 500 world | compact | 48,080 B | 44,624 B | −7.2% | 2.63 ms | 1.57 ms |
| 3,000 world | compact | 255,184 B | 227,192 B | −11.0% | 13.77 ms | 9.40 ms |
| 3,000 world | warm | 106,128 B | 73,951 B | −2.6% | 4.95 ms | 4.95 ms |
| 500 prose | compact | 187,915 B | 182,149 B | −3.1% | 4.13 ms | 2.94 ms |
| 3,000 prose | compact | 1,145,057 B | 1,096,286 B | −4.3% | 22.21 ms | 14.98 ms |
| 3,000 prose | warm | 142,532 B | 107,571 B | −1.4% | 5.62 ms | 5.90 ms |

(100 items: compact −3.6% world, −2.7% prose; warm −1.4%, −1.0%.) The best case, 11% of a compact world blob and
4.4 ms off its 188 ms thaw (2%), is under half the size bar; the warm form gains nothing in time.

## What would move the numbers, and why it is not this

- Writing the index's postings as they are (no varint gaps) would take `ungaps` (about 2 ms at 3,000 items) off the
  warm thaw and make the arrays several times larger before zstd: faster only by being bigger.
- Shrinking the warm blob by a quarter needs its texts compressed together (one zstd stream over them, as the compact
  form does), and then the thaw must deflate every item's text again to hold it packed (D188), the compact thaw's cost.
  That is the warm/compact trade D860 and D862 already made.
- Carrying the vocabulary's fingerprints would take its rehash (about 1% of the profile) off the thaw for about 12
  bytes a term (D860 left them out for that).

So the layout is not where a frozen user's time or bytes are. Keeping the JSON forms also keeps every blob on disk
readable with no second decoder.
