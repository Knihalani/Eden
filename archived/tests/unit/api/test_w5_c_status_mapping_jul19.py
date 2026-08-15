"""W5-C — notifications / allowed-domains status mapping (no fake 500s)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException


@pytest.mark.asyncio
async def test_create_notification_row_none_is_409():
    from eden.api.routes import notifications as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(return_value=None)

    with (
        patch.object(mod, "eden_user_id_from_auth", AsyncMock(return_value="u1")),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        req = mod.CreateNotificationRequest(
            type="job_completed",
            title="t",
            message="m",
        )
        with pytest.raises(HTTPException) as ei:
            await mod.create_notification(req, user={"user_id": "clerk_u"})
        assert ei.value.status_code == 409


@pytest.mark.asyncio
async def test_create_notification_invalid_uuid_is_400():
    from eden.api.routes import notifications as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=Exception("invalid input syntax for type uuid: \"org_bad\"")
    )

    with (
        patch.object(mod, "eden_user_id_from_auth", AsyncMock(return_value="u1")),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        req = mod.CreateNotificationRequest(
            type="job_completed",
            title="t",
            message="m",
            org_id="org_bad",
        )
        with pytest.raises(HTTPException) as ei:
            await mod.create_notification(req, user={"user_id": "clerk_u"})
        assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_add_allowed_domain_unique_is_409():
    from eden.api.routes import orgs as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=Exception("duplicate key value violates unique constraint")
    )

    with (
        patch.object(
            mod,
            "require_org_admin",
            AsyncMock(return_value={"org_id": "00000000-0000-0000-0000-000000000001"}),
        ),
        patch.object(mod, "eden_user_id_from_auth", AsyncMock(return_value="u1")),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        req = mod.AddAllowedDomainRequest(domain="example.com")
        with pytest.raises(HTTPException) as ei:
            await mod.add_allowed_domain(
                "00000000-0000-0000-0000-000000000001",
                req,
                user={"user_id": "clerk_u"},
                payload={"sub": "clerk_u"},
            )
        assert ei.value.status_code == 409
        assert "already" in ei.value.detail.lower()


@pytest.mark.asyncio
async def test_add_allowed_domain_fk_is_400_not_500():
    from eden.api.routes import orgs as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=Exception('insert or update on table "org_allowed_domains" violates foreign key constraint')
    )

    with (
        patch.object(
            mod,
            "require_org_admin",
            AsyncMock(return_value={"org_id": "00000000-0000-0000-0000-000000000001"}),
        ),
        patch.object(mod, "eden_user_id_from_auth", AsyncMock(return_value="u1")),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        req = mod.AddAllowedDomainRequest(domain="example.com")
        with pytest.raises(HTTPException) as ei:
            await mod.add_allowed_domain(
                "00000000-0000-0000-0000-000000000001",
                req,
                user={"user_id": "clerk_u"},
                payload={"sub": "clerk_u"},
            )
        assert ei.value.status_code == 400
