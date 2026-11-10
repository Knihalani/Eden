# O3: the push for every request, and a line that asks for the specifics

Status: 2026-11-10, branch `claude/o3-k-behind`, session O3. Decisions D702–D704. Train suites only (train1–6);
heldout18 is not dumped, labelled or run. Paid calls go to Anthropic directly with `HAIKU_API_KEY` through the lab
(D97): **Anthropic-direct lab figures**. Numbers marked **[EST]** are arithmetic or judgement; every other number
comes from a command in this note.

## 0. What the miss decomposition showed (o3-check-behind.md §0)

On train seed 41 the default's agent raised 120 of 192 hidden facts (Sonnet-graded). Of the 72 misses, 42 never had
the fact handed and 30 had it in hand. Two things stand out, neither needing a model call:

- **The push never starts for one hidden request in six.** `observe` starts the push only when `isImperative` knows
  the request's verb (`LEADING` and `MORE_VERBS`, closed lists). On train seeds 41–44, **132 of 768 hidden requests
  start no push** ("Cash in £3,000 of my Premium Bonds", "Top up Maya's dinner account", "Reimburse Oskar the £180",
  "Spin up four more A100 nodes"); the funnel's ask cites the planted item in 100 of them, so the fact is in the
  ranking's top five and nobody hands it. The gate was built to save the reader's paid call (D168 measured a wider
  verb list in that era: +17% reader calls). Since D237 the push hands candidates with no model call, so the gate
  saves nothing; live, an agent with no packet asks less (it asked in 59 of 192 tasks).
- **Handed facts are stated without what to do about them.** Of 24 answers that had the fact in a push packet and
  were graded not raised, about three in four state its core (the band tops out at £54k; hospitality is capped at £75
  a head) and leave out the consequence the user needs (it needs Dana's sign-off; it needs a Finance exception).

## 1. What is built (trials, off)

- **`pushOpen` (D702).** With `pushCandidates`, the push also runs for a message `isOpenRequest` reads as a request
  by its shape: at least four words, not a remark or reply ("Thanks, …", "Yes …"), not a request to be told ("let me
  know …"), and a question mark only on a polite ask ("Can you …?"). The candidates' own gate (a constraint-like
  item in the pool) still decides whether a packet goes. The reader's paid push (`pushCandidates` 0) keeps the verb
  lists.
- **`candidatesSpecifics` (D703).** The candidates' lead adds one line (`CANDIDATES_SPECIFICS`): if an item does
  bear on the request, tell the user what it says and what it means for the request, with the item's own specifics
  (the limit, date, amount or fee, who has to agree, what has to happen first). The check before it and "if it is
  not, ignore it and do not mention it" stand.

## 2. Screen at $0 (funnel, train seeds 41–44 with `-- --neutral`, 768 tasks a variant)

`bun run funnel --suite train --seeds 41,42,43,44 --set '{"pushOpen":true}' -- --neutral`, `n2/compare.py`:

| Arm        | Hidden surfaced | Decoys surfaced | Planted handed in the push | Decoy handed | Neutral packets | Packet KB (hidden / control / neutral) |
| ---------- | --------------- | --------------- | -------------------------- | ------------ | --------------- | -------------------------------------- |
| default    | 634             | 552             | 491                        | 418          | 617             | 964 / 926 / 693                        |
| `pushOpen` | 635 (+1 −0)     | 554 (+2 −0)     | **590 (+99 −0)**           | 510 (+92 −0) | 746             | 1,129 / 1,070 / 826                    |

- The funnel always asks, so its "surfaced" does not move: the facts were reachable by an ask. What moves is where
  they are: in the first packet for 77% of hidden tasks instead of 64%.
- The price is in the same table: look-alikes handed rise as much as facts (+92), and nearly every neutral request
  now gets a packet (617 → 746 of 768), so the packet's tokens are paid on more requests (+19% packet bytes on
  neutral tasks). Whether the agent turns the extra look-alikes into false concerns is what the live run measures.
- `bun run eval` and `bun run eval --config '{"pushOpen":true}'` both read precision 0.65, recall 0.52,
  falseFireRate 0.

## 3. Pre-registration (committed before the first call of the run below)

- **Arms** (pi-ab, the bench recipe, Haiku 5.5 as agent, grader and cards; cards and intent replayed): `eden`;
  `eden~O` = `pushOpen`; `eden~L` = `candidatesSpecifics`; `eden~OL` = both.
- **Stage 1:** train seeds 41–44, hidden, control and neutral, all 192 templates, one seed a process, two at a time.
  **Stage 2:** seeds 45–48 (intent inert there, cards made in-run, as in N5), only for arms whose stage-1 hidden
  difference is at least +3.0 points; the rule is then read on all eight seeds.
- **Grades:** every hidden answer and every control or neutral concern regraded by Sonnet 5.5 (`i3-regrade.ts`);
  intervals by template-clustered bootstrap (`bench_report.py --sonnet`); cost and wall paired by task on the 1:1:8
  mix (`n5/mix.py`).
- **Rule, per arm against `eden`:** put to the owner for the default only if hidden raised is at least **+4.0
  points** with the clustered interval's lower bound above 0; Sonnet-confirmed concerns (control and neutral) are
  not up; wall on the 1:1:8 mix rises by at most **0.1 s**; total cost rises by at most **$0.20 per 1,000 tasks**.
  An arm that raises the agent's bill is the owner's call even when it passes (D112): it is reported, not promoted
  by this session. An arm that fails is deleted with its code and tests.
- **Also reported, no bar:** planted and decoy items handed in the push, `ask_context` calls a task, and the
  packet's share of the agent's bill.
- **Budget [EST]:** $5.5 (four arms, four seeds $3.6; regrade $1.9).
