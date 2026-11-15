# The third low-level round: per-object and per-request memos in the rule paths

Decision: D1920. A profiling survey of main 4559e0634 (`bun --cpu-prof --cpu-prof-interval=500
packages/engine/bench/pipeline.bench.ts`) named five places in `@eden/engine` that redo per item, or per name, work
whose inputs had not changed; this round removes that work with every output unchanged. No model call and no paid call
was made. Every number below comes from a command run in this session on the shared 4-core VM with other agents'
benchmarks beside it (load average 1.9 to 5.8 over the session), so each A/B carries a self-against-self control.

## Method

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

## Changes

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

## Measured

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

## Not changed

- A per-item memo of `mentions`' lowercased text: it would hold a copy of every touched item's text (`READINGS` holds
  none for a packed item, by design); building it once a call by a code-unit pass took most of the cost.
- `noteShown`'s own share: what is left is adding each shown word to the session's `Set`, which `askDedup` reads.
- `namesRequestDay` builds its day patterns per item too, but had no samples in either profile.
- The first loop's surrogate fallback in `mentionText` is equivalent to none: a high surrogate it meets starts a run
  whose next unit, the low surrogate, the run loop hands to the regex. It stays, mirroring `wordsIn`.

## Gates

On the final tree: `env -u OPENROUTER_API_KEY CHECK_COLD=1 FORMAT_COLD=1 bun run check` green; `bun run eval` (the
no-model eval, `packages/eval/src/cli.ts`) reads precision 0.65, recall 0.52, falseFireRate 0, acting packets on 19 of
28 neutral requests at 1.18 items, facts handed 10 of 11, look-alikes 3 of 10, as on main; `bun run funnel --jobs 4`
reads hidden 323/384 and decoys 294/384 on main (engine sources of origin/main, run in this session) and on the
branch, and `--baseline` against main's run reads hidden +0 −0, decoys +0 −0.
