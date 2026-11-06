# Graph storage as struct-of-arrays (D169, stage 1)

Status: **gate passed** (2026-11-06, package `graph-soa`, finding `scale-graph-soa-and-compact-text`). No behaviour
change: the knowledge graph (`packages/engine/src/kg.ts`, `UserGraph`) stores the same nodes, items and links in a
different layout, and every walk returns exactly what it returned before. Stage 2 (deflated `item.text`) is not part
of this note: it reopens D111 and waits for a trial (D169).

## What changed

Before, each node was a `GNode` object (two `Int32Array`s for its items and links, a key string, a label string and
counters), found through a `Map` from key to id; each item had an `Int32Array` of what it placed, found through a
`Map` from item id to slot. A verifier's heap breakdown put the graph at about 1,750 B/item: node objects and arrays
428, key and label strings 451, the two Maps 502, the sentence/people memo 215, `placedAt` 110.

Now (`kg.ts`, from "The graph's storage is struct-of-arrays"):

- **Typed columns per node id** (state, kind, white-space-in-label, items and links offset/used/held, refs, key
  offset/length/hash, label offset/length), grown by half rather than doubled.
- **Open addressing (`Table`)** from key to node id and from item id to slot: an `Int32Array` of ids, linear probing,
  backward-shift deletion, at most half full and halved when an eighth full. It replaces both Maps.
- **Shared arenas (`Arena`)** for node items, node links and what each item placed: blocks appended to one typed array;
  a block given back is counted, and the blocks in use are copied to a new array when the array is full or more than
  four times what is in use. Block sizes follow the old per-node arrays (from 4, doubled when full, halved when a
  quarter used past 8).
- **Keys and labels as UTF-16 code units in a character arena**, copied when the node is interned (so no label keeps
  the item text it was sliced from alive). A label that is its key past the two-character prefix (every kind but a
  name, and an organisation named by its domain) is not stored again.

Unchanged: `extract`, the memo, `long`, the learned weights, the walk's arithmetic and visiting order, id and slot reuse
(a stack of freed ids, then the next new one), the `maxIds` and `MAX_INDEX` bounds. One test outside the package's
files changed: `kg-store.test.ts` read the private `nodeAt.length` (ids handed out); it now reads `top`, the same count.

## Measurements

All on this box (4 cores, shared with other agents, Bun 1.4.4), 2026-11-06. "Before" is `audit/2026-11-06-integration`
(46285584e) with its `kg.ts`; "after" is this branch. Each bench mode runs in its own process.

### `bun packages/engine/bench/ingest.bench.ts` (full, 200 users × 500 items, workload text, avg 1,599 chars)

| | `+graph` held | `+graph` released | `+graph` backfill | graph mode released | shipped released |
|---|---|---|---|---|---|
| before | 1,668 B/item | 1,703 B/item | 70.1 µs/item | 4,460 B/item | 4,454 B/item |
| after | 716 B/item | 719 B/item | 72.2 µs/item | 3,465 B/item | 3,458 B/item |
| after, final commit | 716 B/item | 719 B/item | 70.0 µs/item | 3,465 B/item | 3,459 B/item |
| ratio | 2.33x smaller | **2.37x smaller** | unchanged (70.0-72.2 against 70.1) | 1.29x | 1.29x |

Gate (D169): `+graph` released at least 2x smaller. 1,703 → 719 passes (the finding's 1,721 was the `--quick` figure).

### `--world` (new): 200 × 500 items of the sim world, `buildWorld` seed 1, noise scale 5

6,892 world items, 500 spread evenly over them per user, avg 1,091 chars; 30.4% of those 500 (29.6% of all 6,892) hold
characters past Latin-1. Two runs each:

| | `+graph` held | `+graph` released | `+graph` backfill |
|---|---|---|---|
| before, run 1 | 973 B/item | 952 B/item | 53.4 µs/item |
| before, run 2 | 953 B/item | 931 B/item | 52.5 µs/item |
| after, run 1 | 682 B/item | 508 B/item | 58.0 µs/item |
| after, run 2 | 704 B/item | 508 B/item | 53.0 µs/item |

About 1.8x smaller released and 1.4x held. The world's graph per item was already smaller than the workload's (fewer,
shorter names per item), so the fixed costs the new layout removes are a smaller share of it.

### Where the remaining bytes are (`--quick`-sized scratch script, 40 users × 500 workload items, `UserGraph` alone)

709 B/item after a full GC: memo 224 (bounded at 256 sentences and 256 people per user, so smaller per item at the
3,000-item cap), node columns 142 (1,395 slots for 1,089 ids), character arena 95, items arena 85, placed arena 79,
links arena about 1, tables and the rest about 80. 2.18 nodes per item, as before.

### Speed (scratch script: 3,000 sim-world items into one graph, 1,200 walks, 1,500 removes; two pairs per run)

Warm pairs over three runs: add 51.2-60.6 µs before, 51.4-55.3 after; walk 36.4-46.7 µs before, 40.3-43.8 after
(after hoisting the arena reads out of the walk's loops); remove 1.48-1.80 µs before, 1.52-1.85 after. The walk now
decodes each reached node's label from the arena once per walk; on this shared box the difference is within noise.

## Equivalence

- `kg.test.ts`, "UserGraph against the storage before D169": the old `UserGraph` kept verbatim as `PreviousGraph`. 200
  seeds of random adds, changed copies, removes and learning (60-140 steps over 10-90 item ids), with names in several
  scripts (Latin Extended, Greek, CJK, an astral letter, lone surrogates, case variants), crowds that fill nodes'
  links, and every eighth seed bounding node ids so copies are refused. Every 40 steps and at the end: `size`, `keys()`,
  `has` and `around` on a sample of keys, and 12 random walks (with parents, exclusions and floors) `toEqual` the old
  graph's. Then everything removed (size 0) and, every fourth seed, re-added and compared again. About 5 s.
- A 3,000-item graph churned to 50 and refilled: walks equal, and the arenas give back what they no longer hold (under
  a quarter of the peak words).
- A 200,000-character item: the character arena holds under 1,000 code units, and the walk's tie label is the name
  as written.
- `kg-store.test.ts` (the D58 reference graph, 3 seeds × 1,500 steps, bounds, memo) passes unchanged but for the one
  field read above.

Screens on the final commit (the funnel and eval re-run after the last code change):

- `bun run funnel --jobs 4 --baseline <before json>`: hidden +0 −0, decoys +0 −0 (train1–6, seeds 41–42; TOTAL hidden
  214/384, decoys 211/384; pool hidden 230/384, decoys 229/384, both runs).
- `bun run eval`: precision 0.8276, recall 0.48, falseFireRate 0, before and after. The JSON differs only in wall-clock
  latency and `plannedLookups` (121 or 122), which varies run to run on the old code too (5 runs: 121, 122, 121, 121,
  121). Latency, four runs each: p50 0.29-0.50 ms and p95 7.4-10.7 ms before, p50 0.31-0.63 ms and p95 7.7-12.3 ms
  after: overlapping, on a box shared with other agents.
- `bun run check`: 1,671 pass, 0 fail.
