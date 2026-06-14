"""Shared FastAPI dependencies."""

import hashlib
import logging
from collections.abc import Callable
from dataclasses import dataclass

from fastapi import Cookie, Header, HTTPException, status
from fastapi.security import HTTPBearer

from eden.api.utils.auth import decode_access_token
from eden.config import get_settings
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

security = HTTPBearer(auto_error=False)

# Permission map: role -> set of permissions
# Phase 7.3d: extended with the new SOC-2 + GDPR + observability
# permissions — ``pii:edit``, ``judges:run``, ``gdpr:execute``,
# ``retention:override``. The split is owner-heavy on destructive
# actions (gdpr:execute, retention:override) and admin-spread on
# policy edits.
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
        "jobs:read",
        "jobs:write",
        "org:transfer",
        "prompts:write",
        # Phase 7.3d additions
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
        "audit:view",
        "jobs:read",
        "jobs:write",
        "prompts:write",
        # Phase 7.3d additions — admins can edit PII policy and run
        # judges, but cannot override retention or execute GDPR
        # deletions (those require owner).
        "pii:edit",
        "judges:run",
    },
    "member": {
        "references:read",
        "jobs:read",
        "jobs:write",
        "prompts:read",
        # Phase 7.3d — members can run judges (read-only ops on
        # observability data) but cannot edit PII policy.
        "judges:run",
    },
    "viewer": {
        "references:read",
        "jobs:read",
    },
}


def get_role_permissions(role: str) -> set[str]:
    """Get all permissions for a role."""
    return PERMISSION_MAP.get(role, set())


def has_permission(role: str, permission: str) -> bool:
    """Check if a role has a specific permission."""
    return permission in get_role_permissions(role)


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
    authorization: str | None = Cookie(None),
) -> OrgMember:
    """Authenticate a portal user and resolve their org membership.

    Mirrors ``require_org_member`` but returns a typed ``OrgMember``
    instead of a raw dict. Raises 401 on no/invalid auth, 403 on
    no membership in the requested org.
    """
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    payload = decode_access_token(authorization)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )
    org_id = x_org_id or payload.get("current_org_id")
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
    authorization: str | None = Cookie(None),
) -> dict:
    """Validate JWT cookie and return user.

    Raises HTTPException 401 if not authenticated.
    """
    token = authorization

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )

    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )

    user_id = payload.get("sub")
    email = payload.get("email")

    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )

    return {"user_id": user_id, "email": email}


async def get_optional_user(
    authorization: str | None = Cookie(None),
) -> dict | None:
    """Validate JWT cookie and return user, or None if not authenticated.

    Returns ``None`` when there is no cookie, the token is invalid, or
    the token payload is missing the ``sub`` claim. Callers MUST treat
    a falsy return as "unauthenticated" and not dereference a possibly
    absent ``user_id``.
    """
    if not authorization:
        return None

    payload = decode_access_token(authorization)
    if not payload:
        return None

    user_id = payload.get("sub")
    if not user_id:
        return None

    return {
        "user_id": user_id,
        "email": payload.get("email"),
    }


async def get_user_by_id(user_id: str) -> dict | None:
    """Fetch a user by their ID."""
    client = await get_postgres_client()
    query = "SELECT id, email, name, created_at, preferred_org_id FROM users WHERE id = $1"
    return await client.fetchrow(query, user_id)


async def get_current_org(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    authorization: str | None = Cookie(None),
    include_archived: bool = False,
) -> dict | None:
    """Get current organization context from header or JWT.

    Returns org context if user is a member, None otherwise.
    Optionally includes archived orgs (for admin views).
    """
    if not authorization:
        return None

    payload = decode_access_token(authorization)
    if not payload:
        return None

    user_id = payload.get("sub")
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
    authorization: str | None = Cookie(None),
) -> dict:
    """Require user to be an org member, otherwise raise 403."""
    org = await get_current_org(x_org_id, authorization)
    if not org:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )
    return org


async def require_org_admin(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    authorization: str | None = Cookie(None),
) -> dict:
    """Require user to be an org admin/owner, otherwise raise 403."""
    org = await get_current_org(x_org_id, authorization)
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
    authorization: str | None = Cookie(None),
) -> dict:
    """Require user to have 2FA enabled if org enforces it.

    Returns user dict if:
    - Org does not enforce 2FA, OR
    - Org enforces 2FA AND user has 2FA enabled

    Raises 403 with mfa_required code if:
    - Org enforces 2FA AND user does not have 2FA enabled
    """
    org = await get_current_org(x_org_id, authorization)
    if not org:
        # If not in an org context, skip 2FA check
        return {"user_id": None, "email": None}

    # Check if org has 2FA enforcement
    client = await get_postgres_client()
    row = await client.fetchrow(
        "SELECT two_factor_enforced FROM organizations WHERE id = $1",
        org["org_id"],
    )

    if not row or not row["two_factor_enforced"]:
        # Org doesn't enforce 2FA, allow through
        return org

    # Org enforces 2FA - check user has it enabled
    payload = decode_access_token(authorization)
    if not payload:
        return org

    user_id = payload.get("sub")
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


async def require_org_owner(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    authorization: str | None = Cookie(None),
) -> dict:
    """Require user to be an org owner, otherwise raise 403."""
    org = await get_current_org(x_org_id, authorization)
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
    authorization: str | None = Cookie(None),
) -> dict:
    """Require user to have a specific org permission, otherwise raise 403.

    Uses the role-based permission map to determine access.
    """
    org = await get_current_org(x_org_id, authorization)
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


# Phase 7.3d — thin permission guards. Route signatures read
# cleaner with these than with a stringly-typed
# ``require_org_permission("pii:edit")`` call site, and they give us
# a single place to add telemetry / audit-log hooks later.
async def _require_pii_policy_edit(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    authorization: str | None = Cookie(None),
) -> dict:
    return await require_org_permission("pii:edit", x_org_id, authorization)


async def _require_judges_run(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    authorization: str | None = Cookie(None),
) -> dict:
    return await require_org_permission("judges:run", x_org_id, authorization)


async def _require_gdpr_execute(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    authorization: str | None = Cookie(None),
) -> dict:
    return await require_org_permission("gdpr:execute", x_org_id, authorization)


async def _require_retention_override(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    authorization: str | None = Cookie(None),
) -> dict:
    return await require_org_permission("retention:override", x_org_id, authorization)


# Public aliases (used by route signatures).
require_pii_policy_edit = _require_pii_policy_edit
require_judges_run = _require_judges_run
require_gdpr_execute = _require_gdpr_execute
require_retention_override = _require_retention_override


async def check_resource_permission(
    *,
    user_id: str,
    org_id: str,
    permission: str,
    resource_type: str | None = None,
    resource_id: str | None = None,
) -> bool:
    """Resource-scoped permission check for the custom-RBAC system.

    Two layers:

    1. Built-in role permissions (``PERMISSION_MAP``). If the user's
       role in the org grants the requested permission, allow.
    2. Custom-role assignments. A user may be assigned a custom role
       for a specific resource; the assignment grants its permissions
       for that resource.

    The function is async because layer 2 hits Postgres. Layer 1 is
    a pure dict lookup.

    Returns ``False`` on any DB error — fail-closed is the wrong
    default for an "is this allowed?" check, but the route layer
    translates ``False`` into a 403, so we'd rather return False
    than 500.
    """
    try:
        client = await get_postgres_client()
    except Exception:
        logger.warning(
            "check_resource_permission: postgres unavailable for "
            "user_id=%s org_id=%s permission=%s; returning False",
            user_id, org_id, permission,
            exc_info=True,
        )
        return False
    if not client:
        return False

    try:
        row = await client.fetchrow(
            """
            SELECT role
            FROM org_members
            WHERE user_id = $1 AND org_id = $2
            """,
            user_id,
            org_id,
        )
    except Exception:
        logger.warning(
            "check_resource_permission: org_members lookup failed for "
            "user_id=%s org_id=%s permission=%s; returning False",
            user_id, org_id, permission,
            exc_info=True,
        )
        return False

    role = (row or {}).get("role") or ""
    if has_permission(role, permission):
        return True

    # No built-in grant. If a resource_id is given, check the
    # custom-role assignment table for a match.
    if not (resource_type and resource_id):
        return False

    try:
        present = await client.fetchval(
            """
            SELECT 1
            FROM role_assignments
            WHERE user_id = $1
              AND org_id = $2
              AND resource_type = $3
              AND resource_id = $4
              AND $5 = ANY(permissions)
            LIMIT 1
            """,
            user_id,
            org_id,
            resource_type,
            resource_id,
            permission,
        )
    except Exception:
        logger.warning(
            "check_resource_permission: role_assignments lookup failed for "
            "user_id=%s org_id=%s resource_type=%s resource_id=%s; "
            "returning False",
            user_id, org_id, resource_type, resource_id,
            exc_info=True,
        )
        return False
    return bool(present)


def require_org_permission_or_api_key(permission: str) -> Callable:
    """Factory that returns a dependency supporting either cookie or API key auth.

    For user auth, checks role-based permissions.
    For API key auth, checks scopes directly.
    """
    async def dependency(
        x_org_id: str | None = Header(None, alias="X-Org-Id"),
        x_org_api_key: str | None = Header(None, alias="X-Org-Api-Key"),
        authorization: str | None = Cookie(None),
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
        if not authorization:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not authenticated",
            )

        org = await get_current_org(x_org_id, authorization)
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


async def get_ingestion_auth(
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    x_org_api_key: str | None = Header(None, alias="X-Org-Api-Key"),
    authorization: str | None = Cookie(None),
) -> dict:
    """Auth dependency for the public ingestion + AI gateway surfaces.

    Accepts EITHER:

    1. ``X-Org-Id`` + ``X-Org-Api-Key`` headers (programmatic / SDK).
    2. A valid ``authorization`` JWT cookie (browser session).

    Returns a context dict with at minimum ``user_id``, ``org_id``, and
    ``auth_method`` (``"api_key"`` or ``"cookie"``).  For API-key auth
    the dict also includes ``scopes`` and ``key_id``.  For cookie auth
    the org is resolved from the ``X-Org-Id`` header (preferred) or
    the user's ``current_org_id`` JWT claim, then verified against
    the ``org_members`` table.

    Raises ``401 Unauthorized`` when neither auth method is valid.
    """
    # Path 1: API key (programmatic).
    if x_org_api_key and x_org_id:
        try:
            org = await get_current_org_api_key(x_org_id, x_org_api_key)
        except HTTPException:
            raise
        return {
            "user_id": f"apikey:{org['key_id']}",
            "org_id": org["org_id"],
            "scopes": org.get("scopes", []),
            "key_id": org["key_id"],
            "auth_method": "api_key",
        }

    # Path 2: session cookie.
    if authorization:
        payload = decode_access_token(authorization)
        if payload and payload.get("sub"):
            user_id = payload["sub"]
            org_id = x_org_id or payload.get("current_org_id")
            if not org_id:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail=(
                        "No org context. Pass X-Org-Id header or set "
                        "current_org_id on the session."
                    ),
                )
            # Verify the cookie user is actually a member of ``org_id``.
            client = await get_postgres_client()
            row = await client.fetchrow(
                """
                SELECT 1 FROM org_members
                WHERE user_id = $1 AND org_id = $2
                """,
                user_id, org_id,
            )
            if row:
                return {
                    "user_id": user_id,
                    "email": payload.get("email"),
                    "org_id": org_id,
                    "auth_method": "cookie",
                }

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=(
            "Authentication required. Provide X-Org-Id + X-Org-Api-Key "
            "headers OR a valid session cookie."
        ),
    )


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
# Ingestion / Gateway Authentication
# ============================================================================
#
# ``get_ingestion_auth`` is the shared auth dep for the telemetry ingestion
# routes (POST /v1/ingest, /v1/events, /v1/spans, ...) and the OpenAI-
# compatible gateway (/gateway/v1/...). It accepts EITHER:
#
#   * X-Org-Api-Key + X-Org-Id headers  — programmatic callers (curl, SDKs)
#   * ``authorization`` session cookie  — portal users browsing the
#     observability dashboard
#
# Whichever is valid wins. On 401 we raise with a clear error.
# This mirrors the convention OpenAI / Anthropic / Helicone use: a single
# "API key" credential for SDK callers, a cookie for the portal.

async def get_ingestion_auth(
    x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    x_org_api_key: Optional[str] = Header(None, alias="X-Org-Api-Key"),
    authorization: Optional[str] = Cookie(None),
) -> dict:
    """Authenticate ingest / gateway traffic.

    Returns ``{"org_id", "user_id", "api_key_id", "auth_method"}``.
    ``user_id`` is None for API-key callers; ``api_key_id`` is None for
    session-cookie callers. The gateway only requires ``org_id``, but
    downstream telemetry is enriched with whichever IDs are present.
    """
    if x_org_api_key and x_org_id:
        try:
            ctx = await get_current_org_api_key(x_org_id, x_org_api_key)
            return {
                "org_id": ctx["org_id"],
                "user_id": None,
                "api_key_id": ctx.get("key_id"),
                "auth_method": "api_key",
                "scopes": ctx.get("scopes", []),
            }
        except HTTPException as exc:
            # Invalid API key — fall through to cookie check; if that
            # also fails, raise the API-key error (more specific).
            api_key_error = exc

    if authorization:
        payload = decode_access_token(authorization)
        if payload:
            user_id = payload.get("sub")
            org_id = x_org_id or payload.get("current_org_id")
            if org_id:
                return {
                    "org_id": org_id,
                    "user_id": user_id,
                    "api_key_id": None,
                    "auth_method": "session_cookie",
                }

    if x_org_api_key and x_org_id:
        # Re-raise the API key error now that the cookie path failed
        raise api_key_error  # type: ignore[misc]

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Authentication required: provide X-Org-Api-Key or session cookie",
        headers={"WWW-Authenticate": "Bearer"},
    )


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


def require_feature_flag(flag_name: str) -> Callable:
    """Build a FastAPI dependency that gates a route on a boolean setting.

    When the flag is OFF, the dependency raises HTTP 404 (pretending the route
    does not exist) rather than 403. 404 is preferred because it leaks no
    information about the existence of the feature to un-flagged callers.

    Settings are read at request time (not at decorator/build time) so that
    tests can monkeypatch ENABLE_EVAL_PIPELINE between requests.

    Usage:
        @router.get("/jobs", dependencies=[Depends(require_feature_flag("enable_eval_pipeline"))])
        async def list_jobs(...): ...
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
