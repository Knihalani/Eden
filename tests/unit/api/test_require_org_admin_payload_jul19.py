"""Regression: bare ``await require_org_admin(org_id)`` must not 500.

When a route calls ``await require_org_admin(org_id)`` without resolving
the JWT, FastAPI leaves ``payload`` as a ``Depends(...)`` sentinel.
``payload.get(...)`` then raises AttributeError → HTTP 500.

Also covers: Clerk JWT missing ``o.rol`` but DB membership is owner —
``get_current_org`` must return the DB role so org creators can manage
API keys before Clerk ``setActive``.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from fastapi.params import Depends as DependsParam

from eden.api.deps import get_current_org, require_org_admin
from eden.api.utils.clerk_auth import clerk_role_to_eden_role


def test_clerk_role_abbreviated_admin_maps_to_owner():
    assert clerk_role_to_eden_role("org:admin") == "owner"
    assert clerk_role_to_eden_role("admin") == "owner"
    assert clerk_role_to_eden_role("org:member") == "member"
    assert clerk_role_to_eden_role("member") == "member"
    assert clerk_role_to_eden_role(None) == "viewer"


@pytest.mark.asyncio
async def test_get_current_org_rejects_depends_sentinel_not_500():
    """Unresolved Depends payload → None (upstream 403), never AttributeError."""
    sentinel = DependsParam(lambda: None)
    result = await get_current_org("org-eden-uuid", sentinel)  # type: ignore[arg-type]
    assert result is None


@pytest.mark.asyncio
async def test_require_org_admin_with_depends_sentinel_is_403_not_500():
    sentinel = DependsParam(lambda: None)
    with pytest.raises(HTTPException) as exc_info:
        await require_org_admin("org-eden-uuid", sentinel)  # type: ignore[arg-type]
    assert exc_info.value.status_code == 403
    assert "Depends" not in str(exc_info.value.detail)


@pytest.mark.asyncio
async def test_get_current_org_uses_db_role_when_jwt_has_no_org_role(
    monkeypatch,
):
    """Path/header org + DB owner membership, JWT without o.rol → owner."""
    eden_org = "f4dc4575-ebd5-47a2-8541-42b9e41c1148"
    eden_user = "user-eden-uuid"

    monkeypatch.setattr(
        "eden.api.deps._is_clerk_payload_public",
        lambda _p: True,
    )
    monkeypatch.setattr(
        "eden.api.deps.resolve_eden_user_id",
        AsyncMock(return_value=eden_user),
    )
    monkeypatch.setattr(
        "eden.api.deps.resolve_eden_org_id",
        AsyncMock(side_effect=lambda oid: eden_org if oid else None),
    )
    monkeypatch.setattr(
        "eden.api.deps.extract_org_id",
        lambda _p: None,  # no active Clerk org claim yet
    )
    monkeypatch.setattr(
        "eden.api.deps.extract_org_role",
        lambda _p: None,  # no o.rol
    )
    monkeypatch.setattr(
        "eden.api.deps.extract_user_id",
        lambda _p: "user_clerk_sub",
    )

    mock_client = MagicMock()
    mock_client.fetchrow = AsyncMock(
        return_value={
            "role": "owner",
            "name": "My Org",
            "slug": "my-org",
            "owner_id": eden_user,
            "archived_at": None,
        }
    )
    monkeypatch.setattr(
        "eden.api.deps.get_postgres_client",
        AsyncMock(return_value=mock_client),
    )

    payload = {
        "sub": "user_clerk_sub",
        "iss": "https://clerk.edenobservability.com",
    }
    org = await get_current_org(eden_org, payload)
    assert org is not None
    assert org["role"] == "owner"
    assert org["org_id"] == eden_org

    admin = await require_org_admin(eden_org, payload)
    assert admin["role"] == "owner"


@pytest.mark.asyncio
async def test_get_current_org_jwt_member_cannot_demote_db_owner(
    monkeypatch,
):
    """Session-matched JWT org:member must not demote DB owner."""
    eden_org = "f4dc4575-ebd5-47a2-8541-42b9e41c1148"
    eden_user = "user-eden-uuid"
    clerk_org = "org_clerk_active"

    monkeypatch.setattr(
        "eden.api.deps._is_clerk_payload_public",
        lambda _p: True,
    )
    monkeypatch.setattr(
        "eden.api.deps.resolve_eden_user_id",
        AsyncMock(return_value=eden_user),
    )
    monkeypatch.setattr(
        "eden.api.deps.resolve_eden_org_id",
        AsyncMock(
            side_effect=lambda oid: eden_org if oid in (eden_org, clerk_org) else None
        ),
    )
    monkeypatch.setattr(
        "eden.api.deps.extract_org_id",
        lambda _p: clerk_org,
    )
    monkeypatch.setattr(
        "eden.api.deps.extract_org_role",
        lambda _p: "org:member",
    )
    monkeypatch.setattr(
        "eden.api.deps.extract_user_id",
        lambda _p: "user_clerk_sub",
    )

    mock_client = MagicMock()
    mock_client.fetchrow = AsyncMock(
        return_value={
            "role": "owner",
            "name": "Solo Org",
            "slug": "solo-org",
            "owner_id": eden_user,
            "archived_at": None,
        }
    )
    monkeypatch.setattr(
        "eden.api.deps.get_postgres_client",
        AsyncMock(return_value=mock_client),
    )

    payload = {
        "sub": "user_clerk_sub",
        "iss": "https://clerk.edenobservability.com",
        "o": {"id": clerk_org, "rol": "member"},
    }
    org = await get_current_org(eden_org, payload)
    assert org is not None
    assert org["role"] == "owner"

    admin = await require_org_admin(eden_org, payload)
    assert admin["role"] == "owner"
