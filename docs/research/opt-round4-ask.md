# Low-level round 4: the ask path

Decisions: D1930–D1937. The brief (2026-11-15): a deep, low-level pass over the engine's ask path (the agent's
question to its answer), every output unchanged, after three rounds (D1880–D1889, D1910–D1918, D1920/D1925/D1926)
had taken the obvious costs. No model call and no paid call was made. Every number below comes from a command run in
this session on the shared 4-core VM, with other agents' funnels, benches, typechecks and Prettier runs beside it:
the load average was 4 at the start and 18 to 36 for most of the session, so every A/B carries a self-against-self
control and the control's spread is the noise floor.

## Method

- **Profiles**: `bun --cpu-prof --cpu-prof-interval=50` (and 100 µs with `--asks=3000`) of
  `packages/engine/bench/pipeline.bench.ts`, summed by function, self and inclusive, by caller chain and by source
  line (`positionTicks`), with a filter that keeps only the samples after the bench's first `ask` from its own module
  (the ask phase; samples before are the event stream). A scratch script, not kept. The eval (`packages/eval`) and
  the funnel (`BUN_OPTIONS=--cpu-prof`, `--jobs 1`, train1 seed 41) were profiled too.
- **A/B**: arms in separate processes, interleaved and slot-balanced (round k starts at arm k mod n): origin/main's
  `src/` (A), a second copy of it (A', the control), and the branch's changes added in three groups by file: R
  (render.ts and line.ts: D1931, D1933's render and line parts), G (R plus conflict.ts and probes.ts: D1930, D1932,
  D1934, D1935) and B (G plus cache.ts and partner.ts: D1936, D1933's partner parts; the branch). Process CPU time
  (`resourceUsage`, every thread) and the ask phase's own CPU time (`process.cpuUsage` around the bench's ask loop,
  the same line added to every arm's copy of the bench), the bench's ask p50/p99, observe p50 and stream total;
  medians, and the paired median of each arm over A in the same round with its range. Two GC conditions: the natural
  collector ("no GC") and a preload forcing `Bun.gc(true)` every 100 ms ("forced GC").
- **Oracles**: `opt-round4.test.ts` fuzzes each rewrite against the code it replaced (kept in the source: `datesOf`,
  `mentionsAnyByText`, `assessEvery`, `tally`; or in a test or `render.reference.ts`), and 21 mutations of the new
  code were run against it (below).
- **Behaviour gates**: the no-model eval and the funnel against fresh origin/main runs (end of this note).

## Where the ask's time went (origin/main 7bca42093)

The ask phase of the pipeline bench (300 asks, 50 µs samples, one profile): `renderPacket` 27% inclusive (the
answer's own packet and the delivery's second render of the same items, which only `renderedCount` reads),
`searchLive` 20% (source routing in `@eden/graph`, the fan-out in `@eden/sources`, the probes, re-storing what the
search found), `grounded` 18% (the conflict test: `assess` 11%, `analyse` on items read for the first time, the date
patterns 4.4%), `handOut` 7% (`noteShown`, the usage tokens), `rank` 6%, `buildCue` 3%. With `--asks=3000` (the
parts memo thrashing over more items) `renderPacket` was 41% and `grounded` 28%, of which `entryOf` decompressing
item texts was 4.8% of the whole ask.

Algorithmic findings:

1. `entryOf` (the conflict analysis's per-object memo) compared `e.text !== item.text` on every read, so a packed
   item's getter decompressed its text (a decode memo miss) and compared it in full, only to find the memo valid.
2. `renderPacket` compacted every item before its size loop, which stops when the packet is full: the delivery's
   render of an ask's five items into 1,200 bytes compacted all five and printed about three.
3. `assess` ran every date pattern over every dated statement of every candidate on every request (`datesOf`), though
   only the days they name depend on the request's instant.
4. `assess` walked every statement of an item, though a statement with no mark and no date leaves its loop as it was.
5. The packet's `shown` set added every word of every item's text, the last item's too, and one-character words the
   known test never asks of; `Session.shown` kept them too.
6. `mentionsAny` built a normalised copy of the whole item (title, text, people) to search it.
7. `safeLine` replaced each single space with itself; `spacedOut` scanned the whole text in JS; `focusOf` was read
   three times an ask; the ask read its days twice (`buildCue`'s `timeWindow`, then the wider `datedText` reading
   that replaced it).
8. An equal re-put (D1722) tallied the held copy's people out and in, reading its header lines twice.

## Changes

| Decision | Change | Exactness |
|---|---|---|
| D1930 | `entryOf` never reads a packed item's text: an object is packed or plain for life and a packed one's bytes are fixed (non-writable, non-configurable), so its entry is checked by title and date only and holds no decoded copy | `opt-round4.test.ts`: analyses and gate equal a plain copy's; a second read decodes nothing; title and date changes still re-read |
| D1931 | `renderPacket` compacts an item when its size loop reaches it; items past the cut are never compacted; `onParts` (lab) is still told every item, the reader's note gets the item as said | item k's text depends on items before it only; `render-fast.test.ts`'s 3,000 fuzzed packets (maxBytes 200-3,200) against `render.reference.ts`, plus `onParts` and `note` sequences equal to the reference's |
| D1932 | a statement's date matches are read once (`planDates`, kept on the statement) and replayed per request (`replayDates`): only `dayOf`, `after` and `iso(now)` depend on the instant | `datesOf` kept as the reference: 12,000 fuzzed sentences × 4 instants × both vocabularies from one plan each, and the eval's sentences |
| D1935 | with no amount and no routine in the request, `assess` reads only `activeOf`'s statements (a mark of some kind or a date) | every other statement is a no-op of the loop (marks empty, `lastDone` −1, date verdict "none"); `assessEvery` (the full loop) on 120,000 request × item pairs, every verdict exercised |
| D1934 | `mentionsAny` searches the lowercased text in place: a word occurs with no kept character (letter, digit, "@", ".") either side; a surrogate anywhere goes to the copied text | `mentionsAnyByText` on 40,000 fuzzed items and names; `opt-round3.test.ts`'s `mentions` oracle |
| D1933 | the packet's `shown` words join only when another item is read and only if two characters or longer, `Session.shown` likewise; `pick` reads the focus arrays once a packet and the whole text's bytes as a sum; `spacedOut` by `includes` and one class regex; `safeLine` skips `SPACES` where `RESPACED` finds nothing; `focusOf` once a cue (`FOCI`); the ask reads its days once | the known test asks only of words of two or more characters; `render-fast.test.ts`; `spacedOut` and `safeLine` against the code they replaced on 50,000 fuzzed strings each; `compactText` on lone surrogates and astral letters |
| D1936 | an equal re-put's held copy is tallied out and in from one reading of its header lines (`retally`) | counts, Map order and invalidations equal two `tally` calls over 3,000 steps |

Mutations (each alone, its tests run; 19 of 20 fail): dropping the packed shortcut's guard, the plain check,
the `onParts` tail, the note's copy, a pair's year, the deadline role, the "back" day, the plan's vocabulary key,
`lastDone` or `dated` from `activeOf`, the double-space search, NEL from `RESPACED`, a boundary or "." in
`mentionedIn`, `retally`'s order, the whole-bytes sum, the `shown` length filter, `Session.shown`'s filter
(`review-regressions`/`partner` tests) and the ask's single `timeWindow` (`default.test.ts`) each fail. The one that
survives is equivalent: dropping `activeOf`'s amount guard (`LIMIT` needs a digit, so a statement it reads is dated
and active anyway; the guard stays as the stated rule).

## Measured

The end to end, main against the branch with its control, at the session's quietest (load 14-16), pipeline.bench
(6,000 items, 2,000 events, 300 asks):

| Condition | Arm | process CPU ms | paired / A | ask-phase CPU ms | paired | ask p50 µs | paired | ask p99 µs | paired | observe p50 µs | paired |
|---|---|---|---|---|---|---|---|---|---|---|---|
| no GC, 20 rounds | A main | 4,064 | 1 | 833 | 1 | 1,840 | 1 | 9,527 | 1 | 117.0 | 1 |
| no GC | A' main (control) | 3,947 | 0.989 (0.82-1.13) | 843 | 1.006 (0.73-1.36) | 1,864 | 1.000 (0.78-1.29) | 9,247 | 0.984 | 112.7 | 0.985 |
| no GC | B branch | 3,794 | **0.926** (0.74-1.10) | 796 | **0.881** (0.68-1.14) | 1,565 | **0.848** (0.60-1.11) | 8,332 | 0.984 | 115.1 | 0.971 |
| forced GC, 12 rounds | A main | 8,718 | 1 | 2,404 | 1 | 2,238 | 1 | 70,130 | 1 | 122.6 | 1 |
| forced GC | A' main (control) | 8,845 | 0.970 (0.71-1.62) | 2,440 | 1.034 (0.53-2.26) | 2,330 | 0.994 (0.82-1.44) | 63,401 | 1.052 | 123.5 | 0.954 |
| forced GC | B branch | 7,760 | 0.969 (0.55-1.72) | 1,984 | **0.860** (0.46-3.35) | 1,764 | **0.798** (0.61-1.63) | 70,695 | 0.835 | 120.1 | 0.993 |

Ask p50 −15% (no GC) and −20% (forced GC) paired against a control at 1.00 and 0.99; the ask phase's CPU −12% and
−14% (it also counts the work an ask leaves behind it, `askLater` and the stores, which these changes barely touch);
the whole process −7% without forced GC. The ask's p99 (one or two slow asks in 300, a collection or another agent's
burst) moves inside its range. Observe's fast path does not move (none of these is on it but the packet's lazy
compaction, which the fast path's small packets rarely cut).

By group, two earlier runs under heavier load (18-36), ask p50 paired against main, the control beside it:

| Run | Control A' | R (render, line) | G (R + conflict, probes) | B (G + cache, partner) |
|---|---|---|---|---|
| no GC, 10 rounds, load 25-36 | 0.920 | 0.889 | 0.835 | 0.709 |
| forced GC, 8 rounds | 1.005 | 0.807 | 0.891 | 0.763 |
| no GC, 15 rounds, load 16-22 | 0.980 | 0.933 | 0.759 | 0.788 |
| forced GC, 10 rounds | 1.064 | 1.006 | 0.837 | 0.784 |

Roughly half the gain is the conflict side (D1930, D1932, D1935, D1934: G against R 0.81-0.94 in three of four runs)
and half the render side (D1931, D1933: R 0.81-0.93 in three of four); the cache and partner group (D1936, D1933's
`noteShown` filter, `focusOf`, one `timeWindow`) is inside the noise on its own (B against G 0.85-1.04). The forced-GC
CPU columns of those runs were within their controls' spread. The load made per-change A/Bs of the smaller items
pointless; each is exact and kept for its profile share (below) and its micro measurement where one was taken.

Micro measurements (the same inputs, interleaved, five rounds, load 20-30): `spacedOut` on 3,000 texts of 2-6 KB,
the JS loop 24-86 ms, two native searches 3.4-5.5 ms (7x); `wordsIn` plus the shown set's adds 6.7-9.0 µs a 76-word
text against 2.5-5.9 µs for `wordsIn` alone (the adds about 4 µs a text). Profile shares, inclusive, in the ask
phase (50 µs samples; one profile of main, three of the branch): `entryOf` 2.4% → 0.1%, `dateVerdict` 4.4% → 0.4%,
`assess` 11.2% → 5.0%, `spacedOut` 1.0% → 0.1%. With `--asks=3000` (100 µs samples), the decompressions under
`entryOf` were 1,389 of the ask's 28,822 samples before and absent after (what decompresses now is the parts memo's
misses and the search's re-stores).

## Not changed

- **`focusCount` over the parts joined** (one `indexOf` a focus word over all keys rather than one a part): 5.5 parts
  and 5.2 focus words a `pick` on the bench's 4,943 recorded calls; 63-112 ms against 63-167 ms over five rounds under
  load, inside the noise: not built.
- **The delivery's second render of an ask's answer.** Its text is read only by `renderedCount` (which queued packets
  the answer covers) and the span's byte count, but that count depends on the folded items' compacted sizes at the
  delivery's 1,200 bytes against the answer's 4,000 (the answer is rendered without the year, the delivery with it),
  so it cannot be had without compacting; D1931 cuts it to the items the loop reaches. That the count reads a render
  other than the answer's is a behaviour question, left as it is.
- **`searchLive`'s share** (20% of the ask phase) is mostly `@eden/graph`'s routing, `@eden/sources`' fan-out and
  promise machinery, other sessions' areas; the engine's own part (`localRouteHits`, `spentSources`, the probes'
  plumbing) is a few percent, spread thin.
- **First readings** (`analyse` and the parts memo's misses, `dayFactsOf` in the funnel's pushes) are once an item
  object; what is left of `assess` is the loop over active statements.
- **`noteShown`'s Set adds** stay: `askDedup` reads them.
- The eval's asks (6 cases) and the funnel's ask path are dominated by first readings of each world's items (the funnel
  spends 81% of its process outside `ask`, building worlds and syncing).

## Gates

GATES
