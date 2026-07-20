"""W6-A — domain-restriction SQL must use Eden UUID, not raw path org_id."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

EDEN_UUID = "f4dc4575-ebd5-47a2-8541-42b9e41c1148"
CLERK_PATH = "org_2xClerkStylePathId999"


@pytest.mark.asyncio
async def test_get_domain_restriction_uses_eden_org_uuid_not_path():
    from eden.api.routes import orgs as mod

    captured: dict[str, str] = {}
    client = MagicMock()

    async def _fetchrow(query: str, *args):
        captured["org_id"] = args[0]
        return {"domain_restriction_enforced": True}

    client.fetchrow = AsyncMock(side_effect=_fetchrow)

    with (
        patch.object(
            mod,
            "require_org_member",
            AsyncMock(return_value={"org_id": EDEN_UUID, "role": "member"}),
        ),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        result = await mod.get_domain_restriction_settings(
            CLERK_PATH,
            user={"user_id": "clerk_u"},
            payload={"sub": "clerk_u"},
        )

    assert result["domain_restriction_enforced"] is True
    assert captured["org_id"] == EDEN_UUID
    assert captured["org_id"] != CLERK_PATH


@pytest.mark.asyncio
async def test_update_domain_restriction_uses_eden_org_uuid_not_path():
    from eden.api.routes import orgs as mod

    captured: dict[str, object] = {}
    client = MagicMock()

    async def _execute(query: str, *args):
        captured["enforced"] = args[0]
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
        patch.object(mod, "log_audit_event", AsyncMock()),
    ):
        result = await mod.update_domain_restriction_settings(
            CLERK_PATH,
            mod.DomainRestrictionSettings(domain_restriction_enforced=False),
            user={"user_id": "clerk_u"},
            payload={"sub": "clerk_u"},
        )

    assert result["domain_restriction_enforced"] is False
    assert captured["org_id"] == EDEN_UUID
    assert captured["org_id"] != CLERK_PATH
    assert captured["enforced"] is False
