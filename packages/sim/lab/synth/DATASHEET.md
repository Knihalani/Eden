# Datasheet: M2 synthetic worlds, `eden-synth:/v2`

Made 2026-11-11 by session M2 (D880–D884), on branch `claude/m2-synth`. Method and audit:
[docs/research/m2-synth.md](../../../../docs/research/m2-synth.md). How to fetch and load the data:
[README.md](README.md).

## What it is

Generated users ("worlds"). Each world holds a persona, about 15 people, about 26 background items, and six to eight
tasks in the train suites' HiddenTask shape. A task has requests in many phrasings, a planted fact that changes what
the agent should do, the fact's all-clear decoy twin, and one to three neutral same-topic items. Everything is
fictional and was written by Claude Haiku 5.5 (and audited in part by Claude Sonnet 5.5). The set holds no real user
data. Labels come from construction (D881): a request's own fact is `changes`, its decoy and neutrals are `clear`,
and every other item of the world is `unrelated`.

## Counts (v2)

| Split | Worlds | Tasks | Families | Requests | (request, item) pairs | changes | clear | unrelated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| train | 2,128 | 15,843 | 2,880 | 123,540 | 6,460,300 | 123,540 | 357,348 | 5,979,412 |
| val | 274 | 2,034 | 313 | 15,850 | 832,286 | 15,850 | 45,689 | 770,747 |
| test | 293 | 2,206 | 320 | 17,243 | 899,732 | 17,243 | 49,647 | 832,842 |
| **all** | **2,695** | **20,083** | **3,513** | **156,633** | **8,192,318** | **156,633** | **452,684** | **7,583,001** |

The planner made 3,000 worlds. Of those, 2,764 completed (the rest had world replies that were refused or
unusable after two re-asks), and 2,695 passed every check. The full set holds 140,278 items. Of the pairs,
7,705,699 have an item that existed when the request was made (`visible`).

M1's pair groups (I1's PairGroup shape) are in `v2/pairgroups/{split}.jsonl`. There is one group per request, plus
about a quarter again as neutral groups, which have the fact left out.

## Coverage

| Axis | Counts |
| --- | --- |
| Areas | work 2,503, family 2,481, health 2,522, money 2,563, travel 2,478, home 2,527, admin 2,505, social 2,504 |
| Timing | static 11,295, silent change 2,942, late (same day) 2,863, multi-day 2,983 |
| Fact in a rarely used source | 7,307 of 20,083 (36%) |
| Decoy kind | other entity 7,625, other period 3,812, resolved 3,771, superseded 3,188, already met 1,687 |
| Archetypes | 16, about 1,250 tasks each |

The rarely used sources are texts, WhatsApp, notes, to-dos, bank, health app, files, issue tracker, school app and
household app.

Request styles, one of each per task: imperative, should-i, i-need, we-should, question, chatter, terse. The run
holds about 20,080 of each. On top of those:

- **Follow-ups:** 5,966, on multi-day tasks.
- **Non-English:** 10,112, on about half the tasks. es 1,252, fr 1,208, de 1,383, pt 1,282, it 1,265, nl 1,209, pl
  1,244, hi 1,269.

## Splits

Splits are by family cluster (D882):

- Families within content-word Jaccard 0.25 of each other share a cluster.
- A cluster's hash fixes its split: 80/10/10.
- Each world takes all its families from one split.

The Modal validation (`v2/manifest.json`) checks that no family, cluster or exact request text appears in two
splits. In v2, no family or cluster appears in two splits, and one request text does (a short generic phrasing, out
of 156,633). Families were deduped against train1–6: 22 of 3,607 were dropped for being within 0.20 of a train template.
Tasks within word-trigram 0.25 of a train text were also dropped (0 in v1). No held-out suite was read.

## Quality

Measured on the published v1 tasks, which v2 contains:

- **Sonnet critic.** It ran blind on 150 tasks. Its agreement with construction:
  - facts: 0.953
  - decoys: 0.907
  - other tasks' facts: 1.00
  - background: 0.973
- **Hand audit.**
  - Every Sonnet dispute: 9 of 15 were real errors (6.0% of the 150 tasks).
  - Tasks Sonnet passed: 2 of 20 hand-read had a hidden error.
- **Estimated error rate.**
  - About **15% of tasks have at least one wrong label [EST; the hidden share rests on 20 hand-read tasks]**.
  - About **2% have a wrong fact**.
  - About **4% of a task's own item labels are wrong [EST]**.
  - Most errors are a decoy or a "neutral" item that still bears on the request (it shows the thing done, a pending
    step, or a different date).
  - From v2 on, the 1.1% of tasks whose detail shows the writer reasoning aloud are dropped (245 in v2).
- **Neutral items are soft positives.** Sonnet calls about a third of them unrelated.
- **Realism.** Sonnet rated tasks 3.85 out of 5.

## Cost

Anthropic spend on the ledger (`.local/m2/ledger.jsonl`, 52,319 calls) was **$35.10**, against a $60 cap:

| Item | Spend |
| --- | --- |
| Families | $0.50 |
| Worlds | $7.20 |
| Tasks | $18.57 |
| Revision | $6.66 |
| Haiku critic | $0.39 |
| Sonnet audit | $1.78 |

- **Per world:** generation costs **$0.0109 a valid world** (v2's assembly, revision included; mostly direct calls).
- **Cancelled batches:** two Message Batches were cancelled because their queue did not start; their finished part
  ($2.76) is booked and was used.
- **Modal:** CPU validation runs and volume storage only, a few cents **[EST]**.

## Known limits

- Labels are what each item was written to be. About one task in seven carries a label a careful reader would
  change.
- Similarity checks are lexical.
- Items are English. Only requests are multilingual.
- Late and multi-day facts are planted up front in the lab suites. Their timing is in `visible`.
- A world holds both a fact and its decoy. A label describes the item read on its own.
