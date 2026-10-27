# R10 critique C2 (adversarial)

Every number below comes from commands I ran at HEAD ae58b59 (dev, strict sleep, plan labels, coverage v2) unless marked otherwise. My helper scripts are `same.py` and `pullstats.py` in this scratchpad folder.

## 1. Agent-pull is measured unfairly, and its lead is about half what LEDGER claims

**a. "5× precision" and "+0.27 silence" compare a mixed sample with full dev.**
- Pull is scored on the judge sample: all 55 need events plus 110 sampled negatives, so a 1:2 need-to-negative mix.
- The hook methods are scored on full dev: 55 need events against 336 negatives, a 1:6 mix.
- Precision depends on that mix. Scored on pull's exact events:

| World | Method (same events) | Recall | Precision | Silence | Precision at 8% base rate |
|---|---|---|---|---|---|
| code | bank ∧ lex, ltau 2 | 0.3273 | **0.0793** | **0.4818** | 0.0232 |
| code | vote (strip) | 0.3121 | 0.0816 | 0.5545 | 0.0245 |
| code | pull k=2 | 0.4667 | 0.2025 | 0.7364 | **0.0738** |
| life | bank ∧ lex, ltau 4 | 0.2025 | 0.0817 | 0.5833 | 0.0222 |
| life | pull k=2 | 0.2869 | 0.1677 | 0.8426 | **0.0654** |

- On the same events, pull's precision is **2.5× (code) and 2.1× (life)**, not 5×.
- Its silence gain is **+0.18 on code** (vs vote) and **+0.26 on life**, not +0.27 and +0.33.
- **At a realistic 8% base rate, 93% of pull's bullets are unneeded** (code 0.074, life 0.065). That is no better than the brief's "89% unneeded" headline. On code, 0.92 × 26.4% ≈ 24 false packets per 100 human turns, against about 7 true ones.

**b. F13 fails its own pre-registered kill line on code.**
- The criterion was "calls on > 25% of no-need human turns".
- The host actually **called on 31 of 110 = 28.2%**. LEDGER reports 26.4%, which is the false-*packet* rate: 2 calls returned no rows.
- Life passes, at 18/108 = 16.7%.
- STATE marks F13 "borderline" and "frontier". By the rule written before the run, it is dead on code.

**c. Cost is under-counted.**
- "Tokens 49.0" leaves out the index, which is in every turn's context: p50 97 tokens on code and 111 on life (measured from `agentpull/*/in`).
- So the true per-event context cost is about 146 on code. Bank ∧ lex costs 89.7, so pull is *more* expensive in tokens, not cheaper.
- Each call is a full extra model step, which takes seconds, not 150 ms. At an 8% base rate, calls happen on 0.08 × 0.93 + 0.92 × 0.28 ≈ **0.33 of human turns**.
- "The hook stays model-free" is true. The latency the user waits through is not.

**d. The setup is role-play, not a host.**
- Each sonnet subagent judged **55–60 cases in one prompt**, with need and no-need cases mixed at 1:2 in a task that was framed as the experiment.
- A real host sees one turn at a time, while it is busy with tool work, and has the repo in reach.
- The host's instructions are not committed (`agentpull/*/out` record only `host: sonnet`), so the run cannot be reproduced.

**e. The host shares the labeler's sense of need.**
- Every generator in the pipeline is Claude:
  - stream authors: `claude-subagent:…`, model still unrecorded (a C1 fix not done);
  - compiler, labeler and host: sonnet;
  - judge: opus;
  - self-play: haiku.
- On no-need turns where the sonnet labeler *does* see a need, pull calls on **14/28 (50%)**. Where both label sets say no need, it calls on **17/82 (21%)**.
- So pull's precision and silence depend on which Claude's taste the labels follow.

**f. Length is a confound.**
- Code: **0 of 55 need turns are ≤ 3 words, and only 2 are ≤ 12.** Life: 0 of 79 are ≤ 12.
- Pull's call rate on no-need turns, by length (code): ≤ 3 words 1/18, 4–12 words 2/11, 13–30 words 19/52, > 30 words 9/29.
- Real prompts have p50 12 words, and 24% are ≤ 3 words. Short real needs ("deploy like last time") are **untested**.
- Reweighting negatives to a guessed real length mix only lowers pull's false-call rate to about 0.23. The recall side cannot be estimated at all.

**g. The index does not leak in time, but it steers.**
- `index()` uses only strict-visible rows, so nothing from the future gets in.
- But 29 of 51 code calls (37/64 on life) put needed-item tokens into the query that are absent from the turn text. The sonnet-extracted entity list is doing part of the retrieval, and nobody has ablated it.

**h. Triggers.** Pull's trigger recall is **0.19**, against the judge's 0.50 and the oracle's 0.92. Its "trigger silence 0.5" rests on **n = 2**. Pull has no wake path for time or calendar events, so for proactive agents it is structurally reactive.

**i. Where the loss is.** The call gate is strong: it calls on **51/55 (93%)** of code need turns and 64/79 (81%) on life. Retrieval is what loses.

| World | System | Recall | Silence | Precision at 8% |
|---|---|---|---|---|
| code | judge picks, gated by pull's call | 0.6545 | 0.8273 | 0.1415 |
| code | oracle-need, gated by pull's call | 0.7515 | 1.0 | — |
| life | judge picks, gated by pull's call | 0.4937 | 0.8796 | 0.14 |

- Gating the judge's picks by pull's call beats both pull and the judge alone.
- The judge (silence 0.636) is **not a silence ceiling**: pull beats it by 0.10.

## 2. LEDGER re-runs (task 4)

| Claim | Re-run | Match? |
|---|---|---|
| code pull k=2: 0.4667 / 0.2308 / 0.2025 / 0.7364 / 49.0, CIs | identical | yes |
| code judge: 0.6909 / 0.4615 / 0.2552 / 0.6364 | identical | yes |
| life pull k=2 and k=4, life judge (C2-E8) | identical, CIs included | yes |
| eden code (0.0909 / 0.1042), eden life (0.0443 / 0.0503) | identical | yes |
| oracle-need strict (0.8242 / 0.6667) | identical | yes |
| life bank ∧ ltau 4: 0.2025 / 0.087 / 0.5171 | identical | yes |
| **code bank ∧ lex ltau 2: P 0.0395, S 0.4702, tok 88.8** | **P 0.0393, S 0.4643, tok 89.68** (recall 0.3273 matches; same under hash seeds 0–3) | **no**: artifact drift since C2-E2 |
| **vote + strip: recall 0.3212 (C2-E4), STATE 0.321** | **0.3121 / 0.3394 / 0.3121 / 0.3303** under `PYTHONHASHSEED` 1/2/3/0; precision 0.0394–0.0433 | **no**: `Vote` is **nondeterministic** (vote-tie ordering over sets) |
| C2-E8 setup: "79 need events (human and trigger)" | 79 human + 26 trigger = **105** | text wrong |
| STATE: "see LOOKS.md" | **LOOKS.md does not exist** anywhere in the repo | **no**: §4.9 look log missing |

C1 fixes:
- **Done:** `trace` is now deterministic; judge visibility is enforced; CIs are added; coverage is judge-validated (code only); life is scored.
- **Not done:**
  - author model recorded;
  - labeler adjudication: labeler need rate is still **120/391 = 31%** against plan 14% and real 8%;
  - prompts length-calibrated;
  - per-session leak-free sleep;
  - holdout written.

## 3. Blind spots and failure classes

- **Pull always fills k.** k=2 returns 2 rows whenever the call matches anything, and nothing abstains after retrieval. That caps precision on single-need turns at about 0.5.
- **No repeat suppression across a session for pull.** Its redundancy is not reported.
- **Short and elliptic need turns are absent**, so every method's recall on them is unknown (§1f).
- **Every frontier claim rests on one model family.** Nothing tests whether the gains are robust to a non-Claude author or labeler.
- **The 165/187-event sample:** there are 55 code need events, and the 13 proactive ones carry ±0.25 noise. The life trigger negatives number 2.
- **Dev and test interleave sessions** from the same author batches. Coverage v2 has never been checked on life.

## 4. Three orthogonal directions (each with a kill line set first)

**D1 — Distil the call gate into a hook-side need model.** The teacher is the pull or judge decision; the student is a per-user linear model over:
- strip-paste length;
- ask or request form;
- novelty against the session;
- hits on the memory-index entities;
- event class.

This moves pull's silence to the hook without per-turn host tokens or a dependence on host cooperation.
- *First experiment:* train on life's 245 pull decisions, test on code's 195 (cross-world), scoring against plan labels. Pair the student with bank ranking.
- *Kill if* AUC against plan labels is < 0.80, or silence is < 0.70 at recall ≥ 0.30 on code.

**D2 — A prospective-memory agenda: fire on the clock and on events, not on text.** At sleep, compile intentions with conditions (time window, person, place, plan step) into a schedule. The trigger lane checks conditions; it does no retrieval.
- *First experiment:* the 26 life trigger need events on dev, plus 17 trigger negatives.
- *Kill if* trigger recall is < 0.50 (pull's is 0.19), or more than 20% of trigger negatives get a packet.

**D3 — Conflict-triggered injection: verify the draft, don't predict the need.** The host drafts with no memory. Eden checks the draft (and planned tool calls) against stored values, rules and corrections, and injects only the rows the draft contradicts or omits on a keyed slot. Precision comes by construction, and the stale-value class is attacked directly.
- *First experiment:* code sample with haiku drafts. A lexical value and slot comparison picks out conflicting rows.
- *Kill if* recall on need turns is < 0.30, or more than 10% of no-need turns get a packet.

## 5. Realism contract §4: the biggest gaps that remain, ranked

1. **§4.4 labels and §4.7 downstream.** Need strictness is unsettled: plan 14%, sonnet labeler 31%, real 8%. On no-need turns, pull's call rate swings 21% → 50% with the labeler's view, and no downstream check exists to arbitrate. This now decides the frontier.
2. **§4.3 prompt length.**
   - Medians: code 21 words, life 26, real 12.
   - Share of prompts ≤ 3 words: code 8.2%, life 5.4%, real 24%.
   - Need turns of ≤ 12 words: code 2/55, life 0/79.
3. **§4.9 leakage and holdout.** One model family end to end; the author model still unrecorded; no holdout; LOOKS.md missing despite STATE citing it; the pull host's prompt not committed.
4. **Ecological validity of pull.** It was never run as a real host (`claude -p` with a recall MCP tool, turn by turn). Batch role-play is not deployment.
5. **§4.8 external anchors.** LoCoMo is converted but still unscored. LongMemEval is blocked.
6. **§4.3 volume.** The sleep stores hold 375 rows (code) and 611 (life), not thousands, so the index and lexical retrieval have not been stressed at scale.

**Bottom line.**
- F13's call gate is a real gain, measured on the same events: +0.18 to +0.26 silence and 2–2.5× precision.
- But by its own rule it is dead on code (28.2% calls), and its cost and latency are under-stated.
- At an 8% base rate it is still 93% noise per bullet.
- The upside is in "gate × better post-call selection" (judge gated by pull: recall 0.65, silence 0.83 on code) and in a non-text trigger lane, not in more pull tuning.
