# R10 cycle-1 adversarial critique (critic C1)

All numbers below come from commands I ran on the committed artifacts (HEAD 35d979f), code world, dev split, plan labels unless noted.

## 1. Ledger re-runs (task 4)

| Ledger claim (C1-E2/E3) | Re-run | Match? |
|---|---|---|
| eden write: R 0.0909, pro 0.0769, P 0.0062, sil 0.1042, tok 61.7 | identical (55 need / 336 neg events) | yes |
| lex τ=6 write: 0.1545 / 0.0 / 0.0103 / 0.0774 / 194.5 | identical | yes |
| lex τ=4 oracle, τ=8 oracle, lex τ=4 sleep, when=1 sleep, judge, oracle-need sleep | all identical to 4 d.p. | yes |
| union labels: judge P 0.24→0.51, sil 0.51→0.63 | 0.5102 / 0.6341 | yes |
| **Eden bullet classes: past prompts 523 (65.2%), tool 34, untraced 47, needed 5** | **noise:human 512 (63.8%), tool 38, assistant 15, notification 8, allowed 8**; total 802 vs the ledger's 778 | **no** |

The bullet-class mismatch has two causes. First, the ledger leaves out three classes (assistant, notification, allowed: 31 bullets). Second, `score.trace()` is **nondeterministic**: it takes `max()` over a dict built from set iteration, so ties depend on PYTHONHASHSEED. Two runs in this session gave human 512/511 and tool 38/37. Fix: sort the candidates, or set PYTHONHASHSEED. Also, the `decompose` docstring says "human and trigger events", but the function runs over every scored event.

## 2. Why "sleep `when` cues + lexical" is a local optimum

1. **The gain is small and partly leaked.** The when=1 gain is recall 0.2485 → 0.3848 on 55 need events. The paired bootstrap 95% CI on that gain is **[+0.039, +0.242]**. Proactive goes 1/13 → 5/13 (Wilson CIs [0.01, 0.33] vs [0.18, 0.64]). Each sleep batch compiles 10 sessions at once, so the compiler **sees later sessions' prompts while writing `when` cues for earlier rows**. 3 of the 10 events that gained, and 4 of 24 when=1 hits, were served by a row from the need event's own batch. Leak-free, the gain may be about 7 events.
2. **It does not touch the binding constraint.** Silence gets *worse* (0.1518 → 0.125, i.e. 51 → 42 of 336). Precision is 0.022. The judge's advantage is mostly silence (0.51) and precision (0.24), not recall. Lexical scores separate need from no-need turns at AUC ≤ 0.70 (C1-E2). Adding cue tokens to documents raises scores on *every* turn, so it cannot fix a ranking-score separability problem. This is doc2query by another name. R1 already showed doc2query ≈ BM25 (0.48 vs 0.47).
3. **Coverage inflates recall through composite rows.** 137 of 375 sleep rows cover ≥ 2 items. One 54-word "local setup" row covers 14 items, and a "stack" row covers 11. Of the 28 needed bullets that when=1 injects, 10 come from rows covering ≥ 3 items. Recall rewards fat summary rows that a lexical query hits easily. Precision, which is per bullet, then credits them as "needed".
4. **The judge is not a ceiling.** It (a) fires on 49% of sampled no-need turns, (b) is scored on a 165-event sample (55 need, 110 neg), not on the 391 events the others use, and (c) is not visibility-enforced. `judge.prep` shows every row with `t < max(batch)`, and `score.py` never filters by `now`. 1 of 259 judge picks was a row written after its event. It is "opus", and the authors' model is unrecorded (`author: claude-subagent:stream-author-code-bNN`). If that is the same family, the judge reads text it wrote itself.
5. **The "write path loses nothing" verdict is an artefact.** oracle-need = 1.0 on the write store only means that *some* row holds ≥ 0.5 of the item's tokens. The write store keeps raw user prompts, so any item the user typed is "covered". That measures token survival, not extraction.

## 3. Blind spots and failure classes

- **Method:**
  - nothing models *when not to speak* except token thresholds;
  - no session-level reasoning (an item needed at turn 1 is re-fired at turns 2–7, which the redundancy metric only partly catches);
  - no use of the agent's own tool calls as cues: `action` events are scored, but `Lex` queries only `text_all` of the event;
  - habituation is per row, not per situation.
- **Benchmark:**
  - authors wrote each proactive prompt *knowing the item*, so topical co-occurrence (e.g. "date picker" → date-fns) is a property of the author's mind, which `when` cues are built to exploit;
  - dev and test are interleaved sessions (mod 5) from the same 11 author batches and the same store, so they are not independent;
  - no holdout;
  - the life world is unscored, so every frontier claim is coding-only, against the brief's "don't overfit to coding".

## 4. Realism contract §4, clause by clause

| Clause | Status | Biggest gap (quantified) |
|---|---|---|
| 1 Streams | good | Real hook sequence via replay. Sleep visibility starts at session end + 0.5, which is fine. Oracle rows are visible from the stating event. |
| 2 Write-path store | partial | Write store 2,737 rows, sleep 375. The coverage matcher makes the write-vs-oracle split uninformative (§2.5). 108 sleep rows cover no item and 16 items are covered by no sleep row; no judge-validated row↔item map. |
| 3 Base rates/volume | **weak** | Plan need rate 14.0% (55/391 dev human). Labeler 176/493 = **36%**; real ≈ 8%. Prompts: p25/p50/p75/p90 = 14/21/31/46 words vs R6 p50 12; ≤ 3-word prompts 8.5% vs R6 24.2%. The base-rate reweighting changes the need mix only, not the negative *composition*, so silence stays inflated: Eden fires on 90% of negatives vs 31% real. Sleep store 375 rows ≠ "thousands". |
| 4 Need labels | **weak** | Plan vs labeler: 71 items agreed, 15 plan-only, **224 labeler-only**. Both labeler and sleep compiler are sonnet, so union labels and the sleep store share a generator, which biases union scores toward sleep rows. No adjudication and no downstream check. |
| 5 Proactive/event | partial | Code: 13 proactive need events on dev, 7 action moments overall. Triggers exist only in the unscored life world. |
| 6 Hard negatives | ok on paper | Categories are planned, but no per-category silence is reported. Acks are a minority because prompts are long. |
| 7 Downstream | **missing** | Every metric rests on the 0.5-token-overlap matcher, which has never been validated against a judge. |
| 8 External anchors | partial | LoCoMo converted but unscored; LongMemEval blocked. |
| 9 Leakage | **weak** | Author model unrecorded. Sleep compiler sees future sessions within a batch. Judge has no visibility enforcement. Labeler is the same model as the sleep compiler. No holdout. |
| Metrics | partial | No CIs anywhere. Latency (p50 129.8 / p99 402.7 ms) was measured under load. |

**Sample sizes.** With 55 need events, a recall SE is about 0.05–0.06. With 13 proactive events, a ±0.25 swing is noise. The judge's negatives number 110, so its silence CI is about ±0.09. Every LEDGER row needs a bootstrap CI, and "F11 lives" should be restated as "CI excludes 0 but is partly leaked".

## 5. Three orthogonal directions

**D1 — Agent-pull memory: retrieval as a tool the host model calls.** The mechanism moves the need decision to the model that already reads the turn. The hook only advertises a one-line memory index, such as top entities and kinds; it never injects. This attacks silence directly, since the host model does the AUC-0.70 problem for free and has no hook-latency cost.
- *First experiment:* on the 165-event judge sample, give a sonnet "agent" the turn, recent context and a 20-line index of store topics. It decides whether to call `recall(query)`, which runs lex on the sleep store and returns ≤ 4 rows. Score recall, silence and precision.
- *Kill if* tool-call rate on no-need human turns > 25%, or recall < when=1's 0.38 on the same sample.

**D2 — Contrastive (PU) trigger learning from the user's own negative history.** About 86–92% of a user's turns need nothing, which makes them free, label-free negatives. At sleep, for each row, fit a discriminative predicate: cue features with high lift on the row's source context vs the user's past turns, plus `unless` features. Example: the row should fire on "dependency" only with an install or add verb, never on "dependency graph" talk. This is not cue expansion; it is cue *pruning* aimed at silence.
- *First experiment:* score each when=1 cue token by its rate on all earlier human turns (causal, label-free), and drop tokens above the 10% firing rate. Measure silence and recall on dev.
- *Kill if* silence does not rise ≥ 0.20 absolute (to ≥ 0.33) at recall ≥ 0.30.

**D3 — Event-sourced situation tracking: fire on state transitions, not prompts.** Deterministic parsers over tool calls, paths, commands, calendar triggers and people named maintain slots: project, activity, artefact, counterpart, time-to-event. Memories are keyed to slot values at sleep, and the hook fires only when a slot *changes* into a keyed value. This gives silence by construction on acks, restatements and in-session repeats, and uses the `action` events lexical methods ignore.
- *First experiment:* slots {path prefix, command verb, package name, person} on the code world. Key each sleep row by its entities; fire on first entry into a keyed slot per session.
- *Kill if* proactive + action recall < 0.30, or human silence < 0.60.

## 6. Benchmark fixes to do before the next frontier claim (by priority)

1. **Downstream-validated coverage.** On 200 bullets, LLM-judge "does this bullet supply item i" vs the 0.5-token rule. Report κ, and split composite rows.
2. **Adjudicate the 224 labeler-only items.** Use a third model plus a downstream answer-with/without check, and settle need strictness so the rate lands at 8–15%.
3. **Length-calibrated v2 stream.** Target p50 12 words and ≥ 20% ≤ 3-word prompts. Re-measure the Eden fire rate against the real 31%.
4. **Leak-free sleep.** Compile session by session (or batch = 1, with `store_before`). Enforce `now` visibility in judge scoring. Record author models.
5. **CIs on every metric.** Score the life world, and write the sealed holdout with a non-Claude generator if one is available.
