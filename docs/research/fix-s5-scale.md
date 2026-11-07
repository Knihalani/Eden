# Fix S5: scale (RealUse-1 weak point 7)

Status: measured 2026-11-07 on branch `claude/fix-s5-scale` (base 97d381ee). Decisions D215 (shipped: the graph
memo emptied after each put) and D216 (rejected: the ingest worker, trial `ingestWorker`, built in commit b217ae1d
and deleted in the next). Plan: [realuse-1-weak-points.md](realuse-1-weak-points.md), issue 7; the evidence it
fixes: [realuse-1/E-speed-scale.md](realuse-1/E-speed-scale.md).

## What this says, in plain words

- **Ingest moved off the request thread works, but not enough to keep.** With the ingest worker (one Bun worker
  per process) each source page is redacted and read for the cache in the worker; the event loop only applies the
  result. The main thread's cost
  of a synced item fell from about 202 to 58 µs (3.5x; 161 to 50 µs on sim-world text). Under the concurrent bench's
  cold-start load the one-second event-loop stall is gone (worst stall 1,259 to 106 ms at 400 events/s) and
  `observe` p99 at 400 events/s fell from 489 to 29 ms. Inside a 100 ms p99 one process held 475 events/s of that load
  instead of 325 (1.46x). The stored state is the same, item for item (tests compare the vocabulary,
  index, graph, stored copies and mentions), and the eval and funnel were identical task by task.
- **It costs CPU, and the shipped wiring does not gain.** The worker reads what the main thread used to, plus the copy
  between threads: the whole process spends 1.19x the CPU per backfilled item (224 to 266 µs, workload). On
  router-sim's realistic connectors, with users already synced, one process held 922 events/s inside a 100 ms p99
  with the worker against 1,030 without, and four processes behind the router 5,001 against 5,151. The cold-start gain
  is 1.46x and the shipped-wiring change below 1x, short of this session's 1.5x bar, so the trial is deleted (D216);
  its code stays in commit b217ae1d for a deployment whose load is cold-start bursts.
- **Memory: one leak-like hold fixed, no 1.5x.** The graph's memo of sentences it had read kept the decoded text of the
  items it read them from alive between puts. Emptying it after every put cut a synced item from 2,636 to 2,399 B
  (1.10x, workload) and 2,524 to 2,074 B (1.22x, sim world), released; that changes no output and ships (D215).
  Nothing else found reached the bar: a synced user at 500 items is still about 1.9-2.0 MB held.

## Machine and method

| | |
|---|---|
| CPU | 4 vCPU, Intel Xeon @ 2.30 GHz (`nproc` 4), cloud container |
| Memory | 15 GiB |
| Kernel, runtime | Linux 6.18.44, Bun 1.4.4 |
| Load average before each run | 0.5-1.6 (recorded per run in `.local/s5/`) |

`BUN_OPTIONS` and `OPENROUTER_API_KEY` unset; one bench at a time; every bench three times, reported as **median
(min-max)**. "Base" is 97d381ee in a worktree; "after" is this branch with the trial off (D215 only); "ingest" is commit
b217ae1d with `ingestWorker` and one ingest worker (the trial's code, deleted after measuring). This machine is not
the E note's (2.30 against 2.10 GHz), so compare only within a table.

## 1. The ingest worker (D216, trial `ingestWorker`, rejected)

### Design (as built in b217ae1d)

`ingest.ts` is a `WorkerPool` task module (D25's pool; one worker per process). The partner's fan-out gate hook
(`pooledIngest`) sends each page a source returned, a lookup's results or a sync listing, to the worker in chunks of
16 items. The worker redacts each item first (`sanitizeItem`: D10, nothing else of the raw item is read) and then reads
the redacted copy as `ItemCache.put` would: its terms with their hash lanes (tokenized into a scratch vocabulary), its
graph reading (`extract`, with a memo for the chunk only), its entity mentions (`mentionsOf`) and its deflated text
(`packedBytes`). A chunk comes back as a few flat values (`PreparedChunk`: one string of distinct terms with a lane
array, one string of other strings, one Int32Array of per-item records): cloning the readings as objects cost 34.5 µs
an item, about half of it on the receiving thread (scratch measurement), and the flat form cut the main thread's cost
of an item from 74.5 to about 60 µs.

The event loop attaches each item's view of its chunk in a WeakMap (`prepared.ts`) and the cache takes it once in
`put`: it interns the item's distinct terms in their order of first occurrence, title then body, with the worker's
lanes (so the user's vocabulary hands out the ids tokenizing would), indexes, places the graph reading
(`UserGraph.addExtracted`), wraps the deflated bytes and notes the mentions for `recordMentions`. A graph reading of
an item that binds a date resolved "today" and the nearest year at the worker's clock, so it is used only when `put`
runs at the same `now`; otherwise the item is read again on the loop. Pages under 2,000 characters are redacted on the
loop (about one item: the round trip costs what the work does), a full pool redacts on the loop with no reading, and a
chunk that fails (past the 5 s deadline, a crashed worker, an abort) fails its page closed, as the gate pool does
(D26). Workers keep no state between chunks.

What stays on the loop: the reuse hash of listed items (`rawHash`, about 10 µs an item), the source map's mention
upserts (SQLite), the per-user tallies (`partiesOf`), interning, indexing and placing the graph reading.

### `ingest.bench.ts` (200 users x 500 items, shipped mode)

`bun packages/engine/bench/ingest.bench.ts [--world] [--ingest] 200 500 shipped`. Backfill is wall time per item;
"CPU" is the whole process (every thread), "main" the main thread alone (`bench/thread-cpu.ts`, from
`/proc/self/task/<pid>/stat`). Base has no CPU columns (it predates them).

| Text, arm | Backfill µs/item | CPU µs/item | Main thread µs/item | Held B/item | Released B/item |
|---|---|---|---|---|---|
| workload, base | 200 (199-201) | | | 4,015 (4,015-4,017) | 2,636 (2,636-2,636) |
| workload, after | 203 (200-210) | 224 (218-230) | 202 (198-208) | 3,781 (3,781-3,782) | 2,399 (2,399-2,399) |
| workload, ingest | 194 (191-205) | 266 (266-285) | **57.6 (54.9-60.8)** | 3,914 (3,914-3,915) | 2,388 (2,387-2,388) |
| world, base | 161 (150-165) | | | 4,192 (4,189-4,198) | 2,524 (2,524-2,533) |
| world, after | 162 (158-168) | 180 (177-188) | 161 (157-167) | 3,916 (3,916-3,916) | 2,074 (2,074-2,075) |
| world, ingest | 162 (161-183) | 228 (227-257) | **50.1 (49.8-54.6)** | 4,084 (4,084-4,085) | 2,065 (2,065-2,066) |

The bench's backfill awaits one sync tick after another, so the worker's time and the loop's add up and the wall time
does not move; what moves is the main thread's share. "Held" is higher with the worker because the readings of a page
in flight are alive when the heap is read; released, it is the same.

### `concurrent.bench.ts` (200 users, sources 50-250 ms, open loop, 8 s)

`bun packages/engine/bench/concurrent.bench.ts [--ingest] <rate>`; lag max is the longest event-loop stall.

| Events/s, arm | `observe` p50 ms | `observe` p99 ms | Lag max ms | Process CPU |
|---|---|---|---|---|
| 200, after | 0.65 (0.52-1.65) | 17.9 (15.6-22.5) | 893 (850-1,032) | 75% (73-80) |
| 200, ingest | 0.14 (0.14-0.17) | 6.3 (4.7-6.9) | 40 (38-42) | 79% (78-86) |
| 300, after | 0.95 (0.80-1.53) | 30.0 (22.6-86.0) | 1,213 (1,088-1,410) | 84% (82-87) |
| 300, ingest | 0.12 (0.10-0.12) | 4.8 (4.5-12.1) | 40 (37-54) | 85% (84-99) |
| 400, after | 1.16 (1.16-1.42) | 489 (438-520) | 1,259 (1,097-1,462) | 87% (87-89) |
| 400, ingest | 0.11 (0.11-0.12) | **28.8 (14.7-64.2)** | 106 (84-144) | 99% (95-106) |
| 500, after | 3.49 (1.90-4.21) | 644 (609-703) | 1,917 (1,501-1,918) | 97% (93-98) |
| 500, ingest | 0.11 (0.09-0.12) | 107 (86-241) | 190 (189-289) | 100% (95-114) |
| 600, after | 6.33 (5.55-11.1) | 697 (541-729) | 1,813 (1,565-1,834) | 111% (108-118) |
| 600, ingest | 0.12 (0.11-0.13) | 381 (325-666) | 487 (420-786) | 123% (120-129) |
| 800, after | 17.2 (15.0-29.8) | 652 (644-673) | 1,846 (1,537-1,983) | 120% (119-123) |
| 800, ingest | 0.30 (0.22-0.33) | 719 (591-1,038) | 1,025 (718-1,386) | 163% (162-166) |

On these steps the loop holds 300 inside a 100 ms p99 and the worker 400 (500 is just past the line at 107 ms). A finer
ladder, three runs each (`.local/s5/concurrent-3.txt`):

| Events/s, arm | `observe` p50 ms | `observe` p99 ms | Lag max ms | Process CPU |
|---|---|---|---|---|
| 325, after | 0.60 (0.30-2.37) | 92.0 (64.2-518) | 1,103 (1,019-1,157) | 83% (82-91) |
| 350, after | 1.57 (1.57-1.61) | 464 (445-482) | 1,179 (1,179-1,347) | 92% (89-92) |
| 375, after | 1.61 (1.22-2.12) | 467 (453-519) | 1,180 (1,066-1,404) | 87% (83-88) |
| 450, ingest | 0.10 (0.09-0.12) | 82.1 (22.9-106) | 153 (75-196) | 97% (95-110) |
| 475, ingest | 0.11 (0.11-0.12) | 84.4 (71.3-161) | 149 (141-245) | 111% (108-116) |

So one process holds 325 events/s on the loop and 475 with the worker inside a 100 ms p99 (medians): **1.46x**. The
decisions per run differ between runs of either arm (open-loop timing decides
whether a user's cache is warm when its next event lands), so quality is judged on the eval and funnel below.

### `pipeline.bench.ts` (one stream, instant sources)

`bun packages/engine/bench/pipeline.bench.ts [--ingest]`.

| Arm | `observe` p50 µs | `observe` p99 µs | slow path p99 µs | wall ms/event |
|---|---|---|---|---|
| base | 125 (122-134) | 3,536 (3,110-3,830) | 1,787 (1,624-2,249) | 0.765 (0.742-0.836) |
| after | 105 (104-122) | 2,992 (2,789-3,082) | 1,510 (1,438-2,087) | 0.685 (0.653-0.809) |
| ingest | 105 (100-122) | 3,009 (2,696-3,419) | 1,954 (1,900-1,986) | 0.696 (0.645-0.758) |

No p50 regression. The lookups here return a few small items, mostly under the 2,000-character inline line.

### `router-sim.bench.ts` (realistic connectors, sync on, 400 users, 4 children)

`bun packages/sim/src/lab/router-sim.bench.ts --children 4 --seconds 5 --reps 3 --profile realistic`, with
`ROUTER_SIM_INGEST=1` for the worker arm (every server process started one ingest worker; b217ae1d's wiring). Both
arms on this branch (D215 in both). Events/s at p99 ≤ 100 ms, median (min-max) of 3 repetitions per arm; RSS per
process at the end of the arm, median.

| Arm | One process | Router over 1 | Router over 4 | Ratio 4/1 median (lowest) | RSS end, one process / child |
|---|---|---|---|---|---|
| worker off | 1,030 (916-1,121) | 1,063 (1,008-1,137) | 5,151 (4,593-5,226) | 5.00 (4.66) | 1,811 / 1,138 MB |
| worker on | 922 (867-1,041) | 908 (877-955) | 5,001 (4,693-5,157) | 5.42 (4.51) | 1,794 / 1,151 MB |

Here the users are synced during the 75 s settle, so the ladder's steps are mostly fast-path events and on-demand
polls of small pages: little of the loop's work is the ingest the worker takes, and the round trip and the second
thread's CPU are paid on every page over 2,000 characters. Both arms meet D172.

## 2. Memory per item (D215)

The heap breakdown (a JSC heap snapshot of a shipped cache after a backfill, and per-structure subtraction, scratch
scripts, 20 users x 500 items, workload): index and doc table 454 B/item, vocabulary and sketcher 114 (306 on sim
text), stored items 967 (deflated bytes 640 on average; 31% of workload items stay plain, short or not compressing),
entries and the per-user `Map` 237, the graph about 745, of which the memo held 236 (308 on sim text).

The memo (`Memo`, up to 256 sentences and 256 people per user) is a cache of `parseSentence`/`parsePerson` results.
Its keys and values are substrings of the item text it read, and a JSC substring keeps its whole base string alive:
the decoded head of every item it had read. Copies that share no storage (`String.fromCharCode` of the codes; a
concatenation then a slice still shares) cut that to about 200 B an item, the memo's own size. Emptying it after each
put instead (`UserGraph.rest`) costs no time: emptied every 100 adds the graph's add ran at 52-59 against 51-56 µs an
item kept (workload) and 35-36 against 35-39 (sim world).

| Bench | Base | After |
|---|---|---|
| `ingest.bench.ts` workload, shipped, held / released B/item | 4,015 / 2,636 | 3,781 / 2,399 (1.06x / 1.10x) |
| `ingest.bench.ts --world`, shipped, held / released B/item | 4,192 / 2,524 | 3,916 / 2,074 (1.07x / 1.22x) |
| `index-memory.bench.ts`, `ItemCache` 1 user x 6,892 after an expiry tick | 1,631 (1,631-1,633) | 1,635 (1,634-1,635) |

Not done, with why: deflated bytes held as a one-byte string (saves a typed array's object, about 30-40 B an item);
a struct-of-arrays entry table instead of `Entry` objects in a `Map` (about 130 of 237 B, a rewrite of most of
`cache.ts`); graph labels interned across users (they are already copied once per user into the graph's arena, D169,
and users' mailboxes share few names). "No raw copy after redaction" holds already: the cache keeps a 53-bit hash
of the raw item (`Entry.raw`), not the item.

### Users per machine (arithmetic, as the E note's section 6)

Heap per synced user at 500 items, `ingest.bench.ts` shipped, held (sources' raw items alive, as the E note quotes):
2.01 to 1.89 MB (workload) and 2.10 to 1.96 MB (sim world); released (the cache's own): 1.32 to 1.20 and 1.26 to
1.04 MB. The E note sizes machines by RSS per user (router-sim: 1.45-2.1 MB, plus 385-400 MB fixed per process).
**Assuming** RSS per user falls in proportion to held heap (0.942 workload, 0.934 world; not measured), its 4-core
16 GB figure becomes (12,288 − 4 × 400) / (2.1 × 0.942) ≈ 5,400 to (12,288 − 4 × 385) / (1.45 × 0.934) ≈ 7,900
users: **5,400-7,900, from 5,100-7,400** (about 1.06x). This session's router-sim (D215 in, worker off) fits 2.16 MB
per user and about 445 MB fixed per process ((1,310 − 661) / 300 users, growth medians), which would give about
4,900; it read RSS without a forced GC on another machine, and the base tree was not run there, so it neither
confirms nor refutes the 1.06x. Memory still binds before CPU; the next real lever is the per-item object overhead
(entries, the per-user `Map`, the item objects: about 550 B of a synced item), which needs a struct-of-arrays cache.

## 3. Quality

| Screen | Base (97d381ee) | After (D215) | Worker (b217ae1d, `ingestWorker` on) |
|---|---|---|---|
| `bun run eval` | precision 0.8276, recall 0.48, falseFireRate 0 | identical, every field but timings | identical, every field but timings |

In the eval, `plannedLookups` also moves with timing between runs of one tree (121 or 122 in the reviewer's four
runs of this branch); the three recorded runs above all read 122.
| `bun run funnel --jobs 4` (train, replayed cards and intent, stub reader) | hidden delivered 98/384, decoys 72/384 | `--baseline` base: hidden +0 −0, decoys +0 −0 | `--baseline` base: hidden +0 −0, decoys +0 −0 |

No paid call was made in this session.

## Reproduce

The worker arms (`--ingest`, `ROUTER_SIM_INGEST=1`, `{"ingestWorker":true}`) need commit b217ae1d checked out; the
rest run on this branch, and "base" on 97d381ee.

```bash
unset BUN_OPTIONS OPENROUTER_API_KEY
bun packages/engine/bench/ingest.bench.ts [--world] [--ingest] 200 500 shipped
bun packages/engine/bench/concurrent.bench.ts [--ingest] 400        # also 200, 300, 500, 600, 800
bun packages/engine/bench/pipeline.bench.ts [--ingest]
bun packages/engine/bench/index-memory.bench.ts
bun packages/sim/src/lab/router-sim.bench.ts --children 4 --seconds 5 --reps 3 --profile realistic
ROUTER_SIM_INGEST=1 bun packages/sim/src/lab/router-sim.bench.ts --children 4 --seconds 5 --reps 3 --profile realistic
bun run eval; bun run eval --config '{"ingestWorker":true}'
bun run funnel --jobs 4 [--set '{"ingestWorker":true}'] -- --json F; bun run funnel --jobs 4 --baseline F ...
```
