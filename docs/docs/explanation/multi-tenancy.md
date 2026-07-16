---
id: multi-tenancy
title: Multi-tenancy
sidebar_label: Multi-tenancy
sidebar_position: 5
---

# Multi-tenancy

Eden is a multi-tenant system. Every byte of customer data is
scoped to a single org, and the database enforces isolation.

## The model

```
Clerk User ──┬── Clerk Org ──── Eden Org ──── Eden Member
             │                                   (role)
             └── Clerk Org ──── Eden Org
                 ...
```

A user can belong to multiple Clerk orgs, and each maps to one
Eden org. The user picks the active org via the org switcher in the
portal; the API key they use is scoped to a single org.

## Identity

- **Eden user** — created lazily on the first Clerk webhook.
  Stored in `users` with `clerk_user_id` as the canonical link.
- **Eden org** — created lazily on the first Clerk `organization.created`
  webhook. Stored in `organizations`.
- **Membership** — created on `organizationMembership.created`.
  Stored in `org_members` with `role` (owner / admin / member /
  viewer).

## Org switching

In the portal, the org switcher is the Clerk `<OrganizationSwitcher />`
component. When the user switches:

1. Clerk updates the active session.
2. The portal re-fetches `/auth/me` with the new session.
3. The backend reads the active Clerk org id and resolves the Eden
   org.
4. The portal re-renders with the new org's data.

For API calls, the caller passes `X-Org-Id` explicitly. There's no
implicit "active org" — every ingestion call names its org, every
read names its org.

## Row-level security

Every table that holds org data has an RLS policy:

```sql
CREATE POLICY org_isolation ON telemetry_events
  FOR ALL TO eden_app
  USING (org_id = current_setting('app.org_id')::uuid);
```

The `eden_app` Postgres role is the only role the FastAPI app uses.
It can't bypass RLS — `BYPASSRLS` is not granted.

The `app.org_id` GUC is set by `get_current_org()` at the start of
every request and reset at the end:

```python
async def get_current_org(request: Request) -> str:
    org_id = await _resolve_org_id(request)
    await request.app.state.db.execute(
        "SET LOCAL app.org_id = $1", org_id,
    )
    return org_id
```

`SET LOCAL` scopes the change to the current transaction, so
concurrent requests in the same connection pool can't see each
other's org.

## Cross-org requests

A request that names an org the caller doesn't belong to fails
before it touches the DB:

```python
async def _resolve_org_id(request: Request) -> str:
    claimed = request.headers.get("X-Org-Id")
    user = await get_current_user(request)
    if not await _is_member(user["user_id"], claimed):
        raise HTTPException(403, "cross_org_access")
    return claimed
```

The `cross_org_access` error is logged to `org_audit_log` for
compliance.

## Subscription / billing isolation

Stripe subscriptions are 1:1 with Eden orgs. The Stripe customer id
is stored in `org_plans.stripe_customer_id`. Webhooks from Stripe
hit `/v1/billing/stripe-webhook` with a per-org signature.

Subscription state is denormalised into `org_plans` for the quota
middleware — the middleware doesn't reach Stripe on the hot path.

## Data residency

The production API is served at:

| Region | Base URL |
|--------|----------|
| Production | `https://api.edenobservability.com` |

Customer data stays in the region that hosts this deployment.
Additional regions (if offered) get their own API host and are
documented when available.

## Audit

Every org-related action is in `org_audit_log`:

- `org.create` — new org created
- `org.archive` — soft-deleted
- `org.delete` — permanently deleted
- `member.invite` / `member.remove`
- `member.role_change`
- `plan.change` — subscription changed
- `sso.saml_login` — SAML login event

This is the evidence pack for SOC 2 CC6.1 (logical access) and
ISO 27001 A.9 (access control).

## Migration across regions

If Eden offers another region later and you need to move:

1. Export the org's data (`POST /orgs/{org}/export`).
2. Create a new org in the target region.
3. Import the data into the new org.
4. Re-issue API keys for the new region.
5. Update your services to point at the new base URL.

There's no in-place cross-region migration; the explicit export /
import is the safe path and gives you a paper trail.