"""Clerk-style path org_id must resolve to Eden UUID before SQL (no 500).

Covers remaining orgs.py handlers that still bound raw path ``org_id``
into UUID columns after authz already resolved the Eden org.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

EDEN_UUID = "f4dc4575-ebd5-47a2-8541-42b9e41c1148"
CLERK_PATH = "org_2xClerkStylePathId999"
USER = "00000000-0000-0000-0000-000000000002"


def _uuid_guard(arg: object) -> None:
    if isinstance(arg, str) and arg.startswith("org_"):
        raise Exception(f'invalid input syntax for type uuid: "{arg}"')


@pytest.mark.asyncio
async def test_get_org_clerk_path_uses_eden_uuid_not_500():
    from eden.api.routes import orgs as mod

    captured: dict[str, object] = {}
    client = MagicMock()

    async def _fetchrow(query: str, *args):
        _uuid_guard(args[0])
        captured.setdefault("args", []).append(args[0])
        if "org_members" in query:
            return {"role": "owner"}
        return {
            "id": EDEN_UUID,
            "name": "Acme",
            "slug": "acme",
            "owner_id": USER,
            "settings": {},
            "created_at": None,
        }

    client.fetchrow = AsyncMock(side_effect=_fetchrow)
    client.fetchval = AsyncMock(return_value=1)

    with (
        patch.object(mod, "resolve_eden_org_id", AsyncMock(return_value=EDEN_UUID)),
        patch.object(mod, "eden_user_id_from_auth", AsyncMock(return_value=USER)),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        result = await mod.get_org(CLERK_PATH, user={"user_id": "clerk_u"})

    assert result["id"] == EDEN_UUID
    assert result["role"] == "owner"
    assert all(a == EDEN_UUID for a in captured["args"])
    assert CLERK_PATH not in captured["args"]


@pytest.mark.asyncio
async def test_get_org_unknown_path_is_404_not_500():
    from eden.api.routes import orgs as mod

    with (
        patch.object(mod, "resolve_eden_org_id", AsyncMock(return_value=None)),
        patch.object(mod, "eden_user_id_from_auth", AsyncMock(return_value=USER)),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=MagicMock())),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.get_org(CLERK_PATH, user={"user_id": "clerk_u"})
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_update_org_settings_uses_eden_org_uuid_not_path():
    from eden.api.routes import orgs as mod

    captured: dict[str, object] = {}
    client = MagicMock()

    async def _fetchval(query: str, *args):
        _uuid_guard(args[0])
        captured["fetch"] = args[0]
        return {}

    async def _execute(query: str, *args):
        _uuid_guard(args[-1])
        captured["update"] = args[-1]
        return "UPDATE 1"

    client.fetchval = AsyncMock(side_effect=_fetchval)
    client.execute = AsyncMock(side_effect=_execute)

    with (
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
        patch.object(mod, "log_audit_event", AsyncMock()),
    ):
        result = await mod.update_org_settings(
            CLERK_PATH,
            {"theme": "dark"},
            user={"user_id": USER},
            org={"org_id": EDEN_UUID, "role": "admin"},
        )

    assert result["settings"] == {"theme": "dark"}
    assert captured["fetch"] == EDEN_UUID
    assert captured["update"] == EDEN_UUID


@pytest.mark.asyncio
async def test_archive_org_uses_eden_org_uuid_not_path():
    from eden.api.routes import orgs as mod

    captured: dict[str, object] = {}
    client = MagicMock()

    async def _fetchrow(query: str, *args):
        _uuid_guard(args[0])
        captured["fetch"] = args[0]
        return {"archived_at": None}

    async def _execute(query: str, *args):
        _uuid_guard(args[0])
        captured["update"] = args[0]
        return "UPDATE 1"

    client.fetchrow = AsyncMock(side_effect=_fetchrow)
    client.execute = AsyncMock(side_effect=_execute)

    with (
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
        patch.object(mod, "log_audit_event", AsyncMock()),
    ):
        result = await mod.archive_org(
            CLERK_PATH,
            user={"user_id": USER},
            org={"org_id": EDEN_UUID, "role": "admin"},
        )

    assert result["org_id"] == EDEN_UUID
    assert captured["fetch"] == EDEN_UUID
    assert captured["update"] == EDEN_UUID


@pytest.mark.asyncio
async def test_get_scim_config_uses_eden_org_uuid_not_path():
    from eden.api.routes import orgs as mod

    captured: dict[str, object] = {}
    client = MagicMock()

    async def _fetchrow(query: str, *args):
        _uuid_guard(args[0])
        captured["org"] = args[0]
        return None

    client.fetchrow = AsyncMock(side_effect=_fetchrow)

    with (
        patch.object(
            mod,
            "require_org_admin",
            AsyncMock(return_value={"org_id": EDEN_UUID, "role": "admin"}),
        ),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        result = await mod.get_scim_config(
            CLERK_PATH,
            user={"user_id": USER},
            payload={"sub": USER},
        )

    assert result["scim_enabled"] is False
    assert captured["org"] == EDEN_UUID
    assert captured["org"] != CLERK_PATH


@pytest.mark.asyncio
async def test_send_invite_uses_eden_org_uuid_not_path():
    from eden.api.routes import orgs as mod

    captured: dict[str, object] = {}
    client = MagicMock()

    async def _fetchrow(query: str, *args):
        _uuid_guard(args[0])
        captured["member_check"] = args[0]
        return None

    client.fetchrow = AsyncMock(side_effect=_fetchrow)

    with (
        patch.object(mod, "sync_plan_usage", AsyncMock()),
        patch.object(mod, "check_limit", AsyncMock(return_value=False)),
        patch.object(mod, "check_domain_restriction", AsyncMock(return_value=(True, None))),
        patch.object(
            mod,
            "create_invitation",
            AsyncMock(
                return_value=(
                    "tok",
                    {
                        "id": "inv-1",
                        "org_name": "Acme",
                        "inviter_name": "Ada",
                        "expires_at": "2099-01-01T00:00:00Z",
                    },
                )
            ),
        ) as create_inv,
        patch.object(
            mod,
            "send_invite_email",
            AsyncMock(return_value=MagicMock(status="sent")),
        ),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
        patch.object(mod, "log_audit_event", AsyncMock()),
    ):
        body = mod.InviteMemberRequest(email="new@example.com", role="member")
        result = await mod.send_invite(
            CLERK_PATH,
            body,
            user={"user_id": USER},
            org={"org_id": EDEN_UUID, "role": "admin"},
        )

    assert "Invitation sent" in result["message"]
    assert create_inv.await_args.kwargs["org_id"] == EDEN_UUID
    assert captured["member_check"] == EDEN_UUID


@pytest.mark.asyncio
async def test_delete_org_uses_eden_org_uuid_not_path():
    from eden.api.routes import orgs as mod

    captured: list[object] = []
    client = MagicMock()

    async def _fetchval(query: str, *args):
        _uuid_guard(args[0])
        captured.append(args[0])
        return 0

    async def _fetchrow(query: str, *args):
        _uuid_guard(args[0])
        captured.append(args[0])
        return {"id": EDEN_UUID}

    async def _execute(query: str, *args):
        _uuid_guard(args[0])
        captured.append(args[0])
        return "DELETE 1"

    client.fetchval = AsyncMock(side_effect=_fetchval)
    client.fetchrow = AsyncMock(side_effect=_fetchrow)
    client.execute = AsyncMock(side_effect=_execute)

    with (
        patch.object(
            mod,
            "require_org_owner",
            AsyncMock(return_value={"org_id": EDEN_UUID, "role": "owner"}),
        ),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        result = await mod.delete_org(
            CLERK_PATH,
            user={"user_id": USER},
            payload={"sub": USER},
        )

    assert result["org_id"] == EDEN_UUID
    assert all(a == EDEN_UUID for a in captured)
    assert CLERK_PATH not in captured
