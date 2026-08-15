# Test depth — full coverage targets

## Integration tests in `tests/api/`

For each deliverable above, integration tests exercise the full path:

| Layer | Target | Count |
|---|---|---:|
| 5 GET × 6 paths × 3 tenants | routes return correct body | 90 |
| 5 POST × 6 paths × 3 tenants | route mutate + reads back | 90 |
| 6 baseline + 1 new (071) × forward + back | migrations clean | 14 |
| 1 sidecar × 5 trace types × 3 watermark gaps | worker resume/replay | 15 |
| 1 hot-path × 5 PlanningFramework subclasses | guardrail hook firing | 25 |
| 1 Cat 22 integration × 5 keep-rules | sampling policy | 25 |
| 1 quality-pipeline failure × 5 modes | errors, retries, deadletters | 5 |
| 1 per-action kill switch × 10 actions × 2 tenants × 2 toggles | applied/NOOP | 40 |
| **Total integration** | | **~304** |

## End-to-end tests in `tests/e2e/` (5 minimum)

1. **Happy path.** Ingest 11-step customer-support trace. Verify all
   5 reports (TAS, loop, quality, reasoning, detection) written
   within 200ms. Reproduce GT within ±20 TAS points.
2. **Loop path.** Ingest 7-iteration loop trace. Verify LoopDetector
   fires, `trace_guardrail_actions` carries `block_user` with
   `applied=False` (kill switch off by default). The action is
   recorded but NOT executed.
3. **Adversarial.** Ingest Crescendo + many-shot + indirect
   injection. Verify all 3 detectors fire (each on a different row
   in `trace_guardrail_actions`), `applied=False` for each, NOOP
   side effect.
4. **Cross-tenant safety.** Ingest under tenant A; read under tenant
   B → 404 (not 200). Read migrations only.
5. **Watermark resumability.** Worker crashes mid-batch. Restart. No
   duplicate processing (idempotency check on `(trace_id, step)`).
   No missing reports. Dead-letter rows are present for poison traces.

## The No-Drop Invariant fixture

`tests/experiments/test_v2_6_acceptance_contract.py` runs the 16-item
manifest from `02_no_drop_invariant.md`. Runs BEFORE any enhancement
promotion. Runs in CI on every PR. Runs as a separate `make
no-drop-check` target.

## Test execution discipline

- Every new file ships with a `test_<feature>.py` next to it.
- Test runner prints `X/X passing`.
- Integration tests use the existing `tests/integration/` harness.
- Per-action kill-switch tests use property-based testing (action
  class × kill state × tenant) so all combinations are covered
  without ballooning the test count.

## Forbidden

- Tests that `pytest.skip` instead of `xfail`.
- Tests that depend on real network or LLM APIs.
- Tests that depend on filesystem state outside `/tmp/eden-tests/`.
- Tests >10s wall-clock each (split into multiple if needed).
- Tests that pass when `print()` is a side effect (use assertions).
