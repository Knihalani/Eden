---
id: sso
title: Configure SSO + SCIM
sidebar_label: Configure SSO + SCIM
sidebar_position: 11
---

# How-to — Configure SSO + SCIM

Eden supports SAML 2.0 SSO and SCIM 2.0 provisioning via Clerk. The
configuration lives in the Clerk dashboard — Eden inherits the
identity provider you connect there.

> **Note (2026-08):** This is the mechanism that's actually wired
> into login — whenever `clerk_secret_key` is configured (true in
> production), Eden's own password-login endpoint is disabled
> outright and Clerk owns authentication end to end. Eden's backend
> separately ships a native OIDC/SAML SSO + SCIM admin API
> (`POST /sso/providers`, `/sso/login/{id}`, `/sso/callback/{id}`,
> etc. — see `src/eden/api/routes/sso.py`) intended for self-hosted
> deployments that don't use Clerk. As of this writing that native
> API has **no portal UI** — the portal only calls it to check
> whether an SSO provider is configured, not to create/enable/enforce
> one — and its login/callback routes aren't linked from any
> "Sign in with SSO" button anywhere in the product. Configuring a
> provider through that API is real (it's a working backend, and
> enabling "enforce" on it does block Eden's native password-login
> endpoint for that org's members), but it will not give end users a
> way to actually complete an SSO sign-in until the portal frontend
> is wired up to call those routes. Don't configure it expecting a
> login button to appear — build the frontend integration first, or
> use Clerk instead.

## Supported identity providers

| Provider | SSO | SCIM |
|----------|-----|------|
| Okta | ✅ SAML 2.0 | ✅ |
| Azure AD (Entra ID) | ✅ SAML 2.0 / OIDC | ✅ |
| Google Workspace | ✅ OIDC | ✅ |
| OneLogin | ✅ SAML 2.0 | ✅ |
| JumpCloud | ✅ SAML 2.0 | ✅ |
| Auth0 | ✅ OIDC | ✅ |
| Generic SAML 2.0 | ✅ | ⚠️ manual |
| Generic OIDC | ✅ | ⚠️ manual |

## Set up SSO

### 1. In Clerk

1. Clerk dashboard → **SSO Connections** → **Add connection** →
   pick your IdP.
2. For SAML: paste the metadata XML or the metadata URL.
3. For OIDC: paste the issuer URL, client ID, and client secret.
4. Map the IdP's claims to Clerk's user attributes:
   - `email` → `email`
   - `firstName` + `lastName` → `name`
   - `groups` → `organizations` (one org per group)

### 2. In Eden

The connection is automatic — once Clerk has the IdP configured,
your Eden login page redirects to it. No additional Eden-side
config is needed.

### 3. Enforce SSO

> **Note:** There is currently no **Settings → Authentication →
> Enforce SSO** page in the Eden portal itself — enforcement for
> Clerk-managed orgs is configured on Clerk's side (org restrictions
> in the Clerk dashboard), not through an Eden UI. The steps below
> describe the intended UX; treat "Portal → Settings" here as
> shorthand for Clerk's own org settings until an Eden-side page
> ships.

To disable password login (SSO-only):

1. Portal → **Settings** → **Authentication** → **Enforce SSO**.
2. Toggle on. From this point, password login is disabled for
   non-owners.

Owners can still log in with a password as a break-glass option.
This is logged in `org_audit_log`.

## Set up SCIM

### 1. Generate a SCIM token

Clerk dashboard → **Organizations** → **SCIM** → **Generate token**.

The token is shown once. Paste it into your IdP's SCIM
configuration.

### 2. Configure the IdP

#### Okta

1. Okta admin → **Applications** → **Create App Integration** →
   **SAML 2.0**.
2. Fill in the SSO URL and Audience URI from Clerk's SCIM page.
3. **Provisioning** tab → **Enable API integration**.
4. Paste the SCIM token. Base URL: `https://api.clerk.com/v2/scim`.

#### Azure AD

1. Azure admin → **Enterprise applications** → **New application**
   → **Non-gallery application**.
2. **Provisioning** → **Get started** → **Automatic**.
3. Paste the SCIM token. Tenant URL: `https://api.clerk.com/v2/scim`.

### 3. Map attributes

| IdP attribute | Clerk attribute |
|--------------|-----------------|
| `userPrincipalName` | `email` |
| `displayName` | `name` |
| `memberOf` | `organizations` (one per group) |

### 4. Test

Push a test user from your IdP. The user should appear in
**Clerk → Users** within ~30 seconds, and in the portal once they
log in.

## Role mapping

> **Note:** Step 3 below references a **Portal → Settings →
> Authentication → Role mapping** page that doesn't exist in the
> Eden portal yet. Until it ships, the JSON mapping has no Eden-side
> UI to enter it into — treat this section as documenting intended
> behavior rather than a page you can go configure today.

By default, every SCIM-provisioned user gets the `member` role.
Map IdP groups to Eden roles via Clerk:

1. Clerk → **Organizations** → **Roles & permissions**.
2. Add a role mapping: `IdP group "eden-admins"` → Clerk role
   `admin`.
3. Map Clerk roles to Eden roles in **Portal → Settings →
   Authentication → Role mapping**:

```json
{
  "mappings": [
    { "clerk_role": "admin",  "eden_role": "admin" },
    { "clerk_role": "owner",  "eden_role": "owner" },
    { "clerk_role": "viewer", "eden_role": "viewer" }
  ]
}
```

When a user's IdP group changes, Clerk updates the Clerk role, and
the next time they hit the Eden API, the role mapping fires and
their Eden role updates.

## Deprovisioning

When a user is removed from the IdP, SCIM removes them from Clerk.
By default, the user is **soft-deleted** from the org:

- Their API keys are revoked
- Their audit log entries are preserved (with `user_id` preserved)
- Their traces are preserved (anonymised on request)
- They lose access immediately

To permanently erase, run [GDPR erase](/how-to/pii#gdpr-right-to-be-forgotten).

## Just-in-time provisioning

If a user logs in via SSO but isn't SCIM-provisioned (e.g. they
were added to the IdP group after the last SCIM sync), Clerk JIT-provisions
them. They land in the org with the default role (`member`).

To disable JIT (strict mode):

Portal → **Settings** → **Authentication** → **Disable JIT provisioning**.

> **Note:** This toggle also doesn't exist in the Eden portal today.
> Strict mode isn't currently reachable from Eden's own UI.

In strict mode, SCIM is the only way to add users — anyone who
shows up without a SCIM entry is rejected.

## Audit

Every SSO event — login, logout, JIT provisioning, role change —
emits an `org_audit_log` entry. The audit log is your evidence
pack for SOC 2 CC6.1 and ISO 27001 A.9.