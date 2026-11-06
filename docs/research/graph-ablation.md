# The knowledge graph against its cost: a paid-reader ablation (stage 1) and a lighter read (stage 2)

Status: 2026-11-05. Stage 2 (D150, the section at the end) is done: the graph now reads 1,000 characters per item.
Deep audit 2026-11-05 round 2, work package `r2-graph-ablation` (findings
`devloop-ingest-bench-not-shipped-path` and `scale-graph-dominates-ingest`). Every number below comes from a command
run in this session on the integration branch (`audit/2026-11-05-integration`, 463f6fdfc, plus this change), on a
shared 4-core container with other agents running. Decisions: D141 in docs/DECISIONS.md (graph stays in the default;
deleting its code rejected) and D150 (stage 2 built with no switch: the graph reads 1,000 characters per item, which
closes the planned `graphLite` trial).

## In plain words

The knowledge graph (D58, cheaper since D107, in the default since D112) is built from every item Eden caches. It is
most of the cost of reading a user's sources in the background: with it, each synced item costs 3.6–3.8 times the
CPU and twice the memory of the item alone (half of the shipped path's 5.2–5.4x; recording mentions is most of the
rest). Every free ($0) screen showed no gain from it, so this round paid for the
one screen that could: the funnel on the six train suites with Eden's real reader (Haiku 5.5), with and without the
graph, plus a second paid run of the default to measure how much the reader alone moves the score between runs.

The graph earns a small, repeatable gain. Without it, the reader is never shown the planted fact on 5 tasks, and the
reader cited that fact on all 5 in both paid runs of the default. One task goes the other way, so the net effect is
4 more hidden facts surfaced with the graph, out of 384 (+1.0 point). It also surfaces 2 more decoys. The other
differences between the runs are the reader's own run-to-run noise, which is larger: two paid runs of the same
default differ on 8 hidden and 19 decoy tasks. In total over the whole suite, the change is within noise (hidden
247 vs 243, decoys 127 vs 129).

So the graph is not neutral and stays in the default for now (D112 removes a part only when it is measured neutral at
no extra paid cost). Its ingest cost is what needs to go: stage 2 is a cheaper graph that must keep those 5 tasks.

## What was measured

### 1. Ingest, the shipped path (`packages/engine/bench/ingest.bench.ts`)

The bench measured only the cache's own work: no graph and no `onStored` hook. It now runs three modes, each in its
own process: `core` (the old line), `graph` (`core` plus `ItemCache.enableGraph`), and `shipped` (a `ContextPartner`
on `DEFAULT_CONFIG` with no model deps, which is what the servers run with no key: the graph plus `onStored`'s mention
recording into an in-memory `SourceMap`). It prints µs per item for the backfill and the unchanged sweep, and heap
per item with the sources' raw items held and released.

`bun packages/engine/bench/ingest.bench.ts` (200 users × 500 synced items, average text 1,599 chars), two runs:

| Mode | Backfill µs/item | Sweep µs/item | Heap B/item, raw held | Heap B/item, raw released |
|---|---|---|---|---|
| core | 73.4 / 66.1 | 3.4 / 3.8 | 2,595 / 2,595 | 2,790 / 2,790 |
| graph | 265.1 / 248.3 | 5.8 / 5.5 | 5,217 / 5,236 | 5,480 / 5,480 |
| shipped | 380.6 / 357.6 | 4.6 / 6.1 | 5,237 / 5,230 | 5,483 / 5,482 |
| stage: + graph's add | 191.7 / 182.1 | 2.4 / 1.7 | 2,622 / 2,641 | 2,690 / 2,690 |
| stage: + `onStored` (mentions) | 115.4 / 109.3 | −1.2 / 0.6 | 20 / −6 | 3 / 2 |
| shipped / core | 5.18x / 5.41x | | 2.02x / 2.02x | 1.97x / 1.96x |

The old bench, run unchanged from 463f6fdfc in this session, printed 79.1 µs/item backfill, 3.7 µs/item sweep and
2,595 B/item: the `core` line. So earlier scale figures quoted from this bench understate the shipped per-item backfill
CPU about 5x and the memory about 2x. The verifiers' scratch runs found 3.3x and 3.6x; theirs wired the graph and the
mentions by hand on the bench's own sync settings, while `shipped` runs the partner's own sync and fan-out on the
default's settings. The sweep of an unchanged listing stays cheap in every mode (3.4 to 6.1 µs/item). Mention
recording costs CPU but almost no JS heap: the source map's SQLite pages are outside the heap and not counted.

`bun packages/sim/src/lab/graph-memory.ts` (20 users × 2,000 realistic items): heap per user 2.62 MB without the
graph and 3.85 MB with it (0.63 KB per item); put 35 → 97 µs per item (the graph's share 63 µs); extraction alone
51.9 µs per item; 1,204 nodes per user; fingerprint `24232465bfa96eee`. The realistic sim's items are shorter than the
bench's, so the graph's share is smaller there (1.47x heap) than in the bench (2.0x).

### 2. Funnel with the paid reader (train1–6, seeds 41–42, 384 hidden and 384 control tasks)

```bash
L=/home/user/Eden/.local/mkt/ledger.jsonl   # the campaign's shared spend ledger
bun run funnel --json default.json -- --reader live --reader-model claude-haiku-5-5 --reader-cache rc.jsonl \
  --spend-ledger $L --spend-cap 25 --spend-headroom 0.3 --run-label ga-default
bun run funnel --json default2.json -- --reader live --reader-model claude-haiku-5-5 --reader-cache rc2.jsonl \
  --spend-ledger $L --spend-cap 25 --spend-headroom 0.3 --run-label ga-default2      # the noise floor
bun run funnel --preset minus-graph --baseline default.json --json mg.json -- --reader live \
  --reader-model claude-haiku-5-5 --reader-cache rc.jsonl --spend-ledger $L --spend-cap 25 --spend-headroom 0.3 \
  --run-label ga-minus-graph
```

The minus-graph run shares the first default run's reader cache: a prompt that is the same with and without the graph
gets the same verdict (439 of its 650 calls replayed), so the paired difference is the graph's, not the reader's
noise on identical prompts. The second default run has its own cache: every one of its calls was a fresh reading.
Cards were replayed from the checked-in cache. Intent was inert (no replay file is checked in), as in every funnel
screen; the shipped default with a key has intent hits too, which this screen does not see.

| Run | Hidden surfaced | Decoys surfaced | Hidden in reader's pool | Decoy in reader's pool | Reader calls |
|---|---|---|---|---|---|
| default (1st paid read) | 247/384 | 127/384 | 230/384 | 229/384 | 656 |
| default (2nd paid read) | 247/384 | 132/384 | 230/384 | 229/384 | 657 |
| minus-graph (paid read) | 243/384 | 129/384 | 226/384 | 226/384 | 650 |
| default, stub reader ($0) | 214/384 | 211/384 | 230/384 | 229/384 | 658 |
| minus-graph, stub reader ($0) | 215/384 | 211/384 | 226/384 | 226/384 | 654 |

Surfaced is delivered or cited by an ask (the funnel score). Task by task (`--baseline`, and the same comparison of
pools from the `--json` files):

| Comparison | Hidden surfaced | Decoys surfaced | Hidden in pool | Decoy in pool |
|---|---|---|---|---|
| default 1st → default 2nd (reader noise only) | +4 −4 | +12 −7 | +0 −0 | +0 −0 |
| default 1st → minus-graph | +3 −7 | +6 −4 | +1 −5 | +1 −4 |
| default 2nd → minus-graph | +6 −10 | +11 −14 | +1 −5 | +1 −4 |
| default → minus-graph, stub reader | +3 −2 | +2 −2 | +1 −5 | +1 −4 |

The pool does not depend on the reader, so its differences are the graph's alone. Of the tasks whose pool changed:

- Hidden lost from the pool without the graph, each surfaced in **both** paid default runs and in neither way without
  the graph: train4 `supplier-bank-not-verified` (seed 41), train4 `msa-template-withdrawn` (41 and 42), train6
  `rejection-before-feedback` (41 and 42). Five tasks.
- Hidden gained in the pool without the graph: train2 `nursery-collection-list` (42), surfaced only without it.
- Decoys lost from the pool without the graph: train5 `entebbe-yellow-fever-shortage` (41 and 42), surfaced in both
  default runs; train2 `oven-delivery-lift-closed` (41 and 42), surfaced in neither. Decoy gained:
  train3 `postgres13-support-ending` (42), surfaced in neither.

So the graph's reproducible effect through the paid reader is **+4 hidden and +2 decoys surfaced** of 384 each. The
rest of the totals' difference is reader noise: across the whole suite, hidden 247 → 243 has 3 tasks gained and 7
lost (two-sided sign test p = 0.34), and two reads of the same default already differ on 8 hidden tasks.

### 3. Realistic simulation (`quality-cli.ts`, 8 users × 20 sessions, 1,210 turns, $0)

`bun packages/sim/src/quality-cli.ts --users 8 --sessions 20 --jobs 2 [--judge perfect] [--sync]
[--config '{"graph":false,"graphMerge":false}']`:

| Run | Precision | Recall | Must facts delivered | False fires | Delivered |
|---|---|---|---|---|---|
| default, no judge (what ships) | 0.585 | 0.454 | 148/326 | 2 | 316 |
| minus-graph, no judge | 0.585 | 0.454 | 148/326 | 2 | 316 |
| default, perfect judge | 0.985 | 0.761 | 248/326 | 0 | 404 |
| minus-graph, perfect judge | 0.985 | 0.752 | 245/326 | 0 | 396 |
| default, no judge, `--sync` (oracle) | 0.595 | 0.463 | 151/326 | 2 | 341 |
| minus-graph, no judge, `--sync` | 0.592 | 0.463 | 151/326 | 2 | 341 |

Secrets leaked 0 in every run. With no judge, which is what the servers run (D112 wires none), the graph changes
nothing here; with a perfect judge it adds 3 must facts (its judge seats, D58), a path the shipped servers do not run.

### 4. Eval (`bun run eval`, 31 scenarios, no model)

`bun packages/eval/src/cli.ts --config '{}'` and `--config '{"graph":false,"graphMerge":false}'`: precision 0.828,
recall 0.48, falseFireRate 0 both ways; the two JSON outputs are identical except the latency fields.

## Cost of this round

Spend booked to this round's run labels in the shared ledger (`ga-*`): $0.4303 in all: $0.0149 for a one-shard smoke
run, $0.1719 and $0.1868 for the two default runs, $0.0568 for minus-graph (the rest of its calls replayed). The
ledger stood at $6.44 before the round and $6.87 after it. One reader call costs $0.000282–0.000285 as made, 2,784–2,814
input and 177 output tokens on average.

## Decision (D141) and stage 2

**Keep `graph` in the default.** The paid screen shows a small but reproducible gain (+4 hidden, +2 decoys surfaced of
384), so the part is not neutral and D112 does not remove it. Its cost is CPU and memory on ingest, not paid calls:
about 182–192 µs of the shipped 358–381 µs per backfilled item, and 2.0x the per-item heap, in the bench.

Stage 2 (a trial, not built here): make the graph cheaper without losing those tasks. Candidates from the finding:
extract only the headers and the first ~1,000 characters of each item, or add only lookup items (not every synced
item) to the graph. D141 names it: a trial switch `graphLite` (owner: repo owner, ends 2026-12-17), with no
trials-table row until the switch exists. The gate: `ingest.bench.ts`'s `+graph` stage at least 2x cheaper; the five
pool tasks above still in the reader's pool (the stub screen shows the pool at $0: `bun run funnel -- --reader stub`
with `--baseline`), and `graph-memory.ts`'s fingerprint is expected to change. A stage 2 that loses them goes back to this paid screen.

Limits: one suite family (train), two seeds, intent inert, one paid read of minus-graph. A live agent (Pi) run was not
made: the gain is 4 tasks of 384 and the decision is to keep the default as it is, which needs no agent run.

## Stage 2 (D150): the graph reads each item's first 1,000 characters

Status: 2026-11-05, deep audit 2026-11-05 final round, work package `graph-read-chars-1000`. Measured on
`audit/2026-11-05-integration` at c11b0289c (before) and the same tree with this change (after), on a shared 4-core
container with other agents running. Decision: D150 (promoted into the default with no switch; `graphLite` closed).

### In plain words

The graph read the first 4,000 characters of every synced item's text. It now reads the first 1,000. The item's title
and its `meta.people` field are read as before, and `meta.start` still places it on its day. On the ingest bench the
graph's work per synced item is now 2.1–2.3 times cheaper and holds 37% less memory, and the shipped path's backfill
fell from about 5x the cache's own work to about 3.6x. Every $0 screen and the replayed paid-reader screen gave the
same result on every task. Nothing costs more, so D112 promotes it into the default directly, with no trial switch.

### Ingest (`bun packages/engine/bench/ingest.bench.ts`, 200 users × 500 items, average text 1,599 chars)

Two runs each way, alternated (before, after, before, after):

| Mode or stage | Backfill µs/item, before | Backfill µs/item, after | Heap B/item raw held, before | after |
|---|---|---|---|---|
| core | 64.8 / 67.2 | 66.1 / 64.4 | 2,562 / 2,562 | 2,562 / 2,562 |
| graph | 238.7 / 234.6 | 140.4 / 143.5 | 5,196 / 5,202 | 4,230 / 4,231 |
| shipped | 335.2 / 334.4 | 235.1 / 239.4 | 5,188 / 5,187 | 4,222 / 4,219 |
| stage: + graph's add | 173.9 / 167.4 | 74.3 / 79.1 | 2,634 / 2,640 | 1,668 / 1,669 |
| stage: + `onStored` | 96.5 / 99.7 | 94.8 / 95.9 | −8 / −15 | −8 / −12 |
| shipped / core | 5.17x / 4.97x | 3.56x / 3.72x | 2.02x / 2.02x | 1.65x / 1.65x |

The `+graph` stage is 2.34x and 2.12x cheaper per item (173.9 → 74.3, 167.4 → 79.1), which clears D141's 2x gate on
this command. The work package's planning run used `--quick` (40 users × 500) and saw 1.84x (156.9 → 85.1); the full
bench is the gate's command. The sweep of an unchanged listing stays at 3.5–5.0 µs/item.

`bun packages/sim/src/lab/graph-memory.ts` (20 users × 2,000 realistic items) prints fingerprint `24232465bfa96eee`
and 0.63 KB of graph per item, as in stage 1: the sim's items fit in 1,000 characters, so its graph is unchanged. The
bench's longer items are where the cut acts. The funnel's train worlds (`buildWorld({ seed: 41_000 })` and
`42_000`, before planting, counted by a scratch script that filters `world.items` on `text.length`) hold 294 of 1,487 and 297 of 1,494 items
longer than 1,000 characters, and 114 and 106 longer than 4,000, so the screens below do read long items.

### Quality screens ($0)

```bash
S=<scratch dir>; gunzip -c packages/sim/lab/distilled/reader-haiku-train-4142.jsonl.gz > $S/reader-haiku.jsonl
# before (4,000), then after (1,000) with --baseline of the before run. These screens ran intent inert; since D158
# the funnel replays intent by default, so --intent none reproduces them (and the cache below is intent inert).
bun run funnel --jobs 4 --intent none --json $S/base-stub.json
bun run funnel --jobs 4 --intent none --baseline $S/base-stub.json --json $S/new-stub.json
bun run funnel --jobs 4 --intent none --allow-misses --json $S/base-replay.json -- --reader replay \
  --reader-model claude-haiku-5-5 --reader-cache $S/reader-haiku.jsonl
bun run funnel --jobs 4 --intent none --allow-misses --baseline $S/base-replay.json --json $S/new-replay.json \
  -- --reader replay --reader-model claude-haiku-5-5 --reader-cache $S/reader-haiku.jsonl
bun run eval
```

| Screen | Before | After | Task by task (`--baseline`) |
|---|---|---|---|
| funnel, stub reader | hidden 214/384, decoys 211/384, pool 230/229 | the same | hidden +0 −0, decoys +0 −0 |
| funnel, Haiku 5.5 reader replayed (D141's paid reading) | hidden 247/384, decoys 127/384, pool 230/229; 648 replayed, 5 missed | the same | hidden +0 −0, decoys +0 −0 |
| eval (31 scenarios, no model) | precision 0.8276, recall 0.48, falseFireRate 0 | the same | |

Every per-task field of the two funnels' `--json` outputs is equal before and after except the timing fields (`ms`,
`askMs`, `readerWaitMs`, `deliveryMs`): the reader's pool, the reader's verdicts, deliveries and ask citations did not
move on any of the 768 tasks. The five pool tasks D141 kept the graph for (train4 `supplier-bank-not-verified` 41,
`msa-template-withdrawn` 41 and 42, train6 `rejection-before-feedback` 41 and 42) are in the pool after the change.
The replay's 5 misses are prompts the recorded cache never held, answered without the reader (fail open), the same 5
before and after. No paid call was made for this stage.

### Decision (D150)

Promote `READ_CHARS = 1_000` (`packages/engine/src/kg.ts`) into the default with no switch: measured neutral on every
quality screen, and cheaper (D112). This closes D141's `graphLite`: its candidate "headers plus the first ~1,000
characters" is this change (header lines at the head of the text are inside the 1,000 characters, so they are
still read; a forwarded message's headers further down are not), and its other candidate (only
lookup items in the graph) is not built. A name or address that first appears past an item's first 1,000
characters adds no node now (`kg.test.ts`, "only the first 1,000 characters of an item's text are read"); the item is
still cached, indexed and searchable whole, so only the graph's walk loses that tie.

Limits: one suite family (train), two seeds, intent inert, the paid reader replayed rather than re-read (a pool that
did not change replays the same verdicts, which is why it is a valid screen here). No live agent run: nothing the
agent sees changed on any task.
