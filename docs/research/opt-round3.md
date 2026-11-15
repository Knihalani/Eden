# Low-level round 3

Optimisations found by a profiling survey of main 4559e0634. Each section is one branch's work, with its own method
and numbers; every number below comes from a command run in that branch's session.

## The sweep stops re-sketching unchanged items (D1927; branch claude/sweep-skip)

Decision: D1927. Every sweep re-lists a source whole, and the sync's `store` read every listed item's title and text
into the source's `TermSketch` and the user's `RareTerms` again, decoding each held copy's packed text to do it. Two
earlier rounds left it ("it needs per-item state", opt-round2); most of that state was already there, since a listing
hands back the held copy itself when the raw item is unchanged (`reuseFor`, `rawHash`). Re-measured on main 7bca42093
(`bun --cpu-prof packages/engine/bench/ingest.bench.ts 40 500 shipped`, 3,385 samples): `sketchTerms` 19.9% self and
23.8% inclusive, the sync's `sweep` 18.7% inclusive, `zstdDecompressSync` 2.0%. The survey's 7.4% self / 18.9%
inclusive split differs by what the JIT inlined into `sketchTerms`; the total is the same order.

### The rule, and why it is exact

`store` skips an item when (1) it is the very object the cache's entry holds, (2) the entry's `stamp` equals the
source's current stamp and (3) the sketch is not `saturated`. The stamp (`SyncManager.stampOf`) is a value from one
process-wide counter, new whenever the source's `TermSketch.epoch` or the user's `RareTerms.epoch` moves; it is taken
before a page's first add and written to every entry the page puts (`ItemCache.put`'s `stamp`). So a stamp that still
matches says: this entry's words were all added to this sketch and this table, and neither has since done anything
that could make adding them again write a bit.

- `TermSketch`: a term once added stays matched until a restart (a fold ORs the halves, so every set bit has its image).
  A restart takes a new epoch. A saturated sketch restarts at its next add whatever the term, so while it is
  saturated nothing is skipped: the old code's re-add of a held item was the add that restarted it.
- `RareTerms`: `add` returns at the source's own slot or at the common mark before writing anything, and no slot is
  ever emptied (a renumbering rewrites numbers, a dropped source's slot becomes a hole only `add` takes over). The
  epoch moves on the three events that could change what a re-add does: a word not kept (`dropped`), a forgotten
  source, a renumbering.
- A restart in the middle of a page makes the page's stamp stale: it never matches again, so those items are added at
  the next listing. A source dropped and back, a user forgotten, a sketch or table read from a snapshot are new objects
  with new epochs. Stamps from one counter never coincide across sources or users.

Stamps survive freezes in memory: `FrozenUser.stamps` holds them in blob order beside the blob, never inside it, so
nothing on disk changes (`PERSIST_FORMAT` stays 7) and a user read from disk starts with none. Without that the daily
sweep of an idle user, which is always frozen by then (warm after 2 minutes, compact after 30), would skip nothing.
`stampOf` reads a live user only, with no thaw and no `seen`: a frozen user's items are added as before.

### Tests

`sketch-skip.test.ts` drives two engines, the skipping one and one built under `SyncManager.resketchForTests` (since
the follow-ups below, `PartnerDeps.syncResketchForTests`; the old
behaviour), through six seeded sequences of 60 steps over three users in two tenants, three sources each: backfill,
ticks, sweeps, edits, new items, items past the cut, deletions, floods that saturate a folded sketch, sources dropped
and coming back, `forget` of a source and of a user, warm and compact freezes, restarts through `EncryptedFrozenDisk`,
and asks. After every step the sync's snapshots (sketch bits and `RareTerms` dumps), `sketchScores`, `rareHolders`,
synced counts and the asks' citations are equal. Directed cases: a saturated sketch met by an unchanged item (a sweep
that reads the whole listing in one page), stamps through warm and compact freezes and not from disk, and the two
invariants on `TermSketch` (40,000 adds with folds) and `RareTerms` (360,000 adds past the full table, forgotten
sources, a renumbering). Nine mutations each fail the file (no saturation check, a restart or a drop or a forget or a
renumbering keeping its epoch, the skip compared with the page's stamp instead of the current one, no identity check,
thawed stamps shifted by one, the stamp not following the sketch's epoch). A tenth, stamping the page's entries only
when no restart happened during it, is equivalent (the stale stamp never matches) and was simplified away. Since
sync.ts changed, `mutate-sync-kick.py` was run: 35 of 35 killed.

### Measured

Three arms in separate processes, interleaved and slot-balanced (round k starts at arm k mod 3): main (A), main again
(A', the control), the branch (B); process CPU per item from the bench's own phase counters (`sweepCpuUs` is new in
the bench, as is `--freeze=warm|compact`, which freezes every user before the sweep). Paired medians of B/A and A'/A
in the same round with their ranges. Another agent's runs shared the 4-core machine.

ingest.bench 200 × 500 shipped:

| Condition | Rounds | Sweep CPU µs/item A → B | paired B/A | control A'/A | Backfill CPU paired B/A | control | Total CPU B/A |
|---|---|---|---|---|---|---|---|
| bench as is (a full GC between phases) | 6 | 47.2 → 7.5 | **0.159** (0.14-0.17) | 1.111 (0.91-1.20) | 1.038 (1.00-1.06) | 1.015 | 0.832 |
| forced `Bun.gc(true)` every 100 ms | 6 | 343.3 → 68.3 | **0.178** (0.05-0.42) | 0.887 (0.63-1.43) | 1.019 (0.66-1.13) | 0.927 | 0.663 |
| every user frozen warm before the sweep | 4 | 61.4 → 15.3 | **0.252** (0.21-0.30) | 1.017 | 0.967 | 1.029 | 0.772 |
| every user frozen compact before the sweep | 4 | 111.8 → 64.3 | **0.560** (0.54-0.69) | 1.028 | 1.027 | 0.999 | 0.856 |

Memory in the same runs: held B/item paired 1.000, 1.001, 0.997, 0.999; released after the sweep 1.005 (1,821.3 →
1,829.9 B/item), 1.002, 0.999, 1.001. Frozen, the sweep keeps the thaw's cost (a compact thaw rebuilds the index),
which is why the compact case keeps more; the warm case is the active user's pause.

users.bench 200 × 500, 6 rounds, medians B/A (control A'/A): live heap a user 1.000 (1.000), live RSS 1.005 (0.996),
frozen heap 1.006 (1.000: the stamps, 4 bytes an entry), frozen RSS 1.010 (1.000), backfill peak RSS 0.929 (0.947),
thaw peak RSS 0.974 (0.996), thaw p50 1.056 (1.054), storm CPU µs/item 1.000 (1.008).

A profile after (same command, 2,768 samples against 3,385): `sweep` 1.9% inclusive, `sketchTerms` 9.3% self (the
backfill's), `zstdDecompressSync` gone, `stampOf` 0.3%.

The rule was registered in ef7f794d3 before the runs: adopt if the sweep's process CPU paired is ≤ 0.90 with identical
bits and held/released memory within +1%. Every condition passes; adopted. The backfill pays a `Map` lookup an item
(`stampOf`, 0.3% of samples), inside the controls' spread in every condition.

### Gates

On the final tree: `env -u OPENROUTER_API_KEY CHECK_COLD=1 FORMAT_COLD=1 bun run check` green on its second run
(2,988 of 2,990 tests pass, 0 fail, plus 524 of 524; the first, on a loaded machine, failed four load-sensitive tests
and a format check of the new test file, each file passing alone after the format fix); `bun packages/eval/src/cli.ts` reads precision 0.65, recall 0.52, falseFireRate 0, acting packets on 19 of 28
neutral requests at 1.18 items, facts handed 10 of 11, look-alikes 3 of 10, as on main; `bun run funnel --jobs 4`
reads hidden 323/384 and decoys 294/384 on main (main's engine, run in this session) and on the branch, and
`--baseline` against main's run reads hidden +0 −0, decoys +0 −0.

### Follow-ups (D1927's review; branch claude/sweep-followups)

**Backfill CPU.** The review read backfill process CPU at 1.080 of main against a control of 0.989, every backfilled
item paying `SyncManager.stampOf` and `ItemCache.stampOf` where nothing can skip. Measured again with
`bun packages/engine/bench/ingest.bench.ts 200 500 shipped`: A is main 2deecc12d with #366's engine changes taken out
(`git diff cada39c33^1 cada39c33` on cache, rare-terms, sketch and sync, applied in reverse: D1927's parent code with
the later rounds' changes kept, so only D1927 differs), A' the same copy again (the control), B main; 8 rounds,
interleaved and slot-balanced, each run its own process, paired medians against A with their ranges. The machine was
not quiet (two other agents; load average 8.6-29 on 4 cores), so the control's spread is the noise floor.

| Condition | Backfill CPU µs/item A, A', B | B/A | control A'/A | Backfill CPU total s A → B | Sweep B/A |
|---|---|---|---|---|---|
| bench as is | 155.5, 154.6, 154.1 | 0.985 (0.925-1.163) | 0.962 (0.872-1.131) | 15.55 → 15.41 | 0.149 (0.124-0.200) |
| forced `Bun.gc(true)` every 100 ms | 290.3, 318.1, 338.2 | 1.102 (0.919-1.297) | 1.124 (0.960-1.217) | 29.03 → 33.82 | 0.151 (0.101-0.337) |

Neither condition reads dearer beyond the control. The two lookups alone, timed in a loop over 500 items no cache
entry holds (a backfill page), cost 60-87 ns an item, about 0.05% of a backfilled item's 155 µs. So nothing was
changed for the backfill: hoisting the lookups would save less than the bench can see.

**The test's switch and the epochs.** `SyncManager.resketchForTests` (a static read at construction) is now
`SyncOptions.resketchForTests`, passed by `PartnerDeps.syncResketchForTests`: one manager's option, so no test can
leave it set for the next. `TermSketch.epoch` and `RareTerms.epoch` are getters over private fields
(`sketch-skip.test.ts` checks an assignment throws and moves nothing).

**The differential at its edges** (`sketch-skip-edges.test.ts`). Two randomized cases the six seeds rarely reached,
each the skipping engine against the old store, compared after every step:

- A user with 4,110 sources whose items are a few words each, a fresh one and some still being taken up, so the
  last sources listed have no `RareTerms` number and their words are dropped, and a word one of them dropped is later
  written by a numbered source (adding the dropped one's item again then marks the word common); adds, edits, sweeps,
  polls, forgotten sources (numbers taken back by a renumbering), warm and compact freezes; 4 seeds of 24 steps.
- Sketches restarting mid-listing: a source read again (its sketch folded small), a flood of 300-800 fresh words at a
  random place in its listing read one to three items a page, by a sweep or a poll; a lookup's put of some items
  (equal copies: the held object and its stamp kept, the entries moved last); a warm or compact freeze; a sweep. One
  source or two whose pages interleave; 12 seeds of 12 rounds.

Mutations of the follow-ups (each applied alone, the file run whole):

| Mutation | `sketch-skip-edges.test.ts` | `sketch-skip.test.ts` |
|---|---|---|
| a drop keeps its epoch (`RareTerms.add`) | killed: seeds 2 and 4 of the dropped-words case | killed by the `RareTerms` invariant only |
| warm thaw gives entry j the stamp of j + 1 | killed: 5 of 12 restart seeds | killed by the directed freeze case |
| compact thaw gives entry j the stamp of j + 1 | killed: 3 of 12 restart seeds | killed by the directed freeze case |
| warm or compact thaw gives j the stamp of j − 1 | survives | survives |

The shift back is equivalent on every path the engine has: a sync page stamps all its entries with one stamp and
moves them last, so a source's entries run from older stamps to the current one in the cache's order, and the one
other put that moves an entry (a lookup's) ends its listing's reuse (`raw` cleared), so that entry is not skipped at
its next listing whatever its stamp. An entry whose words a restart lost therefore never follows one carrying the
current stamp while it can still be skipped.

A finding from the first case: every drop moves the table's epoch, and each page's stamp then goes stale, so a user
past 4,094 sources, or with a full table, re-adds almost every item at every listing (the oracle's cost, as before
D1927): exact, and only that user's skip is lost.

Gates on the final tree: `env -u OPENROUTER_API_KEY CHECK_COLD=1 FORMAT_COLD=1 bun run check` green on its second run
(3,029 of 3,031 tests pass, 0 fail, plus 524 of 524; the first failed one timing test in the untouched
`server/src/http.test.ts`, which passed alone); `bun packages/eval/src/cli.ts` reads precision 0.65, recall 0.52,
falseFireRate 0, acting packets on 19 of 28 neutral requests at 1.18 items, facts handed 10 of 11, look-alikes 3 of
10; `bun run funnel` reads hidden 323/384 and decoys 294/384 on main (run in this session) and on the branch, and
`--baseline` against main's run reads hidden +0 −0, decoys +0 −0; `mutate-sync-kick.py` 35 of 35 killed.

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

### The independent review's fixes (D1925, D1926)

**A BOM inside a value (routing).** The scan decoded the `userId` value's bytes with TextDecoder's default, which
drops a BOM at the start of whatever it decodes. Main decoded the whole body, so only a BOM at the body's first byte
went; `{"userId":"﻿alice"}` (raw EF BB BF opening the value) routed as "alice" here and "\uFEFFalice" on main, and the
cluster router's `bucketOf` and the D995 fence read the same `userOf`. The value decoder is now `ignoreBOM`; the scan
still skips the body's one leading BOM. `router-user.test.ts` gained hand cases (a BOM alone, leading, inside,
trailing, escaped, two of them, in a key, between tokens, after leading whitespace) and its generator now puts BOMs
and other edge bytes (U+2028/9, U+FFFE, surrogates and overlong forms as UTF-8, a lone continuation byte, a cut BOM)
inside keys and values, at their start, their end or anywhere; without the fix the file fails. After the fix and
again after the CPU fix: 1,000,000 bodies from the file's generator and 1,000,000 from the review's own, each on a
fresh seed, against main's `userOf`, 0 differ (38,930 routed, 11,760 with a BOM in the id). The other decodes were
audited: `packed-text.ts` already decodes with `ignoreBOM` (D1913's review), and cache.ts's JSON decodes start at
`{`.

**Padded and many-keyed bodies (CPU).** The review measured bodies with many top-level keys and bodies past the
values bound at 2.1-4.5x main. Two causes. An escaped top-level key was decoded and parsed (`stringAt`) to compare
it with `userId`; it is now compared in place, a character or `\uXXXX` at a time (`escapedIsUser`). And on a body
refused by the values bound, main's `bodyShapeUnder` byte loop reaches the bound about four times faster than the
grammar scan; bodies without escapes (8 MB of `"a":1,`, of digits, of short strings, of small objects) were all this
case. A first fix ran `bodyShapeUnder` before the scan on every body past 1,010,000 bytes; within the bound that made
dense bodies pay the check on top of the scan, and handing them to main's parse instead lost every dense body's gain.
The kept fix asks every 16,384 values whether the body, at the density read so far, would hold more than an eighth of
the bound, and if so runs `bodyShapeUnder` once (`padded`): a padded body is refused at about main's cost, a dense one
within the bound pays the check plus the scan against main's check plus parse, and items and events (a value every
few hundred bytes or more, under 126 KB never) pay nothing. The scan keeps its own bounds check, so the routing does
not depend on `padded`.

CPU per body shape, each in its own process (interleaved, 9-15 rounds, medians; main's shape check and parse run
twice, the second as the control; another agent's benchmarks shared the machine, so the control is the noise band).
Main in ms (µs where marked); the other columns are ratios of medians to it:

| Body                                         |         Main |   Control | Before (2f0fbbb38) |      After |
| -------------------------------------------- | -----------: | --------: | -----------------: | ---------: |
| 8 MB of `"a":1,` (past the bound)            | 12.39, 18.17 | 0.92-0.96 |         2.03-2.06x | 0.82-1.05x |
| 2 MB of `"a":1,`                             |        22.94 |      0.81 |              0.46x |      0.85x |
| digits, one past the bound (2 MB)            |   4.46, 4.67 | 1.01-1.33 |         2.28-2.48x | 1.04-1.14x |
| 8 MB of digits (past the bound)              |   4.92, 5.57 | 0.80-1.17 |         3.04-3.33x | 0.90-0.97x |
| 8 MB of `,"\u0061":1` (escaped keys)         |        69.22 |      1.25 |              3.44x |      0.66x |
| 8 MB of `,"\u0075serId":"v"`                 |        50.52 |      1.12 |              2.84x |      0.75x |
| 8 MB of short strings (past the bound)       |   5.84, 8.06 | 0.93-1.30 |         1.55-2.24x | 1.06-1.19x |
| 8 MB of small objects (past the bound)       | 20.95, 25.54 | 0.77-1.00 |         1.06-1.32x | 0.59-0.66x |
| 3.9 MB of short strings (within)             |        27.47 |      1.07 |              0.31x |      0.96x |
| 5 MB of small objects (within)               |        30.22 |      1.24 |              0.70x |      0.92x |
| 8 MB of `"userId":"v",` (within)             |        46.03 |      1.21 |              0.48x |      0.85x |
| 6 MB string, then digits past the bound      |   5.09, 6.44 | 0.96-0.97 |         2.19-3.34x | 1.33-1.79x |
| 7 MB of 70-byte strings, then digits past it |  9.54, 10.91 | 1.14-1.37 |         1.73-2.44x | 1.41-1.51x |
| 8 MB string                                  |        12.02 |      0.95 |              0.21x |      0.19x |
| event (µs)                                   |         0.65 |      0.75 |              0.80x |      0.75x |
| items, tool text, 190 KB (µs)                |          534 |      0.91 |              0.57x |      0.61x |
| items, prose, 190 KB (µs)                    |          228 |      1.27 |              0.46x |      0.44x |

Two figures in a cell are two runs (9 and 15 rounds). Every shape main refused or parsed is now at or under main
within the control's band but the last crafted two: padding that stays under the projection until late (a long
string or sparse values first, then the bound's worth of digits) is scanned up to the checkpoint that sees it, 1.3-1.8x
main's refusal, about 2-5 ms more on 8 MB. `--hop` on the final tree (9 rounds): event 1.07x, 12 and 193 KB of tool
text 1.53x and 1.55x, 11 and 181 KB of prose 2.15x and 2.00x.

**A bad tag in a warm blob (D1926).** `packedFrom` indexed `TEXT[tag]` unchecked, so a tag outside 0-3 from a thawed
blob threw a TypeError inside the thaw; for a user read from disk every request then threw (the user stayed frozen).
`packedFrom` refuses such a tag with a RangeError, and `ItemCache` drops a user read from disk whose thaw throws, with
their file (`freezes.discarded`), as `EncryptedFrozenDisk` discards a blob that does not open; the user starts over.
`persist.test.ts` writes a warm blob with tag 7 through the encrypted store and reads it back: nothing found, no
throw, the file gone, a later put served; `packed-text.test.ts` checks the RangeError.

**Memory (the review's measurements, not re-run here).** Peak RSS over a compact thaw paired 1.036 (1.012-1.058;
controls 0.997, 0.993) and live RSS +1-5%: costs of zstd, inside the rule (which bounded live heap, +3%). The backfill
storm's +11% above did not reproduce there (paired 1.030, inside the ±20% band its controls showed).

## Per-object and per-request memos in the rule paths (D1920; engine memo)

Decision: D1920. A profiling survey of main 4559e0634 (`bun --cpu-prof --cpu-prof-interval=500
packages/engine/bench/pipeline.bench.ts`) named five places in `@eden/engine` that redo per item, or per name, work
whose inputs had not changed; this round removes that work with every output unchanged. No model call and no paid call
was made. Every number below comes from a command run in this session on the shared 4-core VM with other agents'
benchmarks beside it (load average 1.9 to 5.8 over the session), so each A/B carries a self-against-self control.

### Method

- **Profiles**: one 500 µs profile of the pipeline bench before and after, summed by function (self and inclusive,
  and by callee under a frame; a scratch script over the `.cpuprofile`, not kept). Shares from one profile move by a
  few tenths of a percent between runs; they locate cost, the A/B sizes it.
- **A/B**: three arms in separate processes, interleaved and slot-balanced (round k starts at arm k mod 3, so each
  arm takes each slot equally often): main's `src/` and `bench/` (A), a second copy of main (A', the control), the
  branch (B). The bench process's CPU time (`resourceUsage().cpuTime`, every thread, its children included) beside the
  bench's own figures; medians, and the paired median of each arm over A in the same round, with its range. Two GC
  conditions: the natural collector ("no GC") and a preload forcing `Bun.gc(true)` every 100 ms ("forced GC"), which
  takes allocation-driven collection timing out of the comparison and adds its own noise.
- **Oracles**: `opt-round3.test.ts` fuzzes each rewrite against the code it replaced (the old function itself where it
  stays, `mentions` and `settled`; a verbatim copy in the test for `namesEntity`; the old expressions for the line
  readers; fresh copies of the items for the memos) on items with surrogate pairs (letters past the BMP and emoji),
  combining marks, `İ`, regex metacharacters and odd spacing in entities, packed and plain, plain ones edited in place
  between reads. Twelve mutations of the new code each fail it; a thirteenth is equivalent (below).
- **Behaviour gates**: `bun run eval` and the funnel against a fresh main run (end of this note).

### Changes

| Item | Before | Change |
|---|---|---|
| `settled(item)` (probes.ts), from `confident`, the fallback and the candidate dump | 2.17% inclusive; a pattern over title and text per candidate per path, `new RegExp(SETTLED.source, "gi")` each call | `settledOf` on the item's `READINGS` entry (re-read when a plain item's text or title changes in place); the global copy built once: 0.26% |
| `anchorsOf` in `foldEchoes` (fold.ts) | 1.69% inclusive (`foldEchoes` 2.55%) | the anchors kept on the `OWN` entry beside the own text, under the same key check: `anchorsOf` 0.08%, `foldEchoes` 0.97% |
| `mentions(name, item)` (probes.ts), six call sites in partner.ts | 2.40% inclusive, `cleanEntities` per candidate in `about` | `mentionsAny(words, item)` builds the item's text once a call by a code-unit pass (`mentionText`, the regex for a surrogate); the names cleaned and split once a cue (`CUE_NAMES`); the candidate dump's two identical tests read once: 0.86% |
| `noteShown`, `renderedCount`, `shownText` (partner.ts, render.ts) | 2.34% + 0.11%; three splits of the same text in `build`, a `u`-flag regex per line | one split (`itemLinesOf`, `shownTextOfLines`); a line's words through `wordsIn`: 2.17% (the rest is the session's `Set` of shown words, which must stay) |
| `namesEntity` (settle.ts) | 1.80% inclusive; a pattern per entity per candidate and the candidate's spacing rewritten | patterns built once per `Anchors` (`ENTITY_TESTS`), compiled on first need as before; the text tested lowercased as written, each space of an entity read as `\s+`; the text read only when a participant test leaves an entity to look for |
| `mentionsOf` (partner.ts), on ingest | `extractTypedEntities` read every capitalised run, then kept 20 | `persistableCap`: the run loop stops once 20 `PERSISTABLE_KINDS` are found; see the ingest A/B below |

Alone on the pipeline workload's items (886 items found by its people, 1 KB average; 2 rounds, a scratch script, not
kept): `namesEntity` for 200 two-entity requests × 40 items, 148-155 → 36-42 ms (about 18.9 → 4.9 µs a call);
two names' mention test, `names.some(mentions)` 197-214 → `mentionsAny` 111-139 ms (about 25.6 → 15.6 µs a call).

Why `namesEntity`'s spacing rewrite is exact: the old test matched the entity's words (spacing made one space, trimmed)
against the text with each run of `\s` made one space. Outside spacing the two texts are the same characters, a run
of spacing in the text maps to one space, and the entity's words hold no spacing but single spaces, so `\s+` where a
space was matches exactly where the space matched; the boundary lookarounds read a letter or digit, which no spacing
is. `İ`'s lowercase (`i̇`, two code units) is lowercased the same way in both.

Why the cap is exact: entities enter a `Map` by first insertion, names last of every kind; once 20 persistable
entities are in it, every later insertion lands after them, and `mentionsOf` keeps only the first 20 of those kinds.

### Measured

pipeline.bench (6,000 items, 2,000 events, 300 asks), 14 rounds each:

| Condition | Arm | process CPU ms (median) | paired / A | ask p50 µs | paired | observe p50 µs | paired | total ms | paired |
|---|---|---|---|---|---|---|---|---|---|
| no GC | A main | 4,398 | 1 | 2,161 | 1 | 121.9 | 1 | 2,430 | 1 |
| no GC | A' main (control) | 4,528 | 1.005 (0.85-1.10) | 2,167 | 0.996 (0.85-1.28) | 121.9 | 0.989 | 2,448 | 0.999 |
| no GC | B branch | 4,247 | **0.943** (0.83-1.03) | 2,005 | **0.941** (0.82-1.16) | 121.1 | 1.001 | 2,320 | **0.933** (0.81-1.02) |
| forced GC | A main | 8,523 | 1 | 2,494 | 1 | 127.6 | 1 | 4,250 | 1 |
| forced GC | A' main (control) | 8,332 | 0.981 (0.81-1.17) | 2,268 | 0.935 (0.82-1.21) | 129.7 | 1.008 | 4,368 | 1.020 |
| forced GC | B branch | 7,959 | 0.964 (0.73-1.07) | 2,228 | 0.905 (0.77-1.10) | 129.4 | 1.019 | 4,096 | 0.972 |

Without forced GC the branch saves about 6% of the bench's CPU and of the ask's p50 against a control at 1.00; the
observe fast path does not move (these paths run on the slow path and the ask). Forced collections every 100 ms
nearly double the CPU and widen the control's spread (its ask p50 read 0.935), so that condition only says the gain
does not come from collection timing: the branch reads ahead of the control there too, by less than its spread.

ingest.bench 40 × 500 shipped, items 1-5 only (none of them on the ingest path), 8 rounds each: no GC, CPU paired
0.954 (control 1.037), backfill 0.915 (control 0.972), sweep 1.151 (control 1.194); forced GC, CPU 1.001 (control
1.003): inside the control's spread, as expected for code ingest does not run.

The entity cap alone (`mentionsOf`; the branch with items 1-5 as A, a copy of it as A', the cap as B), ingest.bench
40 × 500 shipped:

| Condition | Arm | process CPU ms | paired / A | backfill µs/item | paired | CPU µs/item | paired | sweep µs/item | paired |
|---|---|---|---|---|---|---|---|---|---|
| no GC, 10 rounds | A | 6,388 | 1 | 197.3 | 1 | 251.2 | 1 | 45.6 | 1 |
| no GC | A' (control) | 6,444 | 1.027 (0.90-1.11) | 197.4 | 1.017 | 252.3 | 1.006 | 51.2 | 1.084 |
| no GC | B cap | 5,691 | **0.914** (0.78-1.01) | 166.1 | **0.855** (0.77-1.00) | 217.1 | **0.878** | 46.0 | 1.001 |
| forced GC, 8 rounds | A | 7,833 | 1 | 223.4 | 1 | 301.0 | 1 | 61.3 | 1 |
| forced GC | A' (control) | 7,800 | 0.983 (0.91-1.04) | 223.3 | 1.000 | 302.6 | 1.008 | 55.6 | 0.911 |
| forced GC | B cap | 7,133 | **0.909** (0.84-0.96) | 199.2 | **0.894** (0.82-0.98) | 269.9 | **0.910** | 55.3 | 0.923 |

The backfill reads every new item's mentions, and a 1.6 KB workload item holds more than 20 capitalised runs, so the
scan mostly stopped well before the text's end: about 30 µs an item saved, every forced-GC round faster. The sweep
re-lists unchanged items and records no mentions, so it does not move.

### Not changed

- A per-item memo of `mentions`' lowercased text: it would hold a copy of every touched item's text (`READINGS` holds
  none for a packed item, by design); building it once a call by a code-unit pass took most of the cost.
- `noteShown`'s own share: what is left is adding each shown word to the session's `Set`, which `askDedup` reads.
- `namesRequestDay` builds its day patterns per item too, but had no samples in either profile.
- The first loop's surrogate fallback in `mentionText` is equivalent to none: a high surrogate it meets starts a run
  whose next unit, the low surrogate, the run loop hands to the regex. It stays, mirroring `wordsIn`.

### Gates

On the final tree: `env -u OPENROUTER_API_KEY CHECK_COLD=1 FORMAT_COLD=1 bun run check` green; `bun run eval` (the
no-model eval, `packages/eval/src/cli.ts`) reads precision 0.65, recall 0.52, falseFireRate 0, acting packets on 19 of
28 neutral requests at 1.18 items, facts handed 10 of 11, look-alikes 3 of 10, as on main; `bun run funnel --jobs 4`
reads hidden 323/384 and decoys 294/384 on main (engine sources of origin/main, run in this session) and on the
branch, and `--baseline` against main's run reads hidden +0 −0, decoys +0 −0.
