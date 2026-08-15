# SCIM drift runbook (Wave 1)

## Symptom

Clerk org membership and Eden `org_members` diverge: portal shows 403,
`_pending_sync`, or missing roles after SCIM / Clerk webhook lag.

## Detect

1. Compare Clerk org membership (`organizationMemberships`) to
   `SELECT user_id, role FROM org_members WHERE org_id = $1`.
2. Check webhook delivery: Clerk dashboard → Webhooks → failed
   `organizationMembership.*` events.
3. Eden logs: `ensure_clerk_membership`, `get_current_org` pending_sync.

## Remediate

1. Re-deliver failed Clerk webhooks for the org.
2. If webhook path is healthy but row missing, call authenticated
   `/auth/me` while the user has the org active in Clerk — session-
   matched upsert only (Wave 1: foreign `X-Org-Id` cannot upsert).
3. Manual SQL insert into `org_members` only as last resort; prefer
   webhook replay so `last_writer_source` stays accurate.

## Prevention

- Do not trust client `X-Org-Id` over the session JWT (W1).
- Portal proxy sets org from Clerk `auth().orgId` only.
- N06: API key create/revoke/rotate must write `org_audit_log`
  (see `api_keys.py` audit calls).

## Related

- [SOTA-WAVE-TRACKER.md](../specs/SOTA-WAVE-TRACKER.md) W1
- N06 compliance audit trail
