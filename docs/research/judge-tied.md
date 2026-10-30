# Judge only what the request is tied to (PoC, flag off)

Status: 2026-10-30. One flag, `judgeTied`, off by default (D54); no model call added, no source call, no dependency,
no new state. Every number below comes from commands run in this work: simulation `quality-cli.ts --planner`,
realistic profile seeds 41–44 and profiles zoo-a and zoo-b seeds 41–42, no judge and the perfect judge. Held-out 5,
6 and 7 were neither run nor read.

`G` is D53's recommended set with `judgeContested`, `judgeItemBytes` 200, `probeShare`, `probeTopicAlone` and
`fallbackAsks` (the combined configuration's best); `V` is `G` plus `judgeTied`.

## Where the judge's cost went

The simulation prices a judge call by its input (characters / 4 at $0.15 per million tokens) and output; it does
not model cached input tokens (`OracleJudge` reports `cachedInputTokens: 0`), so a cache-friendly prompt layout
saves nothing here and nothing is claimed for it. A log of G's judge inputs (seed 41, perfect judge, 179 calls)
showed per call about 650 characters of fixed instructions, 330 of conversation and 1,060 of candidates (6.1 on
average). 75 of the 179 calls (42%) returned no pick: the perfect judge found no needed item among the candidates.

Those empty calls were mostly requests about the world at large or small talk ("Translate 'see you tomorrow' into
Portuguese", "write a haiku about autumn in London", "nice one", "put it in my calendar"), whose candidates shared one
word with the request and that word was common in the user's mail ("week", "nice", "calendar", "perfect"). Calls
with a pick had a candidate a probe found, an event on a day the request names, or two or more of the request's
words.

## `judgeTied`

Before the judge is asked, at least one candidate must be tied to the request:

- found by a probe (for a person, organisation, topic or day the request names), or
- an event on a day the request names, or
- holding two or more of the request's words, or
- holding one of the request's words that fewer than `judgeTiedShare` (3%) of the user's cached items hold
  (`ItemCache.isRare`, the index's idf): a name, a reference, a place ("dentist", "Zanzibar").

With none tied, the lookup ends silent ("judge: untied") and no call is made. Rarity is the user's own: while their
cache holds too few items for a share to mean anything, every word is rare and every candidate tied, so a new user
is judged as before. With no model configured the flag does nothing (the no-model paths decide as before).

This differs from the rule `model-calls.md` measured and rejected ("every candidate holds at most one query term and
the best scores below S"): the score there is coverage, which is near 1 whenever the request has one known word, and
it had no notion of the word's rarity or of probe and day ties. That rule lost recall as it saved calls; this one
keeps a one-word match on a rare word and every structural tie.

## Results

Simulation, perfect judge (model cost: mean of `costPer1kTurnsUsd`, as rounded in each report, then the unrounded
`costPerTurnUsd` × 1000 in brackets):

| Profile | Config | Recall | Stated | Precision | Model calls / turn | Cost / 1k turns | Calls / lookup | Bytes / fact |
|---|---|---|---|---|---|---|---|---|
| realistic (41–44) | G | 0.647 | 0.604 | 0.950 | 0.253 | $0.02025 ($0.02031) | 7.79 | 433 |
| realistic (41–44) | V | 0.643 | 0.601 | 0.949 | 0.212 | $0.0170 ($0.01713) | 7.78 | 434 |
| zoo-a (41–42) | G | 0.596 | 0.555 | 0.952 | 0.253 | $0.0195 ($0.01994) | 7.70 | 447 |
| zoo-a (41–42) | V | 0.596 | 0.555 | 0.952 | 0.213 | $0.0170 ($0.01696) | 7.73 | 445 |
| zoo-b (41–42) | G | 0.722 | 0.671 | 0.965 | 0.284 | $0.0235 ($0.02332) | 7.86 | 430 |
| zoo-b (41–42) | V | 0.717 | 0.668 | 0.964 | 0.252 | $0.0210 ($0.02074) | 7.84 | 430 |

No judge: identical rows for G and V on every profile (realistic recall 0.408, precision 0.601, soft fire rate 0.299;
the flag needs a model). No hard false fire in any run. `judgeTiedShare` 0.05 instead of 0.03 (realistic): recall
0.638, precision 0.947, $0.0176: a looser share is not better, and the difference from 0.03 is within run-to-run
movement (planner and probe learning follow what is delivered).

The realistic profile is in-sample: the empty-call log above was read from it. zoo-a and zoo-b were not inspected.

No-model funnel (hidden, held-out 1–4): G and V both 148/128/21 (returned / delivered / decoys), 8.5 calls per task:
the funnel has no judge, so the flag cannot act there.

Real-time latency (the `bench.ts --latency` tier run directly: realistic seed 41, 3 users × 6 sessions, `--time 1`,
perfect judge at 900 ms; two runs each, same machine): delivery p50 4,320 / 4,317 ms (G) and 4,323 / 4,319 ms (V),
p95 28,497 / 28,500 ms (G) and 28,501 / 28,501 ms (V); model calls per turn 0.22 in all four. Its users' caches stay
too small for any word to count as common, so no call is skipped there and latency cannot move. Where calls are
skipped, the lookup ends at once rather than after the judge's round trip, but it delivers nothing, so delivery
latency (measured on deliveries) does not show it.

## Not done, and why

- Prompt-cache-friendly ordering: the fixed instructions already come first and the per-call data last; cached input
  is not priced by the simulation, so no saving is shown or claimed.
- Shorter fixed instructions, or a shorter conversation window: the perfect judge reads neither, so the simulation
  would show the saving as free whatever it did to a real judge's verdicts. Needs a live run to judge.
- Memoising a "none" verdict across near-identical turns: the candidates are re-ranked per request, and the judge's
  relevance is per request; the tie rule removed most repeated empty calls (the same small-talk turn) without it.

## Risks

- The simulation's judge is perfect: the calls skipped are ones it turned down, so precision cannot be seen to
  rise. A live judge picks some decoys on such calls (D48's false concerns); skipping them can only remove those, but
  a live judge may also have found a needed item the oracle's labels count as relevant only through a common word.
- Rarity needs a filled cache; a user with a small cache gets no saving, a user whose mail repeats a name on more
  than 3% of items needs a probe or a second word to tie it (names the request mentions are probed with probes on).

## Reproduce

```bash
G='{"probes":true,"compactInjection":true,"quietSettled":true,"groundAway":true,"judgeContested":true,"judgeItemBytes":200,"probeShare":true,"probeTopicAlone":true,"fallbackAsks":true,"groundConflict":true,"quietClear":true,"probeFresh":true,"probeYield":true,"densePacket":true,"groundOccasion":true}'
V="${G%\}},\"judgeTied\":true}"
for sd in 41 42 43 44; do
  bun packages/sim/src/quality-cli.ts --profile realistic --seed $sd --planner --judge perfect --config "$V"
done
```
