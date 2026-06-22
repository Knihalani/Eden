"""Shared FastAPI dependencies."""

import hashlib
from dataclasses import dataclass
from typing import Annotated

from fastapi import Cookie, Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from eden.api.utils.auth import decode_access_token
from eden.api.utils.clerk_auth import (
    clerk_role_to_eden_role,
    extract_org_id,
    extract_org_role,
    extract_user_id,
    is_clerk_payload,
    verify_clerk_token,
)
from eden.config import get_settings
from eden.storage.postgres import get_postgres_client

security = HTTPBearer(auto_error=False)


# Bearer-JWT resolver used by the auth dependencies below. Pulls the
# JWT from the ``Authorization: Bearer <jwt>`` header first (the path
# the Clerk-authed portal uses), then falls back to the legacy Eden
# ``authorization`` cookie (the path the CLI / SDK / service-to-service
# callers use). Returns the decoded payload dict in either case, or
# raises 401 if neither path yielded a valid token.
async def _resolve_token_payload(
    authorization_cookie: Annotated[str | None, Cookie(alias="authorization")] = None,
    bearer: Annotated[HTTPAuthorizationCredentials | None, Depends(security)] = None,
) -> dict:
    # Clerk path: portal forwards the Clerk session JWT as a Bearer.
    if bearer and bearer.scheme.lower() == "bearer":
        clerk_payload = verify_clerk_token(bearer.credentials)
        if clerk_payload:
            return clerk_payload

    # Legacy Eden-issued cookie JWT (CLI, SDK, internal services).
    if authorization_cookie:
        payload = decode_access_token(authorization_cookie)
        if payload:
            return payload

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
    )

# Permission map: role -> set of permissions
PERMISSION_MAP: dict[str, set[str]] = {
    "owner": {
        "references:read",
        "references:upload",
        "references:delete",
        "members:invite",
        "members:remove",
        "settings:edit",
        "billing:view",
        "billing:edit",
        "audit:view",
        "org:transfer",
        # June 2026: gating for the onboarding wizard's "Connect GitHub"
        # + "Open Integration PR" path. Wiring a repo into an org
        # exposes commit + branch-create access on behalf of the
        # installation token; only owners/admins should be able to do
        # that. Members and viewers see a "Request from your admin"
        # callout instead.
        "integrations:write",
        # Job submission/read — granted to owner and admin so the
        # portal's "Trigger test run" + "Trigger sim run" actions work
        # without requiring a separate per-resource grant. Members and
        # viewers do not get these scopes (they would only use them via
        # a CI-scoped API key anyway).
        "jobs:read",
        "jobs:write",
        # Phase 7.3d — the four sensitive permissions (June 2026).
        "pii:edit",
        "judges:run",
        "gdpr:execute",
        "retention:override",
    },
    "admin": {
        "references:read",
        "references:upload",
        "references:delete",
        "members:invite",
        "members:remove",
        "settings:edit",
        "billing:view",
        "billing:edit",
        "audit:view",
        "integrations:write",
        "jobs:read",
        "jobs:write",
        "pii:edit",
        "judges:run",
    },
    "member": {
        "references:read",
        "judges:run",
        # Members can submit + read their own jobs (CI runs, sim runs,
        # test runs). ``jobs:write`` is intentionally broader than
        # ``jobs:read`` so a future "observer" role can read results
        # without being able to enqueue work.
        "jobs:read",
        "jobs:write",
    },
    "viewer": {
        "references:read",
        # Viewers can read job results (read-only dashboard) but
        # cannot submit new work.
        "jobs:read",
    },
}


def get_role_permissions(role: str) -> set[str]:
    """Get all permissions for a role."""
    return PERMISSION_MAP.get(role, set())


def has_permission(role: str, permission: str) -> bool:
    """Check if a role has a specific permission."""
    return permission in get_role_permissions(role)


async def check_resource_permission(
    user_id: str,
    org_id: str,
    permission: str,
    resource_type: str | None = None,
    resource_id: str | None = None,
) -> bool:
    """Resource-scoped permission check.

    Returns True if the user has the given permission either
    org-wide (via their built-in role) or on a specific resource
    (via a custom-role assignment).

    The check is two-step:

    1. Look up the user's role in the org. If the role grants
       the permission (e.g. ``admin`` → ``members:invite``), return
       True immediately.
    2. If a ``resource_type`` and ``resource_id`` are provided,
       look up a custom-role assignment on that exact resource.
       If one exists, the user gets the permission for that
       resource only (org-wide access is NOT implied).

    Used by routes that need finer-grained access than the
    org-wide role map (e.g. "only the owner of this resource can
    delete it"). Routes that only need org-wide access should
    keep using :func:`require_org_permission`.
    """
    client = await get_postgres_client()

    role_row = await client.fetchrow(
        """
        SELECT role
        FROM organization_members
        WHERE user_id = $1 AND org_id = $2
        LIMIT 1
        """,
        user_id,
        org_id,
    )
    role = (role_row or {}).get("role", "")
    if has_permission(role, permission):
        return True

    if resource_type is None or resource_id is None:
        return False

    # Custom-role assignment on the specific resource.
    assignment = await client.fetchval(
        """
        SELECT 1
        FROM custom_role_assignments
        WHERE user_id = $1
          AND org_id = $2
          AND resource_type = $3
          AND resource_id = $4
          AND permission = $5
        LIMIT 1
        """,
        user_id,
        org_id,
        resource_type,
        resource_id,
        permission,
    )
    return assignment is not None


@dataclass
class OrgMember:
    """Authenticated organization member context.

    Returned by ``get_current_org_member`` and used as the auth
    surface for human-facing CRUD endpoints. Wraps the user_id,
    org_id, and role in a typed object so route signatures read
    cleanly.
    """

    user_id: str
    org_id: str
    role: str
    email: str = ""
    name: str = ""


async def get_current_org_member(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict = Depends(_resolve_token_payload),
) -> OrgMember:
    """Authenticate a portal user and resolve their org membership.

    Mirrors ``require_org_member`` but returns a typed ``OrgMember``
    instead of a raw dict. Raises 401 on no/invalid auth, 403 on
    no membership in the requested org.
    """
    user_id = payload.get("sub") or extract_user_id(payload)
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )
    # Clerk path: the active org id is in the abbreviated ``o.id``
    # claim by default (and ``org_id`` only when a custom JWT
    # template is configured). ``extract_org_id`` covers both.
    # Fall back to ``X-Org-Id`` header (org switcher) and the legacy
    # ``current_org_id`` claim (cookie-authed callers).
    org_id = (
        x_org_id
        or (extract_org_id(payload) if is_clerk_payload(payload) else None)
        or payload.get("current_org_id")
    )
    if not org_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No active organization",
        )
    client = await get_postgres_client()
    row = await client.fetchrow(
        """
        SELECT om.role, u.name AS user_name, u.email
        FROM org_members om
        JOIN users u ON u.id = om.user_id
        WHERE om.user_id = $1 AND om.org_id = $2
        """,
        user_id,
        org_id,
    )
    if not row:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )
    return OrgMember(
        user_id=user_id,
        org_id=org_id,
        role=row["role"],
        email=row.get("email") or "",
        name=row.get("user_name") or "",
    )


async def get_current_user(
    payload: dict = Depends(_resolve_token_payload),
) -> dict:
    """Validate JWT (Clerk Bearer or Eden cookie) and return user.

    Raises HTTPException 401 if not authenticated.
    """
    user_id = payload.get("sub") or extract_user_id(payload)
    email = payload.get("email")

    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )

    return {"user_id": user_id, "email": email}


async def _try_resolve_token_payload(
    authorization_cookie: Annotated[str | None, Cookie(alias="authorization")] = None,
    bearer: Annotated[HTTPAuthorizationCredentials | None, Depends(security)] = None,
) -> dict | None:
    """Same as ``_resolve_token_payload`` but returns None instead of raising."""
    try:
        return await _resolve_token_payload(authorization_cookie, bearer)
    except HTTPException:
        return None


async def get_optional_user(
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict | None:
    """Validate JWT (Clerk Bearer or Eden cookie) and return user, or None."""
    if not payload:
        return None
    user_id = payload.get("sub") or extract_user_id(payload)
    return {"user_id": user_id, "email": payload.get("email")}


async def get_user_by_id(user_id: str, lookup_column: str = "id") -> dict | None:
    """Fetch a user by their ID or by their Clerk ID.

    ``lookup_column`` accepts ``"id"`` (UUID PK) or ``"clerk_id"`` (the
    string Clerk mints, e.g. ``user_2abc...``). The Clerk-auth path
    passes the JWT ``sub`` claim, which is the Clerk id — it never
    matches the UUID PK, so a UUID-only lookup would 404 every
    Clerk user.

    Both columns are indexed (``id`` is the PK, ``clerk_id`` has a
    partial unique index from migration 047). The single combined
    query keeps this trivial to call from either path.
    """
    if lookup_column not in ("id", "clerk_id"):
        raise ValueError(f"lookup_column must be 'id' or 'clerk_id', got {lookup_column!r}")
    client = await get_postgres_client()
    query = (
        "SELECT id, email, name, created_at, preferred_org_id, clerk_id "
        f"FROM users WHERE {lookup_column}::text = $1"
    )
    return await client.fetchrow(query, user_id)


async def get_current_org(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
    include_archived: bool = False,
) -> dict | None:
    """Get current organization context from header or JWT.

    Returns org context if user is a member, None otherwise.
    Optionally includes archived orgs (for admin views).

    Clerk path: when the JWT came from Clerk, ``org_id`` and
    ``org_role`` are read directly off the session claims and we
    skip the ``org_members`` lookup. The Eden row is still fetched
    for ``name`` / ``slug`` / ``archived_at`` / ``last_active_at``
    bookkeeping, but the role is trusted from Clerk (single source
    of truth).
    """
    if not payload:
        return None

    user_id = payload.get("sub") or extract_user_id(payload)
    # Clerk path: trust the org_id + role claims from the session JWT.
    is_clerk = is_clerk_payload(payload)
    if is_clerk:
        org_id = x_org_id or extract_org_id(payload)
        if not org_id:
            return None
        clerk_role = extract_org_role(payload)
        eden_role = clerk_role_to_eden_role(clerk_role)
        client = await get_postgres_client()
        if include_archived:
            row = await client.fetchrow(
                """
                SELECT om.role, o.name, o.slug, o.owner_id, o.archived_at
                FROM org_members om
                JOIN organizations o ON o.id = om.org_id
                WHERE om.user_id = $1 AND om.org_id = $2
                """,
                user_id,
                org_id,
            )
        else:
            row = await client.fetchrow(
                """
                SELECT om.role, o.name, o.slug, o.owner_id, o.archived_at
                FROM org_members om
                JOIN organizations o ON o.id = om.org_id
                WHERE om.user_id = $1 AND om.org_id = $2 AND o.archived_at IS NULL
                """,
                user_id,
                org_id,
            )
        if not row:
            # Clerk says the user is in this org but Eden's
            # ``org_members`` row doesn't exist yet — the Clerk
            # webhook (``user.created`` / ``organizationMembership.created``)
            # will create it shortly. Return a synthesised entry so the
            # caller can still proceed with the Clerk-trusted role.
            return {
                "org_id": org_id,
                "role": eden_role,
                "name": org_id,
                "slug": org_id,
                "is_owner": eden_role == "owner",
                "archived_at": None,
                "_pending_sync": True,
            }
        # Clerk is the source of truth for role — overwrite whatever
        # Eden's row says. This keeps role changes in Clerk in
        # effect without waiting for a webhook round-trip.
        return {
            "org_id": org_id,
            "role": eden_role,
            "name": row["name"],
            "slug": row["slug"],
            "is_owner": row["owner_id"] == user_id,
            "archived_at": row.get("archived_at"),
        }

    # Legacy Eden cookie path — unchanged.
    org_id = x_org_id or payload.get("current_org_id")

    if not org_id or not user_id:
        return None

    client = await get_postgres_client()

    # Verify membership and get role (optionally include archived)
    if include_archived:
        query = """
            SELECT om.role, o.name, o.slug, o.owner_id, o.archived_at
            FROM org_members om
            JOIN organizations o ON o.id = om.org_id
            WHERE om.user_id = $1 AND om.org_id = $2
        """
        row = await client.fetchrow(query, user_id, org_id)
    else:
        query = """
            SELECT om.role, o.name, o.slug, o.owner_id, o.archived_at
            FROM org_members om
            JOIN organizations o ON o.id = om.org_id
            WHERE om.user_id = $1 AND om.org_id = $2 AND o.archived_at IS NULL
        """
        row = await client.fetchrow(query, user_id, org_id)
    if not row:
        return None

    # Update last_active_at on every authenticated org request
    await client.execute(
        "UPDATE org_members SET last_active_at = NOW() WHERE user_id = $1 AND org_id = $2",
        user_id,
        org_id,
    )

    return {
        "org_id": org_id,
        "role": row["role"],
        "name": row["name"],
        "slug": row["slug"],
        "is_owner": row["owner_id"] == user_id,
        "archived_at": row.get("archived_at"),
    }


async def require_org_member(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict:
    """Require user to be an org member, otherwise raise 403."""
    org = await get_current_org(x_org_id, payload)
    if not org:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )
    return org



def require_org_permission_dep(permission: str):
    """Factory for a FastAPI ``Depends(...)`` closure that enforces ``permission``.

    Prefer this over the bare :func:`require_org_permission` async function
    when wiring into route signatures — the closure picks up the JWT
    payload and ``X-Org-Id`` header via FastAPI's dependency injector
    rather than relying on caller-side argument passing. Usage::

        @router.post("/foo")
        async def create_foo(
            org_id: str,
            user: dict = Depends(get_current_user),
            _check: dict = Depends(require_org_permission_dep("foo:write")),
        ):
            ...

    The leading-underscore name on ``_check`` is conventional for a
    side-effect-only dependency (the returned dict is usually discarded;
    the only observable effect is raising 403 if the permission is
    missing). When the caller also needs the org dict (e.g. to read
    the resolved role), use ``org: dict = Depends(...)`` and reference
    it later in the handler.

    The closure reads ``X-Org-Id`` from the header, falling back to
    ``payload.get("current_org_id")`` for the cookie-auth path. If
    neither resolves, the request 403s — no silent bypass.
    """

    async def _dependency(
        # ``org_id`` is accepted without a ``Header`` annotation so FastAPI
        # binds the route's path parameter when one exists (the common
        # case: ``@router.post("/orgs/{org_id}/foo")``). When no path
        # param is in scope (e.g. service-to-service endpoints like
        # ``POST /jobs`` that derive org from the JWT only) we fall back
        # to ``x_org_id`` from the ``X-Org-Id`` header.
        org_id: str | None = None,
        x_org_id: str | None = Header(None, alias="X-Org-Id"),
        payload: dict | None = Depends(_try_resolve_token_payload),
    ) -> dict:
        org = await get_current_org(org_id or x_org_id, payload)
        if not org:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not a member of this organization",
            )
        role = org.get("role", "")
        if not has_permission(role, permission):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permission denied: {permission}",
            )
        return org

    return _dependency

async def require_org_admin(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict:
    """Require user to be an org admin/owner, otherwise raise 403."""
    org = await get_current_org(x_org_id, payload)
    if not org:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )
    if org["role"] not in ("owner", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin or owner role required",
        )
    return org


async def require_2fa(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict:
    """Require user to have 2FA enabled if org enforces it.

    Returns user dict if:
    - Org does not enforce 2FA, OR
    - User authenticated via Clerk (Clerk owns MFA — its session JWT
      already proves the user passed any required factor), OR
    - Org enforces 2FA AND user has 2FA enabled

    Raises 403 with mfa_required code if:
    - Org enforces 2FA AND user authenticated via the legacy Eden
      cookie flow AND user does not have 2FA enabled in Eden's users
      table.
    """
    org = await get_current_org(x_org_id, payload)
    if not org:
        # If not in an org context, skip 2FA check
        return {"user_id": None, "email": None}

    # Clerk-authed callers: Clerk owns MFA. Skip the Eden-side check.
    if payload and _is_clerk_payload(payload):
        return org

    # Check if org has 2FA enforcement
    client = await get_postgres_client()
    row = await client.fetchrow(
        "SELECT two_factor_enforced FROM organizations WHERE id = $1",
        org["org_id"],
    )

    if not row or not row["two_factor_enforced"]:
        # Org doesn't enforce 2FA, allow through
        return org

    user_id = payload.get("sub") or extract_user_id(payload) if payload else None
    user_row = await client.fetchrow(
        "SELECT two_factor_enabled FROM users WHERE id = $1",
        user_id,
    )

    if not user_row or not user_row["two_factor_enabled"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="mfa_required",
        )

    return org


def _is_clerk_payload(payload: dict) -> bool:
    """Best-effort detection of a Clerk session JWT payload.

    Clerk's standard issuer is ``https://<slug>.clerk.accounts.dev$``
    (dev) or ``https://clerk.<production-domain>.com`` (prod). We
    accept any ``iss`` ending in ``.clerk.accounts.dev$`` or matching
    ``clerk.`` as a prefix, which covers the common shapes without
    coupling to a specific Clerk instance URL.
    """
    iss = (payload.get("iss") or "").lower()
    return ".clerk.accounts.dev$" in iss or iss.startswith("https://clerk.")


async def require_org_owner(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict:
    """Require user to be an org owner, otherwise raise 403."""
    org = await get_current_org(x_org_id, payload)
    if not org:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )
    if not org.get("is_owner"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Owner role required",
        )
    return org


async def require_org_permission(
    permission: str,
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict:
    """Require user to have a specific org permission, otherwise raise 403.

    Uses the role-based permission map to determine access.

    NOTE (June 21 2026 polish): This signature was originally designed
    for FastAPI's ``Depends(...)`` injection. Direct ``await`` calls
    (e.g. ``await require_org_permission("foo", org_id)`` from inside
    a route handler) don't resolve ``payload`` — the default value is
    the raw ``Depends`` wrapper, not the resolved dict. Two safer
    usage patterns work:

    1. **Use the factory** — convert callers to
       ``Depends(require_org_permission_dep("foo"))`` (preferred; see below).
    2. **Resolve payload at the call site** — declare
       ``payload: dict = Depends(_try_resolve_token_payload)`` in the
       route signature and pass it explicitly:
       ``await require_org_permission("foo", org_id, payload)``.

    Pattern (1) is preferred for new routes and is what we now use
    throughout the route layer; pattern (2) remains supported for
    the 9 call sites that already pass ``payload`` explicitly.
    """
    org = await get_current_org(x_org_id, payload)
    if not org:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )
    role = org.get("role", "")
    if not has_permission(role, permission):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Permission denied: {permission}",
        )
    return org


# ─────────────────────────────────────────────────────────────────────────────
# Phase 7.3d — convenience guards for the four sensitive permissions.
# Each is a thin alias for :func:`require_org_permission` keyed to
# the named permission. Routes can ``Depends(require_pii_policy_edit)``
# etc. for a self-documenting signature.
# ──────────────────────────────────────────────


async def require_pii_policy_edit(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict:
    """Require ``pii:edit`` — the ability to modify the org's PII policy."""
    return await require_org_permission("pii:edit", x_org_id, payload)


async def require_judges_run(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict:
    """Require ``judges:run`` — the ability to trigger judge evaluations."""
    return await require_org_permission("judges:run", x_org_id, payload)


async def require_gdpr_execute(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict:
    """Require ``gdpr:execute`` — owner-only RTBF / GDPR actions."""
    return await require_org_permission("gdpr:execute", x_org_id, payload)


async def require_retention_override(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict:
    """Require ``retention:override`` — owner-only data-retention override."""
    return await require_org_permission("retention:override", x_org_id, payload)


def require_org_permission_or_api_key(permission: str):
    """Factory that returns a dependency supporting either cookie or API key auth.

    For user auth, checks role-based permissions.
    For API key auth, checks scopes directly.
    """
    async def dependency(
        x_org_id: str | None = Header(None, alias="X-Org-Id"),
        x_org_api_key: str | None = Header(None, alias="X-Org-Api-Key"),
        payload: dict | None = Depends(_try_resolve_token_payload),
    ) -> dict:
        # Try API key first
        if x_org_api_key:
            try:
                org = await get_current_org_api_key(x_org_id, x_org_api_key)
                if org and permission in org.get("scopes", []):
                    return org
            except HTTPException:
                pass

        # Fall back to user auth
        if not payload:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not authenticated",
            )

        org = await get_current_org(x_org_id, payload)
        if not org:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not a member of this organization",
            )

        role = org.get("role", "")
        if not has_permission(role, permission):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permission denied: {permission}",
            )
        return org

    return dependency


# ============================================================================
# API Key Authentication
# ============================================================================

async def get_current_org_api_key(
    x_org_id: str = Header(..., alias="X-Org-Id"),
    x_org_api_key: str | None = Header(None, alias="X-Org-Api-Key"),
) -> dict:
    """Validate X-Org-Api-Key header and return org context.

    This is an alternative to cookie-based auth for programmatic access.
    Returns org context with scopes if valid.
    """
    if not x_org_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="X-Org-Api-Key header required",
        )

    client = await get_postgres_client()
    key_hash = hashlib.sha256(x_org_api_key.encode()).hexdigest()

    query = """
        SELECT o.name, o.slug, o.owner_id, o.id as org_id, oak.scopes, oak.id as key_id
        FROM org_api_keys oak
        JOIN organizations o ON o.id = oak.org_id
        WHERE oak.key_hash = $1 AND oak.org_id = $2
    """
    row = await client.fetchrow(query, key_hash, x_org_id)
    if not row:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        )

    # Update last_used_at
    await client.execute(
        "UPDATE org_api_keys SET last_used_at = NOW() WHERE id = $1",
        row["key_id"],
    )

    return {
        "org_id": str(row["org_id"]),
        "name": row["name"],
        "slug": row["slug"],
        "is_owner": row["owner_id"] == row["org_id"],
        "scopes": row["scopes"],
        "key_id": str(row["key_id"]),
    }


async def get_optional_org(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    x_org_api_key: str | None = Header(None, alias="X-Org-Api-Key"),
    authorization: str | None = Cookie(None),
) -> dict | None:
    """Get org context from either API key or JWT cookie.

    Tries API key first, then falls back to cookie auth.
    Returns None if neither is valid.
    """
    # Try API key first
    if x_org_api_key:
        try:
            return await get_current_org_api_key(x_org_id, x_org_api_key)
        except HTTPException:
            pass

    # Fall back to cookie auth
    return await get_current_org(x_org_id, authorization)


# ============================================================================
# Audit Logging
# ============================================================================

async def log_audit_event(
    client,
    org_id: str,
    user_id: str,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    metadata: dict | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
) -> None:
    """Insert an audit log entry for an org action."""
    query = """
        INSERT INTO org_audit_log (org_id, user_id, action, target_type, target_id, metadata, ip_address, user_agent)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    """
    await client.execute(
        query,
        org_id,
        user_id,
        action,
        target_type,
        target_id,
        metadata or {},
        ip_address,
        user_agent,
    )


# ============================================================================
# Feature Flags
# ============================================================================


def require_feature_flag(flag_name: str):
    """Build a FastAPI dependency that gates a route on a boolean setting.

    When the flag is OFF, the dependency raises HTTP 404 (pretending the route
    does not exist) rather than 403. 404 is preferred because it leaks no
    information about the existence of the feature to un-flagged callers.

    Settings are read at request time (not at decorator/build time) so that
    tests can monkeypatch ENABLE_EVAL_PIPELINE between requests.

    Usage:
        @router.get("/experiments", dependencies=[Depends(require_feature_flag("enable_experiment_v2"))])
        async def list_experiments(...): ...
    """

    async def _dependency() -> None:
        settings = get_settings()
        enabled = bool(getattr(settings, flag_name, False))
        if not enabled:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Not Found",
            )

    return _dependency


# ============================================================================
# Ingestion Auth (Phase 7.0)
# ============================================================================

async def get_ingestion_auth(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    x_org_api_key: str | None = Header(None, alias="X-Org-Api-Key"),
    authorization: str | None = Cookie(None),
) -> dict:
    """Authenticate an ingestion / gateway request.

    Accepts either an API key (X-Org-Api-Key) or a session cookie
    (``authorization``). Returns the org context dict; raises 401
    if neither is provided or both are invalid.

    The gateway/ingestion routes use this instead of
    ``get_current_user`` so the OpenAI-compatible HTTP gateway can be
    hit with just an API key (no browser cookie).
    """
    if x_org_api_key:
        return await get_current_org_api_key(x_org_id, x_org_api_key)

    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="X-Org-Api-Key header or session cookie required",
        )

    org = await get_current_org(x_org_id, authorization)
    if not org:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )
    return org

    return _dependency
