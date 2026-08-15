# Cat 23 policy rollout runbook

> **Owner:** Cat 23 · **Last reviewed:** 2026-06-24

Enable the Cat 23 autonomous code modification surface for a pilot org. Used during the phased rollout once Gates 1-4 ship (per `upgradespec-v2.md` Cat 23 §23).

## When to use

* A pilot customer has signed the Cat 23 addendum
* Gates 1-4 are deployed to production
* The red-team security review (Gate 3) is signed off

## Prerequisites

* Org admin access
* Confirm `code_change_enabled` is the master switch (not `auto_pr_enabled` directly)
* `psql` + `DATABASE_URL`

## Step 1 — Phase 1: read-only opt-in (Gates 1-2)

The org can SEE patches the system would propose, but NOT trigger any destructive action.

```sql
INSERT INTO code_change_policies (org_id, code_change_enabled, auto_pr_enabled, auto_revert_enabled)
VALUES ('$ORG_ID', true, false, false)
ON CONFLICT (org_id) DO UPDATE
SET code_change_enabled = true, auto_pr_enabled = false, auto_revert_enabled = false;
```

The org's portal now shows the "Propose code fix" button on trace detail pages, but clicking it shows the 501 envelope.

## Step 2 — Phase 2: manual PR (Gates 1-4a)

Org admin clicks "Propose code fix" → reviews the patch → clicks "Open PR" (human-in-the-loop).

```sql
UPDATE code_change_policies
SET auto_pr_enabled = false   -- still false; human clicks "Open PR"
WHERE org_id = '$ORG_ID';
```

Now the portal's "Open PR" button works. Every PR is created by a human click — no auto-create.

## Step 3 — Phase 3: auto-PR + manual revert (Gates 4b)

After 2 weeks of Phase 2 with no incidents, enable auto-PR:

```sql
UPDATE code_change_policies
SET auto_pr_enabled = true
WHERE org_id = '$ORG_ID';
```

The system will now auto-create PRs on high-confidence RCA events. Reverts remain manual (org admin clicks "Revert").

## Step 4 — Phase 4: full auto-mode (all gates)

Only after 4 weeks of clean Phase 3:

```sql
UPDATE code_change_policies
SET auto_revert_enabled = true
WHERE org_id = '$ORG_ID';
```

The system now self-heals: detects RCA → proposes patch → opens PR → merges → monitors → reverts if it degrades the org's metrics.

## Rollback

If any phase causes incidents:

```sql
UPDATE code_change_policies
SET auto_pr_enabled = false,
    auto_revert_enabled = false,
    code_change_enabled = false
WHERE org_id = '$ORG_ID';
```

The org is immediately back to read-only (the master switch `code_change_enabled=false` kills every action).

## Observability hooks to watch

* `on_drift_alert(drift_type='cat23_auto_pr_fired')` — fires when auto-mode opens a PR
* `on_drift_alert(drift_type='cat23_auto_revert_fired')` — fires when the system reverts
* `on_judge_regression` — judges score the patch quality; regressions trigger review

## Verification

After each phase enable:
1. Portal `/pr-suggestions` shows the expected activity
2. No `500` errors in `eden.code_change` logs
3. Customer's engagement metrics (trace count, judge scores) hold steady or improve

## Related

* `docs/docs/observability/23-autonomous-code-modification.md` — the full Cat 23 design doc
* `src/eden/code_change/_common.py` — the two-stage opt-in gate