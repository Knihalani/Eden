# R10 — Realism audit of the existing R10 benchmarks and harness (BRIEF §4)

**Dated 2026-10-18, cycle 1.** Audits what the earlier R10 session built (`benchmarks/memory-life/`, `benchmarks/r10/`) and the fixtures it reused (R1 CueBench-code, R8 `test_nim`) against the realism contract in `BRIEF.md` §4. Verdict first: **none of it can be the primary benchmark.** All of it is isolated memory–cue pairs. It stays as **secondary arms**, and nothing is tuned on it alone. The primary benchmark is StreamBench (`benchmarks/memory-stream/`), built this cycle to the contract.

## Contract clause by clause

| §4 clause | LifeBench + `benchmarks/r10/` (as found) | R1 / R8 | Verdict |
|---|---|---|---|
| 1. Streams, not pairs | One cue → gold ids. No sessions, no hook sequence, no assistant turns, tool output, compaction or resume. A cue may carry one `prev_turn` and one `context` line | Same, plus one scope string | **fails** |
| 2. Store from the write path | The store is 315 hand-written, clean, atomic rows (3 authors). Eden's write path never runs. No duplicates, no episode rows, no re-injected user requests or tool output, which R10's own realism facts say are 89% of real noise | 214 hand-written rows | **fails**. Only the oracle-store half exists |
| 3. Base rates and volume | Negatives were planned at a fixed share of cues, not of turns. No non-human events. The store is 315 rows, not thousands. One base rate | R1: 150 negatives of 666 cues (23%); R8: 98 of 558 | **fails** |
| 4. What counts as a need | Gold, allowed and forbidden per cue, with direct, para, proactive, event, multi and stale categories. Good taxonomy. "Already in context" cannot be expressed: there is no context | Has lex, para, ctx, indirect and policy categories; no proactive or stale categories | partial |
| 5. Proactive and event moments | `channel: event` cues exist in the spec | none | partial (no time, no returning user, no agent action moment) |
| 6. Hard negatives | Spec lists general knowledge on the user's topics, other people and chit-chat. No long pastes, no restating context, no non-human turns | R8 `nim-neg` (98), tuned on in P4.3 | partial |
| 7. Downstream effect | none | none | **fails** |
| 8. External anchors | none | none | **fails** |
| 9. Authorship and leakage | Authors recorded per row (memory authors A/B/C, cue authors D/T, holdout H, all Claude subagents). Sealed holdout planned, LOOKS.md logging coded in `common.py` | R1: one author wrote memories and hand cues | ok for LifeBench, weak for R1 |

## Facts found while verifying

- **The LifeBench cue files were never committed.** `benchmarks/memory-life/fixture/` holds only `memories.json` (315 rows, 37 superseded). STATE.md's "dev 330 / test 330 / holdout 210" describes cue sets that are not in the repo. `benchmarks/r10/common.py` loads `cues-dev.json` and `cues-test.json` only if they exist, so every LifeBench number would come from an empty cue set. The memories and the world bible (`WORLD.md`) are sound and are reused below.
- STATE.md's only frontier row (bm25ctx on code dev, r@4 0.567 at FIR 0.043) has **no LEDGER entry** (LEDGER.md is empty). It is unverified. It is carried as a secondary-arm number only once re-run.
- **The long-horizon harness (`benchmarks/memory-long-horizon/harness/`) is close to the contract on clause 1.** It drives the real plugin with Claude Code's real hook sequence, one process per hook, including tool batches, subagents, task notifications, peer messages, compaction and resume. A world replay on today's plugin (seed 1, this session) gave `false_rate` 40/44 = 0.909, which reproduces the realism fact "89% of injected bullets unneeded". Its gaps:
  - word-salad tool output (`"1 cache update return result…"`), which the write path stores as 350 of 364 rows;
  - a 7-slot world with 6 needing cues per run;
  - coding only;
  - one session a day for about a week.

## What changes

1. **StreamBench** (`benchmarks/memory-stream/`) is the primary benchmark. It has:
   - multi-week, multi-session streams in a coding world and a personal-assistant world, played through the long-horizon harness (the real hook sequence, the real plugin, the real write path);
   - per-event oracle labels (needs, allowed, forbidden, need type), with "already in context" computed from the stream;
   - non-human events at R6's share;
   - time, calendar and returning-user triggers;
   - hard-negative categories;
   - several base rates in every report;
   - every method run on both the write-path store and the oracle store.
2. LifeBench's memories become the personal world's oracle items, and R1's memories the coding world's. This keeps continuity with prior numbers. The items are stated *inside* the stream, so the write path has to extract them.
3. R1, R8 and LifeBench pairs stay as secondary arms. A method's win on them alone is not a frontier move.
4. Not done this cycle, and tracked in STATE.md: the downstream-effect judge (clause 7), the external anchors (clause 8), and the sealed StreamBench holdout (clause 9).
