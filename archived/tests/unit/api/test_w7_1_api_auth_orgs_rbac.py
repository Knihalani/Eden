"""Wave 7.1 — auth/orgs/rbac/keys/scim/sso/clerk webhook status mapping.

Client/auth/validation failures → 4xx; true infra → 503; no unintended 500
and no exception-text leaks in webhook responses.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from fastapi.responses import JSONResponse

ORG = "00000000-0000-0000-0000-000000000001"
USER = "00000000-0000-0000-0000-000000000002"
ROLE = "00000000-0000-0000-0000-000000000003"


@pytest.mark.asyncio
async def test_create_org_unique_is_409():
    from eden.api.routes import orgs as mod

    client = MagicMock()
    client.fetchval = AsyncMock(return_value=0)
    client.fetchrow = AsyncMock(
        side_effect=[
            None,  # recent-duplicate idempotency check
            None,  # slug uniqueness check
            Exception("duplicate key value violates unique constraint"),
        ]
    )

    with (
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
        patch.object(mod, "eden_user_id_from_auth", AsyncMock(return_value=USER)),
        patch.object(mod, "organizations_have_is_personal", AsyncMock(return_value=True)),
        patch(
            "eden.api.utils.clerk_client.create_organization",
            AsyncMock(return_value={"id": "org_clerk_1"}),
        ),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.create_org(
                name="Acme",
                user={"user_id": USER},
            )
        assert ei.value.status_code == 409


@pytest.mark.asyncio
async def test_create_org_other_db_error_is_503_not_500():
    from eden.api.routes import orgs as mod

    client = MagicMock()
    client.fetchval = AsyncMock(return_value=0)
    client.fetchrow = AsyncMock(
        side_effect=[
            None,  # recent-duplicate idempotency check
            None,  # slug uniqueness check
            Exception("connection refused"),
        ]
    )

    with (
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
        patch.object(mod, "eden_user_id_from_auth", AsyncMock(return_value=USER)),
        patch.object(mod, "organizations_have_is_personal", AsyncMock(return_value=True)),
        patch(
            "eden.api.utils.clerk_client.create_organization",
            AsyncMock(return_value={"id": "org_clerk_1"}),
        ),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.create_org(
                name="Acme",
                user={"user_id": USER},
            )
        assert ei.value.status_code == 503
        assert ei.value.status_code != 500


@pytest.mark.asyncio
async def test_signup_unique_race_is_202_not_500():
    from eden.api.routes import auth as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=[
            None,  # existing email check
            Exception("duplicate key value violates unique constraint users_email_key"),
        ]
    )

    req = mod.SignupRequest(
        email="race@example.com",
        password="Str0ng!Passw0rd",
        name="Race",
    )
    http_req = MagicMock()
    http_req.client = MagicMock(host="127.0.0.1")
    http_req.headers = {}

    with (
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
        patch.object(mod, "hash_password", return_value="hashed"),
        patch.object(mod, "_check_rate_limit", AsyncMock(return_value=None)),
        patch.object(mod, "validate_password_strength", return_value=None),
        patch.object(mod, "_client_ip", return_value="127.0.0.1"),
    ):
        result = await mod.signup(req, MagicMock(), http_req)
        assert isinstance(result, JSONResponse)
        assert result.status_code == 202


@pytest.mark.asyncio
async def test_signup_db_blip_is_503_not_500():
    from eden.api.routes import auth as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=[
            None,
            Exception("server closed the connection unexpectedly"),
        ]
    )

    req = mod.SignupRequest(
        email="blip@example.com",
        password="Str0ng!Passw0rd",
        name="Blip",
    )
    http_req = MagicMock()
    http_req.client = MagicMock(host="127.0.0.1")
    http_req.headers = {}

    with (
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
        patch.object(mod, "hash_password", return_value="hashed"),
        patch.object(mod, "_check_rate_limit", AsyncMock(return_value=None)),
        patch.object(mod, "validate_password_strength", return_value=None),
        patch.object(mod, "_client_ip", return_value="127.0.0.1"),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.signup(req, MagicMock(), http_req)
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_create_assignment_fk_is_404_not_500():
    from eden.api.routes import rbac as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=[
            {
                "id": ROLE,
                "org_id": ORG,
                "name": "analyst",
                "base_role": "member",
                "description": None,
                "created_at": MagicMock(isoformat=lambda: "2026-01-01T00:00:00"),
            },
            Exception(
                'insert or update on table "role_assignments" violates foreign key constraint'
            ),
        ]
    )
    member = MagicMock()
    member.role = "admin"
    member.user_id = USER

    with patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)):
        req = mod.AssignmentCreateRequest(user_id=USER)
        with pytest.raises(HTTPException) as ei:
            await mod.create_assignment(
                org_id=ORG,
                role_id=ROLE,
                req=req,
                member=member,
            )
        assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_create_assignment_unique_is_409():
    from eden.api.routes import rbac as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=[
            {
                "id": ROLE,
                "org_id": ORG,
                "name": "analyst",
                "base_role": "member",
                "description": None,
                "created_at": MagicMock(isoformat=lambda: "2026-01-01T00:00:00"),
            },
            Exception("duplicate key value violates unique constraint"),
        ]
    )
    member = MagicMock()
    member.role = "owner"
    member.user_id = USER

    with patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)):
        req = mod.AssignmentCreateRequest(user_id=USER)
        with pytest.raises(HTTPException) as ei:
            await mod.create_assignment(
                org_id=ORG,
                role_id=ROLE,
                req=req,
                member=member,
            )
        assert ei.value.status_code == 409


@pytest.mark.asyncio
async def test_clerk_webhook_handler_infra_is_503_no_leak():
    from eden.api.routes import clerk_webhooks as mod

    body = b'{"type":"user.created","data":{"id":"user_1"}}'
    request = MagicMock()
    request.body = AsyncMock(return_value=body)
    request.json = AsyncMock(return_value={"type": "user.created", "data": {"id": "user_1"}})

    with (
        patch.object(mod, "_settings") as settings_mock,
        patch.object(mod, "settings") as settings_alias,
        patch.object(mod, "_verify_svix_signature", return_value=True),
        patch.object(
            mod,
            "_upsert_user",
            AsyncMock(side_effect=Exception("relation users does not exist")),
        ),
    ):
        settings_mock.clerk_webhook_signing_secret = "whsec_test"
        settings_alias.clerk_webhook_signing_secret = "whsec_test"
        with pytest.raises(HTTPException) as ei:
            await mod.clerk_webhook(
                request,
                svix_id="msg_1",
                svix_timestamp="1",
                svix_signature="v1,abc",
            )
        assert ei.value.status_code == 503
        assert "relation" not in str(ei.value.detail).lower()
        assert "users" not in str(ei.value.detail).lower()


@pytest.mark.asyncio
async def test_clerk_webhook_bad_payload_is_400():
    from eden.api.routes import clerk_webhooks as mod

    body = b'{"type":"user.created","data":{}}'
    request = MagicMock()
    request.body = AsyncMock(return_value=body)
    request.json = AsyncMock(return_value={"type": "user.created", "data": {}})

    with (
        patch.object(mod, "_settings") as settings_mock,
        patch.object(mod, "settings") as settings_alias,
        patch.object(mod, "_verify_svix_signature", return_value=True),
        patch.object(
            mod,
            "_upsert_user",
            AsyncMock(side_effect=ValueError("missing email_addresses")),
        ),
    ):
        settings_mock.clerk_webhook_signing_secret = "whsec_test"
        settings_alias.clerk_webhook_signing_secret = "whsec_test"
        with pytest.raises(HTTPException) as ei:
            await mod.clerk_webhook(
                request,
                svix_id="msg_1",
                svix_timestamp="1",
                svix_signature="v1,abc",
            )
        assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_scim_get_or_create_user_unique_race_returns_existing():
    from eden.api.routes import scim as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=[
            None,  # initial email lookup miss
            {"id": USER},  # race re-fetch
        ]
    )
    client.execute = AsyncMock(
        side_effect=Exception("duplicate key value violates unique constraint")
    )

    uid = await mod._get_or_create_user(client, "a@example.com", "A", "B")
    assert uid == USER


@pytest.mark.asyncio
async def test_scim_sync_user_fk_is_404():
    from eden.api.routes import scim as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(return_value=None)
    client.execute = AsyncMock(
        side_effect=Exception(
            'insert or update on table "scim_users" violates foreign key constraint'
        )
    )

    with pytest.raises(HTTPException) as ei:
        await mod._sync_user_to_org(
            client,
            ORG,
            USER,
            "ext-1",
            "Display",
            True,
        )
    assert ei.value.status_code == 404
