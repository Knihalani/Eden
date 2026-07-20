"""W6-C — more FastAPI create-route status mapping (no unintended 500s).

Continues W5-C pattern: unique → 409, missing FK → 404, bad UUID → 400,
other DB failures → 503.
"""

from __future__ import annotations

from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException


ORG = "00000000-0000-0000-0000-000000000001"
USER = "00000000-0000-0000-0000-000000000002"


@pytest.mark.asyncio
async def test_create_sso_provider_unique_is_409():
    from eden.api.routes import sso as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=Exception("duplicate key value violates unique constraint")
    )

    with (
        patch.object(mod, "require_org_admin", AsyncMock(return_value=None)),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        cfg = mod.SSOProviderConfig(provider_type="oidc", name="Okta")
        with pytest.raises(HTTPException) as ei:
            await mod.create_sso_provider(
                cfg,
                org_id=ORG,
                user={"user_id": USER},
                payload={"sub": USER},
            )
        assert ei.value.status_code == 409


@pytest.mark.asyncio
async def test_create_sso_provider_fk_is_404():
    from eden.api.routes import sso as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=Exception(
            'insert or update on table "org_sso_providers" violates foreign key constraint'
        )
    )

    with (
        patch.object(mod, "require_org_admin", AsyncMock(return_value=None)),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        cfg = mod.SSOProviderConfig(provider_type="oidc", name="Okta")
        with pytest.raises(HTTPException) as ei:
            await mod.create_sso_provider(
                cfg,
                org_id=ORG,
                user={"user_id": USER},
                payload={"sub": USER},
            )
        assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_create_sso_provider_bad_uuid_is_400():
    from eden.api.routes import sso as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=Exception('invalid input syntax for type uuid: "org_bad"')
    )

    with (
        patch.object(mod, "require_org_admin", AsyncMock(return_value=None)),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        cfg = mod.SSOProviderConfig(provider_type="oidc", name="Okta")
        with pytest.raises(HTTPException) as ei:
            await mod.create_sso_provider(
                cfg,
                org_id="org_bad",
                user={"user_id": USER},
                payload={"sub": USER},
            )
        assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_create_api_key_unique_is_409():
    from eden.api.routes import api_keys as mod

    client = MagicMock()
    client.execute = AsyncMock(
        side_effect=Exception("duplicate key value violates unique constraint")
    )

    with (
        patch.object(mod, "require_org_admin", AsyncMock(return_value=None)),
        patch.object(mod, "_check_api_key_create_rate_limit", AsyncMock(return_value=None)),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        body = mod.CreateApiKeyBody(name="ci-key", scopes=["ingest:write"])
        with pytest.raises(HTTPException) as ei:
            await mod.create_api_key(
                org_id=ORG,
                body=body,
                user={"user_id": USER},
                payload={"sub": USER},
            )
        assert ei.value.status_code == 409


@pytest.mark.asyncio
async def test_create_api_key_fk_is_404():
    from eden.api.routes import api_keys as mod

    client = MagicMock()
    client.execute = AsyncMock(
        side_effect=Exception(
            'insert or update on table "org_api_keys" violates foreign key constraint'
        )
    )

    with (
        patch.object(mod, "require_org_admin", AsyncMock(return_value=None)),
        patch.object(mod, "_check_api_key_create_rate_limit", AsyncMock(return_value=None)),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        body = mod.CreateApiKeyBody(name="ci-key", scopes=["ingest:write"])
        with pytest.raises(HTTPException) as ei:
            await mod.create_api_key(
                org_id=ORG,
                body=body,
                user={"user_id": USER},
                payload={"sub": USER},
            )
        assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_create_role_fk_is_404_not_500():
    from eden.api.routes import rbac as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=Exception(
            'insert or update on table "role_definitions" violates foreign key constraint'
        )
    )
    member = MagicMock()
    member.role = "admin"

    with patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)):
        req = mod.RoleCreateRequest(name="analyst", base_role="member")
        with pytest.raises(HTTPException) as ei:
            await mod.create_role(org_id=ORG, req=req, member=member)
        assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_create_role_bad_uuid_is_400():
    from eden.api.routes import rbac as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=Exception('invalid input syntax for type uuid: "org_bad"')
    )
    member = MagicMock()
    member.role = "owner"

    with patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)):
        req = mod.RoleCreateRequest(name="analyst", base_role="member")
        with pytest.raises(HTTPException) as ei:
            await mod.create_role(org_id="org_bad", req=req, member=member)
        assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_create_cost_override_fk_is_404():
    from eden.api.routes import cost_overrides as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=Exception(
            'insert or update on table "org_cost_overrides" violates foreign key constraint'
        )
    )

    with patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)):
        body = mod.CostOverrideIn(
            provider="openai",
            model_id="gpt-4o",
            cost_per_1k_input=Decimal("0.01"),
            cost_per_1k_output=Decimal("0.03"),
        )
        with pytest.raises(HTTPException) as ei:
            await mod.create_cost_override(
                body=body,
                org_id=ORG,
                user={"user_id": USER},
            )
        assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_create_cost_override_bad_user_uuid_is_400():
    from eden.api.routes import cost_overrides as mod

    client = MagicMock()
    client.fetchrow = AsyncMock()

    with patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)):
        body = mod.CostOverrideIn(
            provider="openai",
            model_id="gpt-4o",
            cost_per_1k_input=Decimal("0.01"),
            cost_per_1k_output=Decimal("0.03"),
        )
        with pytest.raises(HTTPException) as ei:
            await mod.create_cost_override(
                body=body,
                org_id=ORG,
                user={"user_id": "not-a-uuid"},
            )
        assert ei.value.status_code == 400
        client.fetchrow.assert_not_called()


@pytest.mark.asyncio
async def test_upload_reference_unique_is_409():
    from eden.api.routes import references as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=Exception("duplicate key value violates unique constraint")
    )
    upload = MagicMock()
    upload.filename = "patterns.py"
    upload.read = AsyncMock(return_value=b"def hello():\n    return 1\n")

    with (
        patch.object(mod, "check_limit", AsyncMock(return_value=False)),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
        patch.object(mod, "generate_embedding", AsyncMock(return_value=[0.0] * 8)),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.upload_reference(
                org_id=ORG,
                name="Auth patterns",
                purpose="auth",
                description=None,
                file=upload,
                user={"user_id": USER},
                _check_references_upload={},
            )
        assert ei.value.status_code == 409


@pytest.mark.asyncio
async def test_put_retention_policy_fk_is_404_not_500():
    from eden.api.routes import retention_policy as mod

    client = MagicMock()
    client.execute = AsyncMock(
        side_effect=Exception(
            'insert or update on table "org_retention_policies" violates foreign key constraint'
        )
    )

    with (
        patch.object(mod, "require_org_permission", AsyncMock(return_value=None)),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        body = mod.RetentionPolicyIn(
            table_name="telemetry_events",
            hot_days=7,
            warm_days=30,
            cold_days=90,
            delete_days=365,
        )
        with pytest.raises(HTTPException) as ei:
            await mod.put_retention_policy(
                body=body,
                org_id=ORG,
                user={"user_id": USER},
                payload={"sub": USER},
            )
        assert ei.value.status_code == 404
