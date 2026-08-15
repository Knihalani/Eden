# No-Drop Invariant — the v2.6 Acceptance Contract

The 16-item manifest of every v2.6 behaviour that *must continue to
hold* under any new implementation. This is the gate for every
enhancement promotion.

Encoded as `tests/experiments/test_v2_6_acceptance_contract.py`. Run
this fixture BEFORE promoting any enhancement. If it goes red, the
enhancement is invalid — do not benchmark, do not merge.

## The 16 invariants

1. ETEC composite: 30/30 v1 traces produce TAS within ±20 of GT;
   composite computable in <5ms CPU on 50-step trace.
2. LoopDetector: F1 ≥ 0.83 on v1's 30 traces; per-step latency <2ms.
3. TrajectoryGuardrail: hot-path p99 < 5ms.
4. StatGate: Type-I ≤ 0.05 + Monte Carlo noise; mSPRT always-valid.
5. Detection services: **27 detectors** (22 original + 5 from v2.6)
   run cleanly on every synthetic trace.
6. Pipeline throughput: 50-event trace < 50ms; 100-event < 100ms.
7. Cat 22: TailSamplingBuffer default = 15,000 slots per Sematext
   formula; K8sEnricher from_env works; ProfilingClient ~1% rate.
8. Numeric guard catches the 122% → 144% swap.
9. F1 ≥ 0.55 with real BGE-small on synthetic dataset.
10. Pareto 4-model coverage: DistilBERT-MNLI + MiniCheck-RoBERTa +
    cross-encoder/ms-marco-MiniLM-L-6-v2 + numeric guard all wired.
11. `VALID_ACTIONS` enumeration contains all 14 actions.
12. `VALID_POLICY_TYPES` enumeration contains all 33 entries.
13. 171 synthetic traces round-trip through `TelemetryEvent.from_dict`.
14. All 8 cost optimisations (spec §8) reachable.
15. PII redaction (Cat 10) precedes quality stack (Phase 5).
16. Tenant scoping enforced on every report and route (404, not 403,
    on cross-tenant access).

## Tolerance

- Continuous metrics (latency, memory, F1, Pearson r): ±5%.
- Classification (verdict, intervention enum, detector fire/no-fire): exact.
- Round-trip identity: byte-exact for `from_dict(to_dict(e)) == e`.

## Failure handling

If the fixture goes red after a code change:

1. STOP. Do not continue iterating.
2. Identify which invariant regressed.
3. Revert the change to the v2.6 baseline (git checkout
   v2.6-baseline-<component> -- <files>).
4. Document the regression in §29 enhancement log as `ROLLED-BACK`.
5. Try a different approach in a new branch.

Don't argue. Don't "fix later in the same PR". Revert.
