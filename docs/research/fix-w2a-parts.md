# Fix W2a: which parts of the default earn their place (RealUse-1 issue 11)

Status: measured and decided 2026-11-07 (D225–D229), session W2a of wave 2. Base: the merged wave-1 tree
(`227eff91`). Paid calls only to the Anthropic API (`claude-haiku-5-5`, `HAIKU_API_KEY`, `env -u
OPENROUTER_API_KEY`), on `--spend-ledger .local/ledger.jsonl --spend-cap 4 --spend-headroom 0.3`: **$1.144** in all.
heldout15 was not run. Data: [`packages/sim/lab/fix-w2a/`](../../packages/sim/lab/fix-w2a/) (`parts-replay.json`,
`pi.txt`, `pi-summary.json`).

## Headlines

- **Every part ablated with the paid reader.** "Default minus <part>" for all 15 parts on train1–6, seeds 41–42 (384
  hidden, 384 decoy tasks), with the Haiku reader replayed. The recipe 2a cache was topped up on Anthropic for every
  preset ($0.667, plus $0.010 for `--overlap`) and every row replays with **0 misses**. The topped-up cache is checked
  in, so any `--preset minus-<part>` now replays at $0.
- **Deleted (no measured benefit), with their code and tests:** `graph` (D225), `askVerdicts` (D226), `anticipate`
  (D227), `slowPathQueue` (D228). 53 files, about 6,080 lines removed. **`judge` leaves `PARTS`** (D229): no server
  wires a judge, so the part cannot move what ships; its settings stay for the lab.
- **The slimmed default** reads hidden 313/384, decoys 127/384 against 314/132. It makes 2.7 connector calls a task
  at request time against 3.2. `bun run eval` is unchanged (precision 0.828, recall 0.48, false-fire rate 0).
- **Live (Pi, Anthropic Haiku, heldout13 + heldout14 with neutral, seeds 41–42, the direct market profile,
  `--push signals`), slim − default, paired bootstrap 95%:**

  | Measure | Slim − default | 95% interval |
  |---|---:|---|
  | hidden | −4.7 points | −11.7..+1.6 |
  | false concerns (control) | 0.0 | −2.3..+2.3 |
  | neutral concerns | −7.8 | −15.6..0.0 |
  | 1:1:8 mix wrong rate | −6.2 | −12.6..−0.1 |
  | mix cost | +$0.004/1k | n.s. |

  There is no significant loss on any bar. The hidden point estimate is negative, so wave 2's blind heldout15 check
  should read it.
- **Kept, each for a measured or documented reason:**
  - probes: a trade, −6 hidden and −10 decoys removed;
  - grounds: −3/−4, precision role;
  - fallback: D183's eval loss;
  - compaction: ask answers 1.85x smaller;
  - freshness: the staleness role, D126;
  - probeGrace: 3x lower latency at `--time 1`;
  - sync, cards, intent, reader: the score.

## (1) Each part removed, paid reader replayed

```bash
gunzip -c packages/sim/lab/distilled/reader-haiku-train-4142-intent.jsonl.gz > .local/reader-haiku-train-4142-intent.jsonl
R="--reader replay --reader-model claude-haiku-5-5 --reader-cache .local/reader-haiku-train-4142-intent.jsonl"
env -u OPENROUTER_API_KEY bun run funnel --jobs 4 --allow-misses --json default.json -- $R
env -u OPENROUTER_API_KEY bun run funnel --jobs 4 --allow-misses --preset minus-P --json minus-P.json -- $R
# the top-up (one process per preset; five lanes ran at once on copies of the cache, then merged):
env -u OPENROUTER_API_KEY bun run funnel --preset minus-P -- --reader live --reader-model claude-haiku-5-5 \
  --reader-cache COPY --spend-ledger .local/ledger.jsonl --spend-cap 4 --spend-headroom 0.3 \
  --run-label w2a-topup-minus-P
```

The first replay of the then-committed cache missed most prompts for the presets that change the reader's pool:
- probes 634, sync 1,244, askVerdicts 814, cards 1,156, intent 449;
- graph 228, grounds 102, anticipate 67.

After the top-up (ledger runs `w2a-topup-minus-*` and `w2a-topup2-minus-*`) every row is a whole paid reading. In
the table below:
- **Surfaced** is what was delivered unasked or cited by the ask, split into flagged by the reader, rule path and
  listed only (D173).
- **Reader calls** counts replayed plus missed.
- **Calls / task** is connector calls a task at request time.
- **Ask bytes** is the mean ask answer.

| Preset | Hidden | Decoys | Δ hidden | Δ decoys | Pool hidden / decoys | Hidden flagged / rule / listed | Decoys flagged / rule / listed | Reader calls | Calls / task | Ask bytes |
|---|---:|---:|---:|---:|---:|---|---|---:|---:|---:|
| default | 314 | 132 | +0 | +0 | 285 / 254 | 261 / 21 / 32 | 25 / 66 / 41 | 643 | 3.2 | 810 |
| minus-probes | 308 | 122 | -6 | -10 | 279 / 247 | 253 / 23 / 32 | 21 / 64 / 37 | 643 | 3.2 | 822 |
| minus-grounds | 311 | 128 | -3 | -4 | 283 / 254 | 259 / 12 / 40 | 24 / 66 / 38 | 643 | 3.0 | 867 |
| minus-fallback | 314 | 128 | +0 | -4 | 285 / 254 | 261 / 21 / 32 | 25 / 62 / 41 | 643 | 3.2 | 810 |
| minus-compaction | 314 | 132 | +0 | +0 | 285 / 254 | 261 / 21 / 32 | 25 / 66 / 41 | 643 | 3.2 | 1496 |
| minus-judge | 314 | 132 | +0 | +0 | 285 / 254 | 261 / 21 / 32 | 25 / 66 / 41 | 643 | 3.2 | 810 |
| minus-graph | 317 | 131 | +3 | -1 | 286 / 252 | 263 / 21 / 33 | 27 / 64 / 40 | 643 | 3.1 | 807 |
| minus-anticipate | 315 | 132 | +1 | +0 | 285 / 253 | 262 / 21 / 32 | 24 / 67 / 41 | 643 | 2.7 | 814 |
| minus-sync | 238 | 114 | -76 | -18 | 216 / 190 | 192 / 18 / 28 | 23 / 65 / 26 | 626 | 14.8 | 806 |
| minus-freshness | 314 | 132 | +0 | +0 | 285 / 254 | 261 / 21 / 32 | 25 / 66 / 41 | 643 | 3.2 | 810 |
| minus-askVerdicts | 312 | 128 | -2 | -4 | 282 / 249 | 254 / 24 / 34 | 24 / 67 / 37 | 643 | 3.2 | 806 |
| minus-cards | 253 | 132 | -61 | +0 | 232 / 225 | 212 / 19 / 22 | 18 / 70 / 44 | 619 | 3.2 | 555 |
| minus-intent | 244 | 132 | -70 | +0 | 230 / 229 | 203 / 20 / 21 | 20 / 68 / 44 | 629 | 3.2 | 594 |
| minus-reader | 281 | 256 | -33 | +124 | 0 / 0 | 0 / 98 / 183 | 0 / 72 / 184 | 0 | 3.1 | 1075 |
| minus-slowPathQueue | 314 | 132 | +0 | +0 | 285 / 254 | 261 / 21 / 32 | 25 / 66 / 41 | 643 | 3.2 | 810 |
| minus-probeGrace | 314 | 132 | +0 | +0 | 285 / 254 | 261 / 21 / 32 | 25 / 66 / 41 | 643 | 3.2 | 810 |
| slim (D225–D228 together) | 313 | 127 | -1 | -5 | 282 / 249 | 255 / 24 / 34 | 24 / 66 / 37 | 643 | 2.7 | 806 |

The current default replays with the same 643 reader calls and matches the 314/132 stated in the brief. The
presets that read the pool differently (sync, cards, intent) make fewer reader calls, because fewer asks act.

### The parts that act only on time or overlap

Two parts never act at `--time 0` with one request at a time.

- **`probeGrace`** (`probeGraceMs` 0 in the default; the part's absence is D47's 100 ms grace).
  - `-- --time 1`, the same replay: the default reads 311/135 at **12.8 ms/task**, minus-probeGrace 311/135 at
    **38.8 ms/task** (52 misses in both).
  - The grace buys nothing and costs 3x the latency, so the part is kept.
  - Also at `--time 1`: minus-anticipate 10.6 ms/task (2.8 calls a task), minus-graph 10.8.
- **`slowPathQueue`** under `-- --overlap` (LAB.md 1c), where each request arrives while a lookup is in flight.
  - After a top-up (`w2a-topup-overlap-*`, $0.010) there were still 25–26 misses: the overlap's timing makes the
    pools vary between runs.
  - With the queue: 316/133. Hidden surfaced 261 flagged / 23 rule path / 32 listed; decoys 25 / 67 / 41.
  - Without it: 310/85. Hidden 261 / 2 / 47; decoys 25 / 4 / 56.
  - The queued lookups delivered rule-path items almost only, at 21 hidden to 63 decoys; the reader's flags did not
    move. Precision ahead (D3), so the part is deleted (D228).
  - With no overlap the funnel is identical.

### What the table says

- **graph** (D225) reads better removed: +3 hidden, −1 decoy, 0.1 fewer calls.
  - This agrees with realuse-1 part D's stub screen (+6) and the earlier live ablations (no difference).
  - Its rule path ("grounded-graph") delivered 3 hidden and 1 decoy in the default. The slim default finds those by
    other paths (grounded-conflict 21/30).
- **askVerdicts** (D226): −2 hidden, −4 decoys when removed. The stub's +16 hidden was an artefact of the stub
  reader listing everything.
- **anticipate** (D227): +1 hidden, 0 decoys, and **0.5 fewer connector calls a task** (16% of request-time calls)
  when removed. Its prefetches cost source calls and their answers were not used.
- **judge** (D229): exactly the default (no judge is wired in the funnel or the servers).
- **compaction:** the same score, but answers grow 1.85x (810 → 1,496 bytes) and packets 1.37x (456 → 623) without
  it: tokens in the agent's context.
- **fallback:** −4 decoys, 0 hidden. D183's two correlated templates and its eval loss (precision 0.828 → 0.821,
  recall 0.48 → 0.46) still decide: kept.
- **grounds:** −3 hidden, −4 decoys, and request-time calls 3.2 → 3.0. A trade, not a part with no value. Kept for
  its precision role (the quiet rules hold back what a no-model path cannot ground).
- **freshness:** no change on train (a static world); its value is the staleness T3 measures (realuse-1 part D: 7 of
  46 updates delivered stale without it, 1 of 43 with it). Kept.
- **probes:** −6 hidden, −10 decoys removed: 1.7 decoys a hidden fact, inside the range of the rule paths D196 kept.
  Not in this issue's list; kept.

## (2) The deletions

Commit `ecc9089e` (deletion only in `partner.ts`, as the brief asked; W2b owns its ask and reader-flag paths):

- **graph:**
  - Removed: `kg.ts`, `kg.test.ts`, `kg-store.test.ts`, the cache's per-user graph (`enableGraph`, `walk`,
    `learnGraph`), the graph's config keys, its walk, seats and conflict ground, and the graph facts in `decide.ts`.
  - Lab tools removed: `graph-memory.ts`, `graph-bench.ts`, and ingest.bench's `graph` mode.
  - `orgLabel` moved into `firewall.ts`, whose "graph" ground went.
- **askVerdicts:** the ask's verdict-gathering branch and `ask-verdicts.test.ts`. The ask answers as it did with the
  switch off.
- **anticipate:**
  - Removed: `anticipate.ts` and its test, the session's prefetch state, early decisions, `IntentPatterns`, the
    `anticipate.*` spans, the trace fields `anticipateCalls` and `prefetched`, and the probes' wait on a running
    prefetch.
  - quality-cli's `--drafts`/`--typing-ms` and its anticipation report went too.
  - A draft event is ignored, as it was with the switch off. The lookup's own `probeGraceMs` stays.
- **slowPathQueue:** `drainQueued`, the session's one-slot queue and `slow-path-queue.test.ts`. A busy slow path
  traces "slow path busy" and returns. `--overlap` still prints the busy count.
- **PARTS** is now probes, grounds, fallback, compaction, sync, freshness, cards, intent, reader, probeGrace.
  - `default.test.ts` lists 42 changed keys (was 50).
  - `tied.test.ts` sets `judgeTied: false` itself, now that the core keeps the judge's default settings.
- **`docs/profiles/`** had no `minus-*.json` for the five parts.

The tree after the deletions, checked in this session:

| Check | Result |
|---|---|
| `bun run check` | 1,863 tests pass |
| `bun run eval` | precision 0.8275862068965517, recall 0.48, false-fire rate 0; the counts as before but `skipped` 87 → 80 (anticipation's own traces); `plannedLookups` 121–122 run to run, before and after |
| The funnel on the committed cache | `{"replayed":643,"sent":0,"missed":0,"failed":0}`, TOTAL hidden 313/384, decoys 127/384 |

The funnel figure equals the slim settings measured before the code went, so the deletion changed nothing beyond the
switches.

## (3) Live: Pi on Anthropic Haiku

```bash
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite heldout13,heldout14 --seeds $SEED \
  --variants hidden,control,neutral --conditions eden,eden~slim --config default \
  --variant-config '{"slim":{"graph":false,"graphMerge":false,"askVerdicts":false,"anticipate":false,"slowPathQueue":false}}' \
  --cards packages/sim/lab/cards/cards-v2.jsonl --cards-out .local/w2a/pi/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push signals --budget 1.5 \
  --spend-ledger .local/ledger.jsonl --spend-cap 4 --spend-headroom 0.3 --run-label $L --out .local/w2a/pi/$L.json
python3 -I packages/sim/lab/fix-s1/s1.py packages/sim/lab/fix-w2a/pi-summary.json .local/ledger.jsonl \
  .local/w2a/pi/w2a-pi-41.json,.local/w2a/pi/w2a-pi-42.json
```

Seeds 41 and 42, one process each, run before the code was deleted: the slim arm is the switches off, which the
funnel shows is the deleted code. Each process ran 320 runs with 0 ungraded and `overBudget: reader 0, cards 0`;
seed 41 cost $0.2326 and seed 42 $0.2356. n = 128 hidden, 128 control, 64 neutral per arm. Rates are raised concerns;
"$/1k" is Eden plus agent all-in.

| Arm | Hidden | Control (false) | Neutral (any) | Mix wrong | Mix $/1k | Mix calls | Mix wall p50 |
|---|---:|---:|---:|---:|---:|---:|---:|
| default (`eden`) | 0.773 | 0.016 | 0.094 | 0.077 | 0.665 | 8.14 | 5.64 s |
| slim (`eden~slim`) | 0.727 | 0.016 | 0.016 | 0.014 | 0.669 | 7.81 | 5.61 s |

Slim − default, paired bootstrap 95% over tasks (4,000 resamples):

| Measure | Difference | 95% interval |
|---|---:|---|
| hidden | −0.047 | −0.117..+0.016 |
| control | +0.000 | −0.023..+0.023 |
| neutral | −0.078 | −0.156..+0.000 |
| mix wrong | −0.062 | −0.126..−0.001 |
| mix $/1k | +0.004 | −0.030..+0.038 |
| connector calls | −0.33 | −0.92..+0.24 |
| hidden reader calls | −0.05 | −0.11..+0.01 |

No significant loss in hidden facts, false concerns or neutral concerns (the brief's bar). Neutral concerns fell, at
the edge of significance, and the mix's wrong rate fell significantly. The hidden estimate is −4.7 points with an
interval that spans zero. Its funnel counterpart is −1, so it is likely noise, but it is the number to watch in the
blind heldout15 check.

## Spend

| Ledger run | $ |
|---|---:|
| `w2a-topup-minus-*` (8 presets) | 0.661 |
| `w2a-topup2-minus-*` (the last 12 misses) | 0.003 |
| `w2a-topup-slim` | 0.002 |
| `w2a-topup-overlap-*` | 0.010 |
| `w2a-pi-41`, `w2a-pi-42` | 0.468 |
| **total** | **1.144** |

## Reproduce at $0

Recipe 2a with the checked-in cache (4,377 lines, plain md5 `32c5fa518a67a2db657f35f981e3262a`), any `--preset
minus-<part>`. The pre-deletion presets need the tree before `ecc9089e`.
