# Enhancement Charter — the "implementer can enhance" workflow

The spec lists a floor; the shipping version sits on the ceiling.
Ship at least 3 enhancements in v2.7.

## What "enhancement" means

A component is "enhanced" iff, vs the v2.6 supplementary:

- ≥1 quality / latency / cost metric improves by ≥5%, AND
- 0 metrics regress, AND
- No-Drop Invariant (`tests/experiments/test_v2_6_acceptance_contract.py`)
  still passes.

The decision rule is identical for every enhancement. No custom rules.

## Suggested enhancements (commit to ≥3 from this list OR your own)

Each is pre-registered with hypothesis, decision rule, success
criteria. Pre-register ALL chosen enhancements in §29 BEFORE writing
any code.

### 1. Phase 2 ETEC calibration

**Hypothesis:** The v2.6 engineering defaults are not Pareto-optimal
vs the 171 traces; bootstrap will shift ~0.05 weight from OBS to LHP.
**Component:** `phase_2_efficiency/calibration.py` + composite.
**Metric:** Pearson r vs ground-truth TAS.
**Decision:** ≥5% improvement on Pearson r, no regression on any
other ETEC metric, No-Drop passing.

### 2. Phase 3 5th detector

**Hypothesis:** Adding Markov entropy collapse as detector 5 closes
the paraphrase-loop detection gap. F1 improves 0.571 → ≥0.62 on
loop-stuck + adversarial-paraphrase archetypes.
**Component:** `phase_3_loops/ensemble.py`.
**Metric:** F1 on synthetic dataset.
**Decision:** ≥5% F1 improvement, no latency regression > 2ms,
No-Drop passing.

### 3. Phase 5 dual-model fact-check

**Hypothesis:** Pipeline runs MiniCheck FIRST (stronger on
grounding), then DistilBERT-MNLI as fallback. Currently reverse-
ordered. Reordering should improve precision on multi-fabricated
hallucinations.
**Component:** `phase_5_quality/pipeline.py`.
**Metric:** F1 on hallucinating + multi-fab-stats + paraphrase
archetypes.
**Decision:** ≥5% F1 improvement, latency parity, No-Drop passing.

### 4. Phase 7 23rd detector — reward_tampering_textual

**Hypothesis:** Spec lists the policy type but no detector function.
Adding real regex coverage catches reward-hacking attempts in
tool-completion flows.
**Component:** `phase_7_detection/detectors.py`.
**Metric:** Detection rate on a new synthetic reward-tampering trace
(added to v3 in v2.7 — extend the dataset).
**Decision:** Detection rate ≥ 0.8, false-positive rate < 0.1,
No-Drop passing.

### 5. Sidecar worker threadpool knee finding

**Hypothesis:** Currently `quality_pipeline_workers=2`. Benchmark
{1, 2, 4, 8}. Knee is at 2 for compute-bound, 4 for I/O-bound.
**Component:** `observability/quality_pipeline/worker.py`.
**Metric:** traces/sec sustained + watermark lag p99.
**Decision:** Throughput ≥5% improvement with no regression on
watermark lag above 5s, No-Drop passing.

### 6. Report cache ordering

**Hypothesis:** Reorder from L1→L2→L3→L4 to L1→L3→L4→L2 (skip Bloom
when L3 hit-rate is high). Hits more cache, fewer false misses.
**Component:** `phase_8_cost/cache.py`.
**Metric:** cache hit-rate + p99 lookup latency.
**Decision:** Hit-rate ≥5% improvement OR p99 ≥5% improvement,
No-Drop passing.

### 7. Hot-path check ordering

**Hypothesis:** Move `ConfidenceGuard` (cheap logprob check) earlier
in `TrajectoryGuardrail.evaluate_step`. Average cost-per-step falls
because most steps trip cheap checks before expensive ones.
**Component:** `phase_4_guardrails/trajectory.py`.
**Metric:** hot-path p99 over 10000-step workload.
**Decision:** ≥5% p99 improvement, no FPR regression, No-Drop passing.

### 8. Per-tenant operator dashboard

**Hypothesis:** Adding a `GET /v1/admin/guardrails/dashboard` endpoint
showing per-tenant kill switch state, recent applied/NOOP actions,
and FPR/FNR alignment metrics gives operators faster feedback than
table dumps.
**Component:** `api/routes/admin_guardrails.py` (NEW).
**Metric:** Number of dashboard rendering paths ≤ 3
(per-tenant state, recent actions, alignment metrics).
**Decision:** Endpoint reachable + tested across all 3 paths × 3
tenants = 9 tests, No-Drop passing.

## Discipline

For every enhancement:

1. **Pre-register** in §29: hypothesis, decision rule, expected
   compute cost, success criteria. No code until pre-registration
   is on paper.
2. **Branch.** `git checkout -b enhancement/<component>-<hypothesis-slug>`
3. **Compute budget.** Total budget is
   `enhancements_compute_budget_seconds = 14400` (4 CPU-hours).
   Each individual enhancement ≤ 1 CPU-hour. Track with
   `scripts/experiment_budget.py --estimate "<command>"` if it
   exists, otherwise time manually.
4. **No-Drop first.** Run
   `pytest tests/experiments/test_v2_6_acceptance_contract.py -v`
   BEFORE running the enhancement benchmarks. If this fails, the
   enhancement is invalid — do not benchmark.
5. **Enhancement test.** Every enhancement has its own
   `tests/experiments/test_<slug>.py` that runs the v2.6 reference
   and the enhanced version on the SAME workload, then asserts the
   decision rule.
6. **Compare vs baseline in §29.** Append a row to the enhancement
   log table.
7. **Ship vs revert.** A SHIPPED enhancement merges the branch to
   main. The v2.6 implementation stays accessible via git tag
   `v2.6-baseline-<component>` for 90 days.

## What you CAN enhance

- Algorithm choice, weight initialisation, threshold tuning
- Detector / metric additions (additive only)
- Cache strategies, threading, parallelism
- SQL query optimisation within the existing index budget
- Pydantic field-level validators that don't break existing API
- Operator UX (dashboard endpoints, summarisation helpers)
- Performance engineering of any layer

## What you CANNOT enhance

- Remove a spec'd detector, metric, action enum, or optimisation
- Narrow any enum (VALID_ACTIONS, VALID_POLICY_TYPES)
- Loosen any SLO (latency, memory, false-positive rate)
- Replace deterministic with non-deterministic (no LLMs)
- Skip spec'd tests in CI
- Drop the No-Drop Invariant fixture
- Promote an enhancement that breaks even one baseline test, even
  if "fixed later"
- Ship an enhancement whose metrics didn't all hit the ≥5%
  improvement threshold with 0 regression AND No-Drop passing
