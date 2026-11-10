# O2: what it would take to hold 20,000 users on a 4-core 16 GB box (a plan, not built)

Status: a sized plan written 2026-11-10 from this session's measurements (o2-users-per-box.md, D651-D654). Nothing
here is built. No decision number: it proposes work; it adopts nothing. Paid spend: $0.

## In plain words

- The target is about 0.59 MB of resident memory a user (11,727 MB usable / 20,000). Today a user is 3.39 MB when a
  quarter are active and 1.46 MB when a twentieth are (D651).
- Two numbers decide it: how big a live user is (6.3 MB resident after a thaw) and what share of users are live at
  once. Frozen users are already small (0.62 MB; 0.35 MB when their blob is on disk only, D652, off).
- No single change gives ten times. The arithmetic below says 20,000 needs **both** a live user about three times
  smaller **and** an active share near a twentieth. The first is engineering (about a week, real risk); the second
  is a fact about users nobody has measured, plus a setting (freeze sooner than 20-30 minutes).

## 1. The budget, per item, measured

A live user at the 3,000-item cap, sim world text (about 1,100 characters an item):

| Part | Bytes an item | Source |
| --- | --- | --- |
| Whole live user (heap) | 1,670-1,870 | `users.bench.ts` (5.0-5.35 MB a user) |
| Item text, deflated one by one | 453 | `.local` codec run, 4,969 texts (D654) |
| Search index (packed CSR and delta) | 415 at 6,892 items, about 800 at 2,000 | `index-memory.bench.ts` |
| The rest: entry and item objects, ids, sketches, tallies, vocabulary | about 500-700 | by difference |
| The same user frozen (one zstd JSON blob) | 101 (sim text; A14 estimates about 1.27x less gain on real prose) | `users.bench.ts` |

Resident memory is 1.4x the heap after a thaw (6.33 against 4.52 MB) and more after an ingest burst.

## 2. What was screened and does not get there

- Frozen users on disk only: 1.06-1.2x on a fleet (D652).
- Leaving text in the frozen blob for a live user (read an item's text only when it is delivered): text is 453 of
  about 1,700 bytes an item, so at best 1.35x on a live user. Not built.
- A faster codec or a deferred pack at the thaw: 1.4-2x on the thaw's wait, nothing on memory (D654).
- Bun's `--smol`: nothing (D651).

## 3. The redesign that could: one compact form that is both frozen and searchable

Today a user has two forms: live (objects, an index, packed text) and frozen (a JSON blob that must be parsed,
re-packed and re-indexed: 145 ms). The proposal is one immutable **segment** per user that is searched as it lies,
plus a small live part for what arrived since:

- **Postings** as delta-coded varints in one byte array, a block index per term. Estimate 200-300 bytes an item
  against 415-800: the packed index already stores postings in typed arrays; this compresses them and drops the
  per-term arrays.
- **Entries as columns** (fetch time, read mark, sequence, flags, raw hash, sketch) in typed arrays, ids in one
  `IdSet`: about 40-60 bytes an item against several hundred as objects.
- **Text in zstd blocks** of 16-32 items, inflated per block on delivery, with a small memo: 150-300 bytes an item
  against 453.
- **A live delta** for new and changed items in today's structures, merged into the segment at the freeze tick.

Estimate: 500-700 bytes an item, so a live user of 1.5-2.1 MB heap against 5.0-5.35 MB, about 2.5-3x. The thaw
becomes "map the segment": no parse of 3,000 items, no re-pack, no re-index; the 145 ms should fall under 15 ms,
and with it the cost of freezing sooner.

What it risks:

- **Exact answers.** Ranking must not move: BM25F with field weights, ties in insertion order, the same top-k.
  `sparse-index-packed.test.ts` and `cache-freeze.test.ts` are the oracles; the funnel (314/384, 274/384) and the
  eval (0.65/0.52/0) must read the same.
- **Search time.** Decoding varints costs CPU where memory is saved; `index-memory.bench.ts` reads 37-125 µs a
  search today. A budget of 2x is affordable (CPU has 3-25x headroom, A14), more is not.
- **Churn.** Removes and updates against an immutable segment need tombstones and a merge policy (D120 has one for
  the index).
- **Size of the change.** `cache.ts` (2,000 lines), `packed-text.ts`, `persist.ts` (a new format), the sparse index
  in primitives (its benchmark re-run, per its README). About a week with tests.

Cheap screens before any of it, an hour or two each: (1) encode one user's postings as varints and measure bytes
an item and search time against the packed index, in `index-memory.bench.ts`; (2) lay 3,000 entries out as
columns and measure heap; (3) zstd text in blocks of 16 and 32: bytes an item and the time to read one item. If
(1) is not under 300 bytes at under 2x the search time, stop.

## 4. What the fleet then reads

Resident memory a user = active share x live + (1 - active share) x frozen. Live after the redesign taken as 2.5 MB
(heap 1.8 MB x the 1.4 measured today); frozen 0.62 MB, or 0.35 MB on disk only. Users on the box = 11,727 MB / that.
These are arithmetic on measured pieces, not runs; the mixed runs of D651 read about 1.4x higher than their pieces.

| Active share | Today, measured | Redesign, frozen in memory | Redesign, frozen on disk only |
| --- | --- | --- | --- |
| 1/4 | 3.39 MB: ~3,460 | 1.09 MB: ~10,800 | 0.89 MB: ~13,200 |
| 1/8 | 2.36 MB: ~4,970 | 0.86 MB: ~13,700 | 0.62 MB: ~18,900 |
| 1/20 | 1.46 MB: ~8,030 | 0.71 MB: ~16,400 | 0.46 MB: ~25,600 |

So 20,000 is reachable only with the redesign, an active share of about a tenth or less, and frozen users' blobs
off the heap (which is D652, and the owner's call).

## 5. The active share

A user is live for 20-30 minutes after their last event (`freezeIdleMs` 30 minutes, ticks of 10). Freezing after
5 minutes would cut the share by whatever part of sessions are followed by a pause longer than that; it costs one
thaw for each return after 5-30 minutes. At 145 ms a thaw that is noticeable; at under 15 ms it is not. What share
of users are active is not known: A14's quarter is a convention. A pilot's `EDEN_TRACE=1` log has the event times to
compute it (`bun run trace-report`); that number should be read before the redesign is paid for.
