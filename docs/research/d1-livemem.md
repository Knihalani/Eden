# D1: a heavy user's memory, live and frozen (D998)

2026-11-11, $0 (no model call). The question (the parent's, after D996): a live heavy user's footprint was about
9-10 MB of RSS at the 3,000-item cap, the largest share of a daily agent's peak hour. Where does it go, and which
structural changes cut it by a fifth without moving the eval, the funnel or the observe p99?

Pre-registered (03e01d2b, a34de2e6, d5e338b1, before each arm ran): `users.bench.ts 100 3000 --prose --sources=20`
in the 2-core 12 GB cgroup, two runs an arm back to back; ship if the "after thaw" RSS a user falls 20% or more, the
backfilled live line does not rise, `bun run eval` and the funnel are identical and the first event's p99 rises no
more than 10%; a lever alone worth 3% or more under the same identities is kept if the set misses 20%. Card levers
(state only a user with a model key holds) are judged on the same bench with `--cards` (a $0 stub maker,
`bench/stub-cards.ts`); freezing card state (C6) on the frozen line and the D996 peak-hour shape.

## 1. Where it goes (main, `live-heap.bench.ts`)

`bench/live-heap.bench.ts` builds users as `users.bench.ts` does, freezes and thaws them (`--thaw`), then walks each
user's state object by object (JSC's `estimateShallowMemoryUsageOf`, plus Map, Set and array slots, a typed array's
buffer once) and sums it by part; `--types` and `--snapshot` give JSC's own object counts and heap snapshot by class,
`--cards` adds the stub card maker. 12 users, 3,000 prose items over 20 sources, after a thaw, main:

| Part | MB a user | Bytes an item |
| --- | --- | --- |
| Item text, deflated (one `Uint8Array` an item) | 1.92 | 672 |
| Index (`SparseIndex`: postings, forward arena, per-term arrays) | 1.88 | 658 |
| Vocabulary (a string a term, 18,244 terms; hash table) | 0.63 | 219 |
| Sketcher (`TextSketcher`'s per-id memo, as long as the vocabulary) | 0.41 | 142 |
| Entry objects | 0.32 | 112 |
| Item objects (ids, titles, refs) | 0.26 | 89 |
| The items Map | 0.18 | 61 |
| Sync: ids, sketch, rare terms | 0.26 | 92 |
| **Walked / measured heap** | **5.95 / 7.83** | |

Measured on `users.bench.ts` (100 users): 7.23 MB of heap and 8.57 MB of RSS a user after a thaw, 11.31 MB of RSS
straight after the backfill; 5.62 MB of the heap is typed arrays' stores.

With a model key, card state is the largest part, and it was **never frozen**: a frozen user kept it live. With the
stub maker (a card and two requests an item) a user's heap was 10.98 MB after a thaw against 7.23 without, and a
frozen user's 6.71 MB against 2.97 (RSS 11.01 against 4.13). JSC's heap snapshot showed why the walk under-counted
it: a `Map` of thousands of entries costs 40-130 bytes an entry and a one-element `Set` 248 bytes (measured), and
the card state was six Maps keyed by content hash plus a `Set` a hash.

Ruled out: the vocabulary's terms pinning their source texts as substrings (they do not: dropping the terms freed
what the walk counted); the index's delta preallocation (it grows by doubling and a thaw starts it empty); the entry
objects' shape (112 bytes whatever the optional fields).

## 2. Levers

| Lever | What changed | Exact? |
| --- | --- | --- |
| L1 | `TextSketcher` holds nothing per term: a load hashes its terms again (from the vocabulary's arena, L2) | `dedup.reference.ts` oracle, output for output |
| L3 | A packed item's deflated text is held as a one-byte string, not a `Uint8Array` (two cells and a malloc'd store) | same items; the decode memo keyed per encoding |
| L2 | `Vocab` holds Latin-1 terms as bytes in one arena (`start`, `blen` an id), others in a Map; a process-wide memo of decoded terms keyed by vocabulary serial | same ids and terms (`vocab.test.ts`) |
| C1 | Card holders: an id alone until a hash has two items | same order |
| C4 | Intent index: one Map of records per hash, not three Maps | same docs, same finds |
| C5 | A card's sentence key on its record, not a second Map | same |
| C6 | Card state frozen with its user (one zstd JSON blob), thawed at its first read or write | twin test (`cards-freeze.test.ts`), mutations caught |

## 3. Results

TODO

## 4. Decision

TODO
