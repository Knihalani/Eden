# F13: anticipation (precompute warnings for what the user is about to ask)

Status: 2026-11-12, branch `claude/f13-anticipate` (from main a8c03340), session F13. Simulated worlds only (train,
reworded, longtail, dev20; seeds 41–42; hidden, control and neutral). No paid API: the anticipation pass was served
by Haiku subagents through the queue transport (D1101), so its numbers are **served by subagents (D1101)**, not Haiku
API figures; prices are **[EST]** from `packages/sim/lab/f7/price-queue.py`'s Haiku 5.5 list prices and the queue's
recorded sizes. Every other number comes from a command named here.

## 0. The idea

The push check (one Haiku call per acting request, about $0.16 per 1,000 requests and 0.7–0.9 s on the request path,
F7) is the largest obstacle to Eden making the agent cheaper and faster. Anticipation moves that model call off the
request path: a background pass per user predicts the requests the user's active rules bear on and writes the
warning for each in advance; at request time a CPU match (F2's `multilingual-e5-small` int8 encoder) of the request
against the anticipated requests hands the warning with no model call and no wait. A miss falls through to the
check.

Built (engine, unwired: `packages/engine/src/anticipate.ts`, `anticipate.test.ts`):

- `ANTICIPATE_SYSTEM`, `anticipateMessages`: the user's sheet (F5's rule: constraint cards, no `none` or
  `preference`, not ended) whole as the first user turn (a cached prefix), then "write anticipations for rules a to
  b" in chunks of 25. Per rule: up to four requests as the user would type them (direct, indirect, question),
  `on` (the days it bears on), `who` (names or references a request must concern) and `warn` (one line).
- `parseAnticipations`: field by field, bounded, redacted; rule numbers outside the chunk dropped; ids from the sheet.
- `Anticipator`: per tenant/user; `update` asks only about rules not yet held (a rule keeps its anticipations while
  it stays on the sheet: re-anticipation on change) and drops rules that left the sheet; one update a user at a time;
  every call through `Budget`; fails open. `match` is CPU only: best act's cosine over `minScore`, the rule's days
  holding one of the request's days (when both have days), a named rule mentioned by the request, and only rules
  still live on the current sheet.

Lab: `packages/sim/lab/f13/` (`sheet.py`, `precursor.py`, `pass.ts`, `match.ts`, `score.py`).

## 1. Coverage at $0

**Plan-driven anticipation predicts nothing in the sim worlds.** `precursor.py` asks whether some item other than the
planted facts, in a plan-like place (calendar, tasks, trips, notes, documents), shares at least two anchors (names,
numbers, ids) with the request, against a baseline of another world's requests:

| group | requests foreseen by a plan item | baseline (another world's requests) |
| --- | ---: | ---: |
| train | 10/384 (2.6%) | 11/384 (2.9%) |
| reworded | 9/384 (2.3%) | 10/384 (2.6%) |
| dev20 | 3/320 (0.9%) | 3/320 (0.9%) |
| longtail | 2/48 (4.2%) | 1/48 (2.1%) |

The suites' requests are written from templates, not from the worlds' own plans, so nothing in a world foreshadows
them: a calendar-, task- or plan-driven pass cannot be measured to help here. Real users may differ (their next
action is often on their calendar); that needs the pilot kit (docs/PILOT.md), not the sim. **[finding]**

**Constraint-driven anticipation can reach most facts.** `sheet.py` (shipped card coverage on the world's clock,
D1102): the planted item is on the user's sheet in 322/384 hidden train tasks (84%), the same in reworded (same
worlds), 180/320 on dev20 (56%) and 36/48 on longtail (75%); sheets hold 87–106 rules. The look-alike is on the sheet
in 177/384 control train tasks.

## 2. The free baseline: the cards' own anticipated requests

Each card already carries the requests it anticipates (the intent index's, `cardsRequestsFix`). Matched on CPU
(`match.ts --arm cards`, 1.6 ms a request on one thread) with the threshold fit on train at 2% neutral packets,
hand-out at most one rule (k 1), grounds day and names:

| group | planted handed | look-alike per planted hit | neutral packets |
| --- | ---: | ---: | ---: |
| train | 79/384 (20.6%) | 0.316 | 7/384 (1.8%) |
| reworded | 77/384 (20.1%) | 0.390 | 7/384 (1.8%) |
| dev20 | 21/320 (6.6%) | 0.524 | 21/320 (6.6%) |
| longtail | 8/48 (16.7%) | 0.250 | 4/48 (8.3%) |

This agrees with F10's D1270: meaning alone cannot hand a fact without the model at the precision the check keeps.

## 3. The pass and screen 1

Pre-registered in 04d69058 (rule) and 1376a27b (two more arms, before any neutral world was read): fit the
threshold on train hidden against train neutral at the largest hit rate with neutral packets ≤ 2%; read reworded,
dev20 and longtail at it. Pass: in each read group, anticipation hands the planted fact on ≥ 35% of hidden tasks,
the look-alike on ≤ 1 per 8 planted hits, a packet on ≤ 3% of neutral tasks. Else the switch is deleted.

The pass: 218 requests over 66 distinct sheets (a reworded suite shares its base's worlds), served by subagents
(D1101), 0 unreadable. It kept 324 of 358 planted rules and 161 of 177 look-alike rules on train (both about 91%):
**the whole picture does not reject look-alikes**, because a look-alike is wrong only relative to the request
("ISA allowance £20,000" bears on any ISA deposit; whether it blocks one depends on the amount asked).

RESULTS PENDING.

## 4. Cost [EST]

From the queue's recorded sizes (76 answered chunks, about 4 characters a token, Haiku 5.5 list prices): a chunk
reads a 3,240-token prefix (system and sheet) and writes about 950 tokens. A user's full pass (about 100 rules, four
chunks, the prefix written once and read three times) costs about **$0.0024**, about 15 push checks. An incremental
update for one new rule costs about $0.00005 on a warm cache (about $0.0004 when the prefix must be written again).
