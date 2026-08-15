"""W1-B / W4-A: Clerk-style path org_id must resolve to Eden UUID (no SQL 500).

Representative UUID-SQL routes: GET /orgs/{org_id}/roles and /permissions.
Handlers bind ``org_id: str = Depends(require_path_org_access)`` so the
value passed into Postgres is the Eden UUID, not a raw ``org_…`` Clerk id.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient

from eden.api.routes import rbac

_EDEN_ORG_UUID = "f4dc4575-ebd5-47a2-8541-42b9e41c1148"
_CLERK_ORG_PATH = "org_2xClerkStylePathId999"


@pytest.mark.asyncio
async def test_list_roles_clerk_path_uses_eden_uuid_not_500(monkeypatch):
    """Clerk org_ path → Depends rewrite → SQL gets UUID → 200 (not 500)."""
    captured: dict[str, str] = {}

    client = MagicMock()

    async def _fetch(query: str, *args):
        captured["org_id"] = args[0]
        # Simulate asyncpg UUID column: non-UUID would raise DataError → 500
        if not (
            isinstance(args[0], str)
            and len(args[0]) in (32, 36)
            and "-" in args[0]
        ):
            raise ValueError(f"invalid UUID {args[0]!r}")
        return []

    client.fetch = AsyncMock(side_effect=_fetch)

    monkeypatch.setattr(rbac, "get_postgres_client", AsyncMock(return_value=client))

    application = FastAPI()
    application.include_router(rbac.router)
    application.dependency_overrides[rbac.require_path_org_access] = (
        lambda: _EDEN_ORG_UUID
    )
    application.dependency_overrides[rbac.get_current_org_member] = lambda: rbac.OrgMember(
        user_id=str(uuid4()),
        org_id=_EDEN_ORG_UUID,
        role="member",
        email="m@test.io",
        name="Member",
    )

    transport = ASGITransport(app=application)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        resp = await http.get(f"/orgs/{_CLERK_ORG_PATH}/roles")

    assert resp.status_code == 200, resp.text
    assert resp.json() == []
    assert captured["org_id"] == _EDEN_ORG_UUID
    assert captured["org_id"] != _CLERK_ORG_PATH


@pytest.mark.asyncio
async def test_list_roles_cross_org_path_is_403_not_500():
    """Denied path-org access must surface 403, not a UUID DataError 500."""
    application = FastAPI()
    application.include_router(rbac.router)

    async def _deny() -> str:
        raise HTTPException(status_code=403, detail="Not a member of this organization")

    application.dependency_overrides[rbac.require_path_org_access] = _deny
    application.dependency_overrides[rbac.get_current_org_member] = lambda: rbac.OrgMember(
        user_id=str(uuid4()),
        org_id=_EDEN_ORG_UUID,
        role="member",
        email="m@test.io",
        name="Member",
    )

    transport = ASGITransport(app=application)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        resp = await http.get(f"/orgs/{_CLERK_ORG_PATH}/roles")

    assert resp.status_code == 403, resp.text
    assert resp.status_code != 500


@pytest.mark.asyncio
async def test_permissions_catalogue_clerk_path_uses_eden_uuid():
    """GET /permissions aligns with /roles: Depends rewrite + router gate."""
    application = FastAPI()
    application.include_router(rbac.permissions_router)
    application.dependency_overrides[rbac.require_path_org_access] = (
        lambda: _EDEN_ORG_UUID
    )
    application.dependency_overrides[rbac.get_current_org_member] = lambda: rbac.OrgMember(
        user_id=str(uuid4()),
        org_id=_EDEN_ORG_UUID,
        role="member",
        email="m@test.io",
        name="Member",
    )

    transport = ASGITransport(app=application)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        resp = await http.get(f"/orgs/{_CLERK_ORG_PATH}/permissions")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["org_id"] == _EDEN_ORG_UUID
    assert body["org_id"] != _CLERK_ORG_PATH
    assert body["count"] == len(body["permissions"])


@pytest.mark.asyncio
async def test_permissions_catalogue_cross_org_is_403_not_500():
    application = FastAPI()
    application.include_router(rbac.permissions_router)

    async def _deny() -> str:
        raise HTTPException(status_code=403, detail="Not a member of this organization")

    application.dependency_overrides[rbac.require_path_org_access] = _deny
    application.dependency_overrides[rbac.get_current_org_member] = lambda: rbac.OrgMember(
        user_id=str(uuid4()),
        org_id=_EDEN_ORG_UUID,
        role="member",
        email="m@test.io",
        name="Member",
    )

    transport = ASGITransport(app=application)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        resp = await http.get(f"/orgs/{_CLERK_ORG_PATH}/permissions")

    assert resp.status_code == 403, resp.text
