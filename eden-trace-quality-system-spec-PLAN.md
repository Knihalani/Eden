# Eden Trace Quality + Online Guardrails — Plan

**Date:** 2026-06-28
**Goal:** Hyper-detailed, comprehensive engineering spec for a deterministic, non-LLM trace quality + runtime guardrail system across Eden's Cat 1-23 surface. From spec → shippable SOTA system.
**Constraint reminder:** No language models of any kind (no SLM judge, no LLM-as-judge, no GPT-4o-mini fallback). Cost optimisation = minimise compute, minimise memory, maximise speed.

---

## Current State (as of v0.1 spec)

- v0.1 spec at `~/.claude/plans/eden-trace-quality-system-spec.md` (608 lines, 11 phases, ~11,800 LoC estimated)
- Synthetic dataset at `tests/fixtures/traces/synthetic/` (30 traces × 10 archetypes × 3 variants, ~280 events, 17/17 smoke tests passing)
- Existing Eden surface to integrate with:
  - `src/eden/observability/telemetry_collector.py:32-175` — `TelemetryEvent` (39 fields)
  - `src/eden/insights/unified_trace_model.py` — `UnifiedTrace`/`Span` + 9 normalizers
  - `src/eden/guardrails/policy.py:69,82` — `VALID_POLICY_TYPES`, `VALID_ACTIONS`
  - `src/eden/guardrails/intervention.py:279` — `InterventionEngine.evaluate_and_act`
  - `src/eden/guardrails/detectors.py` — `PromptInjectionDetector`/`PIIFirewall`/`HallucinationBlocker`/`LLMFirewall`
  - `src/eden/multi_agent/planning.py:143` — `PlanningFramework` + 5 subclasses (CoT/ReAct/ToT/PE/Reflexion)
  - `src/eden/llmops/closed_loop_executor.py:308` — `apply_approved` is `v0_noop`
  - `src/eden/llmops/promotion_hooks.py` — hook registry
  - `src/eden/optimization/model_router.py` — cascade router
  - `src/eden/observability/message_store.py` — Laminar 20× dedup (already shipped)
  - `src/eden/db_migrations/versions/041_trace_messages.py` — `trace_messages` table

---

## Plan: 4 phases over multiple sessions

### Phase A — Foundation + Broad Research (THIS SESSION)
**Output:** v0.2 spec draft + 12 research notes + initial test fixtures.

1. Write this plan to disk (✓ done above).
2. Confirm `TelemetryEvent` schema matches what synthetic dataset tests against; verify all 39 fields.
3. Verify synthetic dataset actually round-trips through `TelemetryEvent.from_dict` (run `tests/fixtures/traces/synthetic/test_loader.py`).
4. Dispatch **12 parallel research subagents** to deepen each of the v0.1 spec's areas — see "Research streams" below.
5. Read all 12 research notes; identify gaps; mark v0.2 sections that need deep-dive in next session.

### Phase B — Deep Research + Cross-validation (NEXT SESSION)
**Output:** v0.3 spec draft with evidence-backed formulas, weights, thresholds, and code stubs for each detector/metric.

1. Spawn deep-dive agents on the 5-8 highest-leverage gaps from Phase A.
2. Cross-validate by running micro-benchmarks: HHEM-2.1 vs HHEM-2.1-Open on 100 RAGTruth-QA samples; MiniLM-L6-v2 vs BGE-small vs GTE-small on the paraphrase-loop archetype; TraceRazor weights against synthetic dataset ground truth.
3. Implement each detector as a runnable prototype in `supplementaries/` (referenced by spec).
4. Run prototypes against the synthetic dataset; record F1, latency, memory.

### Phase C — Iterative Dev + Test (LOOP UNTIL PERFECT)
**Output:** All detectors, metrics, gates pass acceptance criteria from v0.1 spec §4.

1. Per phase (Phase 1-11 in v0.1 spec):
   a. Implement detector/metric/gate in `supplementaries/<phase>/<name>.py`.
   b. Write unit + integration tests in `supplementaries/<phase>/test_<name>.py`.
   c. Run tests; iterate until acceptance criteria pass.
   d. Record benchmark results in `supplementaries/<phase>/BENCHMARK.md`.
2. End-to-end: run full synthetic dataset through entire pipeline; verify all 30 traces produce expected TAS, intervention, loop detection, hallucination detection within tolerance.

### Phase D — Final Spec + Supplementaries
**Output:** `eden-trace-quality-system-spec.md` (final, in CWD) + `supplementaries/` directory.

1. Update v0.3 spec to v1.0 with all research findings, validated algorithms, exact thresholds, code refs to supplementaries.
2. Spec must include:
   - Per-phase implementation code in supplementaries (not in spec).
   - Acceptance criteria with measured results from Phase C.
   - Hyper-detailed algorithm descriptions (math, pseudo-code, edge cases).
   - Cost analysis: per-trace CPU, memory, latency, $/1M traces.
   - Test strategy: synthetic dataset + adversarial cases + load tests.
   - Rollout plan with feature flags and rollback.
   - Risk register + open questions.
3. Spec is canonical reference; supplementaries are runnable truth.

---

## Research streams (12 parallel agents in Phase A)

Each agent returns: 5-10 pages of cited findings + 1-3 algorithmic recommendations + 1 worked example.

| # | Stream | Goal |
|---|---|---|
| 1 | **TraceRazor metrics deep-dive** | Verify 8 metric formulas + weights from paper; check τ-bench + τ²-bench evidence; find any newer metrics since v0.1 |
| 2 | **Loop detection SOTA** | Beyond Felix 2025: Markov entropy, TF-IDF cosine, Levenshtein-on-canonicalised; adversarial loop patterns |
| 3 | **Hallucination/grounding non-LLM** | HHEM-2.1 vs HHEM-2.1-Open vs MiniCheck vs Binoculars; latest as of 2026-06 |
| 4 | **Semantic embedding tradeoffs** | MiniLM-L6-v2 vs BGE-small vs GTE-small vs E5-small vs all-MiniLM-L12-v2 on paraphrase-loop + retrieval |
| 5 | **OTel GenAI semantic conventions** | Latest spec version; exact attribute names; what Eden's 30-column migration should add |
| 6 | **Statistical tests for StatGate** | mSPRT implementation, BH-FDR, conformal prediction, ECE calibration — concrete Python libs (scipy.stats, statsmodels) |
| 7 | **Cost optimisation SOTA** | AutoMix, GPTCache, FrugalGPT, RouteLLM, semantic cache eviction policies — measure $/1M traces |
| 8 | **Agent benchmarks 2026** | τ-bench v2, BFCL v3, SWE-bench Verified, LiveCodeBench, GAIA, HLE — latest results + how Eden-8-cat maps |
| 9 | **A2A protocol + memory patterns** | Google A2A current spec; Mem0, MemGPT, Letta; blackboard/market/swarm topology patterns |
| 10 | **Reasoning quality research** | Lanham 2023 follow-ups; CoT validity; self-refine; verification markers; CoT-collection 2025-2026 |
| 11 | **Online guardrails + circuit breakers** | Sponsio, Fencio, EnforceCore, DeepConf, GPTCache lookup; latest patterns for in-flight intervention |
| 12 | **Adversarial attacks + red-teaming** | PAIR, TAP, Crescendo, indirect prompt injection, multi-turn escalation, sycophancy, reward hacking — detection patterns |

---

## Session structure reminder

- This session = Phase A (broad research).
- Next session = Phase B (deep research + cross-validation).
- Subsequent sessions = Phase C (iterative dev + test loop).
- Final session = Phase D (final spec + supplementaries).
- Each session: end with explicit status (what's done, what's next, what's blocked) so the next session can resume.

---

## Stop conditions

- v0.2 spec saved to `eden-trace-quality-system-spec.md` (overwriting v0.1) or `eden-trace-quality-system-spec-v0.2.md`.
- 12 research notes saved to `supplementaries/research/`.
- Synthetic dataset verified to round-trip through `TelemetryEvent.from_dict`.
- Clear list of Phase B deep-dive targets.

---

## File structure at end

```
eden-trace-quality-system-spec.md          # canonical spec (v1.0 final)
eden-trace-quality-system-spec-PLAN.md     # this file (kept for reference)
supplementaries/
  research/
    01_tracerazor.md
    02_loop_detection.md
    03_hallucination.md
    04_embeddings.md
    05_otel_genai.md
    06_statistical_tests.md
    07_cost_optimization.md
    08_agent_benchmarks.md
    09_a2a_memory.md
    10_reasoning.md
    11_online_guardrails.md
    12_adversarial.md
  phase_1_telemetry/
  phase_2_efficiency/
  phase_3_loops/
  phase_4_guardrails/
  phase_5_quality/
  phase_6_stat_gate/
  phase_7_detection/
  phase_8_cost/
  phase_9_reasoning/
  phase_10_memory/
  phase_11_benchmark/
```

---

**Status:** Phase A starting now. First step: verify synthetic dataset + dispatch 12 research agents in parallel.