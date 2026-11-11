# H2b: the card call's dropped requests lists, fixed as a trial (`cardsRequestsFix`)

Status: 2026-11-11, branch `claude/h2-requests-fix` (from main 684ec7d0, after #264), session H2. Decisions
D1060–D1064. Train suites, reworded train and longtail only; heldout19 is never read or run. Paid calls go to
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
