"""W7-A — 2FA SQL must use Eden UUID, not raw path org_id."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

EDEN_UUID = "f4dc4575-ebd5-47a2-8541-42b9e41c1148"
CLERK_PATH = "org_2xClerkStylePathId999"


@pytest.mark.asyncio
async def test_get_2fa_enforcement_status_uses_eden_org_uuid_not_path():
    from eden.api.routes import orgs as mod

    captured: dict[str, str] = {}
    client = MagicMock()

    async def _fetchrow(query: str, *args):
        captured["org_id"] = args[0]
        return {"two_factor_enforced": True}

    client.fetchrow = AsyncMock(side_effect=_fetchrow)

    with (
        patch.object(
            mod,
            "require_org_admin",
            AsyncMock(return_value={"org_id": EDEN_UUID, "role": "admin"}),
        ),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        result = await mod.get_2fa_enforcement_status(
            CLERK_PATH,
            user={"user_id": "clerk_u"},
            payload={"sub": "clerk_u"},
        )

    assert result["two_factor_enforced"] is True
    assert captured["org_id"] == EDEN_UUID
    assert captured["org_id"] != CLERK_PATH


@pytest.mark.asyncio
async def test_enforce_org_2fa_uses_eden_org_uuid_not_path():
    from eden.api.routes import orgs as mod

    captured: dict[str, object] = {}
    client = MagicMock()

    async def _execute(query: str, *args):
        captured["enforce"] = args[0]
        captured["org_id"] = args[1]
        return "UPDATE 1"

    client.execute = AsyncMock(side_effect=_execute)

    with (
        patch.object(
            mod,
            "require_org_admin",
            AsyncMock(return_value={"org_id": EDEN_UUID, "role": "admin"}),
        ),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
        patch.object(mod, "log_audit_event", AsyncMock()) as audit,
    ):
        result = await mod.enforce_org_2fa(
            CLERK_PATH,
            mod.EnforceTwoFARequest(enforce=True),
            user={"user_id": "clerk_u"},
            payload={"sub": "clerk_u"},
        )

    assert result["two_factor_enforced"] is True
    assert captured["org_id"] == EDEN_UUID
    assert captured["org_id"] != CLERK_PATH
    assert captured["enforce"] is True
    assert audit.await_args.kwargs["org_id"] == EDEN_UUID
    assert audit.await_args.kwargs["target_id"] == EDEN_UUID


@pytest.mark.asyncio
async def test_get_org_members_2fa_status_uses_eden_org_uuid_not_path():
    from eden.api.routes import orgs as mod

    captured: dict[str, str] = {}
    client = MagicMock()
    joined = datetime(2026, 1, 1, tzinfo=timezone.utc)

    async def _fetch(query: str, *args):
        captured["org_id"] = args[0]
        return [
            {
                "id": "user-1",
                "email": "a@example.com",
                "name": "A",
                "two_factor_enabled": True,
                "joined_at": joined,
                "last_active_at": None,
            }
        ]

    client.fetch = AsyncMock(side_effect=_fetch)

    with (
        patch.object(
            mod,
            "require_org_admin",
            AsyncMock(return_value={"org_id": EDEN_UUID, "role": "admin"}),
        ),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        result = await mod.get_org_members_2fa_status(
            CLERK_PATH,
            user={"user_id": "clerk_u"},
            payload={"sub": "clerk_u"},
        )

    assert len(result) == 1
    assert result[0]["two_factor_enabled"] is True
    assert captured["org_id"] == EDEN_UUID
    assert captured["org_id"] != CLERK_PATH
