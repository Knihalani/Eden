# R10 — Retrieval research: report (living document)

**Status:** cycle 2 of an open-ended programme (`research/R10/BRIEF.md`). Every number below comes from `research/R10/LEDGER.md`, which says where it came from. The current state, the hypothesis portfolio and the graveyard are in `research/R10/STATE.md`.

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
5. **Agent-pull breaks the plateau** (F13).
   - The host model already reads every turn. Given a ~150-token memory index and a `recall()` tool, it decides when to look and what to ask.
   - Result on code: recall 0.47 at silence 0.74, with bullet precision 0.20, five times the best hook-side method.
   - The hook stays model-free.
6. **The labels need a downstream test.**
   - An independent labeler confirms 83% of the planned needs, but labels 36% of human turns as needing something. Real use measured 8%.
   - Strictness has to be settled by whether the packet changes the answer (BRIEF §4.7). Until then, results are shown under both label sets.

## 5. Open problems, ranked by size

1. **Triggers and proactive needs in the personal world.** Every method is at or below 0.15 trigger recall and below 0.09 life proactive recall.
2. **Silence on statement and task turns.** These are the two largest false-fire classes.
3. **Benchmark realism.**
   - Prompts are about 2× R6's length.
   - The false-fire rate is inflated.
   - Sleep batches must be compiled per session to remove the leak and the strict-mode delay.
   - No sealed holdout yet.
   - LongMemEval is blocked by the environment's network policy.

## 6. What this suggests for the plan (proposals, not yet slices)

- **A pull channel next to the push channel.** The hook pushes only high-precision items (rules on actions, corrections). The host model gets a memory index and a `recall` tool for everything else. This needs a DECISIONS proposal: it changes A4's delivery model, but not D15's no-model hot path.
- **Sleep-time compilation of memories with `when` cues and self-play exemplars.** This is the store format the hot path matches against.
- **Benchmark arms in A5:** StreamBench code and life arms, gating the Phase 8 slices with pre-registered targets. The proposed targets will be set after the length-calibrated stream, version 1.1.
