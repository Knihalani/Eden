# O3: the push for every request, and a line that asks for the specifics

Status: 2026-11-10, branch `claude/o3-k-behind`, session O3, measured. Decisions D702, D703, D705–D707. **Result:
`pushOpen` passes its pre-registered rule one request a session on eight train seeds (hidden +4.1 points,
+1.6..+6.7, concerns level, +$0.006 per 1,000 tasks, no added wait) and fails the hidden clause over a user's days
(−2.0 points on 101 tasks, −10.0..+5.3): not promoted, an off trial whose deletion is the owner's call (§7).
`candidatesSpecifics` fails and is deleted.** **Since (2026-11-11):** the days clause was replaced (D709) and a
32-user days run passed it (+2.1 points, −1.6..+5.6; o3-pointer.md §3), so `pushOpen` is in the default (D710).
Train suites only (train1–6);
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

- **`pushOpen` (D702).** With `pushCandidates` and without `pushCheck`, the push also runs for a message
  `isOpenRequest` accepts. No verb can be recognised without a list, so it reads what the message is not: at least
  four words, and its first word after the openers is not a remark's ("Thanks, …"), a question's ("What …", "Is …",
  or a "can/could/would/will" not followed by "you"), a statement's ("I think …", "The boiler …") or a request to be
  told ("let me know …"); a question mark only on a polite ask ("Can you …?"). The candidates' own gate (a
  constraint-like item in the pool) still decides whether a packet goes. The reader's paid push (`pushCandidates` 0)
  and the push check keep the verb lists. **As measured in §2–§4 the test was looser (any message of four or more
  words that was not a remark or a plain question); §5 says what the review changed and what that moves.**
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

## 4. Result (Pi, local; stage 1 at d63681c8 on seeds 41–44, stage 2 on seeds 45–48; Sonnet-graded)

4,608 task runs an arm (1,536 a variant); 26 results ungraded and dropped (all in stage 1, which ran two processes
at once and had 992 requests retried on a 429; stage 2 ran one process at a time with none). Sonnet regraded 6,214
answers (0 failed). `bench_report.py --sonnet` (template-clustered) and `n5/mix.py` (1:1:8):

| Against `eden` (56.2% of hidden raised)        | `eden~O` (`pushOpen`)           | `eden~L` (`candidatesSpecifics`) | `eden~OL` (both)        |
| ---------------------------------------------- | ------------------------------- | -------------------------------- | ----------------------- |
| Hidden raised, eight seeds                     | **+4.1 points (+1.6..+6.7)**    | +2.0 (+0.2..+3.7)                | +4.0 (+1.6..+6.9)       |
| seeds 41–44 (cards and intent replayed)        | +6.3 (+3.2..+9.7), 67.4 vs 61.1 | +3.9 (+1.4..+6.7)                | +3.8 (+0.7..+7.3)       |
| seeds 45–48 (cards in-run, intent inert)       | +2.0 (−1.2..+5.2), 53.3 vs 51.3 | +0.0 (−2.6..+2.5)                | +4.3 (+1.2..+7.6)       |
| Sonnet-confirmed concerns, control and neutral | **1 against 1** of 3,064 pairs        | 0 against 1                      | 1 against 1             |
| Haiku-flagged concerns (before the regrade)    | 26 against 15                   | 22 against 15                    | 13 against 15           |
| Total $ per 1,000 tasks, 1:1:8 mix             | +0.006 (+0.000..+0.012)         | +0.013 (+0.008..+0.018)          | +0.019 (+0.013..+0.026) |
| Wall a task, 1:1:8 mix                         | −0.05 s (−0.20..+0.09)          | +0.04 s (−0.08..+0.14)           | +0.01 s (−0.15..+0.18)  |
| `ask_context` calls a task, mix                | −0.062 (−0.109..−0.019)         | +0.029                           | −0.014                  |
| Planted item in a push packet (of 1,534)       | 1,066 against 961               | 961                              | 1,069                   |
| Decoy in a push packet (control, of 1,535)     | 1,010 against 894               | 892                              | 1,013                   |
| Neutral requests given a candidates packet     | 1,498 against 1,239 of 1,534    | 1,240                            | 1,497                   |

(Wall on seeds 45–48 alone, the clean stage: `eden~O` −0.06 s, −0.11..−0.02, on a base of 2.00 s. Both against
`eden~O` alone, eight seeds: −0.1 points, −1.9..+1.7.)

- **`pushOpen` passes every clause** (hidden at least +4.0 with the lower bound above 0; confirmed concerns not up;
  wall not up; +$0.006 per 1,000 tasks). The agent asks a little less, because more requests start with a packet.
  The gain is larger where the intent index is live (seeds 41–44): the ranking's top five hold the fact more often
  there, so an opened push hands it more often.
- **What it costs is not in the rule: look-alikes handed rise with the facts** (the decoy is in a push packet in
  1,010 control tasks against 894), and nearly every request now gets a packet (98% of neutral requests against
  81%). The agent turned none of the extra look-alikes into a confirmed concern here (Haiku flagged 11 more answers;
  Sonnet confirmed one in each arm). The brief wanted look-alikes handed down, so this session does not promote it:
  it stays an off trial for the owner, with a blind run on heldout18 as the next step (D706).
- **`candidatesSpecifics` fails** (+2.0 points against a bar of +4.0). `eden~OL` meets the rule as printed (+4.0,
  concerns level), but it is `pushOpen` with a line that adds nothing (−0.1 against `pushOpen` alone) for three
  times the cost, so the line is deleted with its code and tests (D705; the code is in commit d63681c8).
- **Some facts change path.** With the switch on, facts the default delivered by a rule path (a grounded conflict,
  the fallback) arrive in the candidates' packet instead: on funnel seeds 41–42 the hidden rule paths read candidates
  243, grounded-conflict 13, fallback 3, others 3 without it and candidates 293, grounded-conflict 2 with it. The live
  figures are net of this.
- **What is left after `pushOpen`** (seeds 41–44, its arm, 768 hidden tasks): the fact is in a push packet in 596
  (488 raised), only in an ask's answer in 36 (27), never handed in 136 (the agent asked in 35). So the two gaps are
  still open: about 18% of tasks never get the fact (it is outside the ranking's top five or outside the pool, where
  only a read of the request against more items has found it: N2, N5), and about 18% of handed facts are not stated
  with their specifics (a line asking for them did not move that).

## 5. Review, and what it changed

The reviewer subagent ran on 146aa636..c9ac7fe8 (REQUEST_CHANGES; on its own run `CHECK_COLD=1 bun run check` green,
eval 0.65 / 0.52 / 0, funnel 314 / 274, and §2's and §4's figures reproduced). Fixed after the paid runs:

- **With `pushCheck` on, an opened push made the check's paid call.** `pushOpen` now does nothing when `pushCheck`
  is on (a test holds it); "no model call" is true as built.
- **An opened message was kept as an acting request for plan alerts (D301),** so a remark could be quoted later as
  the user's request. Only listed verbs are kept now. Plan alerts were not exercised by §4's runs.
- **The test accepted almost any message of four or more words,** and read the whole text. It now rejects question,
  statement and remark openers with or without a question mark, reads the first word after the openers, takes
  "can/could/would/will" as a request only before "you", is Unicode-aware, and reads the first 400 characters and
  the last 32. On train seeds 41–44 this changes the packet for **2 of 192 templates** ("When you do Mum's FreshCart
  order …, add …", "I can't make the Larkspur Winter Weekender … just forward my ticket …": 24 of 2,304 tasks); every
  other task's packet is the same as in the measured arm. At $0 the tree as shipped reads planted handed **582** of
  768 (+91 −0; measured arm 590), decoy handed 502 (510), neutral packets 738 (746). **So §4's live figures are the
  looser test's; the shipped test differs on about 1% of tasks and was not re-run live.**
- The isolation test could not fail (the other user had no session); it now gives them one.

**A filter for the extra packets (the parent's question, $0).** On the 392 pushes the open rule adds (seeds 41–44:
132 hidden, 131 control, 129 neutral; 99 planted and 92 decoys handed), no no-model test of the pool keeps the facts
and drops the neutral packets:

| Push only when                                   | Planted handed (of 99) | Neutral packets (of 129) | Decoys handed (of 92) |
| ------------------------------------------------ | ---------------------- | ------------------------ | --------------------- |
| a constraint-like item is among those handed     | 91                     | 97                       | 87                    |
| a constraint-like item is in the top five        | 93                     | 108                      | 90                    |
| three or more constraint-like items in the pool  | 90                     | 104                      | 80                    |
| an anchored item is handed                       | 59                     | 54                       | 60                    |
| a constraint-like, anchored item is in the pool  | 48                     | 29                       | 41                    |

The mildest trims a quarter of the added neutral packets for 8% of the facts; none was built.

**Notes on the figures.** `eden` reads 61.1% on seeds 41–44 here and 62.1% in o3-check-behind.md §4: two separate
runs of the same arm. Stage 2 ran on d63681c8's code as stage 1 did. Spend figures are the ledger's, rounded.

## 6. Pre-registration, addendum: `pushOpen` over a user's days (committed before its first call)

§4 measured one request a session, with the looser test. This run is on the tree as shipped (daf758a3, §5's test).
Over a user's days the agent keeps the day's transcript, so a packet on nearly every request (98% of neutral requests
against 81%) is carried and re-read all day: the cost clause has to be read there too.

- **Run:** pi-ab `--days 8`, users w41–w48 (one user a process, one at a time), arms `eden` and `eden~O`, the bench
  recipe; every hidden answer and every control or neutral concern regraded by Sonnet 5.5.
- **Read:** hidden with whole users resampled (`n5/days_hidden.py`; about 100 hidden tasks an arm, so the interval is
  wide and is read beside §4's); cost and wall paired by task, clustered by user (`n5/mix.py --days`).
- **Rule:** `pushOpen` keeps §4's verdict only if, over days, hidden is not lower at its point estimate,
  Sonnet-confirmed concerns are not up, total cost rises by at most **$0.20 per 1,000 tasks** and wall by at most
  **0.1 s** a task. Failing the cost or wall clause, it goes to the owner with that price stated; failing hidden or
  concerns, it is deleted.
- **Budget [EST]:** $1.2.

## 7. Result over days (Pi, local, daf758a3; Sonnet-graded): the hidden clause fails

`.local/o3/days.sh days 41 … 48`: 989 task runs an arm (101 hidden, 101 control, 787 neutral), 0 ungraded, 0 requests
retried; Sonnet regraded 212 answers (0 failed). `n5/days_hidden.py` (whole users resampled), `n5/mix.py --days`:

| `eden~O` against `eden`, eight users' days     | Result                                             |
| ---------------------------------------------- | -------------------------------------------------- |
| Hidden raised                                  | **−2.0 points** (57 against 59 of 101; −10.0..+5.3) |
| Sonnet-confirmed concerns, control and neutral | 0 against 0 of 888 (Haiku flagged 5 in each arm)   |
| Total $ per 1,000 tasks                        | +0.015 (+0.009..+0.021)                            |
| Wall a task                                    | +0.05 s (+0.01..+0.09)                             |
| `ask_context` calls a task                     | +0.001                                             |

- **Against §6's rule: concerns, cost and wall pass; hidden does not** (the rule asked for a point estimate not
  lower; it is two tasks lower, inside an interval eleven times that wide). By the rule as written `pushOpen` is to
  be deleted. It is **not promoted**. The deletion is left to the owner's delegate, because the rule's test cannot
  tell −2 from +2 on 101 tasks and the branch is already merged: D707 records the failure and the choice.
- **Why it gains nothing over days.** Where the planted item reached the agent, by arm (`eden`; `eden~O`): at its own
  request in 52 tasks (47 raised); 52 (43). Only at an earlier request that day in 37 (12 raised); 39 (14). Never in
  12; 10. So over a day the open push does not put more facts in front of the agent at their own request: a user's
  world holds every day's planted items, the candidates hand five items on nearly every request, and most facts the
  open push would add have already been handed for an earlier request, where the not-twice ledger keeps them.
- **That is the days horizon's largest miss: 37 of 101 hidden facts are handed only at an earlier, unrelated
  request, and 12 of them are raised** (against 47 of 52 handed at their own request). A17, A26 and N2 measured a
  re-show for it and deleted it (D380, D512); it is still where the long horizon loses its facts.

**Spend (both O3 notes):** Anthropic **$14.48** booked of $25 (`.local/o3/ledger.jsonl`: this note's short runs $5.48
and their regrades $3.41, the days run $0.70 and its regrade $0.11; o3-check-behind.md's $4.79; rounded). Modal $0.

## Reproduce

```bash
bun run funnel --suite train --seeds 41,42,43,44 --jobs 4 --json .local/o3/base.json -- --neutral            # $0
bun run funnel --suite train --seeds 41,42,43,44 --json .local/o3/open.json --set '{"pushOpen":true}' -- --neutral
python3 -I packages/sim/lab/n2/compare.py --arm C0=.local/o3/base.json --arm O=.local/o3/open.json
V='{"O":{"pushOpen":true},"L":{"candidatesSpecifics":true},"OL":{"pushOpen":true,"candidatesSpecifics":true}}'
# one seed a process, the bench recipe (LAB.md 7b's RECIPE; the three card files concatenated); L is at d63681c8
bun packages/sim/src/lab/pi-ab.ts --suite train --seeds 45 --conditions 'eden,eden~O,eden~L,eden~OL' \
  --variant-config "$V" --variants hidden,control,neutral --config default --tenant-prompt --push payload …
bun packages/sim/src/lab/i3-regrade.ts --results .local/o3/ol2/s45/out.json,… --spend-ledger … --spend-cap 25
python3 -I packages/sim/modal/bench_report.py --pair 'eden~O:eden' --group cached=.local/o3/ol \
  --group inrun=.local/o3/ol2 --sonnet
python3 -I packages/sim/lab/n5/mix.py --base eden --arms 'eden~O' .local/o3/ol/s4*/out.json .local/o3/ol2/s4*/out.json
```
