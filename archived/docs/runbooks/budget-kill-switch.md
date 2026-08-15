# Budget kill-switch runbook

> **Owner:** Platform · **Last reviewed:** 2026-06-24

Disable budget enforcement for a single org in an emergency (e.g. a misconfigured budget blocks a paying customer from using the API). Used during a budget-related incident.

## When to use

* Org reports `429 Budget exceeded` on legitimate traffic
* `on_budget_exceeded` hook is firing for a paying customer
* The budget rule is misconfigured (e.g. wrong window, wrong cap)

## Prerequisites

* `psql` + `DATABASE_URL`
* Org admin access (the kill-switch is org-scoped)

## Steps

1. **Verify the budget is the problem**:

   ```bash
   curl -s -i "$BASE_URL/v1/orgs/$ORG_ID/inference" \
     -H "Authorization: Bearer $EDEN_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "test"}]}'
   ```

   Look for `HTTP/1.1 429` with body `{"status": "budget_exceeded"}`.

2. **Inspect the org's current budget**:

   ```bash
   psql "$DATABASE_URL" -c "
     SELECT b.id, b.window, b.cap_usd, b.enabled,
            bc.consumed_usd, bc.window_start
       FROM budgets b
       LEFT JOIN budget_consumption bc ON bc.budget_id = b.id
      WHERE b.org_id = '$ORG_ID'
      ORDER BY b.window;
   "
   ```

3. **Disable budget enforcement** for the org (fastest fix — keeps the budget record, just turns enforcement off):

   ```sql
   UPDATE organizations
   SET features = features || '{"budget_enforcement_enabled": false}'::jsonb
   WHERE id = '$ORG_ID';
   ```

4. **Verify the fix**:

   ```bash
   curl -s -i "$BASE_URL/v1/orgs/$ORG_ID/inference" \
     -H "Authorization: Bearer $EDEN_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "test"}]}'
   ```

   Expected: `HTTP/1.1 200`.

5. **Notify the org admin** (via portal + email) that the kill-switch is on and that they should review their budget config.

6. **Investigate the root cause**:
   * Was the budget cap set too low?
   * Was the window wrong (daily vs monthly)?
   * Was there a usage spike from a runaway script?

7. **Re-enable enforcement** when the budget is fixed:

   ```sql
   UPDATE organizations
   SET features = features - 'budget_enforcement_enabled'
   WHERE id = '$ORG_ID';
   ```

   (Removing the key resets it to the default — `true` per `src/eden/config.py`.)

## Verification

* The org's API requests succeed (HTTP 200)
* The budget record remains in the DB (audit trail intact)
* The on-call alert `budget_exceeded` stops firing within 2 minutes

## Related

* `docs/runbooks/judge-circuit-breaker.md`
* `src/eden/budgets/` — the budget service implementation