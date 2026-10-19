# R10 — Retrieval research: report (living document)

**Headline (cycle 5):** a design that beats today's plugin, measured by its effect on the agent's replies. The hook picks up to 15 candidate memories with no model. A small model checks them off the hook. Each delivered memory carries its date ("as of Aug 30"). On fresh turns it improves replies by +0.11 (coding) and +0.13 (personal assistant) per turn on a 0–3 scale; today's plugin scores about 0. Where memory is needed it lifts replies by about +0.6, and where it isn't it does no measurable harm. With more turns added (C6-E1) and a second independent run on coding (C6-E2), the result is now firm on both worlds: personal assistant +0.13 per turn (95% range +0.04 to +0.23), coding +0.10 (range +0.01 to +0.20). One caveat stands: every model involved is a Claude model.

**Status:** cycle 5 (2026-10-19) of an open-ended programme (`research/R10/BRIEF.md`). Every number below comes from `research/R10/LEDGER.md`, which says where it came from. The current state, the hypothesis portfolio and the graveyard are in `research/R10/STATE.md`.

## 1. The question

Eden injects a short packet of memories into an agent's context. "Perfect" retrieval means three things:
- every needed memory on every turn, including those the user never mentions;
- an empty packet on the many turns that need nothing;
- nothing repeated that is already in context.

The user asked for this across coding agents *and* personal, proactive, coworker and tutor agents, measured on a benchmark that reflects real use.

## 2. The benchmark changed the picture

The earlier fixtures (R1 CueBench, R8, LifeBench) are isolated memory–cue pairs written by one author. They fail the realism contract (`R10/REALISM-AUDIT.md`), so they are now secondary.

**StreamBench** (`benchmarks/memory-stream/`) is the primary benchmark:
- **Streams:** multi-week, multi-session streams, played through the real plugin's hooks.
- **Worlds:** a coding world (110 sessions) and a personal-assistant world (160 sessions over 18 months).
- **Event mix:** non-human events at R6's share (0.45); time, calendar and message triggers; hard-negative categories; corrections.
- **Labels:** per-turn need labels, plus an independent labeler audit.
- **Stores:** every method runs on Eden's own write-path store, on a perfect-extraction oracle store, and on a sleep-compiled store.

On realistic streams, lexical retrieval is far weaker than the pair fixtures suggested:
- On the clean oracle store, BM25 recall is 0.21 at only 20% silence.
- The best lexical score separates need turns from no-need turns at AUC 0.66–0.70.
- On pairs, R1 had reported recall 0.47–0.56.

## 3. Where Eden is today (the plugin on `main`)

**Measured by outcome (C5-E3):** the plugin's memories barely change the agent's replies. Where memory is needed, coding replies improve by +0.1 on a 0–3 scale (the right memories would give +1.2) and personal-assistant replies get slightly worse (−0.2). Where nothing is needed, they do no measurable harm. Overall: coding −0.04 per turn (slightly net-negative by the pre-set rule), personal assistant +0.03 (near zero).


| World | Recall | Proactive | Bullet precision | Silence on no-need human turns | Non-human silence | Trigger recall |
|---|---|---|---|---|---|---|
| code | 0.091 | 0.077 | 0.006 | 0.104 | 1.0 | — |
| life | 0.044 | 0.044 | 0.003 | 0.050 | 1.0 | 0.0 |

- **Where the bullets come from:** 59–65% are the user's own past prompts re-injected. That matches the realism fact from real use (89% of bullets unneeded, mostly the user's own requests).
- **Non-human silence is already solved:** 1.0 on both worlds.
- **The write path loses almost nothing:** a perfect selector on Eden's own store reaches recall of about 1.0. The losses are in *selection* and *gating*.
- **Latency:** Submit hook p99 403–425 ms at 2.7k–3.6k rows. That is over the 150 ms budget, but it was measured under load and is not yet confirmed on a quiet machine.

## 4. What we learned (cycles 1–2)

1. **Lexical gating cannot make the silence decision on realistic streams** (graveyard). This holds for any threshold, habituation (F12) or negative-history pruning (F14). These only move along one curve.
2. **Sleep-time compilation helps** (F11).
   - An LLM write path that stores atomic memories with compiled `when` cues (entities, activities, times) raises proactive recall on code from 0.08 to 0.31. This is measured leak-free.
   - It is the substrate the better methods use.
3. **Self-play exemplars beat fact matching** (F4).
   - A third model family writes, at sleep, situations that need each memory and near misses. Matching the turn against those exemplars raises silence by +0.16–0.26 at equal recall, on both worlds.
   - AND-ing two independent kinds of evidence gives the best hook-side point: code recall 0.33 at silence 0.47 (coverage v2).
4. **Every hand-built combination plateaus** at about 0.3 recall and 0.5–0.6 silence. That is a local optimum.
5. **Agent-pull lifts precision and silence, but less than first reported** (F13).
   - The host model already reads every turn. Given a ~100-token memory index and a `recall()` tool, it decides when to look and what to ask.
   - On the same events (critic C2's correction), it gets 2.5× the precision and +0.18 silence on code, and 2.1× and +0.26 on life.
   - It calls on 93% of need turns, but also on 28% of no-need code turns, which fails its own pre-registered 25% line.
   - At an 8% base rate, 93% of its bullets are still unneeded. Retrieval *after* the call is now the weak half.
6. **No cheap hook-side signal decides "is memory needed?"** All of these cap at AUC 0.62–0.70 on both worlds:
   - lexical scores;
   - self-play exemplars;
   - situation tracking;
   - a gate distilled from a strong model's decisions;
   - static word vectors.
   An independent blank-slate design converged on the same wall (about 0.3 recall@4) and on the same remedies (sleep-time situations and clean statements). Its one new mechanism, budgeted firing calibrated per user, is adopted. It adds about +0.1 silence on code.
7. **Memory matters a lot, and wrong memories hurt** (downstream check, BRIEF §4.7; clean re-run C5-E1).
   - The right memories improve the reply on 97% of coding and 87% of personal-assistant turns that need them (+1.2 and +1.1 on a 0–3 scale).
   - The cheap hook-side matcher captures about half of that on coding (+0.63).
   - But on turns that need nothing, its wrong memories make the reply worse (−0.47, against a noise level of −0.07). A wrong memory costs about 40% of what a right one gains, so Eden should only push a memory when it is at least about 30% sure it is needed.
   - (Two earlier versions of this check had protocol bugs; their numbers are superseded.)
8. **Benchmark realism, after fixes.**
   - The coverage rule is calibrated against a judge (κ 0.86).
   - Prompts were shortened toward R6's lengths (p50 15 words; R6's is 12).
   - A leak-free sleep mode was added.
   - The incumbent now also runs with P4.3's evidence gate on: silence 0.21, which is still a 79% fire rate against the real 31%.

9. **A model checking candidates off the hook helps, but less than first measured** (cycle 4).
   - The hook picks up to 15 candidates with no model. A small model (haiku) checks them while the agent works, and the result arrives at the agent's first tool call. Eden stays in charge; the agent never has to ask.
   - Checked one turn at a time (as it would really run), it reaches code recall 0.52 at silence 0.43, and life 0.30 at 0.62. On fresh red-team cases it beats the word matcher clearly (silence +0.38 code, +0.53 life).
   - The first measurement checked 50 turns per call and looked much quieter (silence 0.66). The model was comparing turns with each other, which a real hook never can. That number is retracted. A calibrated version (C4-E11) tuned well on the main set but its cutoff did not carry over to fresh cases.
   - Two of the critic's alternatives are dead: showing the small model the whole store instead of a shortlist (no better), and checking the agent's draft reply before the user sees it (it flags as often when nothing is needed as when something is).

10. **The test's labels undercount what coding users need, but not personal-assistant users** (C4-E13, confirmed by the clean re-run C5-E1).
   - On turns labelled "no memory needed" where the strong model still picked memories, those picks improved the reply on coding (60% helped, 17% hurt) but not on the personal assistant (23% helped, 20% hurt: the model just over-flags there).
   - What it found was mostly recent project state (open branches, unpushed work, open PRs) that the planned labels never tagged.
   - So "stays quiet when nothing is needed" has been partly punishing correct behaviour on coding. The next step is labels checked by outcome: a memory counts as needed if adding it actually makes the reply better.
11. **Even the strong model over-flags when it sees one turn at a time** (C4-E12), and a confidence cutoff tuned on the main set does not carry over to fresh, shorter prompts (C4-E11).

12. **Dates on memories stop wrong memories from hurting** (C5-E6, C5-E7). Most damage from a wrong memory came from old state presented as current ("the branch is not pushed", "the repo uses yarn"). Showing each memory's date lets the agent treat it as history and check. That cut the cost of a wrong memory from −0.6 to −0.1 on a small sample (10 turns), and on fresh turns the dated checker beat today's plugin. Both passed their pre-set tests; neither is statistically firm yet.
13. **A sleep-time bug:** the compiler could only mark a memory replaced within the same batch, so facts that changed later stayed live forever. A cross-batch pass fixes most of it on personal data, but on coding data it fell short of the bar I set (stale memories down 19–26%, bar 30%). It is worth doing as a bug fix, not as a measured win.

## 5. Open problems, ranked by size

1. **Making the lead firm.** The dated checker beats today's plugin, but on about 70 turns per world; it needs more turns, a second responder run, and real latency and cost numbers. Coding labels still miss real needs (C5-E1), so outcome-checked labels remain the right yardstick.
2. **Triggers in the personal world** (calendar, location, messages). Uncalibrated systems are not quiet on routine triggers (trigger silence 0.0–0.36); the calibrated checker reaches 0.45 on fresh cases, on only 11 negatives.
3. **The gap to a strong model.** opus with the same view finds +0.14 (code) and +0.21 (life) more of what is needed than haiku. Its ceiling numbers were also batched, so they need a one-at-a-time re-run.
4. **Benchmark realism.** There is no sealed holdout yet and no non-Claude author; LongMemEval is blocked by the network policy.

## 6. What this changed in the plan (consolidation, cycle 3)

- **ROADMAP and PROGRESS:**
  - Phase 8 now measures on StreamBench.
  - New slices: P8.8 (sleep compiler with need cues and self-play, shadow), P8.9 (pull channel), P8.10 (calibrated firing).
  - P8.6 builds the StreamBench arms.
  - Targets are pre-registerable from the R10 numbers above.
- **A5:** arms `stream-code`, `stream-life`, `stream-trigger`, `stream-downstream`; LifeBench pairs secondary.
- **DECISIONS:** proposals R10-1 (pull channel), R10-2 (StreamBench primary), R10-3 (precision and silence as outcome metrics) and R10-4 (sleep models write cues and situations). All are pending the user's decision.
