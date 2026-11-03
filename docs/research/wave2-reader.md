# Wave 2 on the reader: pool universe, push-verdict reuse, subset replay, answer gate (2026-11-03)

Four items the 2026-11-03b deep audit left open (`quality-reader-pool-universe`, `lat-ask-rereads-after-push`,
`devloop-reader-replay-item-level-key`, `lat-answer-gate-not-start-gate`), each built behind a trial switch on top of
the unified default (D112), measured, then promoted or deleted (the one-product rule). Outcome: **three deleted
(D115, D116, D118), one lab instrument kept (D117)**. Nothing in the engine, server or client changed. Spend $1.16 of
a $4 cap (Anthropic direct, Haiku 5.5, one spend ledger, D97). Every number below was run in this session on a
4-core container; train suites are in-sample tuning data, held-out 13 a blind check run once per arm.

Common setup: train1–6, seeds 41–42, cards replayed (`bun run funnel`), intent requests replayed from the committed
`packages/sim/lab/distilled/intent-v2.jsonl.gz` (`-- --intent F`, so no screen here is intent-inert). Baselines:
`--reader stub` hidden in pool 255/384, decoy in pool 242/384, 654 reader calls; `--reader oracle:0.9,0.1` (proxy)
hidden 274/384, decoys 134/384.

## 1. Widening the reader's pool with the user's constraint items (D115, rejected)

**Diagnosis first.** Of the 129 train tasks whose planted hidden item never reached the reader's pool, 88 had no card
at the request (the replayed card caches hold cards only for items an earlier run fetched), 31 had a card of a
standing kind whose actions did not meet the request's, and 9 met. A card-based universe (carded constraints ranked
by `cardVerdict` and name ties) moved hidden in pool only 255 → 261. The ranking's own cache search keeps 12 items
(`rank`), so the switch was rebuilt as: up to N of the user's cached items that pass the cards' prefilter
(`worthCardingStrict`, no bulk mail) and that the ask's ranking left out, best lexical match first among the cache's
top 400, appended after the request's own pool; they never open `readerGate`.

| Run ($0, `--jobs 4`) | hidden in pool | decoy in pool | mean pool | mean prompt chars |
|---|---|---|---|---|
| default | 255/384 | 242/384 | 12.3 | 7,511 |
| `askReaderUniverse` 10 | 278 | 265 | 19.0 | 10,133 |
| `askReaderUniverse` 15 | 284 | 271 | 21.5 | 11,052 |
| `askReaderUniverse` 30 | 287 | 271 | 25.2 | 12,390 |

Oracle proxy at 15: hidden 274 → 301, decoys 134 → 138. Retrieval misses fell 129 → 100 (1.3x), not the audit's
6.1x: that figure counted the union of a 30-item pool with the whole prefiltered set, which no reader prompt holds.

**Paid train screen** (Haiku 5.5 reader live, default wait, 652 calls each arm): hidden surfaced 280 → 303/384,
decoys surfaced 143 → 148; the reader flagged the planted hidden item 231 → 254 and the decoy 22 → 30 (decoys with a
`blocks` bearing 6 → 10); reader cost $0.184 → $0.295 for the run ($/call 0.000283 → 0.000453, +60%; input tokens per
call 2,819 → 4,304); call latency p50/p90 1,074/1,556 → 1,237/1,721 ms.

**Held-out check** (Pi, `--act`, held-out 13, seeds 41–42, `--time-scale 1`, Haiku 5.5 as agent, grader and Eden's
roles; 64 hidden + 64 control tasks per arm): hidden raised 81.3% → 85.9% (+4.7, paired bootstrap 95% CI −4.7..+14.1),
**false concerns 0.0% → 4.7%** (3 of 64, +0.0..+10.9), $ per 1k tasks +0.295 (+0.188..+0.404) on hidden, wall p50/p90
4.65/7.03 → 4.71/6.65 s. More decoys reach the reader and some of them read as binding to the agent: it fails the
bar (no extra false concerns) and costs more. Deleted with its code; no `PARTS` entry.

## 2. Reusing the push's verdict for a later ask (D116, rejected)

An explicit `ask_context` after the push re-reads whenever its wording differs: the question changes the item text
the reader sees (`readerFocus`), so the verdict key misses. The switch let an ask take the push's verdict, with no
call, when the push had read every item of the ask's pool unchanged (content hash and card) for the same request and
day. Measured first with the oracle reader (`-- --ask-question narrow`, an agent's narrower wording): 1,171 reader
calls; strict coverage avoided 46 of them (about 9% of the roughly 520 explicit asks' reads), so as the audit feared
narrow asks mostly pool items the push never read. Relaxed so that uncovered items the gate's own test says cannot
constrain need no reading: 92 avoided (about 17%), oracle score unchanged (270/131).

**Paid** (Haiku 5.5, narrow asks, both arms on one reader cache so only the ask reads differ): reader calls
1,171 → 1,079 ($0.117 for the baseline's calls), hidden surfaced 279 → 277, decoys 130 → 131. The narrow ask's own
reading finds what the push's missed; reusing it loses that. Cheaper, worse on both counts: deleted. With request-
worded asks (as the funnel's default `--ask`) reuse saved 651 → 635 calls: the existing verdict cache already covers
most of them.

## 3. Item-level reader replay for $0 screens (D117, adopted as a labelled lab instrument)

The audit's version (a verdict per item, keyed on the item alone) assumes verdicts do not depend on their neighbours,
erasing the order and distractor effects a pool lever acts through. The narrow version, `--reader-subset LOG`, answers
a missed prompt only from a recorded reading (same model, instructions, day, request and question) whose pool held
every item of the missed one, rendered identically, in the same order: a lever that removes items. Is that faithful?

| Comparison (Haiku 5.5, train) | calls | exact same verdict | flags kept / lost / added |
|---|---|---|---|
| Same prompt sent twice (train1–2, seed 41) | 110 | 97 (88%) | 59 / 9 / 7 |
| A 15-item reading against its 15-to-30-item superset restricted (train1–6, seeds 41–42) | 600 | 493 (82%) | 364 / 84 / 60 |
| The same, train1–2 seed 41 only | 93 | 81 (87%) | 52 / 7 / 10 |

End to end, the default replayed from the widened run's recordings (600 of 653 calls approximated, 52 exact, 1 miss)
scored hidden 277/384, decoys 146/384 against the real reading's 280/143; the widened-minus-default delta read +26/+2
against the real +23/+5. The approximation is within about the model's own rerun noise on this lever; it says nothing
about levers that add or re-render items (those still miss). Kept, labelled on every line it touches (docs/LAB.md).

## 4. Gating actions instead of the agent's start (D118, rejected)

The default waits up to 3 s on the user message's observe so the reader's push lands before the agent's first model
call (D98: no wait lost 18–32 points on train). The trial `answerGate` let the agent start at once (`@w0`) and moved
the wait to its actions: `checkAction` (the client's `check`, `POST /v1/check`) waited for the session's push (at most
8 s) and held an action with the newest packet the agent had not taken, as the firewall's held result.

**Held-out check** (same run as section 1): hidden raised 81.3% → 75.0% (−6.2, −15.6..+3.1); false concerns 0.0% →
1.6% (one of 64; control actions held 9.4%, overridden 3.1%); wall p50/p90 hidden 4.65/7.03 → 4.16/5.65 s (paired
−0.27 s, −0.67..+0.10), control −0.59 s (−1.00..−0.17); Eden on the critical path 1,954 → 2,146 ms mean per task
(the gate's wait now sits before the action). A held action makes the agent reconsider a plan already formed; it
raises fewer facts than a reading present from the start, and adds a false concern. Faster, not better: deleted with
its code (engine switch, harness hook).

## Reproduce

```bash
W=.local/w2; I=$W/intent/intent-v2.jsonl; mkdir -p $W/intent
gunzip -c packages/sim/lab/distilled/intent-v2.jsonl.gz > $I
L="--spend-ledger $W/ledger.jsonl --spend-cap 4 --spend-headroom 0.3"
bun run funnel --jobs 4 --json $W/base-stub.json -- --reader stub --intent $I          # $0 baselines
bun run funnel --jobs 4 --json $W/base-oracle.json -- --reader oracle:0.9,0.1 --intent $I
bun run funnel --json $W/p-base.json -- --intent $I --reader live --reader-model claude-haiku-5-5 \
  --reader-cache $W/rc-base.jsonl $L --run-label t1-base                                 # paid, $0.18
python3 -I packages/sim/lab/scripts/reader-score.py $W/p-base.json $W/p-base.json
bun packages/sim/src/lab/pi-ab.ts --suite heldout13 --seeds 41 --variants hidden,control --act --time-scale 1 \
  --config default --variant-config "$V" --cards packages/sim/lab/cards/cards-v2.jsonl --cards-out $W/pi/cards-41.jsonl \
  --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --model claude-haiku-5-5 --grader claude-haiku-5-5 \
  --conditions eden,eden~G@w0,eden~U $L --budget 1.2 --out $W/pi/h13-41.json             # and seed 42; $0.26 each
bun packages/sim/src/lab/act-report.ts $W/pi/h13-41.json $W/pi/h13-42.json
```

`V='{"G":{"answerGate":true},"U":{"askReaderUniverse":15}}'` names the two trial arms, and the screens above set
them with `--set`. The three engine switches were deleted before merge (sections 1, 2 and 4 describe what they did),
so those arms no longer run; the subset replay's commands are in docs/LAB.md.
