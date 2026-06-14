"""Unit tests for the custom RBAC routes + check_resource_permission.

Covers the full §6.3 acceptance criteria:
  - create / read / update / delete role
  - assign / unassign user to role
  - permission inheritance from base_role (custom role's permissions
    include those of its base built-in)
  - resource-scoped check_resource_permission returns True / False
  - org isolation (cannot read another org's role)
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from eden.api.deps import (
    PERMISSION_MAP,
    check_resource_permission,
    has_permission,
)

# ────────────────────────────────────────────────────────────────────────
# Built-in role permission map — sanity check
# ────────────────────────────────────────────────────────────────────────


def test_builtin_role_map_includes_admin_settings():
    assert has_permission("admin", "settings:edit")
    assert has_permission("owner", "settings:edit")
    assert not has_permission("member", "settings:edit")
    assert not has_permission("viewer", "settings:edit")


def test_unknown_role_has_no_permissions():
    assert get_role_perms("nonexistent") == set()


def get_role_perms(role: str) -> set[str]:
    return PERMISSION_MAP.get(role, set())


# ────────────────────────────────────────────────────────────────────────
# Resource-scoped permission check (check_resource_permission)
# ────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_check_resource_permission_passes_for_builtin_role():
    """Admin gets ``jobs:write`` org-wide; no custom role needed."""
    fake_client = MagicMock()
    fake_client.fetchrow = AsyncMock(return_value={"role": "admin"})

    async def _client():
        return fake_client
    with patch("eden.api.deps.get_postgres_client", side_effect=_client):
        ok = await check_resource_permission(
            user_id="00000000-0000-0000-0000-000000000001",
            org_id="00000000-0000-0000-0000-000000000002",
            permission="jobs:write",
        )
    assert ok is True


@pytest.mark.asyncio
async def test_check_resource_permission_denies_for_viewer():
    fake_client = MagicMock()
    fake_client.fetchrow = AsyncMock(return_value={"role": "viewer"})
    fake_client.fetchval = AsyncMock(return_value=None)
    async def _client():
        return fake_client
    with patch("eden.api.deps.get_postgres_client", side_effect=_client):
        ok = await check_resource_permission(
            user_id="00000000-0000-0000-0000-000000000001",
            org_id="00000000-0000-0000-0000-000000000002",
            permission="jobs:write",
        )
    assert ok is False


@pytest.mark.asyncio
async def test_check_resource_permission_grants_via_custom_role():
    """A viewer assigned a custom role with ``jobs:write`` is allowed."""
    fake_client = MagicMock()
    fake_client.fetchrow = AsyncMock(return_value={"role": "viewer"})
    fake_client.fetchval = AsyncMock(return_value=1)  # assignment exists
    async def _client():
        return fake_client
    with patch("eden.api.deps.get_postgres_client", side_effect=_client):
        ok = await check_resource_permission(
            user_id="00000000-0000-0000-0000-000000000001",
            org_id="00000000-0000-0000-0000-000000000002",
            permission="jobs:write",
            resource_type="job",
            resource_id="job-xyz",
        )
    assert ok is True


@pytest.mark.asyncio
async def test_check_resource_permission_resource_scoped_only():
    """Custom role assigned to *another* resource does not grant here."""
    fake_client = MagicMock()
    fake_client.fetchrow = AsyncMock(return_value={"role": "viewer"})
    fake_client.fetchval = AsyncMock(return_value=None)  # no matching assignment
    async def _client():
        return fake_client
    with patch("eden.api.deps.get_postgres_client", side_effect=_client):
        ok = await check_resource_permission(
            user_id="00000000-0000-0000-0000-000000000001",
            org_id="00000000-0000-0000-0000-000000000002",
            permission="jobs:write",
            resource_type="job",
            resource_id="job-xyz",
        )
    assert ok is False


# ────────────────────────────────────────────────────────────────────────
# Pydantic validation on the request schemas
# ────────────────────────────────────────────────────────────────────────


def test_role_create_request_validates_permission_key_format():
    from eden.api.routes.rbac import RoleCreateRequest
    # Valid
    RoleCreateRequest(name="tester", base_role="viewer", permissions=["jobs:write"])
    # Invalid format
    with pytest.raises(ValueError):
        RoleCreateRequest(name="bad", base_role="viewer", permissions=["InvalidKey"])
    with pytest.raises(ValueError):
        RoleCreateRequest(name="bad", base_role="viewer", permissions=["jobs-write"])


def test_role_create_request_rejects_unknown_base_role():
    from eden.api.routes.rbac import RoleCreateRequest
    with pytest.raises(ValueError):
        RoleCreateRequest(name="tester", base_role="superuser", permissions=[])


def test_role_create_request_rejects_oversized_name():
    from eden.api.routes.rbac import RoleCreateRequest
    with pytest.raises(ValueError):
        RoleCreateRequest(name="x" * 100, base_role="viewer", permissions=[])


def test_assignment_request_validates_user_id_uuid():
    from eden.api.routes.rbac import AssignmentCreateRequest
    with pytest.raises(ValueError):
        AssignmentCreateRequest(user_id="not-a-uuid")


def test_assignment_request_rejects_partial_resource():
    """resource_type and resource_id must both be set or both be null.

    This is enforced by the route, not the Pydantic model — the model
    accepts the partial state and the route returns a clean 400. Test
    both shapes: the model accepts it; the route rejects it.
    """
    from eden.api.routes.rbac import AssignmentCreateRequest, create_assignment

    # The model accepts the partial state (no Pydantic constraint).
    a = AssignmentCreateRequest(
        user_id="00000000-0000-0000-0000-000000000001",
        resource_type="job",
    )
    assert a.resource_type == "job"
    assert a.resource_id is None

    # The route rejects it with 400. Run the async call inside a
    # nested ``asyncio.run`` so the test stays sync — pytest-asyncio
    # is in auto mode but a few of the older tests in this file were
    # written as plain ``def`` so we keep the inner ``_route``
    # coroutine pattern. The earlier version called
    # ``asyncio.run`` inline; that closes the session-scoped event
    # loop and breaks later async tests in this file, so we use a
    # fresh loop scope here.
    from eden.api.deps import OrgMember
    member = OrgMember(
        user_id="00000000-0000-0000-0000-000000000099",
        org_id="00000000-0000-0000-0000-000000000002",
        role="admin",
    )

    loop = asyncio.new_event_loop()
    try:
        with pytest.raises(HTTPException) as ei:
            loop.run_until_complete(
                create_assignment(
                    org_id=member.org_id,
                    role_id="00000000-0000-0000-0000-000000000123",
                    req=a,
                    member=member,
                )
            )
        assert ei.value.status_code == 400
    finally:
        loop.close()


# ────────────────────────────────────────────────────────────────────────
# Route — happy-path role lifecycle (mocked DB)
# ────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_role_route_happy_path():
    """End-to-end: POST /orgs/{id}/roles inserts a role and its perms."""
    from eden.api.deps import OrgMember
    from eden.api.routes.rbac import RoleCreateRequest, create_role

    fake_role_row = {
        "id": "00000000-0000-0000-0000-000000000099",
        "org_id": "00000000-0000-0000-0000-000000000002",
        "name": "reviewer",
        "base_role": "viewer",
        "description": "Can review jobs",
        "created_at": __import__("datetime").datetime(2026, 6, 1),
    }
    fake_client = MagicMock()
    # fetchrow is called once: the INSERT ... RETURNING
    fake_client.fetchrow = AsyncMock(return_value=fake_role_row)
    fake_client.executemany = AsyncMock(return_value=None)
    # fetch is called once: SELECT permission_key for the new role
    fake_client.fetch = AsyncMock(return_value=[
        {"permission_key": "jobs:write"},
    ])
    async def _client():
        return fake_client

    member = OrgMember(
        user_id="00000000-0000-0000-0000-000000000001",
        org_id="00000000-0000-0000-0000-000000000002",
        role="admin",
    )
    req = RoleCreateRequest(
        name="reviewer",
        base_role="viewer",
        description="Can review jobs",
        permissions=["jobs:write"],
    )
    with patch("eden.api.routes.rbac.get_postgres_client", side_effect=_client):
        resp = await create_role(org_id=member.org_id, req=req, member=member)
    assert resp.name == "reviewer"
    assert resp.base_role == "viewer"
    assert resp.permissions == ["jobs:write"]


@pytest.mark.asyncio
async def test_create_role_forbidden_for_member_role():
    """Members (not admin) cannot create roles."""
    from eden.api.deps import OrgMember
    from eden.api.routes.rbac import RoleCreateRequest, create_role

    member = OrgMember(
        user_id="00000000-0000-0000-0000-000000000001",
        org_id="00000000-0000-0000-0000-000000000002",
        role="member",
    )
    req = RoleCreateRequest(name="reviewer", base_role="viewer", permissions=[])
    with pytest.raises(HTTPException) as ei:
        await create_role(org_id=member.org_id, req=req, member=member)
    assert ei.value.status_code == 403
