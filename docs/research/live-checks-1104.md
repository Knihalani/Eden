# Live checks, 2026-11-04: the current default on held-out 13, and the landlord gate trial

Two paid runs on the Pi harness (CLAUDE.md's standard agent), Haiku 5.5 as agent, grader and Eden's model roles
through the lab's Anthropic provider, one spend ledger capped at $5. Total spent: **$1.764** ($0.327 held-out 13,
$1.437 train). Decisions: D123 (live check) and D124 (landlord gate, promoted into the default).

## 1. The current default on blind held-out 13 (D123)

D112's live run predates D114 (the reader may empty an answer when it read every candidate) and D119
(`groundOccasion` no longer takes a participant's name for an occasion word). This run repeats D112's setup on the
current default: blind held-out 13, seeds 41–42, `--time-scale 1`, 32 hidden + 32 control tasks per seed and
condition, checked-in cards (`cards-v2.jsonl`, 4,634 replayed) with new cards and intent requests made live.
Conditions: `tools` (search tools, no Eden), `eden` (the default) and `eden~R` (the default minus the reader part,
`PARTS.reader`).

| Condition | Hidden fact raised | False concerns | Wall p50/p90 hidden (s) | Eden on the critical path (mean ms/task) | Agent + Eden per-task, $/1k hidden / control | Background, $/1k |
|---|---|---|---|---|---|---|
| D112 unified default (recorded) | 73.4% | 0.0% | 3.37 / 6.50 | 1,740 | 0.667 / 0.900 | 0.451 |
| tools | 4.7% (3/64) | 0.0% | 3.85 / 5.99 | 0 | 0.338 / 0.346 | 0 |
| **default (eden), now** | **73.4% (47/64)** | **0.0% (0/64)** | **3.13 / 5.97** | **1,597** | **0.577 / 0.830** | 0.459 |
| default minus reader | 54.7% (35/64) | 0.0% (0/64) | 3.35 / 4.47 | 60 | 0.393 / 0.398 | 0.459 |

Paired (bootstrap 95% CI over tasks): eden − tools hidden +68.8 points (+56.3..+79.7); minus-reader − eden hidden
−18.8 points (−32.8..−6.3), wall −0.57 s hidden (−0.94..−0.19) and −1.69 s control (−2.00..−1.39), $/1k −0.184 hidden
and −0.432 control. Eden's per-task calls (the reader) cost $0.332 per 1k hidden tasks and $0.510 per 1k control.
The critical-path column is the mean over hidden and control tasks (128), as `pi-ab-report.ts` prints it.

Reading: the current default holds D112's quality exactly (73.4% hidden, no false concern) and is a little faster and
cheaper per task (p50 3.13 against 3.37 s, $0.577 against $0.667 per 1k hidden); with 64 tasks per arm those
differences are within run-to-run noise, so the claim is "no regression", not "faster". D114 and D119 are now
live-checked. The reader is still worth its cost: without it the default raises 18.8 points fewer hidden facts.
The `gutters-landlord` template raised its fact in no condition (0/2 each); held-out results are not tuned on.

## 2. The landlord gate trial, re-run live on train (D124)

D122 rejected a model-free pattern that opens `readerGate` for arranged visits ("I've booked the engineer, he'll come
Thursday between 8 and 12. Can you make sure someone's in?"), at +6 reader calls on 438 simulated messages against a
bar of +5. The owner reset the bar: promote if hidden facts rise or stay equal, false concerns do not rise, and the
extra cost stays under 10% of reader calls. Re-implemented from D122's description as trial `readerGateVisits`
(conflict.ts `arrangedVisit`: a booking verb and, within 60 characters of the same sentence, he/she/they/someone +
'll/will + come/arrive/visit/call round/be round; or "make sure someone's/someone is/you're/you are in/home/around"
ending its clause), OR'd into the gate's per-candidate test; unit tests held it to the landlord wording and an engine
test showed the gate opening on the landlord mail.

**$0 screens.** `gate-traffic.ts` (seeds 41–44, 438 messages): default 66 reader calls, gated 22, missed-binding 0.227;
with the trial 72 calls (+9.1%), gated 16, missed-binding 0.000; landlord read 3 → 8, reply-pricing read 4 → 5,
exactly D122's numbers. `bun run funnel --jobs 4` (train, reader stub): TOTAL hidden 214/384, decoys 211/384, 658
reader calls, merged delivered 97/72, with and without the switch: no train task's gate decision changed.
`bun run eval`: precision 0.8276, recall 0.48, falseFireRate 0 (the eval wires no reader, so the switch is inert there).

**Live, Pi, train1–6, seeds 41–42**, `--time-scale 1`, 192 hidden + 192 control tasks per seed and arm, cards
(`cards-train.jsonl`) and intent (`distilled/intent-v2.jsonl.gz`) replayed:

| Arm | Hidden fact raised | False concerns | Reader calls | Reader $ | Agent + Eden $/1k hidden / control | Wall p50/p90 hidden (s) |
|---|---|---|---|---|---|---|
| default | 68.2% (262/384) | 1.0% (4/384) | 1,156 | $0.330 | 0.688 / 0.829 | 3.87 / 6.55 |
| default + `readerGateVisits` | 66.7% (256/384) | 1.0% (4/384) | 1,158 (+0.2%) | $0.334 | 0.702 / 0.826 | 3.75 / 6.59 |

Paired: hidden −1.6 points (−5.7..+2.3), control +0.0 (−1.3..+1.3), wall −0.05 s, $/1k +0.014 (−0.019..+0.047).
Per task, reader calls differed in 217 of 768 paired tasks, 107 up and 110 down: the agent's own asks vary between
runs, and that noise, not the gate, moves the count (the funnel shows no gate decision changing on train).

**Outcome: promoted into the default (D124, amending D122).** The bar's three tests hold. Cost: +9.1% reader calls
in gate-traffic, +0.2% live on train, both under 10%. False concerns: 4 and 4. Hidden facts: equal. The gate makes
no different decision on any train task, so both live arms ran the same Eden behaviour and the 6-task gap (CI
−5.7..+2.3) is agent noise, not an effect of the switch. What the switch does do, it does in gate-traffic: every missed
landlord binding (0.227 → 0.000) is read. A first draft of this note read the 6-task gap as "hidden facts fell" and
deleted the switch; the review pointed out that the same evidence would have promoted it had the noise gone the other
way. Not measured: the live quality effect on arranged-visit tasks. Train has none that the gate decides
differently, and held-out 13's `gutters-landlord` is not tuned on.

`readerGateVisits` is a setting of the `reader` part (`PARTS.reader`, `docs/profiles/minus-reader.json`), so the
default has 43 changed keys (`default.test.ts`). After the promotion, on this tree: `gate-traffic.ts` default 72
calls, gated 16, missed-binding 0.000; `bun run funnel --jobs 4` TOTAL 214/211, 658 reader calls; `bun run eval`
precision 0.8276, recall 0.48, falseFireRate 0.

## Reproduce

```bash
W=.local/lc; L="--spend-ledger $W/ledger.jsonl --spend-cap 5 --spend-headroom 0.3"
H="--card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --model claude-haiku-5-5 --grader claude-haiku-5-5"
R='{"R":{"askReader":false,"askReaderDrop":false,"readerPush":false,"readerGate":false,"readerPushBehind":false,"askReaderPool":30,"askReaderItemChars":400}}'
for S in 41 42; do   # one process per seed; $0.163 each
  bun packages/sim/src/lab/pi-ab.ts --suite heldout13 --seeds $S --variants hidden,control --time-scale 1 \
    --config default --variant-config "$R" --cards packages/sim/lab/cards/cards-v2.jsonl \
    --cards-out $W/pi/cards-h13-$S.jsonl $H --conditions tools,eden,eden~R $L --budget 1.2 \
    --timeline $W/pi/h13-$S --out $W/pi/h13-$S.json
done
bun packages/sim/src/lab/pi-ab-report.ts $W/pi/h13-41.json $W/pi/h13-42.json
# The landlord gate as a variant (now in the default: on this tree V is a no-op; run it on main before D124):
gunzip -c packages/sim/lab/distilled/intent-v2.jsonl.gz > $W/intent/intent-v2.jsonl
for S in 41 42; do   # $0.718 each
  bun packages/sim/src/lab/pi-ab.ts --suite train --seeds $S --variants hidden,control --time-scale 1 \
    --config default --variant-config '{"V":{"readerGateVisits":true}}' \
    --cards packages/sim/lab/cards/cards-train.jsonl --cards-out $W/pi/cards-train-$S.jsonl \
    --intent $W/intent/intent-v2.jsonl $H --conditions eden,eden~V $L --budget 1.6 --run-label train-$S \
    --timeline $W/pi/train-$S --out $W/pi/train-$S.json
done
bun packages/sim/src/lab/pi-ab-report.ts $W/pi/train-41.json $W/pi/train-42.json
```
