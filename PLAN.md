# Plan — Eden Trace Quality + Online Guardrails System

**Status:** In progress (Session 1, 2026-06-28)
**Owner:** Session

## Context

The v0.1 spec at `eden-trace-quality-system-spec.md` (600 lines, 11 phases) covers a
deterministic, non-LLM trace quality scoring + online trajectory guardrail system
for Eden. It is informed by 15 research streams but **none of the implementation
or rigorous SOTA validation has been performed yet**. Goal: produce a hyper-
detailed, fully validated spec from which a SOTA system can be implemented.

## Hard Constraints (from user)

1. **No language models of any kind** — local <500M-param models only; nothing
   that requires GPU at inference.
2. **Cost optimisation = minimise compute, memory, increase speed.** No
   "we can throw more hardware at it" solutions.
3. **Iterative development** — write test implementations, run them, refine,
   ship into supplementary files referenced by the final spec.
4. **Test dataset must be 100% accurate to Eden schemas and data the system
   will actually evaluate.**

## Initial Codebase Audit Findings (Session 1)

Verified spec claims against existing Eden codebase. **All confirmed** with
these precise file:line references:

| Spec claim | Actual location |
|---|---|
| `telemetry_collector.py:32-175` TelemetryEvent (39 fields) | Lines 32-90 dataclass, 38 fields in `to_dict` (lines 92-132). `from_dict` at 134-175 |
| `policy.py:69` VALID_POLICY_TYPES | Lines 69-77 — 5 types currently |
| `policy.py:82` VALID_ACTIONS | Lines 82-84 — 5 actions currently |
| `closed_loop_executor.py:308` apply_approved v0_noop | Lines 290-329 — confirmed `v0_noop` at line 327 |
| `multi_agent/planning.py:143` PlanningFramework + 5 subclasses | Line 132 base, subclasses at 163, 284, 354, 435, 509 |
| `insights/detectors.py:447` RewardHoggingAnomaly | Line 435 — `RewardHackingDetector` |

**Synthetic dataset (verified):**
- 30 traces × 10 archetypes × 3 variants at
  `tests/fixtures/traces/synthetic/traces/` ✓
- 30 ground-truth files at `tests/fixtures/traces/synthetic/ground_truth/` ✓
- 17 smoke tests at `tests/fixtures/traces/synthetic/test_loader.py` ✓
- All events round-trip via `TelemetryEvent.from_dict/to_dict`

**Existing surface (already shipped, will reuse):**
- `promotion_hooks.py` has 14 hook methods across 6 hook classes
- Cat 22 APM shipped with sampling + K8s + profiling
- Cat 17 ClosedLoop via HookBus (dedup + approval gate)
- Cat 18 columnar engine with compaction + Postgres fallback
- Cat 13 PSI drift detector on judge scores
- Cat 5/6 memory + agent intel

## Session Structure

### Session 1 (now): Discovery + Broad Research
- [in_progress] Verify spec claims (DONE)
- [in_progress] Validate synthetic dataset
- [in_progress] Fan out 4 broad research subagents in parallel
- [in_progress] Begin reference implementation: trace quality pipeline

### Session 2+: Iterative Deep Dives
Per stream: research → implementation → test → refine → update spec.

| Stream | Focus | Deliverable |
|---|---|---|
| A. TraceRazor deep read | Validate 8 metrics, OBS weight, τ-bench evidence | supplementary file + spec section |
| B. Loop detection ensemble | Felix et al. 2025, hybrid F1 0.72 | reference impl + tests |
| C. Non-LLM quality scoring | HHEM-2.1, DeBERTa-NLI, BGE-rerank | reference impl + tests |
| D. Online guardrails | 8+4 check decomposition | reference impl + tests |
| E. StatGate | 5-check safe auto-apply | reference impl + tests |
| F. Cost optimisation | Semantic cache 4-tier, AutoMix | reference impl + tests |
| G. Memory + multi-agent | Cat 5/6 extensions | spec update only |
| H. Reasoning quality | CoT validity | reference impl + tests |

### Final Assembly
- Compile all findings + tested algorithms + latency measurements into the
  final spec at `/Users/kaiavnihalani/Downloads/Eden/eden-trace-quality-system-spec.md`
- All supplementary files cross-referenced from spec
- Validated against synthetic dataset: TAS within ±5, intervention 100%, loop F1 ≥ 0.7

## Reference Implementation Strategy

Each test implementation goes in `/Users/kaiavnihalani/Downloads/Eden/supplementaries/`:

```
supplementaries/
  trace_quality/        # Phase 2 — 8 TraceRazor metrics + composite TAS
    metrics/            # one file per metric
    composite.py
    tests/              # pytest test_X.py per metric
  loop_detection/       # Phase 3 — 4-detector ensemble
    detectors/          # hash_ring, jaccard, semantic, page_hinkley
    ensemble.py
    tests/
  quality_stack/        # Phase 5 — HHEM, DeBERTa-NLI, BGE-rerank, MiniLM
    models/
    pipeline.py
    tests/
  trajectory_guard/     # Phase 4 — 8 hot + 4 async checks
    checks/
    trajectory.py
    tests/
  stat_gate/            # Phase 6 — 5-check gate
    gate.py
    conformal.py
    tests/
  cost_opt/             # Phase 8 — semantic cache + AutoMix + LLMLingua
    cache.py
    tests/
```

All implementations:
- Pure Python (stdlib + minimal deps; no LLM frameworks)
- Lazy-loaded where appropriate (sentence-transformers etc. optional)
- CPU-only, single-core perf targets from spec
- Test against synthetic dataset from `tests/fixtures/traces/synthetic/`

## Definition of Done (final spec)

1. Every algorithm has a tested reference implementation in supplementaries/
2. Every test passes against the 30-trace synthetic dataset
3. Latency budgets met on a single CPU core
4. TAS predictions within ±5 of ground truth on 8/10 archetypes
5. Loop F1 ≥ 0.7 on synthetic dataset, including adversarial-paraphrase
6. StatGate Type-I ≤ 0.05, Type-II ≤ 0.20 at n=30
7. All Cat 1-23 integration points documented with concrete code references
8. No LLM dependency anywhere in the runtime path

## Open Questions to Resolve via Research

1. TraceRazor — does the paper exist? arXiv ID? Re-validate weights.
2. Felix et al. 2025 loop detection — does F1=0.72 hold on Eden's synthetic dataset?
3. HHEM-2.1 — license, behaviour on numeric/tabular data, exact RAGTruth-QA score?
4. Best non-LLM sentence embedding for loops (MiniLM vs BGE-small vs E5-small)?
5. Page-Hinkley tuning constants for short trajectories (5-10 steps)?
6. Conformal prediction with multi-metric adjustment — Bonferroni vs BH?
7. ECE computation: 15 equal-mass bins the right call for sparse signals?
8. CRR (Caveman Compression Ratio) — what does "wordlist/gzip/ngram max" mean?