# R10 — Retrieval research: report (living document)

**Status:** end of cycle 3 of an open-ended programme (`research/R10/BRIEF.md`). Every number below comes from `research/R10/LEDGER.md`, which says where it came from. The current state, the hypothesis portfolio and the graveyard are in `research/R10/STATE.md`.

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
7. **The labels are valid; wrong bullets cost tokens, not measured quality** (downstream check, BRIEF §4.7; re-measured in C4-E10 after two harness fixes).
   - Memory changes the outcome on 77% of plan-labelled need turns in both worlds (+0.8 code, +0.9 life, on a 0–3 scale).
   - Half of the independent labeler's extra needs are real but mild.
   - The cheap hook-side vote keeps about 21% of the available benefit on code.
   - A packet on turns that need nothing scored the same as no packet (0.0). The earlier "−0.40 harm" came from a responder that swapped reply order and a judge that called true history "fabricated"; it is withdrawn.
8. **Benchmark realism, after fixes.**
   - The coverage rule is calibrated against a judge (κ 0.86).
   - Prompts were shortened toward R6's lengths (p50 15 words; R6's is 12).
   - A leak-free sleep mode was added.
   - The incumbent now also runs with P4.3's evidence gate on: silence 0.21, which is still a 79% fire rate against the real 31%.

9. **A model checking candidates off the hook helps, but less than first measured** (cycle 4).
   - The hook picks up to 15 candidates with no model. A small model (haiku) checks them while the agent works, and the result arrives at the agent's first tool call. Eden stays in charge; the agent never has to ask.
   - Checked one turn at a time (as it would really run), it reaches code recall 0.52 at silence 0.43, and life 0.30 at 0.62. On fresh red-team cases it beats the word matcher clearly (silence +0.38 code, +0.53 life).
   - The first measurement checked 50 turns per call and looked much quieter (silence 0.66). The model was comparing turns with each other, which a real hook never can. That number is retracted. Calibration is the open problem (C4-E11 is testing a fix).
   - Two of the critic's alternatives are dead: showing the small model the whole store instead of a shortlist (no better), and checking the agent's draft reply before the user sees it (it flags as often when nothing is needed as when something is).

## 5. Open problems, ranked by size

1. **Calibrating the off-hook checker.** One turn at a time, it fires on more than half of the coding turns that need nothing.
2. **Triggers in the personal world** (calendar, location, messages). No system is quiet on routine triggers; trigger silence is 0.0–0.36 everywhere, on few negatives.
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
