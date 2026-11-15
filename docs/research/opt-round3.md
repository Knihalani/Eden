# Low-level round 3

Optimisations found by a profiling survey of main 4559e0634. Each section is one branch's work, with its own method
and numbers; every number below comes from a command run in that branch's session.

## The router's body scan and the packed-text codec (D1925, D1926; branch claude/router-codec)

Two levers from the survey: the router's `userOf` decoded and parsed a whole body to read one key (1.6 µs for 126
bytes, 15.9 µs for 14 KB, 158 µs for 213 KB, about 85% of it decode and parse, on the router's one thread), and
`packItem`'s DEFLATE level 6 was 14% of ingest's self time and 40-53% of a compact thaw.

**Method.** Each change against the tree before it, in separate processes, interleaved and slot-balanced (the arms'
order rotates every round, a Latin square), with a self-vs-self control arm (the old code run twice), on process CPU
time; medians, and the paired median of new/old with its range. Another agent was benchmarking on the same 4-core
machine throughout, so ranges are wide and the control arm is the noise floor. The codec's rule was registered in a
commit before the paid-for-in-time runs (86c1645bc): promote if ingest process CPU paired ≤ 0.92 and live heap a
user ≤ +3%, else delete.

### D1925: `userOf` scans instead of parsing (adopted)

One pass over the bytes checks the whole body against JSON's grammar (whitespace, the number grammar, literals,
string escapes and control bytes) and `bodyShapeUnder`'s bounds (depth 1,008; 1,010,000 opening brackets and commas,
the same count), notes where the last top-level `userId` value lies, and decodes only that value. Exactness against
`JSON.parse` of the decoded body rests on three facts: the WHATWG UTF-8 decoder never swallows a byte under 0x80 (so
structure survives invalid UTF-8, and inside a string the replacement character is valid), it drops one leading BOM
(so the scan skips one), and a key is compared byte by byte only when it holds no escape (otherwise it is decoded as
the parse would). Invalid JSON gives "" (the tenant's child, which answers 400) exactly as the parse's throw did.

Strings are the cost. A JS byte loop on Bun reads about a byte a nanosecond (a bare loop over 136 bytes took 0.12-0.15
µs), so a plain per-byte scan was barely faster than the parse on text with escapes. The scan reads a short run byte
by byte, then finds the next quote and backslash with the native `indexOf` and the next control byte four at a time
over an aligned `Uint32Array` view (Hacker's Delight's `hasless`), keeping each found position until the scan passes
it, so each search covers a byte at most once whatever the number of strings or escapes; where the stop found was
near, the run doubles to 4,096 (D1870's lesson: on text with an escape every couple of dozen bytes a native call each
costs more than the loop). Before that run, a 193 KB body of tool text (an escaped quote or newline every ~24 bytes)
scanned in 376-411 µs, slower than its parse; after, 215-238 µs.

| Body (`bench/router.bench.ts --hop`, µs a call, median of rounds) |   Bytes |        Scan |       Parse |      Speed-up |
| ----------------------------------------------------------------- | ------: | ----------: | ----------: | ------------: |
| event                                                             |     136 | 0.41 / 0.63 | 0.43 / 0.67 | 1.04x / 1.07x |
| items, tool text with escapes                                     |  12,245 | 12.7 / 22.1 | 24.9 / 30.1 | 1.96x / 1.37x |
| items, tool text with escapes                                     | 193,437 |   238 / 300 |   378 / 498 | 1.59x / 1.66x |
| items, prose                                                      |  11,465 |   4.1 / 6.7 |  9.9 / 12.8 | 2.41x / 1.90x |
| items, prose                                                      | 181,087 |     66 / 96 |   116 / 167 | 1.75x / 1.73x |

Two runs (9 and 11 rounds), the second on a busier machine. On CPU time, events whose text holds escaped quotes and
newlines: 163 B 1.13x, 248 B 1.49x, 418 B 2.10x, 758 B 2.51x, 1.4 KB 2.68x, 2.7 KB 2.95x (9 rounds).

Oracle: `router-user.test.ts` keeps the old `userOf` verbatim. Random bodies with odd but valid spellings (escaped
and near-miss keys, duplicates, `userId` at every depth, strings to 1,500 bytes with escapes, non-ASCII and the odd
raw control byte), a BOM, two BOMs or half of one in front, then zero to two random byte edits (a structural byte, a
control byte, invalid UTF-8, an insertion, a deletion, a cut), each placed at a random offset in a larger buffer of
quotes: 60,000 in the file (3,191 routed, 0 differ) and 1,000,000 with another seed (51,929 routed, 0 differ). Hand
cases cover `__proto__`, lone surrogates, numbers the grammar refuses, trailing bytes, and the large and padded
bodies (213 KB, depth 1,007 and 1,008, values at and one past the bound, a 60,000-deep bomb). Ten mutations (the
first duplicate kept, escaped keys never matched, no control-byte check, trailing bytes allowed, depth bound +1, the
control stop ignored, `hasless` at 0x1f, the four-byte loop's restart off by one, the backslash position never
refreshed, the positions not reset between bodies) each fail it.

Not done: fusing with `bodyShapeUnder` is what the scan is (its bounds are checked in the same pass); a SWAR test of
all three string stops in the byte run (1.44x on a micro, not the share left once the native searches took long runs).

### D1926: packed text as zstd level 1 (adopted by its rule)

Survey on the 4,969 world texts `packItem` would pack (seed 1, noise 5; 256+ characters; 7.26 MB raw), 5
interleaved rounds, CPU µs a text, and held bytes (the compressed bytes when under 0.8 of the string's own bytes, else
the string) against zlib 6:

| Codec           | Compress | Decompress |   Held | Packed |
| --------------- | -------: | ---------: | -----: | -----: |
| zlib 1          |     11.1 |        4.4 | +41.4% |  2,099 |
| zlib 2          |     24.4 |        7.0 |  +2.4% |  4,968 |
| zlib 3          |     29.3 |        7.2 |  +1.3% |  4,968 |
| zlib 5          |     26.4 |        6.6 |  +0.3% |  4,968 |
| zlib 6 (before) |     27.0 |        6.2 |      0 |  4,968 |
| zlib 9          |     32.8 |        7.4 |  +0.6% |  4,968 |
| zstd 1          |     10.0 |        5.3 |  +8.2% |  4,839 |
| zstd 3          |     11.6 |        4.7 |  +7.7% |  4,877 |
| zstd 5          |     20.0 |        4.7 |  +5.3% |  4,885 |

zlib's levels are no trade (Bun's level 1 packs fewer than half the texts under the 0.8 rule); zstd 1 is 2.7x faster
to compress. The shipped form drops each frame's 4-byte magic (about 0.9% of a held text here), put back to decode.

Bun 1.4.4 has `Bun.zstdCompressSync`/`zstdDecompressSync` and `node:zlib`'s zstd built in: no dependency.

| Measure (zstd against DEFLATE, paired median)         |    Rounds |                   zstd |               Control |
| ----------------------------------------------------- | --------: | ---------------------: | --------------------: |
| ingest process CPU, 40 × 500 shipped `--world`        | 8 / 8 / 8 |  0.922 / 0.899 / 0.920 | 0.993 / 0.973 / 0.981 |
| the same, last 16 rounds pooled                       |        16 |      0.901 (0.82-1.10) |                 0.974 |
| main-thread CPU, `--world`                            | 8 / 8 / 8 |  0.909 / 0.868 / 0.896 |                       |
| ingest process CPU, workload text                     |         6 |      0.879 (0.76-0.97) |                 1.015 |
| ingest process CPU, `--world`, `bun --smol` (more GC) |         6 |      0.928 (0.89-0.98) |                 0.988 |
| held B/item, `--world` / workload                     |           | +0.1% to +0.4% / +1.0% |                       |
| live heap a user (users.bench 100 × 1,000 `--world`)  |         4 |      0.970 (0.92-1.02) |                 0.999 |
| live RSS a user                                       |         4 |                  1.003 |                 0.992 |
| compact thaw p50 / p99                                |         4 |          0.806 / 0.832 |         0.980 / 1.045 |
| peak RSS over the thaw (VmHWM after clear_refs)       |         4 |                  1.019 |                 1.027 |
| peak RSS over the backfill storm                      |         4 |      1.114 (1.00-1.15) |                 1.016 |

The live heap reads bimodal across processes (1.427 or about 1.30 MB a user, by when the last full collection
ran); in the same mode zstd read 1.453-1.454 against 1.427, +1.9%, inside the rule either way. Both criteria held
(CPU at the edge on the median batch, 0.920; 0.901 pooled), so the switch was promoted and removed. Outside the rule,
the backfill storm's peak RSS (100 users backfilled at once) rose about 10%; 20 passes over the survey's texts in
isolation peaked only 1-2 MB higher with zstd, so the storm's figure is the allocator under a faster backfill, or
noise of 4 rounds, not a per-call context: worth a look if peak RSS at cold start is what sizes a machine.

Compatibility: each packed copy's getter carries a tag (bit 0 Latin-1, bit 1 zstd), one decode memo map a tag; a warm
blob's `FastEntry.p[1]` is the tag, so format 6's 0 and 1 read as DEFLATE. `PERSIST_FORMAT` 7 reads 6. The tests:
`packed-text.test.ts`'s 3,000 random texts (a leading BOM, lone and paired surrogates, Latin-1 and two-byte
characters) round-trip under both codecs, the memo's read equal to a real decode's; `persist.test.ts` rewrites a
warm blob as format 6 wrote it (every packed text, and every other one) and reads it back exactly through the
encrypted store (forcing the zstd tag on thaw fails it); `cache-freeze.test.ts` puts DEFLATE copies and finds every
text held as zstd through warm and compact freezes.
