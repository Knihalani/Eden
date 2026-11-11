# H2b: the card call's dropped requests lists, fixed as a trial (`cardsRequestsFix`)

Status: 2026-11-11, branch `claude/h2-requests-fix` (from main 684ec7d0, after #264), session H2. Decisions
D1060–D1063. Train suites, reworded train and longtail only; heldout19 is never read or run. Paid calls go to
Anthropic directly with `HAIKU_API_KEY` through the lab's spend ledger (`.local/h2b/ledger.jsonl`, D97):
**Anthropic-direct lab figures**. Numbers marked **[EST]** are arithmetic or judgement; every other number comes
from a command in this note.

## 0. The bug (D1053)

The shipped card-and-intent prompt's first example reply is `{"cards":[...]}`; the requests list appears only in
the intent paragraph after it. On 400 train items in batches of 20, Haiku 5.5 left the whole requests list out of 3,
5 and 7 of 20 replies in three runs (15 of 60). `CardEnricher` reads no item of such a batch for intent again, so
those items have no requests. Showing the list in the first example (H2's B20r) cut it to 1 of 20, and items given
requests rose from 260 to 379 of 400, at the same price per item covered (docs/research/h2-haiku-lean.md §2b).

## 1. The trial (D1060)

`cardsRequestsFix` (off), needs `cards` and `intent`:

- **The prompt** (`cardMessages(…, form)`, `CARD_FORM_REQUESTS` = 3): the first example reply reads
  `{"cards":[...],"requests":[...]}`. Nothing else in the prompt changes.
- **The guard** (`CardEnricher.reask`): a batch whose reply still holds no requests list is asked once more for
  its items' requests only (`requestMessages`: the card prompt's opening, data rule and day, and its intent
  instructions without the card clause), under a reservation of its own on the enricher's `Budget`. Bounded: once a
  batch, the batch's items, the maker's output cap. Over budget or failing, the batch keeps no requests, as before.
- **Replay caches** (`formKey`): a line made by form 3 is keyed `<hash>:f3`, so one file holds both forms and
  neither ever answers the other; every reader that keys by `cardKey` alone sees only the shipped form.

Tests: `cards-requests-fix.test.ts` (the prompt, the re-ask, budget and failure, the shipped text unchanged with the
switch off), `cards-disk-form.test.ts` (the forms kept apart in replay).

## 2. Pre-registration (committed before any paid call of this branch)

**Caches.** `cold-start.ts --set '{"cardsRequestsFix":true}' --cards-out` over the same worlds `cards-shipped` was
recorded on for these suites (P7, D872): train1–6 × seeds 41–44 × hidden, control, neutral (72 worlds; reworded
shares their worlds) and longtail × seeds 41–44 × the same three (12). Its form-3 lines are appended to
`packages/sim/lab/distilled/cards-shipped.jsonl.gz`; the shipped form's lines are untouched. Cap $2 (P7 paid $0.50
and $0.17).

**Funnel** (shipped coverage, $0 once the caches exist): `bun run funnel --suite train5,train6,train5r,train6r,longtail
--seeds 41,42,43,44 --jobs 4 [--set '{"cardsRequestsFix":true}'] -- --neutral`, the default against the default with
the switch. Pooled over the five families (n 1,088 hidden, 1,088 control):

- **hidden surfaced not down** (the fix's ≥ the default's), and
- **decoys surfaced not up** (the fix's ≤ the default's).

Reported beside: neutral packets, items given requests (`cards use`'s `requested`), card calls and re-asks, and all
of train seeds 41–42 (the baseline CLAUDE.md quotes, 281/264).

**Pi pair (cap $8)**, only if the funnel bar passes: H2's §1d harness (`lab_fanout.py`, `--config default
--tenant-prompt --push payload`, direct profile, Haiku 5.5 agent, grader, cards and reader), `--coverage shipped`,
`--conditions eden,eden~fix --variant-config '{"fix":{"cardsRequestsFix":true}}'`, train5, train6, train5r, train6r
and longtail, seeds 41–44, hidden, control and neutral; every hidden answer and every concern regraded by Sonnet 5.5
(`i3-regrade.ts`); `bench_report.py --pair eden~fix:eden --sonnet`.

- **hidden facts raised (Sonnet): template-clustered lower bound > −1.5 points**, and
- **Sonnet-confirmed concerns (control and neutral) not up** (the fix's ≤ the default's).

**Decision.** Both pass: `cardsRequestsFix` joins `DEFAULT_CONFIG` (D814), with COST-MODEL updated (the re-ask's
calls and the fixed prompt's longer output) and the new funnel baseline recorded where CLAUDE.md quotes 281/264.
Either fails: the switch, its code and its tests are deleted, and the form-3 lines leave the shipped file.

## 3. Results so far, and an addendum (before the Pi pair's first call)

**Caches** (at c05fe0be; `.local/h2b/regen-{1,2,3}.json`): 84 worlds, 581 card calls (17 of them re-asks, 2.9%),
$0.63. Of 9,376 items sent, 9,165 got requests (97.7%). 9,623 form-3 lines are now in `cards-shipped.jsonl.gz` after
its 11,024 shipped-form lines (longtail's first, then train's, so train's win on shared items, as before).

**Funnel** (shipped coverage, train5, train6, train5r, train6r and longtail, seeds 41–44: 608 hidden, 608 control,
608 neutral; the pre-registration's "n 1,088" was an arithmetic slip, the families hold 608):

| | default | `cardsRequestsFix` | task by task |
| --- | --- | --- | --- |
| Hidden surfaced | 468 | **513 (+45)** | +53 −8 |
| Decoys surfaced | 385 | **396 (+11)** | +27 −16 |
| Neutral given a packet | 553 | 548 | |
| Card calls (replayed); re-asks | 949; 0 | 1,534; 574 | |
| Items given requests | 4,631 | 4,714 | |

By family, hidden rose in all five (train5 96 → 108, train5r 92 → 104, train6 112 → 121, train6r 108 → 116, longtail
60 → 64); decoys rose in the four train families (+4 to +6) and fell on longtail (58 → 50).

**The pre-registered funnel bar fails on its second clause: decoys rose 11.** By §2's rule the trial is deleted. The
574 re-asks in replay are items the funnel's per-task worlds send that the recording's worlds did not; they replay
nothing and cost nothing.

**Addendum.** The trade is the shape D829 accepted for `pushIndirect` (more facts for a small rise in look-alikes,
which the funnel overstates: live agents reject most of them, LAB.md). So it goes to the parent, and the Pi pair of
§2 runs now as the information for that call, unchanged in shape and cap. It decides nothing by itself: unless the
parent explicitly accepts the funnel's +11 decoys, the trial is deleted whatever Pi reads. If the parent accepts,
Pi's two clauses decide (hidden's clustered lower bound > −1.5, Sonnet-confirmed concerns not up).

## 4. Pi, the parent's call, and the decision

**The parent accepted the funnel's decoys** ("accept decoys", recorded as D1061): the change fixes a malformed prompt,
facts rise +9.6% against look-alikes +2.9%, neutral packets flat. Pi's own clauses then decided.

**Pi pair** (§2's shape, at 014e5672 on Modal: `eden` against `eden~fix`, `--coverage shipped`, train5, train6,
train5r, train6r and longtail, seeds 41–44, hidden, control and neutral, 3,648 task runs, 1.1% of one wave's requests
retried on a 429; Sonnet 5.5 regraded 1,225 answers, 0 failed; `bench_report.py --pair eden~fix:eden --sonnet`):

| `eden~fix` − `eden` | |
| --- | --- |
| Hidden raised (Sonnet) | **+4.1 points (+0.5..+7.7)**, 78.1 vs 74.0, n 608 pairs over 152 templates (task-level +0.9..+7.3) |
| Confirmed concerns, control and neutral | +0.0 (−0.2..+0.2): 1 vs 1 of 1,216 |
| Agent and Eden $ per 1,000 tasks (cards replayed) | −0.001 (−0.008..+0.006) |
| Wall a task | −0.007 s (−0.064..+0.049) |
| Agent model turns a task | +0.002 (−0.020..+0.025) |

Both clauses pass (lower bound +0.5 > −1.5; concerns 1 against 1). **`cardsRequestsFix` joins the default (D1062).**

**After promotion** (on this branch):

- `bun run funnel` (train seeds 41–42, shipped coverage, stub reader): **295/384 hidden, 268/384 decoys**, the new
  baseline (281/264 before, still read with `--set '{"cardsRequestsFix":false}'`).
- `--coverage full` 315/276, unchanged: the full index holds no form-3 line, so it is replayed as recorded
  (`DiskCardMaker.replayed`, D1063).
- `bun run eval`: precision 0.65, recall 0.52, falseFireRate 0; acting packets on 19 of 28 neutral requests, facts
  handed 10 of 11. Unchanged.
- Cost: the enricher's card spend is about +8% a world ($0.0075 against $0.0070), re-asks 2.9% of calls; COST-MODEL
  has the section.

**Spend:** Anthropic $3.36 (caches $0.63, Pi $2.06, Sonnet regrade $0.68); Modal four shards of about 2.5 minutes.

**For M10 (archived, D960), recorded here as the parent asked:** a requests-only background call (no cards) costs
$0.0000419 an item against the shipped call's $0.0000766 (−45%; −57% with a compact reply), 3.4–4.8 s a call against
8.5 s. M10 measured cards off at −2.4% hidden on the funnel (D963).

## 5. Reproduce

```bash
unset OPENROUTER_API_KEY; L="--spend-ledger .local/h2b/ledger.jsonl --spend-cap 2 --spend-headroom 0.2"
bun packages/sim/src/lab/cold-start.ts --users train1:41:hidden,… --set '{"cardsRequestsFix":true}' \
  --cards-out f3.jsonl $L      # 84 worlds (§2); appended to cards-shipped.jsonl.gz after its own lines
bun run funnel --suite train5,train6,train5r,train6r,longtail --seeds 41,42,43,44 --jobs 4 \
  [--set '{"cardsRequestsFix":false}'] -- --neutral
# Pi: lab_fanout.py with §2's arguments (--conditions eden,eden~fix), then i3-regrade.ts and bench_report.py --sonnet
```

## 6. The review (once, before the merge)

The `reviewer` subagent reproduced every figure above (check, eval, the three funnels, the Pi report, the caches)
and asked for changes, all fixed in the commit after e39bbe9f:

- **A batch cut at the cap twice was re-asked a third time:** `retry` now carries `truncated` through, and a cut batch
  is not re-asked (test).
- **An unreadable reply was re-asked and the answer thrown away** (no item of it is kept): only a reply with a card
  read, or with an item read for its requests only, is re-asked (test).
- **heldout19 at shipped coverage would have replayed nothing under form 3:** `shippedUncovered` takes the form
  (`SHIPPED_FORM_COVERS`), so the funnel and pi-ab/hermes refuse it or fall back to `--coverage full` (test).
- The cards and the requests choose their replay form apart (test); `intentCoverage`, the funnel's replay line and
  `--card-log` read the run's form; a re-ask is not counted against `--cards-calls`; a refused re-ask counts
  `overBudget`; the docs' D1046 and D1064 references, INDEX, ARCHITECTURE and COST-MODEL's world sets are fixed.
