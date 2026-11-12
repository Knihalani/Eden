# G2: look-alikes handed (target 1)

Status: 2026-11-12. Decisions D1450–D1455. Every model answer here was **served by subagents (D1101)**: Haiku
subagents answered the push check and the agent through the queue, Sonnet subagents graded. Compare arms within a
table, never against API numbers. Nothing was run on heldout20.

**Headline.** The bar G2 was given (look-alikes handed down at least 60% on dev20 seeds 41–44 with hidden facts
handed down at most 0.5 points) was **not met**. What ships is two no-call switches: `packetHeedsCheck` (D1450) and
`stateFilterWide` (D1451). Together, on main with F5's sheet and F2's state, seed 41: packets on neutral requests
40 → 26 of 160 (−35%), rule-path packets that carry the look-alike 8 → 2, look-alikes handed 63 → 59 (−6%), hidden
facts handed 105 → 104. The one arm that reached the headline (−63% look-alikes) cost 3.4 points of facts handed and
five raised facts in a targeted agent test, and was rejected (D1452).

## 0. How it was measured

- **The harness.** `bun run funnel --suite dev20 --seeds 41,42,43,44 -- --check live --check-cache F --neutral`
  with `EDEN_LAB_QUEUE=DIR`: every task through Eden alone, the push check answered through the queue, one ask a
  request with the request's own text (what `pi-ab --agent-sim single` sends). "Handed" is the planted item in a
  packet or in the ask's answer, the final report's definition (`reached = pushed or asked`).
- **Two passes.** A first pass with `EDEN_LAB_QUEUE_TIMEOUT_S=1` lets every check fail open, which writes all its
  prompts to the queue at once; workers answer them; a second pass replays them (0 misses). The first pass's numbers
  are discarded. An arm that does not change the check's prompt replays the same answers, so arms differ only by
  the code under test.
- **Two bases.** "Branch base" is main at 6e4bfb79 with this branch's code, four seeds (640 a variant). "New base"
  is main after F5's rule sheet (D1180) and F2's card state (D1193) merged, seed 41 only (160 a variant): the
  account neared its weekly subagent limit, so the confirmation there was cut to one seed.
- Raw outputs are in `.local/g2/` (not committed).

## 1. Where the look-alikes come from (D1455)

Branch base, 640 control tasks, 267 look-alikes handed:

| how it reached the agent | look-alikes | hidden facts (of 381 handed) |
| --- | ---: | ---: |
| the check said yes: the candidates' packet | 37 | 280 |
| the ask's answer, after the check read it and named it as a no | 99 | 16 |
| the ask's answer, after the check read it and left it unnamed | 44 | 6 |
| the ask's answer, `hits` none | 2 | 0 |
| the ask's answer, no check ran for the request | 55 | 64 |
| a rule path's packet, the check having ruled the item out | 19 | 0 |
| a rule path's packet, the check having left it unnamed, or not read it | 11 | 15 |

The check itself is precise: 37 look-alikes against 280 facts. Seven in eight look-alikes go round it. The ask has no
reader since D236, so it lists what ranks; the rule paths (grounded-conflict, fallback, grounded-clash, sources)
queue their packet before the check answers, and the no-model conflict test reads "credit hold lifted" as a hold.

## 2. The ask heeds the check: rejected (D1452)

`askHeedsCheck`: an explicit ask in the request a push check answered leaves out items that check turned down.

| arm (branch base, 4 seeds) | look-alikes handed | hidden handed | neutral packets |
| --- | ---: | ---: | ---: |
| main | 267 | 381 | 175 |
| ask leaves out what the check named and ruled out | 166 (−38%) | 365 (−2.5 pt) | 175 |
| ask leaves out everything the check read and did not say yes to | 127 (−52%) | 362 (−3.0 pt) | 175 |
| the same, and rule-path packets too | 99 (−63%) | 359 (−3.4 pt) | 115 (−34%) |

On the new base, seed 41, the last arm reads 63 → 39 look-alikes, 105 → 99 facts, 40 → 26 neutral packets.

The facts it loses are ones the check itself rejects: `lisa-car` (the 25% Lifetime ISA penalty is world knowledge),
`cph-thursday-departure-time` (a silently edited flight), `nursery-paid-twice` ("from November" against "this
month's fees"), `kennel-stay-seville` (the 200-character excerpt ends before "Kennel cough: never given").

**The raise test** asked whether those facts matter once handed: `pi-ab --agent-sim single` on the nine templates
and four seeds where the arm drops a fact (36 hidden tasks, new base, Sonnet-graded). The rule, set before the run:
the arm stands if it loses at most 2 raised facts.

| arm | handed | raised |
| --- | ---: | ---: |
| default | 35 of 36 | 23 |
| ask and packets heed the check | 21 of 36 | 18 |

Five raised facts lost. The agent raises about half of the facts the check rejects when the ask hands them, so the
unfiltered ask is doing work the check does not. Rejected; the code is in commit b90b08a6 and before.

## 3. A reason on each rejection, and a longer excerpt: rejected (D1453, D1454)

A `why` field on the entries the check rules out (`clear`: the item is a go-ahead; `other`: another one of the same
kind; `background`), so the ask could leave out only go-aheads. The field is written after the verdict.

| arm (branch base, 4 seeds) | look-alikes | hidden | neutral packets |
| --- | ---: | ---: | ---: |
| main (the shipped prompt) | 267 | 381 | 175 |
| the `why` prompt, nothing left out | 263 | 382 | 177 |
| leave out clear, other and `hits` none | 168 | 373 | 177 |
| leave out clear, only when the check read the item whole | 226 (−14%) | 382 | 177 |

All five facts called `clear` had been read from a cut excerpt, which led to two measurements:

- At $0, over the same pools: at `pushCheckItemChars` 200 the check reads a planted fact whole in 62 of 310 checks
  and a look-alike in 110 of 251; at 400, 305 and 249, for 1,836 → 2,181 item characters a call.
- Through the queue at 400 characters the facts did **not** follow (D1454): the check's yes on facts 222 (228–231
  at 200), facts handed 375, look-alikes 266. And leaving out clear-and-whole there lost eight facts (193
  look-alikes, 367 facts): `chase-refund` and `post-hold-request`, where the item says the job is already done.
  A go-ahead label cannot tell "the obstacle is gone" from "the thing you are about to do is done".

On the new base the clear-and-whole arm at 200 reads 63 → 58 look-alikes, 105 → 108 facts and 40 → 43 neutral
packets: the gain shrinks and the re-sampled verdicts move the neutral count. D1104 holds: any change to the check's
reply re-samples every verdict. Rejected and deleted.

## 4. Rule-path packets heed the check: promoted (D1450)

`packetHeedsCheck`: a proactive packet a rule path made for a request is not handed when that request's push check
read every item in it and said yes to none (a rule the sheet names counts as a yes). `observe` already waits for the
push, so the reply's packet is dropped once the check has settled, and a queued one at the take. The ask is left
alone. No call, no wait, no prompt change; a check that did not answer, read another copy or belongs to another
request holds nothing back.

| arm | look-alikes handed | hidden handed | neutral packets |
| --- | ---: | ---: | ---: |
| branch base, off (4 seeds) | 267 | 381 | 175 of 640 |
| branch base, on | 266 | 381 | 115 (−34%) |
| new base, off (seed 41) | 63 | 105 | 40 of 160 |
| new base, on | 63 | 105 | 26 (−35%) |

On the new base the rule-path packets that carry the look-alike go 8 → 4 and those that carry the fact 16 → 15.
"Handed" does not move because this harness forces an ask and the ask then lists the item; what goes is what Eden
pushes unasked. One fact's packet in sixteen is held back with it: in a loop where the agent does not ask, that fact
is not handed (not measured here).

## 5. The cleared-state test on the other channels: promoted (D1451)

`stateFilterWide`: F2's test (an item carded `none` whose state says a constraint was lifted, met or superseded)
also on rule-path packets (`deliverChecked`) and on an explicit ask in a request the push started for. An ask in any
other request lists the item: "has the hold been lifted?" must still find it.

| arm | look-alikes | hidden | neutral packets |
| --- | ---: | ---: | ---: |
| new base at $0, no check wired, off (4 seeds) | 238 | 372 | 432 of 640 |
| the same, on | 218 (−8%) | 371 | 432 |
| new base, check live, `packetHeedsCheck` on (seed 41) | 63 | 105 | 26 of 160 |
| the same with `stateFilterWide` | 59 (−6%) | 104 | 26 |

Both switches against neither, new base, seed 41, the same check answers: look-alikes 63 → 59, facts 105 → 104,
neutral packets 40 → 26, rule-path look-alike packets 8 → 2.

## 6. What this leaves

- **The ask is the open channel.** After these two switches 43 of the 59 look-alikes handed (seed 41) are in
  an ask answer. Section 2 shows the check's verdict cannot be reused there without losing facts the agent raises.
  A fix needs a judgement the check does not make, or an ask the agent makes less often.
- **55 look-alikes and 64 facts arrive by an ask on requests where no check ran** (branch base). Whatever decides
  those decides both.
- **The measure and the product differ.** The single-shot harness asks on every request. In the Pi loop the agent
  asks on some; there `packetHeedsCheck` removes exposures this report counts as unchanged. Not measured: capacity.
- F8's `--realism heavy` (D1103) was not run for these switches.

## Reproduce

```bash
export EDEN_LAB_QUEUE=$PWD/.local/g2/q
# pass 1: enumerate the check's prompts (numbers discarded), then answer the queue (queue-worker subagents)
EDEN_LAB_QUEUE_TIMEOUT_S=1 env -u OPENROUTER_API_KEY bun run funnel --suite dev20 --seeds 41 \
  -- --check live --check-cache $EDEN_LAB_QUEUE/enum.jsonl --neutral
# pass 2: each arm on the same answers
env -u OPENROUTER_API_KEY bun run funnel --suite dev20 --seeds 41 \
  --set '{"packetHeedsCheck":false,"stateFilterWide":false}' -- --check live --check-cache $EDEN_LAB_QUEUE/a.jsonl --neutral
env -u OPENROUTER_API_KEY bun run funnel --suite dev20 --seeds 41 -- --check live --check-cache $EDEN_LAB_QUEUE/b.jsonl --neutral
```
