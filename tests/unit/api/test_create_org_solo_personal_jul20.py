"""Wave 1.4: create_org sets is_personal for first/solo workspace."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.api.utils.clerk_client import ClerkAPIError


@pytest.mark.asyncio
async def test_create_org_sets_is_personal_for_first_membership(monkeypatch):
    """User with zero org_members → INSERT includes is_personal=true."""
    from eden.api.routes import orgs as orgs_mod

    executed: list[tuple] = []
    fetchrow_calls: list[tuple] = []

    mock_client = MagicMock()
    mock_client.fetchval = AsyncMock(return_value=0)  # no existing memberships

    async def _fetchrow(query, *args):
        fetchrow_calls.append((query, args))
        if "INSERT INTO organizations" in query:
            return {"id": args[0]}
        if "SELECT clerk_id" in query:
            return {"clerk_id": "user_clerk"}
        if "SELECT id FROM autonomy_policies" in query:
            return None
        return None

    async def _execute(query, *args):
        executed.append((query, args))
        return "OK"

    mock_client.fetchrow = AsyncMock(side_effect=_fetchrow)
    mock_client.execute = AsyncMock(side_effect=_execute)

    monkeypatch.setattr(
        orgs_mod,
        "get_postgres_client",
        AsyncMock(return_value=mock_client),
    )
    monkeypatch.setattr(
        orgs_mod,
        "eden_user_id_from_auth",
        AsyncMock(return_value="user-eden-uuid"),
    )
    monkeypatch.setattr(
        orgs_mod,
        "organizations_have_is_personal",
        AsyncMock(return_value=True),
    )

    async def _clerk_create(**_kwargs):
        return {"id": "org_clerk_new"}

    monkeypatch.setattr(
        "eden.api.utils.clerk_client.create_organization",
        _clerk_create,
    )
    monkeypatch.setattr(
        "eden.api.utils.clerk_client.create_membership",
        AsyncMock(return_value={}),
    )
    monkeypatch.setattr(
        "eden.signals.defaults.seed_org_signals",
        AsyncMock(return_value=None),
    )

    result = await orgs_mod.create_org(
        name="Solo Co",
        make_default=True,
        user={"user_id": "user-eden-uuid"},
    )

    assert result["role"] == "owner"
    assert result["is_personal"] is True
    assert result["org_degraded"] is False

    insert = next(c for c in fetchrow_calls if "INSERT INTO organizations" in c[0])
    assert "is_personal" in insert[0]
    # args: org_id, clerk_org_id, name, slug, user_id, is_personal
    assert insert[1][5] is True

    member_insert = next(c for c in executed if "INSERT INTO org_members" in c[0])
    assert "'owner'" in member_insert[0] or "owner" in member_insert[0]


@pytest.mark.asyncio
async def test_create_org_second_org_not_personal(monkeypatch):
    """User already in an org → is_personal=false on the new row."""
    from eden.api.routes import orgs as orgs_mod

    fetchrow_calls: list[tuple] = []
    mock_client = MagicMock()
    mock_client.fetchval = AsyncMock(return_value=1)  # already a member

    async def _fetchrow(query, *args):
        fetchrow_calls.append((query, args))
        if "INSERT INTO organizations" in query:
            return {"id": args[0]}
        if "SELECT clerk_id" in query:
            return None
        if "SELECT id FROM autonomy_policies" in query:
            return {"id": "pol"}
        return None

    mock_client.fetchrow = AsyncMock(side_effect=_fetchrow)
    mock_client.execute = AsyncMock(return_value="OK")

    monkeypatch.setattr(
        orgs_mod,
        "get_postgres_client",
        AsyncMock(return_value=mock_client),
    )
    monkeypatch.setattr(
        orgs_mod,
        "eden_user_id_from_auth",
        AsyncMock(return_value="user-eden-uuid"),
    )
    monkeypatch.setattr(
        orgs_mod,
        "organizations_have_is_personal",
        AsyncMock(return_value=True),
    )
    monkeypatch.setattr(
        "eden.api.utils.clerk_client.create_organization",
        AsyncMock(return_value={"id": "org_clerk_2"}),
    )
    monkeypatch.setattr(
        "eden.api.utils.clerk_client.create_membership",
        AsyncMock(return_value={}),
    )
    monkeypatch.setattr(
        "eden.signals.defaults.seed_org_signals",
        AsyncMock(return_value=None),
    )

    result = await orgs_mod.create_org(
        name="Team Co",
        make_default=False,
        user={"user_id": "user-eden-uuid"},
    )

    assert result["role"] == "owner"
    assert result["is_personal"] is False
    insert = next(c for c in fetchrow_calls if "INSERT INTO organizations" in c[0])
    assert insert[1][5] is False


@pytest.mark.asyncio
async def test_create_org_degraded_clerk_still_owner(monkeypatch):
    """Clerk unreachable → org_degraded but Eden role remains owner."""
    from eden.api.routes import orgs as orgs_mod

    mock_client = MagicMock()
    mock_client.fetchval = AsyncMock(return_value=0)

    async def _fetchrow(query, *args):
        if "INSERT INTO organizations" in query:
            return {"id": args[0]}
        if "SELECT id FROM autonomy_policies" in query:
            return None
        return None

    mock_client.fetchrow = AsyncMock(side_effect=_fetchrow)
    mock_client.execute = AsyncMock(return_value="OK")

    monkeypatch.setattr(
        orgs_mod,
        "get_postgres_client",
        AsyncMock(return_value=mock_client),
    )
    monkeypatch.setattr(
        orgs_mod,
        "eden_user_id_from_auth",
        AsyncMock(return_value="user-eden-uuid"),
    )
    monkeypatch.setattr(
        orgs_mod,
        "organizations_have_is_personal",
        AsyncMock(return_value=True),
    )
    monkeypatch.setattr(
        "eden.api.utils.clerk_client.create_organization",
        AsyncMock(side_effect=ClerkAPIError("timeout")),
    )
    monkeypatch.setattr(
        "eden.signals.defaults.seed_org_signals",
        AsyncMock(return_value=None),
    )

    result = await orgs_mod.create_org(
        name="Offline Co",
        make_default=True,
        user={"user_id": "user-eden-uuid"},
    )

    assert result["org_degraded"] is True
    assert result["clerk_org_id"] is None
    assert result["role"] == "owner"
    assert result["is_personal"] is True
