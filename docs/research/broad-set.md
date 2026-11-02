# The broad tuning set, and four rule-based tracks that did not generalise

Status: 2026-11-02. No-model funnel only (`hidden-funnel.ts --ask`, ALL3, seeds 41–42). Every number comes from a
command run this session.

## Why a broad set

Four structurally different tracks were built in parallel, each tuned on dev6a and dev6b and checked once on the blind
suites:
- **Constraint ledger:** typed joins from a request to the constraints it might break.
- **Learned ranker and gate:** a logistic regression over the engine's facts.
- **Lexical bridge:** an action-to-constraint lattice, plus per-user word associations.
- **Validity reasoning:** constraint threads and a state machine deciding whether each constraint is in force.

All four gained a lot on dev and little or nothing on the blind suites. The rows below count hidden items surfaced
(delivered or cited by `ask`) and decoys surfaced.

| Track | Dev hidden / decoys (of 120) | Blind held-out 5–8 (158) | Blind held-out 10–11 (128) |
|---|---|---|---|
| ALL3 | 60 / 46 | 95 / 65 | 72 / 60 |
| Learned gate | 63 / 24 (CV) | 88 / 49 | 61 / 50 |
| Validity | 60 / 24 | 95 / 58 | 70 / 56 |
| Lexical bridge | 86 / 50 | 103 / 65 | 74 / 61 |
| Constraint ledger | 82 / 46 | 99 / 65 | 74 / 60 |

Dev is two suites by two authors. Rules written while reading them learn their wording. The tracks' branches
(`opt/ranker`, `opt/validity`, `opt/bridge0`, `opt/ledger`) record the details. None of them is merged.

The broad set replaces dev for tuning: `train1`–`train6` (`--suite train`), 32 templates each, 192 hidden and 192
control tasks per seed.
- Six authors wrote them, each blind: they saw only the world generator, the text helpers and the HiddenTask interface.
- Each suite covers one area of life: personal finance and admin; family, home and health; engineering and IT
  operations; sales, legal and procurement; travel and social life; managing people and a small business.
- Each suite targets the same mix:
  - request–item word overlap: about a third share no content words, a third only a name, a third one topic word;
  - decoys: a third resolved or expired, a third about another entity, a third with the prerequisite already met;
  - several "already done" hidden items.

## The tracks on the broad set (train1–6, seeds 41–42, 384 hidden and 384 control tasks)

| Configuration | Hidden surfaced | Decoys surfaced |
|---|---|---|
| ALL3, cards for 1,528 items, 585 uncovered | 214 | 208 |
| ALL3, cards for every prefiltered item | 214 | 211 |
| + constraint ledger | 219 | 210 |
| + lexical bridge | 213 | 203 |
| + validity | 202 | 185 |

Card enrichment for the train worlds:
- 746 items, 75 calls, $0.0233 (glm-5.3-flash, cheapest endpoint);
- covered 616 of them; 114 remain uncovered after the merge.

None of the rule-based tracks moves the broad set: the ledger gains +5 hidden and validity loses 12.

## Where the misses are (ALL3 with cards, train, hidden variant, `--ask-diag`)

Every planted item is in the user's cache after sync.

| Outcome | Share of hidden tasks |
|---|---|
| Surfaced | 55% |
| In the ask pool, ranked below the five seats | 21% |
| Cached but never a candidate | 23% |

Of the ranked-out items, 140 rank within the top 20 of the pool. A reader that picked the planted item from the top
30 would surface about 74%. That ceiling assumes it also leaves the decoys out.

## What this says

- **Retrieval mostly works; reading does not.** The planted item and its decoy differ in meaning: lifted, about
  another account, already approved. Word rules cannot read meaning, and on unseen writing they fall to about a coin
  flip (214 hidden against 211 decoys).
- **Decoys surfaced overstate harm.** Live, the agent's model rejects most decoys: false concerns were 0–5% (Hermes
  run, hermes-lab.md).
- **Next step:** move the reading to the one place a model is affordable. When the agent asks (`ask_context`), one
  cheap call reads the top ~30 candidates and the request, and returns the items that bear on it. The per-event fast
  path stays model-free. It is being built as `askReader` on branch `opt/reader`.
