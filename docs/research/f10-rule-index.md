# F10: the semantic rule index (meaning picks what the push check reads)

Status: 2026-11-12 (this copy on main carries §9's proxy trial; the lab scripts and the rule index are on branch `claude/f10-rule-index`), **closed: D1270 (finding), D1271 (`pushCheckView` rejected)**. Branch `claude/f10-rule-index` (main 4bda5177 with F8's world-clock coverage and F5's rule sheet
merged), session F10. Tuning suites only: train (train1–6), reworded (train1r–6r), longtail and dev20, seeds 41–42.
heldout19 is not read or run. No paid API call: every model answer here is **served by subagents (D1101-style,
Haiku subagents)**, and every $ and wait figure built from it is **[EST]**. The encoder runs on CPU at $0.

## 1. The brief, and what the data said first ($0)

The brief: embed each constraint card (statement plus "applies when" triggers) with a small multilingual encoder;
at request time score the request against the user's rules on CPU; hand high-confidence rules with no model call,
stay silent on low-confidence requests with no model call, and send only the middle band to the push check.

Data: `bun run funnel --suite S --seeds 41|42 --jobs 1 --set '{"pushCheckSheet":120,"pushCheckSheetAlways":true}'
-- --neutral --check replay --check-cache EMPTY --check-dump D` (checks fail open on an empty replay cache, $0; the
dump now carries each sheet card's anticipated requests), and the same without the sheet for main's calls. 3,090
check rows with the sheet, of which main calls the check on 2,967 (96%). Encoder: `multilingual-e5-small` int8 ONNX
(`packages/sim/lab/f10/embed.py`), a card scored by its best cosine over its statement, its title and statement, and
each anticipated request (`feats.py`); the engine's own day and name grounds per card (`grounds.ts`).

**The no-model bands do not hold up:**

- _Low band (silent, no call)._ Skipping the check on the half of neutral pushes that score lowest also skips 17% of
  the hidden rows whose fact is in the pool or on the sheet (e5-small; e5-base 24%, e5-large 19%; a logistic pair
  scorer over meaning, days, names and card kind, fit on train: 17% pooled, 19% on reworded, 21% on dev20). At a skip
  of 10% of all calls it still loses 4% of reachable facts. Neutral requests in these suites are about the same
  topics as the rules (a travel request meets the travel policy every time), so meaning alone cannot say "nothing
  applies"; M7 (D930) found the same of ten no-model pre-screens.
- _High band (hand with no call)._ At the 99.5th percentile of neutral rows' best score, with a margin over the
  second rule, the top rule is the planted fact on 53 hidden rows and the look-alike on 26 control rows: one decoy
  for every two facts, because the look-alike's card anticipates the same requests. The guard that would separate
  them (another person, the same day but a resolved state, "unaffected" lines) is the judgement the check exists for.

So target "≥ 50% fewer check calls" is not reachable with a CPU-only band at facts in the 90s. What meaning does do
well is **choose what the check reads**:

| view (per row)                                         | train facts / look-alikes | reworded      | longtail    | dev20         | entries read             |
| ------------------------------------------------------ | ------------------------- | ------------- | ----------- | ------------- | ------------------------ |
| main: the pool's first 15                              | 339 / 317                 | 311 / 293     | 38 / 27     | 133 / 102     | ≈ 14.5 items             |
| pool's first 8 (today's order)                         | 324 / 300                 | 302 / 274     | 36 / 25     | 121 / 89      | 8 items                  |
| **V: pool's first 8 + the 3 rules nearest by meaning** | **340 / 307**             | **318 / 280** | **37 / 26** | **136 / 106** | ≈ 8 items + 3 rule lines |
| pool's first 8 + 5 rules                               | 345 / 310                 | 325 / 282     | 37 / 27     | 140 / 108     | ≈ 8 + 5                  |

(Rows where main calls the check, seeds 41–42; "facts" is the planted item in view on hidden rows, "look-alikes" the
look-alike in view on control rows.) A learned ordering of the pool by meaning, rank and grounds did no better than
today's order plus the nearest rules, and the shared-name feature added nothing, so V uses no word matching of its own.

## 2. Pre-registration: the subagent pilot of V against main (committed before any answer is read)

**Rows.** The S dumps' rows where main calls the check: seed 41 of train, reworded and dev20, seeds 41–42 of longtail;
per suite group a seeded sample of 30 hidden, 30 control and 30 neutral rows (all rows when fewer).

**Arms**, each row asked in both, by different subagents (one arm a batch file, 15 prompts a file, files shuffled):

- **B (main):** the pool's first 15 items, no rules (`checkMessages` as main builds it).
- **V:** the pool's first 8 items, then the 3 sheet cards with the highest encoder score whose items are not among
  those 8, as rules (F5's `pushCheckSheet` prompt with a 3-card sheet).

**Read** with `parseCompareSheet`. Handed = the named items, then the named rules' items, first 5
(`pushCandidates`); an unreadable reply hands the pool's first 5 in both arms (fail open). Per arm: planted handed on
hidden rows, the look-alike handed on control rows, neutral rows handed anything; input and output characters a
call, priced at Haiku 5.5 list prices with the fixed instructions and `SHEET_HEAD` read from cache **[EST]**, and the
wait from H3's fit (596 ms + 2.93 ms an output token) **[EST]**.

**Rule.** V goes on (an engine trial, `pushCheckView`, measured end to end) if, pooled over the four groups:
planted handed ≥ B − 3; look-alike handed ≤ B; neutral rows handed anything ≤ B + 4; the check's [EST] $ a call ≤
0.8 × B's. Otherwise V is written up as a finding and not built.

## 3. Result (served by subagents; 48 Haiku subagents, 720 prompts, 0 missing, 0 unreadable)

`bun packages/sim/lab/f10/pilot.ts score .local/f10/pilot` (rows where main calls the check; 30 a variant a group):

|                                       | B (main: pool's 15) | V (pool's 8 + 3 nearest rules) |
| ------------------------------------- | ------------------: | -----------------------------: |
| planted handed, hidden (120)          |              **99** |                         **94** |
| — train / reworded / longtail / dev20 |   28 / 25 / 25 / 21 |              26 / 26 / 24 / 18 |
| look-alike handed, control (120)      |                   6 |                              6 |
| neutral rows handed anything (120)    |                  16 |                             14 |
| uncached input a call [EST]           |          848 tokens |                     602 tokens |
| output a call (subagent replies)      |           27 tokens |                      31 tokens |
| $ a check call [EST]                  |           $0.000108 |              $0.000089 (0.83×) |
| check wait a call [EST, H3's fit]     |              674 ms |                         686 ms |

Paired task by task: hidden, main alone hands 6 facts, V alone 1; control 1 and 1; neutral 7 and 5. Every fact V
lost sat at pool positions 8–13, cut from its view, with no rule near enough to bring it back.

**Against the rule: V fails** (planted 94 < 99 − 3, and the cost ratio 0.83 > 0.8). Under D814 `pushCheckView`,
its ranker interface, the inline sheet and the funnel's `--rank-vectors` are deleted (D1271; the code and its tests
are in commit bd86feaaf). Kept: the dump's anticipated requests per sheet card, the encoder scripts, the pilot.

**Why the view saves little.** An item in the check's prompt is about 200 characters (`pushCheckItemChars`), about
50 tokens, and many pools are short of 15: cutting to 8 removes about 250 tokens of the call's ~850 uncached, while the
fixed instructions are cached and the output (where the wait is) does not shrink. So the most the view could ever
buy is about a fifth of the check's input bill and no wait, and it pays for it with the facts the lexical order puts
ninth to fifteenth.

## 4. The four targets, for each arm (what this work can say)

Read from this pilot (the check alone, rows where main checks; served by subagents, so compare arms only):

| target                                                      | B (main)             | V                | skip band (offline, §1)                                 |
| ----------------------------------------------------------- | -------------------- | ---------------- | ------------------------------------------------------- |
| 1. decoys handed                                            | 6 / 120 control rows | 6 / 120          | fewer, but only with facts lost                         |
| 2. hidden facts handed                                      | 99 / 120 (82.5%)     | 94 / 120 (78.3%) | −17% of reachable facts at 50% of neutral calls skipped |
| 3. cost (check, per 1,000 tasks at 0.93 calls a task) [EST] | ≈ $0.100             | ≈ $0.083         | −$0.05 at a 50% skip, −$0.01 at a 10% skip              |
| 4. wait (check, a task) [EST]                               | ≈ 627 ms             | ≈ 638 ms         | −0.3 s at a 50% skip                                    |
| share of pushes calling the model                           | 96% (2,967 of 3,090) | 96%              | ≥ 50% fewer only at ≥ 17% of facts lost                 |

Agent plus Eden against the agent alone (targets 3 and 4 as the owner states them) is not measured here: the arm
that would move them most, a CPU skip of most check calls, fails on facts before it reaches that size.

## 5. What remains open, for whoever picks it up

- The low band could still pay on a real API if the check's silence is predictable _by Haiku's own measure_: M7's
  ten pre-screens could not (D930), and meaning plus grounds did no better here. A cross-encoder trained on the
  check's own replies (F2's 2,267 recorded API rows) is the untried form; it needs those rows and a CPU budget of
  tens of ms for 15 + K pairs.
- Card-time "applies when" lines (the brief's first step) were not written: the card call's anticipated requests
  already play that part, and their meaning is as close to look-alikes' as to facts' (§1). Broader lines would raise
  the neutral rows' scores as much as the facts' (a travel policy applies to every travel request).

## 6. The index as the sheet's selector (the integrator's merged design with F5; $0)

F5 found the rule sheet holds at a real user's 32–53 cards but breaks at 300 (facts named 52/54 → 26/54,
subagent-simulated). So the index selects the k cards nearest the request and the sheet renders only those.
`padded.py`: each row's sheet padded to N cards with other worlds' cards (F5's stress: no card planted for the same
template, one per statement, seeded places); the planted card's place by score (674 hidden rows with it on the sheet;
the look-alike's on 362 control rows). Tuned on the tuning suites themselves (train, reworded, longtail, dev20,
seeds 41–42), so these are in-sample.

| N cards |   k | F5's order (newest first) | e5-small, best text | **e5-small, `ruleScore`** | e5-small 70k-pruned, `ruleScore` | look-alike, `ruleScore` |
| ------: | --: | ------------------------: | ------------------: | ------------------------: | -------------------------------: | ----------------------: |
|     300 |  10 |                         6 |                 477 |                   **513** |                              490 |               204 / 362 |
|     300 |  20 |                        32 |                 528 |                   **568** |                              539 |               236 / 362 |
|     300 |  30 |                        58 |                 577 |             **599 (89%)** |                        564 (84%) |               257 / 362 |

Without the padding (≤ 50 cards) the best text puts the planted card in the top 30 on 653 of 674. Larger encoders
(best text, 300 cards, top 30): e5-base 599, e5-large 602. `ruleScore` (engine `rule-index.ts`) is the mean of a
card's best two text cosines, less 0.03 when the request names days and none falls in the card's span (the engine's
`timeWindow`): best text alone 577, +days 592, +best two 595, both 599.

Command (from `.local/f10`, the dumps of §1, `grounds.ts` over them): `F10_AGG=mean2 F10_DAY_PENALTY=0.03 python3 -I
packages/sim/lab/f10/padded.py vecs.npz grounds.jsonl d/S-*.dump.jsonl` (`F10_AGG=max F10_DAY_PENALTY=0` for best text).
The review corrected this table's first version (F5's order 6/32/58, e5-base 596, e5-large 601: runs whose padding
drew from Python's per-process string hash); the padding is now seeded by a SHA-1 of the task.

**Cost [EST].** A selected sheet changes with every request, so it is uncached: about 35 tokens a line, so k = 20
is about 700 input tokens ($0.00007) a check, against F5's whole sheet read from cache at about $0.000017. Below
about 60 cards the cached whole sheet is cheaper; the selection is for heavier users.

**Built (unwired; F5 wires the partner and `pushCheckSheetSelect`):** `RuleIndex`, `RuleCandidate`, `ruleTexts`,
`ruleScore`, `topRules` (`packages/engine/src/rule-index.ts`); the lab's `ReplayRuleIndex`
(`packages/sim/src/lab/rule-index-replay.ts`, offline vectors in `packages/sim/lab/f10/vecs-e5s.json.gz`); the
server's `EncoderRuleIndex` (`packages/encoder/src/rule-index.ts`: cards embedded in the background one text a call,
cold and answering null below 90% coverage, per user, bounded per user and across users, `forget` effective even
for an embed in flight). Cold time: about six texts a card at 20 texts a second, so a new 300-card user's index answers
after about 90 s, longer when others' cards wait [EST].

## 7. Pre-registration: a learned skip of the push check on the API's own verdicts (before any model is fit)

The integrator's brief: skip at least 40% of check calls with at most 1% of reachable facts lost, judged on held-out
rows split by template; decision-level features, not topic alone.

- **Data:** F2's 2,282 push-check calls answered by the live API (Haiku 5.5, main 006b505c; train, reworded and
  longtail, seeds 41–42; `claude/f2-pilot-data`, `base-dumps-4142.jsonl.gz`). Labels: the items the API named.
  A single API answer is a noisy label (D931: Haiku repeats its own item set 75–79% of the time).
- **Protected rows:** hidden rows where the API named the planted item. A skip may drop any neutral or control row
  (it removes a neutral packet or a look-alike), never a protected one.
- **Features, no model** (`skip-feats.ts`, `skip.py`): per pool item, its rank, the e5-small cosine to the request,
  constraint wording (`DEONTIC` matches, `constrains`, `mayConstrain`), whether it holds the request's action class's
  ties (`actionClass`, `matchesClass`), the request's names it holds, whether it names one of the request's days,
  its length; per request, the turn gate's logit and kind, `isImperative`, named days and names.
- **Models:** primary, a per-item logistic regression (named by the API, every variant), a row scored by its best
  item; secondary, the same features through a gradient-boosted tree model (reported, not decisive).
- **Split:** 5 folds by template name (a train template and its reworded twin in one fold). Each fold's threshold is
  set on its training folds' rows: the highest score under which at most 0.5% of protected training rows fall.
- **Bar (pooled out-of-fold):** protected rows skipped ≤ 1%, and the share of calls skipped on the 1:1:8 mix
  (0.1 hidden + 0.1 control + 0.8 neutral row skip rates) ≥ 40%. Pass: build it as a trial switch for F12's
  candidate. Fail: a finding.

## 8. Result: the learned skip fails its bar (D1272)

`python3 -I packages/sim/lab/f10/skip.py` over `skip-feats.ts`'s features (2,282 API rows; 614 protected rows; 5
template folds; each fold's threshold from its training folds):

| model                                                                               | protected skipped (out of fold) | skipped: hidden / control / neutral | 1:1:8 mix skipped |
| ----------------------------------------------------------------------------------- | ------------------------------: | ----------------------------------- | ----------------: |
| **logistic, per item (primary)**                                                    |                 4 / 614 (0.65%) | 2.3% / 2.8% / 19.3%                 |         **15.9%** |
| boosted trees, per item (secondary)                                                 |                 26 / 614 (4.2%) | 8.0% / 9.7% / 39.8%                 |             33.6% |
| boosted trees, per row: protected against neutral (exploratory, not pre-registered) |                 45 / 614 (7.3%) | — / 12.2% / 39.9%                   |             34.2% |

Pooled out-of-fold curve (one threshold over all folds, so optimistic) at a given share of protected rows skipped:

| protected skipped | logistic: mix skipped | trees: mix skipped |
| ----------------: | --------------------: | -----------------: |
|                 0 |                  9.2% |               7.3% |
|            7 (1%) |                 20.4% |              20.8% |
|           13 (2%) |                 25.8% |              24.6% |
|           31 (5%) |                 36.1% |              38.7% |
|          62 (10%) |                 53.0% |              48.7% |

**Against the bar: fails** (≥ 40% of calls at ≤ 1% of protected facts; the best reaches about 20%). The decision-level
features (constraint wording, the action class's ties, days, names, the turn gate) add little to meaning: the same
cause as §1 and M7 (D930), and M1's micro checker (D982). A fifth of the check's calls is skippable at 1% of facts
**[EST: about −$0.02 per 1,000 tasks and −0.13 s a task of the check's wait on the mix, from F7's $0.196 and 0.87 s]**;
not built, since the bar was set at 40%.

## 9. The check's wait off the critical path: speculate-and-hold in the proxy (trial `speculate`, built)

**Status (2026-11-12, D1273):** promoted to the proxy's default by the integrator without the live pair this section
asked for, on G4's modelled wall (`wall.py`) and F2's priced calls; the review added the provider-run-tools
exclusion (`providerRunsTools`). The text below is the trial as built.

The integrator's follow-up: the goal is the check's wait (about 0.8 s) against the agent alone, and a skip is one way.
What is already measured: the pool's size barely moves the wait (D1050: p50 0.89 against 0.92 s), a shorter reply let
look-alikes in (D822), and handing the packet after the agent's first call made the agent search and ask first
(D248: hidden wall +1.14 s). The reply itself, on F2's 2,282 recorded API replies (a stop sequence does not change
what comes before it, so truncating the recorded reply is exact): replies average about 66 tokens; a stop at the
first `"act":false` keeps 602 of 614 protected facts and saves about 34 tokens (about 100 ms [EST]); a cap of three
entries keeps 610 and saves about 34 ms. The check's wait is mostly its fixed time to first token, so no reply form
buys much.

**So the lever left is not waiting at all, with nothing the agent sees changing** (F7 §9's design): at a new turn the
proxy sends the request upstream at once, in the exact form it would take if Eden had nothing new, and holds its
answer while Eden works. When Eden's work lands, if the request it would now send is byte for byte the speculative
one, the held answer goes to the agent; otherwise the speculative call is aborted and the request goes as today. The
agent's bytes are the default's in every case, so no fact or concern can move; the cost is the aborted calls.

**Priced on the API's own check calls** (`spec_gate.py`, the 1:1:8 mix; [EST]: a silent check's wait 650 ms and an
aborted Pi first call $0.0001, F7 §9): the check names nothing on 63.4% of calls on the mix, so speculating on every
turn saves **about 0.41 s a task for about +$0.037 per 1,000 tasks** (0.37 aborted calls a task). A gate that
speculates only where skip.py's model expects silence trims the cost and the saving together (median gate: 0.35 s for
+$0.021); not built, the ungated form is simpler.

**Built** (`packages/proxy`, option `speculate`, `EDEN_PROXY_SPECULATE=1`, off): chat completions and Anthropic
Messages only (not the Responses route); not with `askTool`, in shadow mode or with `store: true`; an early 429 or
5xx is not passed on (the request goes again).
`proxy-speculate.test.ts`: off, Eden's wait and the model run in a row; with nothing new, one upstream call made
during the wait and the same answer, about 300 ms sooner in the test; with a packet, two calls and the agent gets the
packet request's answer. **Not measured live:** the aborted call's real bill and the held stream's wall need the API. The +$0.037 counts an
aborted call's input only; output written before the abort, or billed after it for a non-streamed request, adds to it
(the review), and a packet turn sends two requests against the tenant's rate limit. The live pair reads billed output
on aborted calls, streamed and not, and the 429s.
The lab's Pi harness does not go through the proxy, so the decision needs a live pair on the proxy.

## 10. Pre-registration: trial `pushCheckSkip` at the integrator's new bar (before any fit of this form)

A new decision, not a re-read of D1272 (the integrator, 10:16): a cheap skip that stacks with `speculate`.

- **Model:** skip.py's per-item logistic regression **without the encoder** (items are not embedded in production):
  each pool item's rank, `DEONTIC` matches, `constrains`, `mayConstrain`, the action class's ties, the request's
  names it holds, a request day it names, its length and source; the request's turn-gate logit and kind,
  `isImperative`, named days and names. A row scores its best item. The same API rows, the same 5 template folds, the
  same fold thresholds (at most 0.5% of the training folds' protected rows under them).
- **Bar (pooled out of fold):** protected rows skipped ≤ 1% and the 1:1:8 mix skipped ≥ 18%.
- **Pass:** the weights are refit on all 2,282 rows with the threshold at the same 0.5% quantile and shipped as
  trial `pushCheckSkip` (engine, off): a push whose pool scores under the threshold makes no check call and stays
  silent, as a check that named nothing. Handed to F12. **Fail:** a finding, nothing built.

**Result: fails** (`skip.py --no-encoder`): protected skipped 3 of 614 (0.49%), the mix 10.5% (hidden 0.9%, control 1.4%,
neutral 12.9%), against ≥ 18%. Without the item cosine the model is weaker than §8's (15.9%, also short of 18%). Not
built (D1274).
