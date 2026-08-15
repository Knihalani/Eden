# Settings (config.py additions)

Add to `src/eden/config.py:Settings`. All env-var-driven, all Pydantic-validated:

```python
# Trace-quality feature flags
trace_quality_enabled: bool = True
trace_quality_compute_async: bool = True
traceloop_auto_apply: bool = False           # Per-action kill switch default
stat_gate_min_n: int = 30
stat_gate_min_effect: float = 0.2
detector_keep_rate_loop: float = 1.0
detector_keep_rate_error: float = 1.0
quality_pipeline_workers: int = 2
quality_pipeline_watermark_poll_ms: int = 1000
quality_pipeline_batch_size: int = 100

# Per-action kill-switch defaults (mirrored into tenant_guardrail_action_config)
# Read-only actions default True; mutating actions default False.
default_action_applied_flag: dict[str, bool] = {
    "record_to_table":      True,
    "emit_audit_event":     True,
    "emit_drift_alert":     True,
    "rewrite_response":     True,
    "coalesce_step":        True,
    "truncate_context":     False,  # mutating
    "block_user":           False,  # mutating
    "escalate_to_admin":    False,  # mutating
    "revoke_api_key":       False,  # mutating (highest severity)
    "apply_policy_change":  False,  # mutating
}

# Enhancement-tracking
enhancements_per_component_max: int = 5
enhancements_compute_budget_seconds: int = 14400  # 4 CPU-hours
enhancements_no_drop_invariant_enforced: bool = True
```

## Env-var mapping

- `EDEN_TRACE_QUALITY_ENABLED` → `trace_quality_enabled`
- `EDEN_TRACELOOP_AUTO_APPLY` → `traceloop_auto_apply`
- `EDEN_QUALITY_PIPELINE_WORKERS` → `quality_pipeline_workers`
- `EDEN_STAT_GATE_MIN_N` → `stat_gate_min_n`
- (etc.)

## Pydantic validation

- Bools reject anything not 0/1/true/false/yes/no.
- Integers clamp 1-32 for worker counts.
- Floats clamp to [0.0, 1.0] for ratio fields.
- `default_action_applied_flag` must contain all 10 action class names.
- The Settings class emits a warning (not an error) at startup if
  any mutating action default is set to True.

## Migration 071 seeding

At migration time, for each tenant in `tenants` table, insert a
`tenant_guardrail_action_config` row with the settings defaults
unless a tenant-specific override exists. Post-deploy, an admin
script can override per-tenant.
