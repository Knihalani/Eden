# Supersession: surface what the user's items say now (track supersede)

Decision: D81, proposed, flags `supersede` and `supersedeThreads`, both off by default. Developed and chosen on the
development suites `dev6a` and `dev6b` and the old in-sample suites (`hidden`, `heldout`, `heldout2`–`heldout4`) only.
Held-out 5–11 were not run or read. No model call and no OpenRouter spend: cards are replayed from
`packages/sim/lab/cards/cards-v2.jsonl`. Every number below comes from `hidden-funnel.ts` runs in this session (4 seeds,
ALL3 of D80 plus the flag, `--ask`, `--cards`); dev and in-sample are reported apart.

## The question

The live held-out run behind D80 says ranking and surfacing are the lever and precision is the risk: decoys are
near-miss twins of the planted item (resolved, expired, another date, another entity), and the agent raises a false
concern when Eden surfaces the stale or resolved twin. In the no-model funnel the precision proxies under ALL3 are:

| | dev (240 + 240) | in-sample (268 + 268) |
|---|---|---|
| hidden either (delivered or ask-cited) | 122 | 244 |
| control delivered (decoy in a packet) | 10 | 17 |
| control askCited (decoy cited by `ask`) | **91** | **148** |

The leak is the `ask`, not the packet: the answer cites the decoy in 38% (dev) and 55% (in-sample) of control tasks.
The answer takes the five best-scored items, and a resolved twin shares every word with the request.

## Diagnosis

`--ask-diag` dumps each ask candidate's `decide.ts` facts. Of the planted items the answer cited:

| fact of the cited planted item | hidden (366 cited) | control (239 cited) |
|---|---|---|
| conflict test says `clear` | 4 | 125 |
| conflict test says `conflict` | 246 | 0 |
| `settled` (done/resolved words), no conflict, about the request, not a question | 0 | 12 |

The conflict test (`conflict.ts` `assess`) already reads the decoy's latest state (a hold lifted, a booking confirmed,
a return filed with "nothing more needed", a DPA that permits the transfer): the packet path acts on it (`quietClear`,
D48), the `ask` did not. The four hidden `clear` readings are one template (`heldout3/gym-plan-discontinued`, a plan
retired from 1 November read as clear against "same plan as this year"): a misreading the packet path already makes.

Requests in the suites are almost all actions: of the 125 control `clear` cites, 122 are actions, 3 questions.

## The mechanism (`supersede`)

1. **Across items** (`supersede.ts` `supersededIn`): the candidates are grouped by matter, the subject once
   "Re:"/"Fwd:" prefixes are stripped (per source, at least 8 characters) and each identifier the title names
   ("OPS-142"); each group is ordered by when its items were written (the message's `Date:`, else `updatedAt`); an
   item is superseded and dropped by the newest newer item that is decisive (the conflict test says `conflict` or
   `clear`: lifted, extended, moved, cancelled, re-imposed) **and speaks to the same constraint**: its deciding
   statement shares a word with the older item's (the statements behind its verdict when it has one, else its own
   words), the request's names left out and a constraint's irregular forms folded ("frozen"/"freeze", "held"/"hold";
   `conflict.ts` `matterWords`). A newer "thanks, will do" reply decides nothing and hides nothing; a newer "billing
   address change resolved" or "invoice INV-12 paid" in the same thread is decisive but about another point, and does
   not hide "on credit hold, no new orders" (review fix: before it, any decisive newer item in the group won).
   Applied to the `ask` pool and to every proactive packet of more than one item. In a packet, a clearance that
   replaced an item is dropped too (the agent never saw the block it lifts), and a packet left empty is not sent:
   silence, not a fire carrying only "freeze lifted" (review fix).
2. **Latest state of one item, for an action** (`ask` only): an item about the request whose latest state is settled
   (the conflict test clears it, or it says done/resolved and nothing in it conflicts) is dropped when the request is
   not a question. The action meets nothing there, and a lifted hold read by an agent is a concern raised for nothing.
   A question keeps it: "Is the Globex hold still on?" is answered by "hold lifted 12 Oct".
3. The answer is read in rank order until its five items are kept, so a dropped item makes room for the next.

`supersedeThreads` (separate flag): the conflict test reads a reply's quoted messages oldest first
(`chronological`). A reply quotes newest first, and `assess` lets a clearance after a block win: with the quotes
reversed, an older quoted "lifted" after a newer "the hold is back on" read as clear.

No model call, no source call, no new dependency. Verdicts are memoised per cue and item while `supersede` is on (the
ask's facts already computed most of them).

## Results (ALL3 vs ALL3 + `supersede`)

| | dev ALL3 | dev + supersede | in-sample ALL3 | in-sample + supersede |
|---|---|---|---|---|
| hidden either | 122 / 240 | 122 / 240 | 244 / 268 | 245 / 268 |
| hidden askCited | 122 | 122 | 244 | 241 |
| control delivered | 10 | 10 | 17 | 17 |
| control askCited | 91 | **52** (−43%) | 148 | **62** (−58%) |
| bytes per ask answer | 661 | 643 (−2.7%) | 638 | 599 (−6.1%) |
| bytes per packet | 353 | 353 | 341 | 336 (−1.5%) |
| packets | 256 | 256 | 437 | 437 |

Eden's wall time per task, two interleaved pairs of runs (base, supersede, base, supersede) on a machine shared with
other jobs, so read the direction, not the digits: `observe` dev 14.41 / 14.11 ms → 13.28 / 13.00, in-sample 11.36 /
10.79 → 10.50 / 9.48; `ask` dev 8.42 / 8.08 ms → 7.37 / 7.48, in-sample 9.61 / 9.41 → 8.04 / 7.63. The flag is not
slower: the verdict memo it brings saves more than the grouping costs. (Before the memo, one pair measured `ask`
+1.0 ms dev and +1.8 ms in-sample.)

Per suite (each suite's numbers are its own; nothing is fitted):

| suite | hidden either | control delivered | control askCited | bytes/ask |
|---|---|---|---|---|
| dev6a | 61 → 61 of 120 | 6 → 6 | 52 → 33 | 679 → 677 |
| dev6b | 61 → 61 of 120 | 4 → 4 | 39 → 19 | 643 → 609 |
| hidden | 40 → 40 of 40 | 4 → 4 | 19 → 7 | 703 → 657 |
| heldout | 39 → 39 of 48 | 0 → 0 | 19 → 8 | 585 → 549 |
| heldout2 | 56 → 56 of 60 | 1 → 1 | 39 → 8 | 678 → 655 |
| heldout3 | 52 → 52 of 60 | 4 → 4 | 36 → 27 | 522 → 489 |
| heldout4 | 57 → 58 of 60 | 8 → 8 | 35 → 12 | 713 → 655 |

Hidden either never falls: the four `gym-plan-discontinued` asks lost are still delivered in a packet; one
`incident-access-suspended` ask is gained (a superseded twin made room). The reduction holds on every suite.

### What was tried and not kept

- **Date coverage** ("when a request names a date, prefer items whose stated spans cover it"): the ask's dated items
  (events) on none of the named days, by their own day, a day they name, or a stated span or limit covering it, moved
  after the rest. Neutral: control askCited dev 56 → 59, in-sample 70 → 68, hidden unchanged (241); without span
  coverage it cost 6 hidden asks (`cat-feeding-friend-away`, `change-freeze`, `counsel-on-leave`: absences and freezes
  whose span, not start, covers the day). Removed. The decoys of another date are mostly documents and mails, not
  events, and those are already ranked by the request's own days.
- **Thread chronology** (`supersedeThreads`): no change on any suite (with `supersede`: control askCited 52 and 62, hidden either 122 and 245, the same task by task). Kept as a flag, not recommended:
  the suites' decoys put the deciding statement in the newest message, so the order never flips a verdict here.
- **Cross-item groups**: removing them changes one task each way (in-sample control askCited 61 vs 62, hidden 240 vs
  241). Each task plants one item, so the suites hold no newer item superseding an older planted one: the mechanism is
  tested by unit tests (`supersede.test.ts`), not measured by the funnel.

### Honest estimate

Nothing is learned: no weight or threshold was fitted, so leave-one-suite-out cross-validation has nothing to refit.
The choices made on the pooled dev and in-sample suites were (a) adding the `settled` rule, which removes 12 control
cites and no hidden in every suite where it acts (dev6a, heldout2, heldout3), so every leave-one-suite-out fold would
choose it; and (b) dropping date coverage, neutral in total. The per-suite table is the honest spread.

## Risks

- **The funnel asks the request's own text**, nearly always an action. A live agent phrases `ask_context` its own way;
  a question-phrased ask ("anything about the Globex order?") keeps settled items, so the live gain may be smaller.
  The next step is reading the asks `pi-ab.ts` now records (a dev run) and, if agents ask questions, deciding by the
  session's user request rather than the ask's phrasing.
- **The conflict test's misreadings become drops**: a hidden item it wrongly reads as `clear` leaves the answer
  (4 of 366 cited hidden asks here, all one template, still delivered in a packet). The packet path has had the same
  exposure since `quietClear`.
- **A dropped settled item is information the agent no longer gets** ("booking confirmed"): for an action that is
  silence by default; for a question it is kept.
- Grouping by subject can join two matters that share a subject line ("Invoice", 7 characters, is below the minimum;
  "Monthly invoice" is not): only a newer decisive item supersedes, and only within one source.

## Flags off

`bun run eval` on this branch and on `origin/main`: identical apart from latency (precision 1, recall 0.444,
falseFireRate 0, 20 of 45 delivered, 27 scenarios). `bun run check` green (1109 tests).

## Reproduce

```bash
CFG='<ALL3 of D80, plus "supersede":true>'
bun packages/sim/src/lab/hidden-funnel.ts --suite dev6a,dev6b,hidden,heldout,heldout2,heldout3,heldout4 --no-record \
  --config "$CFG" --cards packages/sim/lab/cards/cards-v2.jsonl --ask --json out.json --packets out-packets.jsonl
```

`hidden-funnel.ts` now also records `askMs` (the `ask` call's wall time) per task.
