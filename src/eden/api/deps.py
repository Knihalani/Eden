"""Shared FastAPI dependencies."""

import hashlib
from dataclasses import dataclass
from typing import Optional

from fastapi import Depends, HTTPException, Cookie, Header, status
from fastapi.security import HTTPBearer

from eden.api.utils.auth import decode_access_token
from eden.config import get_settings
from eden.storage.postgres import get_postgres_client

security = HTTPBearer(auto_error=False)

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
        "jobs:read",
        "jobs:write",
        "org:transfer",
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
    },
    "member": {
        "references:read",
        "jobs:read",
        "jobs:write",
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
    x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    authorization: Optional[str] = Cookie(None),
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
    authorization: Optional[str] = Cookie(None),
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
    authorization: Optional[str] = Cookie(None),
) -> Optional[dict]:
    """Validate JWT cookie and return user, or None if not authenticated."""
    if not authorization:
        return None

    payload = decode_access_token(authorization)
    if not payload:
        return None

    return {
        "user_id": payload.get("sub"),
        "email": payload.get("email"),
    }


async def get_user_by_id(user_id: str) -> Optional[dict]:
    """Fetch a user by their ID."""
    client = await get_postgres_client()
    query = "SELECT id, email, name, created_at, preferred_org_id FROM users WHERE id = $1"
    return await client.fetchrow(query, user_id)


async def get_current_org(
    x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    authorization: Optional[str] = Cookie(None),
    include_archived: bool = False,
) -> Optional[dict]:
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
    x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    authorization: Optional[str] = Cookie(None),
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
    x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    authorization: Optional[str] = Cookie(None),
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
    x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    authorization: Optional[str] = Cookie(None),
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
    x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    authorization: Optional[str] = Cookie(None),
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
    x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    authorization: Optional[str] = Cookie(None),
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


def require_org_permission_or_api_key(permission: str):
    """Factory that returns a dependency supporting either cookie or API key auth.

    For user auth, checks role-based permissions.
    For API key auth, checks scopes directly.
    """
    async def dependency(
        x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
        x_org_api_key: Optional[str] = Header(None, alias="X-Org-Api-Key"),
        authorization: Optional[str] = Cookie(None),
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
    x_org_api_key: Optional[str] = Header(None, alias="X-Org-Api-Key"),
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
    x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    x_org_api_key: Optional[str] = Header(None, alias="X-Org-Api-Key"),
    authorization: Optional[str] = Cookie(None),
) -> Optional[dict]:
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
    target_type: Optional[str] = None,
    target_id: Optional[str] = None,
    metadata: Optional[dict] = None,
    ip_address: Optional[str] = None,
    user_agent: Optional[str] = None,
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