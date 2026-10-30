# One occurrence, one line; the event a request names (PoC, flags off)

Status: 2026-10-30. Follows [sharper-grounds.md](sharper-grounds.md) (D48). Three flags, all off by default; no
model call, no new source call, no dependency. Every number below comes from commands run in this work (simulation
`quality-cli.ts --planner`, realistic profile, seeds 41–44; funnel `hidden-funnel.ts --no-record` over hidden and
held-out 1–4). Held-out 5 and 6 were neither run nor read.

`F` is D48's recommended set; `FX` is `F` plus `densePacket` and `groundOccasion`.

## Where the packet's bytes went

A dump of F's perfect-judge packets (seeds 41, 42: 271 packets, 118 KB) showed the envelope at 17%, lines holding a
needed fact at 51%, and 6% in lines whose facts an earlier line of the same packet already stated. Most of those were
one occurrence told three times: the calendar event, the invitation mail for it ("Invitation: Lunch with Nadia @
Wednesday 4 Nov 10:30 … Lunch with Nadia Wednesday 4 Nov ⋅ 10:30 Padella, London Join with Google Meet: …"), and the
reply that booked it ("Perfect, booked Padella for Wednesday 10:30.").

## `densePacket`

- **Folding echoes** (`fold.ts`). An item is an echo of one ranked above it in the packet when both pin the same
  weekday and time (an occurrence anchor read from the text: "Monday 2 Nov 2026, 18:00", "Fri at 19:00", "@ Monday 2
  Nov 18:00") and everything it adds is common in the user's own items: no number, no time, no capitalised name or
  place, no word on fewer than 3% of the user's cached items (`ItemCache.isRare`, from the index's idf), no word that
  says the occurrence changed or is constrained ("moved", "cancelled", "not before", "leave by"). The echo leaves the
  packet's text and citations; the ledger still marks it delivered. Rarity is the user's own: a cache too small for a
  share to mean anything makes every word rare, so nothing folds.
- **Compaction** (`messageParts` with `dense`): a notification's echo of its own subject (a run of four or more of the
  title's words, longest common runs against at most 32 title words: linear), a footer run into a line, the user and
  the people the title names in an attendee list, a greeting by the time of day ("Morning Robin, …"), stock
  courtesies ("Sorry for the slow reply"); and a sentence no longer ends at "St." or "Dr." (it split "booked St. John"
  in two, and the second half was dropped as already shown).
- Tried and left out: dropping a mail's sent time of day ("Date: Tue 20 Oct 09:14"): 5 bytes a line, and it lost a
  stated fact in the simulation.

## `groundOccasion`

With no model's say, the event a request names the way people name one (`Partner.occasion`): its title holds the
request's occasion word and every word of a name it uses, a first name alone included ("what time am I seeing Nadia
for lunch?"); or, for a question, its occasion on a day the request names ("where are we having lunch on Monday?");
or, for a message from someone about meeting, the event whose title names them ("running late, still ok to
meet?"), rather than their best-scored event. The one on a named day wins, else the soonest still to come. A named day
no such event is on grounds nothing: "send Jamie an invite for drinks Saturday" is about a new occasion, and an
existing drinks on Tuesday is not it (this guard brought back the one funnel fact an earlier version lost).

## `recoverNames` (measured, not recommended yet)

Names typed in lowercase ("please reschedule my drinks with chen wei") ground and fall back as capitalised ones do,
when the source map has recorded the user's own sources mentioning the run (two or three words, typed lowercase,
none a stopword or a date). Used on the no-model path only; probes and ranking keep the request as typed. Realistic,
no model: recall +0.005, precision −0.004 over FX; on an earlier build of this branch, zoo-a recall −0.003 and zoo-b
+0.021 with its soft fire rate 0.367 → 0.400. Mixed, so left out of FX.

## Results

Simulation, realistic, 4 seeds:

| | No model: recall, stated, precision | Perfect judge: recall, stated, precision | Bytes / needed fact (perfect) | Calls / lookup | Model $ / 1k turns | Hard false fires |
|---|---|---|---|---|---|---|
| F | 0.326, 0.309, 0.588 | 0.613, 0.575, 0.949 | 484 | 7.86 | 0.0200 | 0 |
| FX | 0.357, 0.339, 0.615 | 0.612, 0.575, 0.946 | 444 | 7.91 | 0.0200 | 0 |

Stated recall with the judge is unchanged (435 of 757 needed facts in both); delivered recall is one fact lower (a
folded reply the simulation credits with a constraint only its quoted part holds). Calls per lookup rose 7.86 →
7.91 although neither flag sends a call: the planner learns from usage of what packets show, and the packets differ.
Whether that is noise was not measured (unverified).

Out of sample (2 seeds each):

| | zoo-a no model | zoo-a perfect | zoo-b no model | zoo-b perfect |
|---|---|---|---|---|
| F | rec 0.347, prec 0.636, soft 0.217 | rec 0.560, prec 0.952, 516 B/fact | rec 0.344, prec 0.576, soft 0.367 | rec 0.681, prec 0.960, 469 B/fact |
| FX | rec 0.362, prec 0.627, soft 0.250 | rec 0.560, prec 0.952, 473 B/fact | rec 0.368, prec 0.585, soft 0.367 | rec 0.679, prec 0.957, 425 B/fact |

No hard false fire in any run; zoo-a's soft fire rate with no model rose 0.217 → 0.250.

Funnel, no model, hidden + held-out 1–4 (268 tasks each way): F and FX both return 130, deliver 58 hidden facts and
40 decoys at 7.2 calls per task. Both flags act on what is retrieved; neither moves the funnel's planted facts, which
are mostly constraints that do not name an occasion.

The eval (`bun run eval`) is unchanged: precision 1, recall 0.444, falseFireRate 0.

## Reproduce

```bash
FX='{"probes":true,"compactInjection":true,"quietSettled":true,"groundAway":true,"judgeContested":true,"judgeItemBytes":200,"probeShare":true,"probeTopicAlone":true,"fallbackAsks":true,"densePacket":true,"groundOccasion":true}'
for j in none perfect; do for sd in 41 42 43 44; do
  bun packages/sim/src/quality-cli.ts --profile realistic --seed $sd --planner --judge $j --config "$FX" > fx-$j-$sd.json
done; done
bun packages/sim/src/lab/hidden-funnel.ts --suite hidden,heldout,heldout2,heldout3,heldout4 --no-record --config "$FX"
```
