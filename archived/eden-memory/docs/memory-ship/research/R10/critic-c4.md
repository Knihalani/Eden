# R10 critique C4 (adversarial): F22 deferred verification

All numbers below come from commands I ran on 2026-10-19 (strict sleep store, dev, judge sample unless stated). My scripts and JSON output are in the scratchpad: `ana.py`, `code.json`, `life.json`.

## 1. F22 is a local optimum, and parts of its lead come from how it was measured

**a. On life, pull beats push on both axes.** F22 life gets recall 0.2553 and silence 0.7222. Pull k=2 gets 0.2869 and 0.8426. On code the two are tied: recall 0.4758 vs 0.4667, CIs [0.348, 0.595] vs [0.344, 0.587]. "Strongest push system" is true. "Matches pull" is true only on code.

**b. The delivery rule gates silence for free, and it learns from how the authors wrote tool use.** On life, 47 of 108 no-need human turns have no tool call (43.5%), but only 18 of 79 need turns do (22.8%). On code the split is 32/110 vs 5/55. Life silence goes from 0.6019 (ideal, delivered at Submit) to 0.7222 (deferred) only because packets are dropped on no-tool turns. Haiku's own false-fire rate is 45/108 on life. Real hosts call tools at their own rates, so this gain will not transfer as measured. The same rule costs recall where it hurts most: life direct questions fall from 0.556 to 0.111 (n 9). Questions the agent answers from memory, with no tool call, never get the memory.

**c. The candidate stage caps recall.** The ceiling is 0.597 on code and 0.3778 on life. Haiku reaches 86% and 90% of it in the ideal setting (0.5121, 0.3397). Of the bullets the judge picks that are actually needed, only 36/57 (code) and 42/70 (life) are among the 15 candidates. On life, the binding constraint is now the lexical stage that F22 still rests on, not verification.

**d. "Proactive 0.31 vs pull 0.23" is a one-event difference** (4/13 vs 3/13).

**e. Base-rate precision is no better than pull.** At 8% need, precision is 0.0728 for F22, 0.0738 for pull, 0.0886 for the judge, and 0.0974 for anticipation. About 93% of F22's bullets are unneeded. Its false-packet rate is 33.6% (code) and 27.8% (life) of no-need human turns. The sample is 33% need (55/165) on code and 42% (79/187) on life, so raw precision (0.21) flatters it about 3×.

**f. Trigger silence 0.0 comes from two events.** Life has only 2 trigger negatives, and both got a packet. It is not a measurement. Critic C2 flagged n=2 and it is still unfixed. Also, triggers are deliverable at Submit under F22 (score.py line 422), so on triggers F22 is the ideal variant.

**g. Non-human silence is 1.0 by construction.** score.py forces those packets empty. So the "all" silence (0.7357 code) mixes in a free 1.0.

**h. The verifier run was not deployment-like (new finding).**
- Haiku ran as a Claude Code subagent, on batches of 50 cases.
- Cases within a batch are out of order across the stream (v00 runs s036, s072, s057, s105…). When it judged s036 it had already read later sessions' turns, including corrections. That is a future leak.
- Batching also lets it calibrate its fire rate to the batch.
- The verifier prompt is not in PROMPTS.md. The run cannot be reproduced, which breaches §4.9 authorship.
- C2 made the same point about pull's batch role-play.

**i. The "third family" claim is wrong.** Haiku, Sonnet (labeler) and Opus (authors, judge) are all Claude. Their errors are correlated:
- When haiku fires on a no-need turn, the judge fires too 74% of the time on code (29/39) and 58% on life (26/45). The judge's base rates are 49% and 36%.
- Of haiku's picks, 96 of 173 (code) and 113 of 243 (life) are also judge picks.

This may be label strictness (C3-E4: labeler-only needs are half real) or shared taste. Nothing yet tells the two apart.

**j. Cost and latency are not measured.**
- One haiku call per human turn and per trigger: all 165 and 215 events in the samples were sent.
- Measured input is about 4.8k chars per call on code and 4.5k on life, so roughly 1.1–1.2k tokens in and under 50 out. At code's rate (493 turns over 67 days) that is about 9k tokens a day.
- Tokens are not the problem. Infrastructure and latency are:
  - The hooks are short-lived processes, so F22 needs a warm sidecar.
  - It needs a model credential outside the user's Claude Code session, or `claude -p` spawns that cost seconds each.
  - Nobody has measured the race between the verifier and the first PreToolUse.
  - Unverified: whether PreToolUse `additionalContext` reaches the model before that tool call runs. If it does not, a rule about the first action (for example "use pnpm") arrives too late, yet the scorer counts it as delivered.

**k. Zero fresh evidence.** F22 was never scored on `code-rt1` or `life-rt1`.

**Kill line.** Code silence CI lower bound 0.569 vs the line, vote 0.4182 + 0.15 = 0.568: it passes by 0.001. Life recall CI [0.177, 0.357] contains vote's 0.2257. So "equal or better recall" holds on the point estimate only.

## 2. Blind spots and failure classes

1. No-tool answer turns: direct recall questions, advice, chit-chat that touches a stored fact.
2. First-action rules delivered after the action is chosen.
3. Candidate misses: about 40% of judge-needed bullets never reach the verifier.
4. Elliptic follow-ups, which the lexical stage cannot see. Verify is unscored on red-team.
5. Shared Claude taste across labeler, judge and verifier.
6. Routine triggers (n=2).
7. Store scale: 375 and 611 rows, not thousands. The 15-candidate ceiling will fall as the store grows.
8. No cross-turn repeat suppression (code redundancy 0.0736).

## 3. Three orthogonal push directions

**A. Store-wide verifier over a cached store digest.** This removes the lexical candidate stage.
- Mechanism: haiku sees the turn plus the whole visible store, compressed at sleep to one line per row or cluster. The digest is a static prefix, so prompt caching applies.
- First experiment: same 165/187 events, strict store (375/611 rows fit in about 15–25k tokens), one case per call, prompt committed.
- Kill: life recall not ≥ 0.42 (ideal 0.3397 + 0.08), or human silence < 0.60 at ideal delivery, or more than 2× F22's input tokens after caching.

**B. Stop-hook draft check.** Delivery becomes a review of the agent's draft, which fixes no-tool turns and gives Eden "what the agent doesn't know".
- Mechanism: when the agent stops, the verifier sees the candidates plus the draft answer. It blocks with a memory note only when the draft contradicts a row or omits one on a tracked slot (F18 with a model). Eden still decides, unasked.
- First experiment: responder drafts from downstream.py on the C3-E4 turns, n ≥ 60.
- Kill: fires on > 12% of no-need turns, or recovers < 50% of the Submit-delivery outcome gain on need turns, or life direct recall < 0.45.

**C. Prospective agenda lane for triggers and absence (F17 with a model at sleep).**
- Mechanism: sleep compiles intentions with conditions. Trigger time runs a condition check plus a haiku confirm.
- First experiment: author at least 40 routine trigger negatives with a non-Claude author (NIM is available), then score F17 + confirm.
- Kill: trigger recall < 0.45 (judge 0.50, F22 0.2308), or false packets > 20% on the new negatives.

**Before any of these:** re-run the F22 verifier one case per call, in stream order, with a committed prompt, and once with a NIM model. If code recall drops by more than 0.05, revise C4-E5.

## 4. Re-runs of LEDGER C4 numbers

| Entry | LEDGER | Re-run | Match |
|---|---|---|---|
| C4-E5 code verify | 0.4758 / 0.3077 / 0.2086 / 0.6636 / 55.2, CI [0.348, 0.595], @8% 0.0728 | identical (55.2242) | yes |
| C4-E5 ideal code / life | 0.5121 / 0.6455; 0.3397 / 0.6019 | identical | yes |
| C4-E5 life verify | 0.2553 / 0.1739 / 0.1689 / 0.7222 / 38.0, @8% 0.0496, trigger 0.2308 / 0.0 | identical | yes |
| C4-E5 ceilings | 0.597 / 0.3778 | 0.597 / 0.3778 | yes |
| C4-E5 vote (sample) | 0.3848 / 0.0695 / 0.4182; 0.2257 / 0.0494 / 0.3426 | identical (`vote:strip=1`) | yes |
| C4-E2 antic code / life | 0.2152 / 0.0769 / 0.2429 / 0.8636 / 22.2, @8% 0.0974; 0.0464 / 0.0 / 0.0833 / 0.8333 | identical | yes |
| C4-E1 hist τ .25 / .35 | 0.0364 / 0.9256; 0.0182 / 0.9702 | identical | yes (AUC not re-run: no script) |
| C4-E3 vote act=1, code / life | 0.3848→0.4152, 0.3839→0.3363; 0.2257→0.2004, 0.2938→0.2676 | identical | yes |
| C4-E4 vote, vote+budget, oracle | as logged | identical | yes |
| **C4-E4 code `lex+when`** | **0.2552 / 0.5 / 0.0691 / 0.3111** | `lex:when=1` gives **0.1862 / 0.3333 / 0.0943 / 0.4444**; tau=4.5 matches recall 0.2552 and proactive 0.5, but precision 0.0756 and silence 0.2444 | **MISMATCH**: no setting I tried reproduces it |
| **C4-E4 life `lex+when`** | **0.1159 / silence 0.2353** | recall 0.1159, **silence 0.4706** (default); tau=5 gives silence 0.2941 | **MISMATCH on silence** |

The config behind C4-E4's `lex+when` rows is not recorded. The fresh-split scoring is also missing from LOOKS.md.

## 5. Realism contract §4: biggest remaining gaps

1. **§4.9 leakage and authorship.**
   - The verifier is batched across time (a future leak).
   - Its prompt is not committed.
   - Generation, labels, judge and verifier are all one family.
   - No holdout exists.
   - The fresh-split looks are not logged.
2. **§4.7 downstream.** F22 has no downstream check. The harm estimate for wrong packets is still n=15, while F22 sends false packets on about 30% of no-need turns.
3. **§4.5 triggers.** 2 negatives. Absence and return moments are untested for F22.
4. **Deployment realism.** Hook-to-sidecar latency, the PreToolUse injection semantics, and real tool-call rates by the host (the delivery rule depends on them) are all unmeasured. Hot-path p50/p99 is not reported for any model lane.
5. **§4.3 volume and base rate.** Stores have 375 and 611 rows. Samples are 33–42% need.
6. **§4.8.** LoCoMo is still unscored by F22. LongMemEval is blocked by network policy.
