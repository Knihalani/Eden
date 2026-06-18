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

from eden.api.deps import (
    PERMISSION_MAP,
    OrgMember,
    get_current_org_member,
    require_org_permission,
)
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
            raise HTTPException(status_code=409, detail=f"Role {req.name!r} already exists")
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
# Permissions catalogue (Phase 7.3d)
# ─────────────────────────────────────────────────────────────────────────────

permissions_router = APIRouter(prefix="/orgs/{org_id}", tags=["rbac"])


@permissions_router.get("/permissions")
async def get_permissions_catalogue(
    org_id: str,
    member: OrgMember = Depends(get_current_org_member),
) -> dict:
    """Return the full permissions catalogue for the org.

    The catalogue is the union of every permission key in
    :data:`PERMISSION_MAP`, annotated with the built-in roles
    that grant each permission by default. Used by the portal
    role-editor UI to render the available permission picker.
    """
    # Build reverse index: permission -> [roles that grant it].
    grants: dict[str, list[str]] = {}
    for role, perms in PERMISSION_MAP.items():
        for perm in perms:
            grants.setdefault(perm, []).append(role)

    permissions: list[dict] = []
    for key in sorted(grants):
        if ":" not in key:
            continue
        resource, action = key.split(":", 1)
        permissions.append(
            {
                "key": key,
                "resource": resource,
                "action": action,
                "granted_by_default": sorted(grants[key]),
            }
        )

    return {
        "org_id": org_id,
        "count": len(permissions),
        "permissions": permissions,
    }
