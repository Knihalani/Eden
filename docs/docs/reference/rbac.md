---
id: rbac
title: RBAC
sidebar_label: RBAC
sidebar_position: 4
---

# RBAC

Eden uses a flat four-role model in v1, with custom roles planned
for v2. Roles are per-org — a user can be `owner` of org A and
`member` of org B.

## The four built-in roles

| Role | Powers |
|------|--------|
| `owner` | All — billing, members, settings, integrations, deletion |
| `admin` | Members, settings, integrations, PII, judges |
| `member` | Read references, run judges, browse traces |
| `viewer` | Read references |

### Permission strings

Permissions follow `<resource>:<action>`:

| Permission | Roles |
|------------|-------|
| `references:read` | viewer, member, admin, owner |
| `references:upload` | admin, owner |
| `references:delete` | admin, owner |
| `members:invite` | admin, owner |
| `members:remove` | admin, owner |
| `settings:edit` | owner |
| `billing:view` | admin, owner |
| `billing:edit` | owner |
| `audit:view` | admin, owner |
| `integrations:write` | admin, owner |
| `pii:edit` | admin, owner |
| `judges:run` | member, admin, owner |
| `gdpr:execute` | owner |
| `retention:override` | owner |
| `org:transfer` | owner |

### Resource-scoped checks

Some endpoints allow finer-grained access via a custom-role
assignment on a specific resource. For example, you can grant a
contractor `references:read` on a single reference without making
them an org member.

```python
from eden.permissions import grant_resource_role

grant_resource_role(
    user_id="u_abc",
    org_id="org_abc",
    resource_type="reference",
    resource_id="ref_xyz",
    role="contractor",
    permissions=["references:read"],
    expires_at=datetime(2026, 12, 31),
)
```

The grant is audited and the contractor's access auto-revokes at
`expires_at`.

## Custom roles (v2)

v2 introduces custom roles per org:

```json
{
  "name": "support_lead",
  "permissions": [
    "references:read",
    "judges:run",
    "members:invite"
  ],
  "applies_to": ["team:support"]
}
```

`applies_to` scopes the role to a subset of org members (e.g. the
support team). The portal's **Settings → Roles** tab is the editor.

## Enforcement

Every API endpoint declares its required permission:

```python
@router.post("/v1/agents/register")
async def register_agent(
    org_id: str,
    user: dict = Depends(require_org_member),
):
    ...
```

`require_org_member` is the minimum bar — any role qualifies. For
permission-scoped endpoints:

```python
@router.post("/v1/orgs/{org}/members")
async def invite_member(
    org_id: str,
    user: dict = Depends(require_org_permission("members:invite")),
):
    ...
```

`require_org_permission(perm)` checks the user's role against
`PERMISSION_MAP` (the table above) and 403s if missing. For
resource-scoped checks, use `require_resource_permission`.

## Org transfer

Owners can transfer ownership to another member:

```bash
curl -X POST https://api.edenobservability.com/v1/orgs/org_abc/transfer \
  -H "Authorization: Bearer sk_eden_owner_..." \
  -d '{ "new_owner_user_id": "u_abc" }'
```

The current owner becomes an admin after the transfer. The transfer
is audited and the new owner must accept via email before it takes
effect (24-hour expiry).

## Audit

Every role change, invite, removal, and permission grant is in
`org_audit_log`:

```bash
curl "https://api.edenobservability.com/v1/orgs/org_abc/audit-log?action=member.role_change" \
  -H "Authorization: Bearer sk_eden_owner_..."
```