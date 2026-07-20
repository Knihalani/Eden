"""Regression: ``get_current_org_member`` must not demote owners.

Mirrors ``test_require_org_admin_payload_jul19.py`` for the typed
``OrgMember`` path: Clerk JWT with org id but missing ``o.rol`` must
use the DB role. Also covers ``ensure_clerk_membership(None)`` two-call
demotion (local owner → viewer via last_writer_source flip).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.api.deps import ensure_clerk_membership, get_current_org_member
from eden.api.utils.clerk_auth import clerk_role_to_eden_role


def test_clerk_role_none_maps_to_viewer():
    """Document mapping; callers must not prefer this over DB owner."""
    assert clerk_role_to_eden_role(None) == "viewer"
    assert clerk_role_to_eden_role("") == "viewer"


@pytest.mark.asyncio
async def test_get_current_org_member_uses_db_role_when_jwt_has_org_but_no_rol(
    monkeypatch,
):
    """JWT o.id matches org, no o.rol, DB owner → OrgMember.role is owner."""
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
        lambda _p: clerk_org,  # session org matches trusted org
    )
    monkeypatch.setattr(
        "eden.api.deps.extract_org_role",
        lambda _p: None,  # no o.rol
    )
    monkeypatch.setattr(
        "eden.api.deps.extract_user_id",
        lambda _p: "user_clerk_sub",
    )
    monkeypatch.setattr(
        "eden.api.deps.ensure_clerk_membership",
        AsyncMock(return_value=False),
    )

    mock_client = MagicMock()
    mock_client.fetchrow = AsyncMock(
        return_value={
            "role": "owner",
            "user_name": "Founder",
            "email": "founder@example.com",
        }
    )
    monkeypatch.setattr(
        "eden.api.deps.get_postgres_client",
        AsyncMock(return_value=mock_client),
    )

    payload = {
        "sub": "user_clerk_sub",
        "iss": "https://clerk.edenobservability.com",
        "o": {"id": clerk_org},
    }
    member = await get_current_org_member(x_org_id=eden_org, payload=payload)
    assert member.role == "owner"
    assert member.org_id == eden_org
    assert member.user_id == eden_user


@pytest.mark.asyncio
async def test_get_current_org_member_prefers_jwt_role_when_present(
    monkeypatch,
):
    """When o.rol is present and stronger than DB, JWT-mapped role wins."""
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
        lambda _p: "org:admin",
    )
    monkeypatch.setattr(
        "eden.api.deps.extract_user_id",
        lambda _p: "user_clerk_sub",
    )
    monkeypatch.setattr(
        "eden.api.deps.ensure_clerk_membership",
        AsyncMock(return_value=True),
    )

    mock_client = MagicMock()
    mock_client.fetchrow = AsyncMock(
        return_value={
            "role": "member",  # stale DB; JWT says admin→owner
            "user_name": "Founder",
            "email": "founder@example.com",
        }
    )
    monkeypatch.setattr(
        "eden.api.deps.get_postgres_client",
        AsyncMock(return_value=mock_client),
    )

    payload = {
        "sub": "user_clerk_sub",
        "iss": "https://clerk.edenobservability.com",
        "o": {"id": clerk_org, "rol": "admin"},
    }
    member = await get_current_org_member(x_org_id=eden_org, payload=payload)
    assert member.role == "owner"


@pytest.mark.asyncio
async def test_get_current_org_member_jwt_cannot_demote_db_owner(
    monkeypatch,
):
    """DB owner + weaker JWT claim (org:member) must stay owner."""
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
        lambda _p: "org:member",  # weaker than DB owner
    )
    monkeypatch.setattr(
        "eden.api.deps.extract_user_id",
        lambda _p: "user_clerk_sub",
    )
    monkeypatch.setattr(
        "eden.api.deps.ensure_clerk_membership",
        AsyncMock(return_value=True),
    )

    mock_client = MagicMock()
    mock_client.fetchrow = AsyncMock(
        return_value={
            "role": "owner",
            "user_name": "Founder",
            "email": "founder@example.com",
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
    member = await get_current_org_member(x_org_id=eden_org, payload=payload)
    assert member.role == "owner"


@pytest.mark.asyncio
async def test_prefer_higher_eden_role_never_demotes():
    from eden.api.deps import prefer_higher_eden_role

    assert prefer_higher_eden_role("owner", "viewer") == "owner"
    assert prefer_higher_eden_role("owner", "member") == "owner"
    assert prefer_higher_eden_role("admin", "member") == "admin"
    assert prefer_higher_eden_role("member", "owner") == "owner"
    assert prefer_higher_eden_role(None, "viewer") == "viewer"
    assert prefer_higher_eden_role("owner", None) == "owner"


@pytest.mark.asyncio
async def test_ensure_clerk_membership_none_does_not_write_or_demote(
    monkeypatch,
):
    """Two-call demotion regression: None must not touch DB at all.

    Previously call 1 with None flipped last_writer_source to 'clerk'
    (preserving local owner), then call 2 wrote role=viewer.
    """
    execute = AsyncMock()
    mock_client = MagicMock()
    mock_client.execute = execute
    monkeypatch.setattr(
        "eden.api.deps.get_postgres_client",
        AsyncMock(return_value=mock_client),
    )

    first = await ensure_clerk_membership("u1", "o1", None)
    second = await ensure_clerk_membership("u1", "o1", "")
    assert first is False
    assert second is False
    execute.assert_not_called()


@pytest.mark.asyncio
async def test_ensure_clerk_membership_with_role_still_upserts(
    monkeypatch,
):
    """Positive control: a real clerk_role still performs the insert."""
    execute = AsyncMock()
    mock_client = MagicMock()
    mock_client.execute = execute
    monkeypatch.setattr(
        "eden.api.deps.get_postgres_client",
        AsyncMock(return_value=mock_client),
    )

    ok = await ensure_clerk_membership("u1", "o1", "org:admin")
    assert ok is True
    execute.assert_called_once()
    args = execute.await_args.args
    assert args[1] == "o1"
    assert args[2] == "u1"
    assert args[3] == "owner"
    sql = args[0]
    assert "ON CONFLICT (org_id, user_id) DO NOTHING" in sql
    assert "DO UPDATE" not in sql


@pytest.mark.asyncio
async def test_ensure_clerk_membership_legacy_also_do_nothing(
    monkeypatch,
):
    """Legacy path (no last_writer_source column) must not overwrite role."""
    execute = AsyncMock(
        side_effect=[
            Exception("column \"last_writer_source\" does not exist"),
            None,
        ]
    )
    mock_client = MagicMock()
    mock_client.execute = execute
    monkeypatch.setattr(
        "eden.api.deps.get_postgres_client",
        AsyncMock(return_value=mock_client),
    )

    ok = await ensure_clerk_membership("u1", "o1", "org:member")
    assert ok is True
    assert execute.await_count == 2
    legacy_sql = execute.await_args_list[1].args[0]
    assert "ON CONFLICT (org_id, user_id) DO NOTHING" in legacy_sql
    assert "DO UPDATE" not in legacy_sql
    assert "EXCLUDED.role" not in legacy_sql
