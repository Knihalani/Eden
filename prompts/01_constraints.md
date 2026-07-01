# Hard Constraints (full)

Read this alongside the parent prompt. Each rule is non-negotiable.

1. **NO language models of any kind at runtime.** No LLM-as-judge, no
   LLM-as-cache-validator, no LLM-as-retrieval-ranker. Only the
   deterministic models from the supplementaries: BGE-small-en-v1.5,
   DistilBERT-MNLI, MiniLM cross-encoder, MiniCheck-RoBERTa-Large.
   All <500M params, all sub-2s/step, all sub-2GB RAM.

2. **Cost optimisation = minimising compute and memory, increasing
   speed.** Latency budgets in spec §3 are upper bounds. Per-trace
   budget: p99 ≤ 50ms CPU, memory ≤ 200MB, $0/trace.

3. **Test implementations go in `supplementaries/`**; integration &
   API tests in `tests/api/`; enhancement tests in
   `tests/experiments/`. **Never delete a supplementary test.** Never
   silently drop a v2.6 test — even if replaced by something better,
   the v2.6 test stays as a parity check.

4. **The synthetic dataset is hallowed.** All 171 traces round-trip
   through `TelemetryEvent.from_dict`. The 39 fields are not optional.

5. **Backward compatibility.** Any change to `VALID_ACTIONS` /
   `VALID_POLICY_TYPES` enums must be additive. Existing routes
   continue returning 200 with the same response shape.

6. **Tenant-safety.** Every new route, table, emit goes through the
   existing `tenant_id` scoping in `api/deps.py`. No PII leaks across
   tenants.

7. **No-drop invariant.** The v2.6 spec IS the floor. You may exceed
   every metric; you may add detectors, metrics, actions,
   optimisations; you may replace internal algorithms with faster or
   more accurate ones. **You may NOT:** remove any spec'd detector,
   metric, optimisation, quality measure; shrink any enum; drop the
   StatGate; drop PII redaction; drop tenant scoping; remove the
   synthetic dataset from the test suite. Run
   `tests/experiments/test_v2_6_acceptance_contract.py` before any
   enhancement promotion.

8. **Per-action kill switches, NOT system-level gating.** There is no
   system-level "muted" mode. Each guardrail action class has its own
   `applied_by_default: bool` field stored in
   `tenant_guardrail_action_config`. Read-only operations
   (`record_to_table`, `emit_audit_event`, `emit_drift_alert`,
   `rewrite_response`, `coalesce_step`) default to ON. Mutating
   operations (`truncate_context`, `block_user`, `escalate_to_admin`,
   `revoke_api_key`, `apply_policy_change`) default to OFF.

9. **No shadow / no calibration period as a runtime gate.** The
   system goes live. The operators' review IS the calibration loop.
   Don't introduce a system-wide muted mode — use per-action kills.

10. **Backward-compatible schema migrations.** All migrations must
    be additive (nullable + defaulted). Each migration has `up()` and
    `down()`. `alembic upgrade head && alembic downgrade base &&
    alembic upgrade head` must be clean.

11. **StatGate is the only auto-apply gate.** No side effect goes
    from guardrail decision to external mutation without passing the
    full 5-check StatGate. This applies equally to enhancement code.

12. **v2.6 implementation must stay accessible.** When you replace
    a v2.6 component with an enhanced version, leave the v2.6 code
    tagged `v2.6-baseline-<component>` for 90 days. This enables
    emergency rollback without re-implementation.
