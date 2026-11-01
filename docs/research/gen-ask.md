# Ask answers that cite what the question runs into (track ask)

Decisions: D73 (`askVerdicts`) and D74 (`askCompact`), proposed, both off by default (the track's single D73,
renumbered when the tracks were combined: docs/research/gen-combined.md). Development used the two new development
suites `dev6a` and `dev6b` and the old in-sample suites (`hidden`, `heldout`, `heldout2`–`heldout4`). Held-out 5–9 were
not run or read. $0 model spend: no OpenRouter call was made, and cards are replayed from
`packages/sim/lab/cards/cards-v2.jsonl` only. Dev results and in-sample results are reported apart; dev is the
generalisation signal.

## The question

The blind live run (docs/research/econ-synthesis.md, "Results") showed that the facts lever is surfacing: a planted item
that reaches the agent in an `ask_context` answer is raised 0.910 of the time. In the no-model funnel with `--ask`
(Eden asked the request's text), the in-sample answer cites the planted item in 191 of 268 tasks, though with sync every
planted item is in Eden's cache. Why does the answer miss the other 77, and can it cite more at the same or fewer
answer bytes?

## Instrumentation (lab only)

- `PartnerDeps.onCandidates` now also reports the ask's candidates (path `"ask"`): the ranked list with each candidate's
  `decide.ts` facts, and what the answer cited. Ids and numbers only. With no hook, nothing is computed.
- `hidden-funnel.ts --ask` records each task's `askBytes` (the answer's size) and `askItems` (its citations), and, when
  the planted item is cited, `askKept`: of the task's `detail` key words (numbers, words of four letters or more) that
  the planted item holds, the share the answer's text holds too. A proxy for "the answer says the fact", not a grader.
- `hidden-funnel.ts --ask-diag out.jsonl` writes per task the planted id, whether it was cached, its rank among the
  ask's candidates, the cited ids, the candidates' facts, and the answer's text (sim data only).
- `pi-ab.ts` records each `ask_context` call's question (through `sanitizeForStore`, at most 500 characters), the ids
  its answer cited and its bytes, on the task line (`asks`, `UptakeLog.answer`) and as a timeline point (`eden.ask`).
  The sim's data is fake; the point is that a later run can replay the questions agents really ask, which the funnel
  cannot (it asks the request's own text).

All runs: ALL (D64's configuration, as given for this track), seeds 41–44, real sync, cards replayed, `--ask`. Command:

```bash
bun packages/sim/src/lab/hidden-funnel.ts --suite dev6a,dev6b --no-record --config "$CFG" \
  --cards packages/sim/lab/cards/cards-v2.jsonl --ask --json out.json --ask-diag diag.jsonl
```

The flags-off baseline matches main exactly (in-sample delivered 218, ask cites 191, either 240 of 268; decoys
delivered 18), and turning the hook on changes nothing.

## Diagnosis

Every ask miss had the planted item in the cache (dev 132 of 132, in-sample 77 of 77). The misses are ranking.

| | ask misses | planted absent from the ask's top 64 | rank 0–4 | rank 5–9 | rank 10+ |
|---|---|---|---|---|---|
| dev6a + dev6b | 132 of 240 | 99 | 8 | 15 | 10 |
| in-sample | 77 of 268 | 49 | 2 | 10 | 16 |

The ask ranked only what shares the question's words (`ItemCache.search`, top 12), the probes' finds and a named day's
events. It did not gather what the lookup gathers: the consequence probe's finds, the knowledge graph's walk, the card
finds. Of the 77 in-sample misses, the planted item was among some lookup's candidates in 75; in dev, in 43 of 132.

What outranked it: items that share the question's names and words. In-sample, the missed planted items scored 0.23 on
average (entity hit 0.00, mentions a named person 0.00), the items cited in their place 0.67 (entity 0.76, mentions
0.76). In dev, 0.32 against 0.55.

What the engine already knows about the planted item: in-sample, 198 of 268 planted items carry a verdict that a rule
path delivers on (`graphHit`, a consequence find in conflict, a violated card, `conflictHit`), 52 of them among the ask's
misses; only 6 of 268 decoys do. In dev, 48 of 240 planted items carry one, and only 1 among the misses.

Why dev differs: cards. No dev item has a replayed card (the replay file predates the suites: 339 items uncovered in the
dev runs, against 114 in-sample, and 0 of 240 dev planted items carded, against 103 of 268 in-sample). The graph walk
reaches 86 of 240 dev planted items, but its conflict test fires on one. Most dev items are tied to their request by an
implication (a hire car and a lapsed driving licence, a half marathon and a physio's advice) that no lexical, graph or
frame test bridges: dev's 99 absent items need cards (live enrichment, not allowed here) or knowledge Eden does not have
without a model.

## Change 1: `askVerdicts`

The ask gathers the lookup's candidates (the consequence probe's finds, the graph walk, the card finds) and answers first
with those carrying a rule path's verdict, best scored first: `conflictHit` (a conflict with the question's frame that is
about it and tied beyond a name), `graphHit` (a binding walked item in conflict), a consequence find in conflict tied by
its class's words, or a violated card. Then the grounded items and the lexical ones, as before. Same item limit (5). No
model and no source call: the walk and the card match read the cache, and the facts are the ones `decide.ts` reads.

## Change 2: `askCompact`

The answer is compacted as a packet is: `compactText` around the question's words, `askItemBytes` (320) per item, the
current year dropped, the user's own name shortened, with `densePacket` the title echo and footers dropped, a part that
only repeats words the answer already shows dropped (an invitation, its event and the reply confirming it), and with
`densePacket` an echo of an occurrence folded out (`fold.ts`). Items past the first `askFullItems` can be cut to
`askLineBytes` (a line each, so a lower-ranked item stays in the answer, shorter); the default keeps all five full,
because the measured tail cut costs detail (below). Citations are unchanged.

## Results

Hidden: tasks whose answer cites the planted item. Control: tasks whose answer cites the decoy (the precision proxy;
lower is better). Either: delivered in a packet or cited by the ask. Bytes and items: per ask, over hidden and control.

**Development suites (dev6a, dev6b)**, 120 hidden and 120 control tasks each:

| config | suite | ask cites (hidden) | ask cites decoy (control) | either | bytes/ask | items/ask | askKept |
|---|---|---|---|---|---|---|---|
| ALL | dev6a | 58 | 53 | 59 | 1,229.5 | 3.6 | 0.937 |
| ALL | dev6b | 50 | 42 | 50 | 1,161.5 | 3.6 | 0.982 |
| ALL + askVerdicts | dev6a | 59 | 52 | 59 | 1,283.1 | 3.7 | |
| ALL + askVerdicts | dev6b | 50 | 39 | 50 | 1,248.2 | 3.8 | |
| ALL + askCompact | dev6a | 58 | 53 | 59 | 689.9 | 3.6 | 0.883 |
| ALL + askCompact | dev6b | 50 | 42 | 50 | 670.1 | 3.6 | 0.982 |
| ALL + both | dev6a | 59 | 52 | 59 | 716.4 | 3.7 | 0.905 |
| ALL + both | dev6b | 50 | 39 | 50 | 715.0 | 3.8 | 0.982 |
| ALL | **dev total** | **108/240** | **95** | **109** | **1,195.5** | 3.6 | 0.958 |
| ALL + both | **dev total** | **109/240** | **91** | **109** | **715.7** | 3.8 | 0.940 |

(`askKept` was added to the funnel after the askVerdicts-alone run.)

**In-sample suites** (hidden, heldout, heldout2–4), 268 hidden and 268 control tasks:

| config | ask cites (hidden) | ask cites decoy (control) | either | bytes/ask | items/ask | askKept |
|---|---|---|---|---|---|---|
| ALL | 191 | 143 | 240 | 1,253.6 | 3.8 | 1.000 |
| ALL + askVerdicts | 244 | 148 | 244 | 1,310.5 | 4.0 | |
| ALL + askCompact | 191 | 143 | 240 | 716.6 | 3.7 | 0.986 |
| ALL + both | **244** | **148** | **244** | **775.8** | 3.9 | 0.987 |

Per in-sample suite with both flags (ALL in brackets): hidden 40 (32), heldout 39 (26), heldout2 56 (46), heldout3 52
(40), heldout4 57 (47).

Where the 53 in-sample gains came from (the planted item's verdict in the ask's candidates): `graphHit` alone 24, a
violated card alone 11, card and graph 9, all three with `conflictHit` 3, `conflictHit` alone 2, a consequence find in
conflict 4. No hidden task lost its citation. The 6 decoys newly cited (one lost) were all violated cards alone. Of the
24 in-sample misses left, 23 rank 5th or lower among the ask's candidates (3 at 5–9, 13 at 10–19, 7 lower) and 1 is
absent from them; in dev, 91 of the 131 misses left are absent.

Tail cut (`askFullItems`, `askLineBytes`), both flags on, totals (the first two rows without the echo fold; with it,
2 / 160 measured 663.8 and 0.918 on dev, 727.9 and 0.976 in-sample):

| askFullItems / askLineBytes | dev bytes | dev askKept | in-sample bytes | in-sample askKept |
|---|---|---|---|---|
| 2 / 160 | 665.3 | 0.918 | 730.2 | 0.976 |
| 3 / 200 | 702.4 | 0.929 | 764.0 | 0.987 |
| 5 (no cut, default) | 715.7 | 0.940 | 775.8 | 0.987 |

The cut saves 13–50 more bytes per ask and loses detail where the planted item sits third or lower (dev: 11 of 16 such
answers short of a key word with 2/160). `askItemBytes` 480 instead of 320 (no cut, no fold) raised dev bytes from
717.2 to 756.7 and dev askKept only from 0.940 to 0.946: most of the detail lost is compaction choosing the wrong parts
(a reply's "Perfect, thanks." kept over its quoted thread), not the cap.

## Reading

- **askVerdicts** turns the engine's existing verdicts into ask ranking. In-sample it lifts the ask's citation of the
  planted item from 191 to 244 of 268 (+20 points) with decoys 143 to 148, but most of those tasks already had the item
  in a packet: "either" moves 240 to 244. On the development suites it moves nothing that matters: 108 to 109 hidden,
  95 to 91 decoys, either unchanged. It generalises only as far as the verdicts do, and on dev they do not fire: no dev
  item has a card here, and the graph's conflict test fires on one. Live, cards are made for every item as it is synced,
  so dev's figure is a floor for the card share of the gain (23 of the 53 in-sample gains involve a card), not a
  measurement of it. The other 30 in-sample gains (graph, conflict, consequence) are card-free and did not reproduce on
  dev at all.
- **askCompact** is the cost lever: answer bytes fall 40% on dev (1,195.5 to 715.7 with both flags) and 38% in-sample
  (1,253.6 to 775.8), citations unchanged. The price is the detail proxy: dev 0.958 to 0.940 (dev6a 0.937 to 0.905),
  in-sample 1.000 to 0.987. About 480 bytes is roughly 120 agent input tokens per answer (an estimate at about four
  bytes a token, not tokenised), each time the answer is in the agent's context.
- What would move dev: dev's 91 planted items still absent from the ask's candidates are reachable only through
  implication (cards made live, or a model). The session's request as context for a narrower question, a graph walk
  from the question's entities beyond what `walkGraph` does, and the questions agents really ask could not be measured
  in the funnel, which asks the request's own text; the pi-ab recording above makes the last one measurable next run.

## Verdict

Adopt both behind their flags, off by default (with every flag off, `bun run eval` equals main's except latency: p50
0.489 to 0.472 ms, p95 5.01 to 3.92 ms, one run each). Do not add either to ALL on this evidence: the development
suites show no facts gain for `askVerdicts` and a small detail loss for `askCompact`. Both go into the next
pre-registered live comparison as `ASK = ALL + askVerdicts + askCompact` against ALL, read on uptake (raised given
reached) and on agent input tokens, with cards enriched live for the blind suites.

## Risks

- `askVerdicts` widens what an ask reads: the graph walk and card match run per ask (both bounded: `graphBudgetMs`,
  `graphItems`, `MAX_CARD_FINDS`), and `factsOf` over at most `decideCandidates` (64) candidates. No model, no extra
  source call; the ask is not on the fast path.
- With `askVerdicts`, an answer built from a graph walk carries the walk's mask like a lookup's packet, so with
  `graphLearn` the agent's use of an answer trains the graph's weights too.
- A violated card alone is the weakest verdict: it brought 11 hidden items and 6 decoys in-sample. A live card model
  that over-flags would put more decoys first in answers.
- `askCompact` can drop the sentence that matters when compaction picks the wrong parts (quoted threads, tables);
  askKept is a word-overlap proxy, not a grader, and the live raise rate of a compacted answer is unmeasured.
- Dev suites carry no cards in the replay; enriching them live was not allowed here, so dev cannot show the card
  share of the gain either way.
