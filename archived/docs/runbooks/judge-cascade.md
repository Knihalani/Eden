# Judge cascade runbook

> **Owner:** LLMOps · **Last reviewed:** 2026-07-08

Contain a cascading failure where one judge's degraded output
contaminates downstream judges, drift detectors, and alert engines.
Distinct from the circuit-breaker runbook — the circuit-breaker
protects a single provider; the cascade runbook is for the
*downstream amplification* where the bad output has already
leaked into the system.

## When to use

* Drift detector fires `psi > 0.3` for an org with no recent
  prompt or model change
* `on_judge_regression` hook fires for the SAME judge across
  multiple orgs in the same hour
* The portal's `/observability/eval` page shows judge scores
  trending toward 0 or 1.0 with no change in the underlying
  telemetry
* Customer reports their judge-driven guardrails are firing
  on every request, blocking legitimate traffic

## First 60 seconds — triage

1. **Identify the contaminated judge**:
   ```bash
   psql "$DATABASE_URL" -c "
     SELECT judge_id, judge_name, count(*) AS n,
            avg(score) AS avg_score,
            stddev(score) AS stddev_score
       FROM judge_scores
      WHERE created_at >= NOW() - INTERVAL '1 hour'
      GROUP BY judge_id, judge_name
      HAVING avg(score) < 0.1 OR avg(score) > 0.9
      ORDER BY n DESC
      LIMIT 10;
   "
   ```
   * One judge dominates with extreme scores → that judge is the
     cascade source. Proceed to step 2.
   * Multiple judges extreme → upstream provider issue; the
     circuit-breaker runbook handles the *cause*, this runbook
     handles the *downstream* state.

2. **Check if the drift detector has already amplified**:
   ```bash
   psql "$DATABASE_URL" -c "
     SELECT org_id, drift_type, psi, severity, created_at
       FROM drift_alerts
      WHERE created_at >= NOW() - INTERVAL '1 hour'
        AND severity IN ('high', 'critical')
      ORDER BY created_at DESC
      LIMIT 20;
   "
   ```
   * Many high-severity alerts across many orgs → the cascade
     has reached the alerting layer. Skip to step 4 (quarantine).
   * Alerts contained to a single org → contained; step 3.

3. **Check guardrail activation**:
   ```bash
   psql "$DATABASE_URL" -c "
     SELECT gp.org_id, gp.policy_name, gp.last_fired_at
       FROM guardrail_policies gp
      WHERE gp.last_fired_at >= NOW() - INTERVAL '1 hour'
      ORDER BY gp.last_fired_at DESC
      LIMIT 20;
   "
   ```
   * Guardrails firing aggressively → step 5 (suspend the
     affected judge, re-evaluate the queue).

## First 15 minutes — remediate

4. **Quarantine the contaminated judge** (single org):
   ```bash
   psql "$DATABASE_URL" -c "
     UPDATE judge_configurations
        SET enabled = false
      WHERE org_id = '$ORG_ID'
        AND judge_name = '$JUDGE_NAME';
   "
   ```
   * The judge stops running for new events. Existing scores
     remain (we don't delete them — that's an audit trail).
     The drift detector will not see new samples from this
     judge, so the cascade stops.

5. **Quarantine platform-wide** (multi-org cascade):
   ```bash
   psql "$DATABASE_URL" -c "
     UPDATE judge_configurations
        SET enabled = false
      WHERE judge_name = '$JUDGE_NAME';
   "
   ```
   * This is the nuclear option. The judge stops for every org
     in the platform. Use it only when the cascade has crossed
     org boundaries. The next deploy must re-enable it after
     the upstream issue is resolved.

6. **Re-evaluate the recent queue** (after quarantine):
   ```bash
   .venv/bin/python -c "
   from eden.llmops.judge_runner import JudgeRunner
   from eden.llmops.queue import get_judge_queue
   queue = get_judge_queue()
   runner = JudgeRunner()
   # Replay the last hour of telemetry through the (now-clean)
   # judge registry. Old judge_scores are kept for audit; the
   # new run is written to judge_scores_v2.
   asyncio.run(runner.replay_window(hours=1))
   "
   ```
   * This re-runs the judge on the recent telemetry. The
     replay is safe to run multiple times; the result is
     idempotent on the new (post-cascade) judges.

7. **Reset the drift detector baseline**:
   ```bash
   psql "$DATABASE_URL" -c "
     DELETE FROM drift_alert_baselines
      WHERE org_id = '$ORG_ID'
        AND drift_type = 'output';
   -- Force a re-baseline on the next detector tick.
   UPDATE drift_detector_state
      SET last_baseline_at = NULL
    WHERE org_id = '$ORG_ID';
   "
   ```
   * The detector will rebuild its baseline on the next
     1-minute tick. Until then, drift alerts are suppressed
     (the `is_baselined` check in the detector).

8. **Notify affected customers** (only if their guardrails fired):
   ```bash
   # Same SendKit-backed template engine as the budget-exceeded runbook
   # (eden.services.email_service, purpose="alert", from alerts@edenobservability.com).
   psql "$DATABASE_URL" -t -c "
     SELECT DISTINCT org_id FROM guardrail_policies
      WHERE last_fired_at >= NOW() - INTERVAL '1 hour';
   " | while read org; do
     send-eden-email --template judge-cascade-notice \
       --org "$org" --data "$(cat /tmp/cascade-context.json)"
   done
   ```
   The email includes:
   * The judge that was contaminated and the time window.
   * The org's guardrails that fired and which were auto-suspended.
   * An ETA for the re-evaluation to complete.

## After — communicate

9. **Status page**: post only if the cascade reached alerting
   for > 5 orgs or lasted > 30 min.
10. **Internal post-mortem**: open an incident in Linear
    (`INC-YYYY-MM-DD`); the runbook author is the LLMOps lead.

## Post-mortem

* Open an incident in Linear (`INC-YYYY-MM-DD`).
* Add a regression test in `tests/integration/test_judge_cascade.py`
  that simulates a contaminated judge (mock with a constant
  0.0 output) and asserts:
  - The cascade-detector flags it within 5 minutes.
  - The drift detector's PSI goes above the threshold on
    the contaminated judge.
  - The quarantine step disables the judge for the affected org.
  - The re-evaluation produces a clean baseline.
* If the cascade crossed org boundaries, file a follow-up
  to add a global "judge health" check that auto-quarantines
  a judge when its mean score drifts > 3σ from baseline
  across all orgs in a 5-minute window.
