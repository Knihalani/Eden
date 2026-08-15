# Budget exceeded runbook

> **Owner:** Platform · **Last reviewed:** 2026-07-08

Handle a sustained budget trip for an org (or the platform as a whole).
Distinct from the kill-switch runbook — this is the proactive
response when the budget *trips*, before anyone considers disabling
enforcement. The kill-switch runbook is the reactive path for a
misconfigured budget that's blocking a paying customer.

## When to use

* `on_budget_exceeded` hook fires for a single org > 10 times in 5 min
* Platform-wide budget trip: `org_budgets` aggregate `current_usd`
  > 80% of the platform cap
* A customer reports `429 Budget exceeded` on legitimate traffic
  AND the budget is correctly configured (not a misconfiguration —
  that's the kill-switch runbook)

## First 60 seconds — triage

1. **Identify the scope**:
   ```bash
   psql "$DATABASE_URL" -c "
     SELECT b.org_id, o.name, b.window, b.cap_usd,
            bc.consumed_usd, bc.window_start
       FROM budgets b
       JOIN org_budget_consumption bc ON bc.budget_id = b.id
       JOIN organizations o ON o.id = b.org_id
      WHERE bc.consumed_usd > b.cap_usd * 0.8
      ORDER BY bc.consumed_usd / b.cap_usd DESC
      LIMIT 20;
   "
   ```
   * Single org > 80% → that org is the source. Proceed to step 2.
   * Many orgs > 80% simultaneously → a single model or prompt
     change is the cause. Look at `judge_scores.created_at` for
     a hot-spot org and check what they deployed in the last hour.

2. **Check the consumption rate**:
   ```bash
   psql "$DATABASE_URL" -c "
     SELECT date_trunc('minute', created_at) AS minute,
            sum(cost_usd) AS usd_per_min
       FROM org_budget_consumption_history
      WHERE org_id = '$ORG_ID'
        AND created_at >= NOW() - INTERVAL '30 minutes'
      GROUP BY 1
      ORDER BY 1;
   "
   ```
   * Steady rate → expected consumption; the budget was set too low.
     Notify the customer (step 5).
   * Sudden spike → runaway loop, retry storm, or a hostile
     integration. Jump to step 3 (circuit-break the org's
     LLM access).

3. **Check for a runaway pattern**:
   ```bash
   psql "$DATABASE_URL" -c "
     SELECT count(*) AS calls_last_min,
            avg(cost_usd) AS avg_cost,
            max(cost_usd) AS max_cost
       FROM judge_scores
      WHERE org_id = '$ORG_ID'
        AND created_at >= NOW() - INTERVAL '1 minute';
   "
   ```
   * `calls_last_min > 1000` → runaway loop. The judge_runner is
     firing too often; check the customer's recent prompt changes
     and disable the `auto_judge` flag on the agent.
   * `max_cost > 5.0` (single call > $5) → the customer is using
     a model they can't afford. The T1 router should have
     downgraded; investigate the routing table.

## First 15 minutes — remediate

4. **Cap the org's spend** (emergency ceiling):
   ```bash
   psql "$DATABASE_URL" -c "
     UPDATE budgets
        SET cap_usd = LEAST(cap_usd, 50.0)
      WHERE org_id = '$ORG_ID';
   "
   ```
   * Sets a hard $50 ceiling regardless of the configured
     budget. Reversible: re-set to the original cap after the
     customer updates their plan. Document the change in
     `audit_log` so the customer can see it in their billing
     history.

5. **Notify the customer** (always do this BEFORE disabling anything):
   ```bash
   # Email template: ``docs/templates/budget-exceeded-notice.md``
   # Sent via SendKit — eden.services.email_service.get_email_service(),
   # purpose="alert", from alerts@edenobservability.com.
   psql "$DATABASE_URL" -t -c "
     SELECT billing_email FROM organizations WHERE id = '$ORG_ID';
   " | xargs -I {} send-eden-email --to {} --template budget-exceeded \
     --data "$(cat /tmp/budget-context.json)"
   ```
   The email includes:
   * The cap, the current spend, the projected time to refill.
   * A link to the billing dashboard to raise the cap.
   * A link to the docs runbook so they understand what happened.

6. **Tighten the rate limit** (if the spike is a hostile integration):
   ```bash
   # Drop the org's per-(org,user) create limit from 5/h to 1/h.
   psql "$DATABASE_URL" -c "
     UPDATE organization_settings
        SET per_user_create_limit_per_hour = 1
      WHERE org_id = '$ORG_ID';
   "
   ```
   * This is the B-11 limit (per the §B.11 audit). It throttles
     new LLM calls without disabling the integration entirely.

7. **Disable the org's webhooks** (last resort, if the customer is
   burning cash on a closed-loop runaway):
   ```bash
   psql "$DATABASE_URL" -c "
     UPDATE webhooks SET enabled = false
      WHERE org_id = '$ORG_ID' AND event_type LIKE 'on_%';
   "
   ```
   The customer's events still flow (they just don't get
   auto-acted on). Re-enable after the runaway is contained.

## After — communicate

8. **Status page**: post only if the budget trip was platform-wide.
   Single-org trips are customer-internal.
9. **Billing reconciliation**: open a ticket in Stripe to
   credit the customer if the overage was on us (e.g. the
   T1 router mis-routed a T2 prompt to a T3 model).

## Post-mortem

* Open an incident in Linear (`INC-YYYY-MM-DD`).
* Add a regression test in `tests/unit/budgets/test_exceeded_triage.py`
  that asserts a synthetic org at 95% of its cap triggers
  the customer-notice email within 5 minutes.
* If the budget cap was misconfigured, file a follow-up
  to surface the right default cap in the onboarding wizard
  based on the customer's plan tier.
