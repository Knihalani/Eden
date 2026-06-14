"""Custom RBAC routes (Phase §6.3 — Advanced RBAC).

These routes are gated by the OWNER/ADMIN built-in permission
(``settings:edit``). The custom-role model lets an admin define
arbitrary permission sets, assign them to users, and scope them
to a single resource (e.g. a specific job or environment).
"""

from __future__ import annotations

import logging
import re
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from eden.api.deps import OrgMember, get_current_org_member, require_org_permission
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/roles", tags=["rbac"])


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic models
# ─────────────────────────────────────────────────────────────────────────────

# Permission key shape: <resource>:<action>
#   e.g. "jobs:write", "billing:view", "members:invite"
# We accept any non-empty string under 64 chars that matches this pattern.
_PERMISSION_KEY_RE = re.compile(r"^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$")


def _validate_permission_key(key: str) -> str:
    if not isinstance(key, str) or len(key) > 64 or not _PERMISSION_KEY_RE.match(key):
        raise ValueError(
            f"Invalid permission_key {key!r}: must match ^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$ "
            f"and be <=64 chars"
        )
    return key


class RoleCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    base_role: str = Field(..., pattern=r"^(owner|admin|member|viewer)$")
    description: str | None = Field(None, max_length=500)
    permissions: list[str] = Field(default_factory=list)

    @field_validator("permissions")
    @classmethod
    def _check_perms(cls, v: list[str]) -> list[str]:
        for p in v:
            _validate_permission_key(p)
        return v


class RoleUpdateRequest(BaseModel):
    description: str | None = Field(None, max_length=500)
    permissions: list[str] | None = None

    @field_validator("permissions")
    @classmethod
    def _check_perms(cls, v):
        if v is None:
            return v
        for p in v:
            _validate_permission_key(p)
        return v


class RoleResponse(BaseModel):
    id: str
    org_id: str
    name: str
    base_role: str
    description: str | None = None
    permissions: list[str] = []
    created_at: str


class AssignmentCreateRequest(BaseModel):
    user_id: str
    resource_type: str | None = Field(None, max_length=32)
    resource_id: str | None = Field(None, max_length=128)

    @field_validator("user_id")
    @classmethod
    def _check_user_id(cls, v: str) -> str:
        try:
            UUID(v)
        except (ValueError, TypeError) as exc:
            raise ValueError(f"user_id must be a UUID: {v!r}") from exc
        return v


class AssignmentResponse(BaseModel):
    id: str
    role_id: str
    user_id: str
    resource_type: str | None = None
    resource_id: str | None = None
    granted_by: str | None = None
    created_at: str


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

async def _fetch_role(role_id: str, org_id: str) -> dict[str, Any]:
    client = await get_postgres_client()
    row = await client.fetchrow(
        "SELECT * FROM role_definitions WHERE id = $1 AND org_id = $2",
        role_id,
        org_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Role not found")
    return dict(row)


async def _fetch_permissions(role_id: str) -> list[str]:
    client = await get_postgres_client()
    rows = await client.fetch(
        "SELECT permission_key FROM role_permissions WHERE role_id = $1 AND granted = TRUE",
        role_id,
    )
    return [r["permission_key"] for r in rows]


async def _require_rbac_admin(org_id: str, authorization_cookie) -> None:
    """Re-uses the built-in ``settings:edit`` permission (owner + admin)."""
    await require_org_permission("settings:edit", org_id, authorization_cookie)


# ─────────────────────────────────────────────────────────────────────────────
# Routes — list / create / get / update / delete
# ─────────────────────────────────────────────────────────────────────────────

@router.get("", response_model=list[RoleResponse])
async def list_roles(
    org_id: str,
    member: OrgMember = Depends(get_current_org_member),
) -> list[RoleResponse]:
    """List all custom roles for the org (any member can read)."""
    client = await get_postgres_client()
    rows = await client.fetch(
        "SELECT id, org_id, name, base_role, description, created_at "
        "FROM role_definitions WHERE org_id = $1 ORDER BY name ASC",
        org_id,
    )
    out: list[RoleResponse] = []
    for r in rows:
        perms = await _fetch_permissions(str(r["id"]))
        out.append(RoleResponse(
            id=str(r["id"]),
            org_id=str(r["org_id"]),
            name=r["name"],
            base_role=r["base_role"],
            description=r.get("description"),
            permissions=perms,
            created_at=r["created_at"].isoformat(),
        ))
    return out


@router.post("", response_model=RoleResponse, status_code=201)
async def create_role(
    org_id: str,
    req: RoleCreateRequest,
    member: OrgMember = Depends(get_current_org_member),
) -> RoleResponse:
    """Create a new custom role. Requires ``settings:edit``."""
    if member.role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Owner or admin required")

    client = await get_postgres_client()
    try:
        row = await client.fetchrow(
            """
            INSERT INTO role_definitions (org_id, name, base_role, description)
            VALUES ($1, $2, $3, $4)
            RETURNING id, org_id, name, base_role, description, created_at
            """,
            org_id,
            req.name,
            req.base_role,
            req.description,
        )
    except Exception as exc:
        # Unique violation on (org_id, name)
        if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
            raise HTTPException(status_code=409, detail=f"Role {req.name!r} already exists") from exc
        raise
    role_id = str(row["id"])
    if req.permissions:
        await client.executemany(
            """
            INSERT INTO role_permissions (role_id, permission_key, granted)
            VALUES ($1, $2, TRUE)
            ON CONFLICT (role_id, permission_key) DO UPDATE SET granted = TRUE
            """,
            [(role_id, p) for p in req.permissions],
        )
    perms = await _fetch_permissions(role_id)
    return RoleResponse(
        id=role_id,
        org_id=str(row["org_id"]),
        name=row["name"],
        base_role=row["base_role"],
        description=row.get("description"),
        permissions=perms,
        created_at=row["created_at"].isoformat(),
    )


@router.get("/{role_id}", response_model=RoleResponse)
async def get_role(
    org_id: str,
    role_id: str,
    member: OrgMember = Depends(get_current_org_member),
) -> RoleResponse:
    row = await _fetch_role(role_id, org_id)
    perms = await _fetch_permissions(role_id)
    return RoleResponse(
        id=str(row["id"]),
        org_id=str(row["org_id"]),
        name=row["name"],
        base_role=row["base_role"],
        description=row.get("description"),
        permissions=perms,
        created_at=row["created_at"].isoformat(),
    )


@router.put("/{role_id}", response_model=RoleResponse)
async def update_role(
    org_id: str,
    role_id: str,
    req: RoleUpdateRequest,
    member: OrgMember = Depends(get_current_org_member),
) -> RoleResponse:
    """Update a custom role's description and/or permission set."""
    if member.role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Owner or admin required")

    await _fetch_role(role_id, org_id)  # 404 if missing
    client = await get_postgres_client()

    if req.description is not None:
        await client.execute(
            "UPDATE role_definitions SET description = $1, updated_at = NOW() WHERE id = $2",
            req.description,
            role_id,
        )

    if req.permissions is not None:
        # Replace the permission set wholesale
        await client.execute("DELETE FROM role_permissions WHERE role_id = $1", role_id)
        if req.permissions:
            await client.executemany(
                "INSERT INTO role_permissions (role_id, permission_key, granted) VALUES ($1, $2, TRUE)",
                [(role_id, p) for p in req.permissions],
            )

    row = await _fetch_role(role_id, org_id)
    perms = await _fetch_permissions(role_id)
    return RoleResponse(
        id=str(row["id"]),
        org_id=str(row["org_id"]),
        name=row["name"],
        base_role=row["base_role"],
        description=row.get("description"),
        permissions=perms,
        created_at=row["created_at"].isoformat(),
    )


@router.delete("/{role_id}", status_code=204)
async def delete_role(
    org_id: str,
    role_id: str,
    member: OrgMember = Depends(get_current_org_member),
):
    """Delete a custom role and all of its assignments."""
    if member.role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Owner or admin required")
    await _fetch_role(role_id, org_id)
    client = await get_postgres_client()
    await client.execute("DELETE FROM role_definitions WHERE id = $1", role_id)


# ─────────────────────────────────────────────────────────────────────────────
# Assignments
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/{role_id}/assignments", response_model=list[AssignmentResponse])
async def list_assignments(
    org_id: str,
    role_id: str,
    member: OrgMember = Depends(get_current_org_member),
) -> list[AssignmentResponse]:
    await _fetch_role(role_id, org_id)
    client = await get_postgres_client()
    rows = await client.fetch(
        "SELECT id, role_id, user_id, resource_type, resource_id, granted_by, created_at "
        "FROM role_assignments WHERE role_id = $1 ORDER BY created_at DESC",
        role_id,
    )
    return [
        AssignmentResponse(
            id=str(r["id"]),
            role_id=str(r["role_id"]),
            user_id=str(r["user_id"]),
            resource_type=r.get("resource_type"),
            resource_id=r.get("resource_id"),
            granted_by=str(r["granted_by"]) if r.get("granted_by") else None,
            created_at=r["created_at"].isoformat(),
        )
        for r in rows
    ]


@router.post("/{role_id}/assignments", response_model=AssignmentResponse, status_code=201)
async def create_assignment(
    org_id: str,
    role_id: str,
    req: AssignmentCreateRequest,
    member: OrgMember = Depends(get_current_org_member),
) -> AssignmentResponse:
    if member.role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Owner or admin required")
    # Resource-id and resource-type must be consistent (CHECK constraint
    # enforces this server-side too, but a clean 400 is friendlier). Done
    # *before* the role lookup so a malformed request returns 400, not 404.
    if (req.resource_type is None) != (req.resource_id is None):
        raise HTTPException(
            status_code=400,
            detail="resource_type and resource_id must both be set or both be null",
        )
    await _fetch_role(role_id, org_id)
    client = await get_postgres_client()
    row = await client.fetchrow(
        """
        INSERT INTO role_assignments (role_id, user_id, resource_type, resource_id, granted_by)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, role_id, user_id, resource_type, resource_id, granted_by, created_at
        """,
        role_id,
        req.user_id,
        req.resource_type,
        req.resource_id,
        member.user_id,
    )
    return AssignmentResponse(
        id=str(row["id"]),
        role_id=str(row["role_id"]),
        user_id=str(row["user_id"]),
        resource_type=row.get("resource_type"),
        resource_id=row.get("resource_id"),
        granted_by=str(row["granted_by"]) if row.get("granted_by") else None,
        created_at=row["created_at"].isoformat(),
    )


@router.delete("/{role_id}/assignments/{assignment_id}", status_code=204)
async def delete_assignment(
    org_id: str,
    role_id: str,
    assignment_id: str,
    member: OrgMember = Depends(get_current_org_member),
):
    if member.role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Owner or admin required")
    client = await get_postgres_client()
    await client.execute(
        "DELETE FROM role_assignments WHERE id = $1 AND role_id = $2",
        assignment_id,
        role_id,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Convenience wrappers — "give user this permission" in one call
# ─────────────────────────────────────────────────────────────────────────────

# The auto-role naming scheme is: f"perm:{permission_key}". These roles
# are hidden from the list-roles UI (filter on name LIKE 'perm:%' and
# skip them) — they're managed entirely by the /assign + /unassign
# convenience routes. The base_role is "viewer" (minimal perms) so the
# only thing the user gets is the explicit permission_key we add.

_AUTO_ROLE_PREFIX = "perm:"


async def _get_or_create_auto_role(org_id: str, permission_key: str) -> str:
    """Find or create the auto-managed role for a single permission.

    Returns the role_id. The role has ``base_role=viewer`` (so the user
    gets no other permissions) plus an explicit entry in
    ``role_permissions`` for ``permission_key``.
    """
    client = await get_postgres_client()
    role_name = f"{_AUTO_ROLE_PREFIX}{permission_key}"
    row = await client.fetchrow(
        "SELECT id FROM role_definitions WHERE org_id = $1 AND name = $2",
        org_id,
        role_name,
    )
    if row:
        return str(row["id"])
    row = await client.fetchrow(
        """
        INSERT INTO role_definitions (org_id, name, base_role, description)
        VALUES ($1, $2, 'viewer', $3)
        RETURNING id
        """,
        org_id,
        role_name,
        f"Auto-managed role for permission {permission_key}",
    )
    role_id = str(row["id"])
    await client.execute(
        """
        INSERT INTO role_permissions (role_id, permission_key, granted)
        VALUES ($1, $2, TRUE)
        ON CONFLICT (role_id, permission_key) DO UPDATE SET granted = TRUE
        """,
        role_id,
        permission_key,
    )
    return role_id


class PermissionAssignRequest(BaseModel):
    user_id: str
    permission_key: str
    resource_type: str | None = Field(None, max_length=32)
    resource_id: str | None = Field(None, max_length=128)

    @field_validator("user_id")
    @classmethod
    def _check_user_id(cls, v: str) -> str:
        try:
            UUID(v)
        except (ValueError, TypeError) as exc:
            raise ValueError(f"user_id must be a UUID: {v!r}") from exc
        return v

    @field_validator("permission_key")
    @classmethod
    def _check_perm(cls, v: str) -> str:
        return _validate_permission_key(v)


class PermissionUnassignRequest(BaseModel):
    user_id: str
    permission_key: str

    @field_validator("user_id")
    @classmethod
    def _check_user_id(cls, v: str) -> str:
        try:
            UUID(v)
        except (ValueError, TypeError) as exc:
            raise ValueError(f"user_id must be a UUID: {v!r}") from exc
        return v

    @field_validator("permission_key")
    @classmethod
    def _check_perm(cls, v: str) -> str:
        return _validate_permission_key(v)


@router.post("/assign", response_model=AssignmentResponse, status_code=201)
async def assign_permission(
    org_id: str,
    req: PermissionAssignRequest,
    member: OrgMember = Depends(get_current_org_member),
) -> AssignmentResponse:
    """One-call ``give this user this permission``.

    Wraps the role/assignment infrastructure: finds-or-creates an
    auto-managed role containing exactly ``permission_key``, then
    creates an assignment for ``user_id`` to that role. Idempotent —
    calling twice with the same args returns the existing assignment.
    """
    if member.role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Owner or admin required")
    if (req.resource_type is None) != (req.resource_id is None):
        raise HTTPException(
            status_code=400,
            detail="resource_type and resource_id must both be set or both be null",
        )
    role_id = await _get_or_create_auto_role(org_id, req.permission_key)
    client = await get_postgres_client()
    # Idempotent: ON CONFLICT (role_id, user_id, resource_type, resource_id)
    # DO NOTHING; then fetch the existing row.
    row = await client.fetchrow(
        """
        INSERT INTO role_assignments (role_id, user_id, resource_type, resource_id, granted_by)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (role_id, user_id, COALESCE(resource_type, ''), COALESCE(resource_id, ''))
        DO NOTHING
        RETURNING id, role_id, user_id, resource_type, resource_id, granted_by, created_at
        """,
        role_id,
        req.user_id,
        req.resource_type,
        req.resource_id,
        member.user_id,
    )
    if row is None:
        # Already exists — fetch the existing row to return.
        existing = await client.fetchrow(
            """
            SELECT id, role_id, user_id, resource_type, resource_id, granted_by, created_at
            FROM role_assignments
            WHERE role_id = $1 AND user_id = $2
              AND COALESCE(resource_type, '') = COALESCE($3, '')
              AND COALESCE(resource_id, '') = COALESCE($4, '')
            """,
            role_id,
            req.user_id,
            req.resource_type,
            req.resource_id,
        )
        row = existing
    return AssignmentResponse(
        id=str(row["id"]),
        role_id=str(row["role_id"]),
        user_id=str(row["user_id"]),
        resource_type=row.get("resource_type"),
        resource_id=row.get("resource_id"),
        granted_by=str(row["granted_by"]) if row.get("granted_by") else None,
        created_at=row["created_at"].isoformat(),
    )


@router.post("/unassign", status_code=204)
async def unassign_permission(
    org_id: str,
    req: PermissionUnassignRequest,
    member: OrgMember = Depends(get_current_org_member),
):
    """One-call ``revoke this user's permission``.

    Reverses ``assign_permission`` by deleting the user's assignment
    to the auto-managed role for ``permission_key``. 204 even if no
    assignment existed (idempotent unassign).
    """
    if member.role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Owner or admin required")
    client = await get_postgres_client()
    role_name = f"{_AUTO_ROLE_PREFIX}{req.permission_key}"
    await client.execute(
        """
        DELETE FROM role_assignments
        WHERE user_id = $1
          AND role_id IN (
            SELECT id FROM role_definitions WHERE org_id = $2 AND name = $3
          )
        """,
        req.user_id,
        org_id,
        role_name,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Permission catalogue (static, derived from PERMISSION_MAP)
# ─────────────────────────────────────────────────────────────────────────────

# This endpoint lives on the /orgs/{org_id}/permissions prefix, not the
# /roles one. We mount it as a separate router on app include so the URL
# shape matches what the portal calls.
permissions_router = APIRouter(prefix="/orgs/{org_id}", tags=["rbac"])


@permissions_router.get("/permissions")
async def list_permissions(
    org_id: str,
    member: OrgMember = Depends(get_current_org_member),
) -> dict[str, Any]:
    """Return the full permission catalogue grouped by built-in role.

    The catalogue is derived from ``PERMISSION_MAP`` in
    ``eden.api.deps`` — the same source of truth used by
    ``require_org_permission`` to gate access. Each entry has the
    permission key, the description (derived from the key's
    ``<resource>:<action>`` shape), and the set of built-in roles
    that include it.
    """
    from eden.api.deps import PERMISSION_MAP  # local import to avoid cycles

    # Invert the map: permission -> {role, ...}
    perm_to_roles: dict[str, set[str]] = {}
    for role, perms in PERMISSION_MAP.items():
        for p in perms:
            perm_to_roles.setdefault(p, set()).add(role)

    items: list[dict[str, Any]] = []
    for p in sorted(perm_to_roles):
        resource, _, action = p.partition(":")
        items.append({
            "key": p,
            "resource": resource,
            "action": action,
            "granted_by_default": sorted(perm_to_roles[p]),
        })

    return {
        "org_id": org_id,
        "count": len(items),
        "permissions": items,
    }
