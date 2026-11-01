# Proactive delivery on new templates (track gen/proactive)

Proposed decision: D75 (`conflictVocab`, off by default; the track's D73, renumbered in
docs/research/gen-combined.md). Branch `gen/proactive`, from `main` (0bc877deb) with the two new development suites merged in (`gen/dev6a`, `gen/dev6b`). No model call and no OpenRouter spend in this
track. Held-out 5–9 were not run or read.

## The question

The blind run (docs/research/econ-synthesis.md, "Results") says the facts lever is surfacing: a planted item that
reaches the agent in a packet or an ask answer is used 85–91% of the time, and 176 of 428 blind tasks had it in
neither. With sync, every planted item is in Eden's cache; the misses are ranking and decision, and the in-sample
tuning that raised the old suites did not carry to the blind ones. This track asks: on templates written after D72
(dev6a and dev6b, 30 templates each, three lexical bands: no shared word, a shared name, a shared topic word), why is
the decisive item not delivered proactively, and which of those reasons are general enough to fix without the suite?

## Method

- Configuration: ALL (D64) as given in the task, cards replayed from `packages/sim/lab/cards/cards-v2.jsonl`, real
  sync, seeds 41–44, `--ask`, `--candidates`:
  `bun packages/sim/src/lab/hidden-funnel.ts --suite <list> --no-record --config "$CFG" --cards
  packages/sim/lab/cards/cards-v2.jsonl --ask --json out.json --candidates cand.jsonl`.
- Cards for the dev suites are not in the replay file: **339 of 2,785** items sent for carding were uncovered on the dev
  run (no card), against 114 of 6,660 on the in-sample run. They were not enriched live (no spend); an uncovered item
  simply has no card.
- Each dev hidden miss was classified from the candidate dump (cached for all of them, via sync): not among the ranked
  candidates at all; a candidate that `conflict.ts` read as `none`, `clear`, or `conflict` but gated or outranked.
  Then the request and the item were read side by side (dev suites only) to name why the verdict missed.
- Fixes were kept only when they are a general reading rule or ordinary English vocabulary, defensible without the
  suite, and each has a unit test written with its own example text (`conflict-vocab.test.ts`), not the suite's.

## Where the dev misses sat (ALL, before)

Hidden variant, 240 tasks (dev6a + dev6b, 4 seeds):

| class | tasks |
|---|---:|
| delivered | 49 |
| not a ranked candidate (shares no searchable word; reached by no probe or walk) | 89 |
| a candidate, `about`, verdict `none` (the conflict test did not read the block) | 64 |
| a candidate, not `about` (verdict `none`) | 26 |
| verdict `clear` (dropped by `quietClear`) | 10 |
| a conflict hit outranked by other conflicts in a three-item packet | 2 |

The 64 + 10 were the actionable group. Read against their items, the verdict misses were general gaps:

- **Missing vocabulary** for a block: "until further notice", "not signed", "revoked", "I'm off from 26 Oct",
  "credit hold", "hold every send", "no new spend", "no commercial concessions until …" (the existing pattern
  allowed one adjective), "scrapped", "dropped in favour of", "in the garage", "Mum's off to …", a standing
  constraint ("stopped drinking"), a security alert ("from a device we don't recognise").
- **Idioms read as blocks**: "Can't wait for Friday" was a block (a decoy fired on it); sign-off courtesies
  ("Happy to jump on a call if easier") were read as a clearance (`CLEARS` has "happy to") and undid a real block
  before them ("Please don't pay it yourself").
- **Date parsing gaps**: a day of the month alone ("till the 10th"), a weekday after an end word ("until Sunday"),
  "back 9 Nov" (away until the day before).
- **Party ties**: possessives did not tie ("Leila's", "Aperture Labs'"); in a table, a row about another party
  ("| Pied Piper | Approved |") cleared the conflict of the row the request names, and the row above tied a row
  below it; a flattened table was one sentence.
- **Sibling references**: another domain ("renew northwind-events.com" against an item about northwind-promo.com) was
  not a sibling, so its "do not renew" fired as a decoy.
- **Gates**: `quietNameOnly` exempts an imperative request, but "Transfer", "Renew", "Raise", "Pick", "Reserve" did not
  count as leading verbs. `quietClear` dropped items only because of the courtesy and table-row clearances above.
  `judgeTied` never decided a dev miss (no model in the funnel).

Not fixed (not general, or not a reading problem): the 89 non-candidates (a role, an organisation behind a person or
plain meaning links them; no shared word: retrieval, not decision); numbers set against each other ("Total
confirmed: 17" against "for 24 people", "drop to 7 seats" against "12 seats"); a quoted older message holding the
decisive line beyond the cached preview (nda-lapsed, accountant-needs); a clash with a non-scheduling request
(class-photo); questions ("how much can I pay into my pension"); `decideConflict`-style joining of a conflict to a
confident packet (rejected as part of ALL2, D72; not repeated).

## The change: `conflictVocab` (off by default)

All in `conflict.ts` unless noted; each piece applies only with the flag:

- `BLOCKS_MORE`: the block vocabulary above, every phrase ordinary English for "this cannot go ahead".
- `CLEARS_MORE` / `REVERSAL_MORE`: "released", "back to normal", "resumed", "reopened", "up and running", "now signed".
- `STANDING_MORE` (read like a standing constraint, whatever its date): not drinking, pregnant, halal, kosher,
  nut/gluten/dairy-free, and security alerts ("don't recognise", "unrecognised", "compromised", "fraudulent").
- `IDIOMS` blanked before reading ("can't wait", "no worries", "no problem", "never mind", "don't worry", "no rush");
  `COURTESY` sentences skipped ("happy to jump on a call", "if easier", "let me know what you think").
- Dates: `BACK_DATED`, `ORDINAL` (next such day of the month), `WEEKDAY_END` (next such weekday after an end word).
- Ties: possessives stripped from request names, word ties and item words; table rows are statements of their own
  (also when flattened onto one line); a row is not tied by the row above; a row about another party does not undo a
  conflict tied to the named one (prose still may: "SSO was blocked, but the cert came through and the date holds").
- References: a domain name is an identifier (not an address's domain, not inside a path), so another domain is a
  sibling and clears.
- `probes.ts` `MORE_VERBS` and `Partner.imperative`: more leading verbs for `quietNameOnly`'s imperative exemption and
  the graph's "engaged" test. `LEADING` itself is not widened (it also cleans names).

CPU only, no state, no source call, no model call. With the flag off every path is the old one (`bun run eval` equal
to main's but for latency, checked by diffing the JSON without latency fields).

## Results (no model, seeds 41–44)

ALL vs ALL + `conflictVocab`. "Ask" is whether `ask` with the request's text cites the planted item; "either" is a
packet or the ask answer.

**Development suites (dev6a, dev6b), reported separately:**

| | dev6a hidden delivered | dev6b hidden delivered | dev decoys delivered | dev ask cites (hidden) | dev either (hidden) | dev ask cites decoy |
|---|---:|---:|---:|---:|---:|---:|
| ALL | 25/120 | 24/120 | 14/240 | 108/240 | 109/240 | 95/240 |
| ALL + conflictVocab | 38/120 | 59/120 | 10/240 | 121/240 | 122/240 | 95/240 |

Dev delivered 49 → 97 of 240 (+48), decoys 14 → 10. No dev task lost a delivery it had. The four fewer decoys are
the domain sibling (dev6b domain-retired, 4/4 → 0/4); the "can't wait" decoy was below the packet anyway.

**Old in-sample suites (hidden, heldout, heldout2–4):**

| | hidden delivered | decoys delivered | ask cites (hidden) | either (hidden) | ask cites decoy |
|---|---:|---:|---:|---:|---:|
| ALL | 218/268 | 18/268 | 191/268 | 240/268 | 143/268 |
| ALL + conflictVocab | 216/268 | 17/268 | 191/268 | 239/268 | 143/268 |

Per task: heldout2 po-threshold lost one hidden and one decoy delivery (the wider verbs let a name-tied "travel over
£500 needs pre-approval" conflict take a packet slot; it was already a conflict); hidden already-sent lost one (the
courtesy rule removed a "Happy to jump on a call" that had been masking an unrelated "I can't do anything before
08:30" as a graph conflict). The first draft of the party rule applied to prose too and raised in-sample decoys to 25
(heldout2 sso-blocked, heldout4 invoice-disputed: a clearance in the same message that does not repeat the name); it
was narrowed to table rows before these numbers.

Ablation, the wider verbs alone off (`conflictVocab` otherwise on): dev 89/240, decoys 14; in-sample 217/268,
decoys 18. The verbs are +4 dev hidden, −1 in-sample hidden, −1 in-sample decoy.

`bun run eval` with ALL vs ALL + `conflictVocab`: identical metrics (precision 0.909, recall 0.444, falseFireRate
0.0167) on the final tree (an earlier run differed only in `plannedLookups`, 95 vs 94). With every flag off, the
eval equals main's but for latency.

Cost: no model call and no source call. Engine CPU, seeds run serially (`--serial`, the funnel's task CPU): in-sample
6.97 s → 7.10 s over 536 tasks (+2%), dev 5.01 s → 5.29 s over 480 (+6%). A first draft scanned every item for domain
names and cost +15% in-sample; the scan now runs only when the request names a domain. Packet bytes were not measured
here: each new delivery adds a packet the agent reads (its input tokens), as any delivery does.

## What the numbers do and do not say

- **The dev gain is in-sample for this change.** The fixes were found by reading dev misses; the vocabulary was written
  from general usage, but it was chosen because dev items used it. dev6a gained +13 and dev6b +35. Both suites were
  read together, so neither is a held-out check on the other.
- **On suites the fixes were not derived from (the old in-sample ones), the effect is neutral**: −2 hidden, −1 decoy
  of 268. Their remaining misses are other classes (not about, outranked conflicts), not vocabulary.
- So the honest generalisation claim is narrow: the change does not hurt precision anywhere measured, and it raises
  delivery wherever a new template phrases a block in ordinary words the old lexicon lacked. Whether held-out phrasing
  is covered is exactly what the next blind measure must answer.

## Verdict

**Adopt as an opt-in flag, proposed for the next blind measure; not yet part of the recommended configuration.**
Precision held on every suite and the eval, with no cost, so it is safe to carry; the evidence of generalisation is
only that it is neutral off its derivation set.

Risks:

- Vocabulary overreach in real mail: "declined", "rejected", "abroad", "suspicious" appear in unrelated sentences; a
  statement must still be tied to the request (by name, word, sender or title) before it counts, which is what kept
  decoys flat here, but real mail is denser than the sim.
- `WEEKDAY_END`/`ORDINAL` resolve to the next such day: "by Friday" in a message from last week means last Friday.
- The courtesy rule exposes blocks a courtesy used to mask (hidden already-sent): those can be real but irrelevant.
- The wider verbs relax `quietNameOnly` for more requests (one in-sample slot lost to a name-tied limit).
- 89 of 240 dev misses are retrieval (not a candidate at all); this change cannot reach them.

## Proposed decision row

| D73 | 2026-11-01 | Proposed (track gen/proactive; docs/research/gen-proactive.md). `conflictVocab`, off by default: the conflict test (`conflict.ts`) reads a wider general vocabulary of blocks (open ends, unsigned, revoked, someone off, holds, no new commitments, plans dropped, things out of action, someone away travelling), clearances (released, back to normal), standing constraints (not drinking, pregnant, halal/kosher, allergen-free) and security alerts; blanks idioms ("can't wait") and skips sign-off courtesies ("happy to jump on a call"), which were read as a block and a clearance; strips possessives in ties; reads a day of the month alone, a weekday after an end word and "back <date>"; reads a table's rows as separate records (a row about another party neither ties nor clears the named one's); counts a domain as an identifier (another domain is a sibling); and widens `quietNameOnly`'s imperative exemption with more leading verbs (`MORE_VERBS`). No model, no state, no source call. Measured with no model on ALL, seeds 41–44: dev6a+dev6b (the suites the fixes were read from) 49 → 97 of 240 delivered, decoys 14 → 10; old in-sample suites 218 → 216 of 268, decoys 18 → 17; eval equal. Not added to ALL until a blind suite says it generalises. |
