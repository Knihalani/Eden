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

Built as a trial (engine, never wired into the partner; **deleted by D1301**, code and tests in commit fd458ac87;
the prompt and parser stay in the lab as `packages/sim/lab/f13/anticipate.ts`):

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

Each arm × grounds mode, threshold fit on train (k 1: a request is handed at most one rule). The best on train of
every arm (`score.py`, `.local/f13/screen1.txt`; the full table there):

| arm, mode | train planted | reworded planted | dev20 planted | longtail planted | look-alike per planted hit (train / reworded / dev20) | neutral packets (reworded / dev20 / longtail) |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| pass, margin, day | 95/384 (24.7%) | 55/384 (14.3%) | 29/320 (9.1%) | 29/48 (60.4%) | 0.389 / 0.509 / 0.448 | 1.0% / 5.9% / 8.3% |
| pass, cosine, day+who | 69/384 (18.0%) | 66/384 (17.2%) | 41/320 (12.8%) | 27/48 (56.2%) | 0.377 / 0.455 / 0.366 | 3.9% / 12.8% / 12.5% |
| union, margin, day+who | 85/384 (22.1%) | 56/384 (14.6%) | 28/320 (8.8%) | 24/48 (50.0%) | 0.376 / 0.446 / 0.429 | 1.0% / 3.1% / 4.2% |
| union, cosine, day+who+act | 71/384 (18.5%) | 54/384 (14.1%) | 15/320 (4.7%) | 14/48 (29.2%) | 0.282 / 0.333 / 0.333 | 2.9% / 6.2% / 18.8% |
| cards (free), cosine, day+who | 79/384 (20.6%) | 77/384 (20.1%) | 21/320 (6.6%) | 8/48 (16.7%) | 0.316 / 0.390 / 0.524 | 1.8% / 6.6% / 8.3% |

**Verdict: rejected (D1301).** No arm in any mode reaches 35% of planted facts in any read group but longtail, and
every one hands one look-alike for every two to four facts (the bar is one for eight). The pass's acts are no better
a key than the cards' own requests (top-1 rank of the planted rule on train hidden: 142 against 144 of 352 at the
interim read), and the action ground (D1270's advice: the instance, not the topic) cut facts faster than look-alikes.
The reason is the one F10 found (D1270) and the pass's own keep rate shows: a precomputed warning cannot know the
request's instance. The look-alike is the same rule about a different instance (another invoice, another week,
another amount); only a reading of the request beside the item tells them apart, which is what the push check does.

The CPU match itself is cheap: 1.6–1.8 ms a request on one thread with the request vectors memoised across a
world's three variants (`match.ts`; F2 measured 4–5 ms for an unseen request).

## 4. Cost [EST]

From the queue's recorded sizes (76 answered chunks, about 4 characters a token, Haiku 5.5 list prices): a chunk
reads a 3,240-token prefix (system and sheet) and writes about 950 tokens. A user's full pass (about 100 rules, four
chunks, the prefix written once and read three times) costs about **$0.0024**, about 15 push checks. An incremental
update for one new rule costs about $0.00005 on a warm cache (about $0.0004 when the prefix must be written again).

At F7's $0.16 per 1,000 checks [EST], a full pass equals about 15 checks. Anticipation would pay for itself only if
it answered at least that many of a user's acting requests a pass with no check; at the measured hit rates (under a
quarter of hidden requests, and a neutral request must still be checked) it would add cost, not remove it.

## 5. What is kept, and what is open

- Kept (lab): `sheet.py` (per-world sheets and the coverage table), `precursor.py` (plan-driven coverage),
  `pass.ts` (the pass through the queue transport), `match.ts` and `score.py` (the CPU screen of any
  anticipation arm against the cards' own requests), the prompt and parser (`anticipate.ts`).
- Open, not measurable in the sim: plan-driven anticipation on real users (their next action on their own calendar
  or task list). The pilot kit (docs/PILOT.md) is where it could be read; the sim's requests are not drawn from its
  worlds' plans (§1).
- Not tried: a pass that writes per-rule conditions the CPU can test exactly (an amount cap, a date range, an
  invoice number) and hands only on a condition met. The cards already carry `limit`, `unit`, `start`, `end` and
  `entities`, and `cardVerdict` already tests them with no model; that path is the card rule path,
  not anticipation.

Reproduce ($0 once the queue is answered; answers in `.local/f13/q/done`):

```bash
env -u OPENROUTER_API_KEY bun run funnel --suite train,reworded,longtail,dev20 --seeds 41,42 --no-ask -- --neutral \
  --corpus-dump .local/f13/corpus.jsonl
python3 -I packages/sim/lab/f13/sheet.py .local/f13/corpus.jsonl packages/sim/lab/distilled/cards-shipped.jsonl.gz \
  .local/f13/sheets.jsonl
python3 -I packages/sim/lab/f13/precursor.py .local/f13/corpus.jsonl
env -u OPENROUTER_API_KEY bun packages/sim/lab/f13/pass.ts queue .local/f13/sheets.jsonl .local/f13/q   # then serve
env -u OPENROUTER_API_KEY bun packages/sim/lab/f13/pass.ts read .local/f13/sheets.jsonl .local/f13/q .local/f13/ants.jsonl
F13_ENCODER=<F2's packages/encoder/src/index.ts> env -u OPENROUTER_API_KEY bun packages/sim/lab/f13/match.ts \
  .local/f13/sheets.jsonl .local/f13/ants.jsonl <e5 model dir> .local/f13/match-pass.jsonl --arm pass
python3 -I packages/sim/lab/f13/score.py .local/f13/match-pass.jsonl --k 1 [--margin]
```
