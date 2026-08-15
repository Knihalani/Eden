# Goal: ship the Eden trace-quality + online guardrails system as the first end-to-end trace-scoring production deployment

Read FIRST: `eden-trace-quality-system-spec.md` (1866 lines, v2.6), then `prompts/01..10`. Work in `/Users/kaiavnihalani/Downloads/Eden/`.

## Why production, not shadow

No integrated trace-scoring exists today. The system goes live directly. Three safety mechanisms:
- **Read-only reports ship day one** — TAS, loop, quality, reasoning, detection report write to new tables on every trace.
- **Guardrail suggestions ship applied=False** — per-action kill switches in new migration `071_tenant_guardrail_action_config`. Read-only default ON; mutating (block_user, revoke_api_key, apply_policy_change) default OFF. Operators flip via admin API.
- **Auto-apply** gated by 5-check StatGate (ECE + BH p + Cohen's d + n+conformal + mSPRT).

## End goal (one sentence)

Deliverables A→H shipped end-to-end live in production, with ≥3 components shipped as enhancements beyond v2.6, every side effect routed through StatGate, and the entire v2.6 surface (every detector, metric, optimisation, quality measure) reachable through its published contract.

## Hard invariants (full: `01_constraints.md`)

- **No LLM at runtime** — deterministic models only (BGE-small, DistilBERT-MNLI, MiniLM cross-encoder, MiniCheck-RoBERTa).
- **No-drop invariant** — every v2.6 behaviour stays reachable. Contract in `02_no_drop_invariant.md`. Run `tests/experiments/test_v2_6_acceptance_contract.py` BEFORE every enhancement promotion.
- **No shadow mode** — killswitches replace system-level gating.
- **Per-action kill switches** — read-only default ON, mutating default OFF.
- Cost = minimise compute/memory: p99 ≤ 50ms CPU, $0/trace.

## Stop conditions (`03_stop_conditions.md`)

7 binary TRUE/FALSE: `pytest ≥820 passed + 0 fail`; migrations forward+back clean; routes 200+4xx never 5xx; spec v2.7 with §29 handoff; No-Drop passing; ≥3 enhancements Pareto-better.

## Non-completion (`04_non_completion.md`)

14 anti-patterns: "Removed spec'd component", "LLM at runtime", "kill switch defaulted ON", "experiment without pre-registration", "rollback without git tag". If you rationalise any, STOP and write it into §29 as deferred.

## Deliverables A→H (`05_deliverables.md`)

A. **Migrations** 065–070 + new 071 `tenant_guardrail_action_config`. Additive, forward+back-tested. ORM in `src/eden/models/trace_quality.py`.
B. **7 routes** in `api/routes/trace_quality.py` — Pydantic, tenant-scope, ETag, audit log.
C. **Wire supplementaries** into Eden hooks — Cat 15/17/22.
D. **Settings** (`06_settings.md`).
E. **Sidecar worker** at `src/eden/observability/quality_pipeline/` — offset poll, 5-step compute, single-tx persist, dead-letter, Prometheus, SIGTERM drain.
F. **Guardrail hot-path + per-action kill switch.**
G. **Tests** — ~304 integration + 5 e2e + 1 No-Drop fixture (`07_tests.md`).
H. **Spec propagation** (`08_spec_propagation.md`).

## Enhancement charter (`09_enhancement_charter.md`)

Implementer enhances by default — spec is the floor. 8 pre-registered: ETEC bootstrap weights, Phase 3 5th detector, dual-model fact-check, sidecar threadpool knee, cache-tier ordering, hot-path check ordering, per-tenant operator dashboard, 23rd detector. Ship ≥3 with Pareto-better rule (≥1 metric ↑ ≥5%, 0 regression, No-Drop passing).

## Iteration (`10_iteration.md`)

1. Order: migrations → routes → sidecar → hot-path hooks → tests → spec.
2. Per step: implement → pytest → measure → commit. No code without a test. Every commit updates the spec.
3. Decompose if >8 hours.
4. **Run No-Drop fixture BEFORE every enhancement promotion.** If red, revert.

## Stop signal

DONE when all 7 stop conditions are TRUE. §29 handoff: (a) what is live, (b) kill-switches-OFF list, (c) deferred-with-spec-citations, (d) enhancements shipped, (e) `pytest tests/ supplementaries/ -q | tail -3` + `git status`. Stop.
