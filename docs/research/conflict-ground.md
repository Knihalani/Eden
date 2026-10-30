# The conflict ground: would this change the action? (D49, PoC)

Status: 2026-10-30. Follows [sharper-grounds.md](sharper-grounds.md) (D48). Both flags are off by default.

## The problem

With no model to judge, Eden delivers on word overlap (the confident path and D36's fallback) and on a few grounds
read from structure (D44, D46, D48: a person's event on a named day, a clash, an absence). Word overlap cannot tell an
item from its near-miss twin: "payment sent for INV-7174" and "payment sent for INV-7157" share every word with "pay
INV-7174"; "Robert on leave 26 Oct–6 Nov" and "Robert on leave 16–20 Nov" share every word with "get Robert to sign
by Friday". On the held-out funnels F delivered 0.80 decoys per hidden fact (heldout 1–4, no model).

## The idea

Ask the question a careful assistant asks before acting: *would this item change what the request is about to do?*
`conflict.ts` reads the request's **frame** (the days it acts on, today when it names none; the money and percentages
it commits, "15 people at £85 a head" as £1,275; the references it names, "INV-5842", "Q3 report", "October invoice")
and sets each candidate's statements against it, sentence by sentence:

- **Blocks with dates**: a hold, freeze, leave, absence, closure, embargo or expiry over a day the request acts on,
  or a deadline before it, is a conflict; the same over other days is a clearance (the twin).
- **Limits**: an amount above a threshold or cap the item states ("above £40,000 … two quotes are required", "the most
  we can offer is 8%") is a conflict; under it, a clearance.
- **Done already and standing constraints**: "was paid", "already submitted", "auto-renew on", an allergy, "strictly
  internal", "recused": a conflict whenever it was said; undone only by a clearing word about the same matter.
- **Moves**: rescheduled, slipped, pushed, brought forward: a conflict unless the request acts on the new day.
- **Clearances**: lifted, restored, unchanged, back from leave, extended, no restrictions; and **sibling references**
  (Q2 for Q3, another invoice number). A friendly line ("happy to jump on a call") clears nothing: a clearance counts
  only where something could have blocked.
- **Ties**: a conflict counts only when the statement is tied to the request: it holds one of the request's names or
  references (or, for a request that names no one, one of its content words), the sentence before it or the item's
  title does, or it is in the first person from someone the request names (the sender, or a chat line's speaker).
  Without this, "travel over £500 needs pre-approval" in a mail from Oskar was a conflict with "lunch with Oskar".
- **Not statements**: headers, signatures, confidentiality footers and notification boilerplate (via `compactText`
  and a footer pattern), and clearing words inside a condition ("do not commit dates until the MSA is countersigned").

Two flags use it on the no-model path:

- `groundConflict`: a grounded path, "conflict", in `grounded()` after the clash ground: items about the request
  (a name, a reference or two of its terms) whose verdict is `conflict`, up to `maxItemsPerInjection`.
- `quietClear`: the confident path and the fallback drop an item about the request whose verdict is `clear`.

No model call, no new dependency, no state beyond a per-cue frame in a `WeakMap` (dropped with the cue). Every pattern
is linear and reads at most 3,000 characters of an item and 2,000 of a request; the tests run ten 32 KB hostile shapes
(each under 10 ms here).

## Results

`F` as in D48; `FX` = F + `groundConflict` + `quietClear`. Commands below; all numbers from runs in this work.

**No-model funnel** (suites hidden, heldout, heldout2–4; 268 hidden and 268 control tasks, seeds 41–44):

| | Returned | Hidden delivered | Decoys delivered | Decoys / hidden | Calls / task | ms / task |
|---|---|---|---|---|---|---|
| F | 130 | 58 | 40 | 0.69 | 7.2 | 34.8 |
| FX | 130 | **113** | **20** | **0.18** | 7.2 | 37.2 |

Held-out suites 1–4 alone: F 35 hidden, 28 decoys (0.80); FX 89 hidden, 17 decoys (0.19).

**Simulation** (realistic, 4 seeds):

| | No model: recall, precision | Perfect judge: recall, precision | Hard false fires | Calls / lookup | Bytes / needed fact (perfect) | Model $ / 1k turns |
|---|---|---|---|---|---|---|
| F | 0.326, 0.588 | 0.613, 0.949 | 0 | 7.86 | 484 | 0.0200 |
| FX | **0.375**, 0.599 | 0.610, 0.947 | 0 | 7.87 | 483 | 0.0200 |

No-model soft fire rate 0.218 → 0.247 (silent turns with a delivery that does no harm); no-model bytes per needed fact
584 → 539. The conflict path delivered 78 items over the four seeds, 54 relevant (69%; the confident path's is 57%).

**Out of sample** (profiles never inspected while building, seeds 41–42): zoo-a no model 0.347/0.636 → 0.393/0.639,
perfect 0.560/0.952 → 0.568/0.954; zoo-b no model 0.344/0.576 → 0.396/0.578, perfect 0.681/0.960 unchanged. No hard
false fire anywhere.

## Honest limits

- The patterns were written while reading the planted items of the dev suites (hidden, heldout 1–4) and the
  deliveries of two realistic simulation seeds, so the funnel numbers above are in-sample. They are general phrases of
  mail, calendars and documents (leave, freeze, expired, above £X, already paid, lifted), not template strings, and
  zoo-a and zoo-b were never inspected; heldout5 and heldout6 were neither read nor run. A clean-suite run is the test.
- Semantic links are out of reach: "passport expires 2 Nov" is no conflict with "flights on the 21st" (no shared
  word), "no production changes" with "schedule the billing release" only shares a word if the item says "releases".
- Multi-fact items are read sentence by sentence with a "same matter" rule (a clearance must share a word with the
  conflict it undoes); exceptions in prose ("G&A pauses hiring; revenue teams keep hiring") are not parsed.
- With a model, only `quietClear` acts (on the confident path); the judge decides the rest. The perfect-judge row
  moves within noise.

## Reproduce

```bash
F='{"probes":true,"compactInjection":true,"quietSettled":true,"groundAway":true,"judgeContested":true,"judgeItemBytes":200,"probeShare":true,"probeTopicAlone":true,"fallbackAsks":true}'
FX='{"probes":true,"compactInjection":true,"quietSettled":true,"groundAway":true,"judgeContested":true,"judgeItemBytes":200,"probeShare":true,"probeTopicAlone":true,"fallbackAsks":true,"groundConflict":true,"quietClear":true}'
bun packages/sim/src/lab/hidden-funnel.ts --suite hidden,heldout,heldout2,heldout3,heldout4 --no-record --config "$FX"
for j in none perfect; do for sd in 41 42 43 44; do
  bun packages/sim/src/quality-cli.ts --profile realistic --seed $sd --planner --judge $j --config "$FX"
done; done
```
