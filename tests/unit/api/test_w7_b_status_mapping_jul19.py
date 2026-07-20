"""W7-B — more FastAPI create/update status mapping (no unintended 500s).

Continues W5-C/W6-C pattern: unique → 409, missing FK → 404, bad UUID → 400,
other DB failures → 503.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException


ORG = "00000000-0000-0000-0000-000000000001"
USER = "00000000-0000-0000-0000-000000000002"


@pytest.mark.asyncio
async def test_put_pii_policy_unique_is_409():
    from eden.api.routes import pii_policy as mod

    client = MagicMock()
    client.execute = AsyncMock(
        side_effect=Exception("duplicate key value violates unique constraint")
    )

    with (
        patch.object(mod, "require_org_permission", AsyncMock(return_value=None)),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        body = mod.PIIPolicyIn(mode="redact", enabled_categories=["email"])
        with pytest.raises(HTTPException) as ei:
            await mod.put_pii_policy(
                body=body,
                org_id=ORG,
                user={"user_id": USER},
                payload={"sub": USER},
            )
        assert ei.value.status_code == 409


@pytest.mark.asyncio
async def test_put_pii_policy_fk_is_404():
    from eden.api.routes import pii_policy as mod

    client = MagicMock()
    client.execute = AsyncMock(
        side_effect=Exception(
            'insert or update on table "org_pii_policies" violates foreign key constraint'
        )
    )

    with (
        patch.object(mod, "require_org_permission", AsyncMock(return_value=None)),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        body = mod.PIIPolicyIn(mode="redact", enabled_categories=["email"])
        with pytest.raises(HTTPException) as ei:
            await mod.put_pii_policy(
                body=body,
                org_id=ORG,
                user={"user_id": USER},
                payload={"sub": USER},
            )
        assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_put_pii_policy_bad_uuid_is_400():
    from eden.api.routes import pii_policy as mod

    client = MagicMock()
    client.execute = AsyncMock(
        side_effect=Exception('invalid input syntax for type uuid: "org_bad"')
    )

    with (
        patch.object(mod, "require_org_permission", AsyncMock(return_value=None)),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        body = mod.PIIPolicyIn(mode="redact", enabled_categories=["email"])
        with pytest.raises(HTTPException) as ei:
            await mod.put_pii_policy(
                body=body,
                org_id="org_bad",
                user={"user_id": USER},
                payload={"sub": USER},
            )
        assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_put_region_fk_is_404_not_500():
    from eden.api.routes import region as mod

    client = MagicMock()
    client.execute = AsyncMock(
        side_effect=Exception(
            'insert or update on table "organizations" violates foreign key constraint'
        )
    )

    with (
        patch.object(mod, "require_org_permission", AsyncMock(return_value=None)),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.put_region(
                body=mod.RegionIn(region="us"),
                org_id=ORG,
                user={"user_id": USER},
                payload={"sub": USER},
            )
        assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_put_region_other_db_error_is_503():
    from eden.api.routes import region as mod

    client = MagicMock()
    client.execute = AsyncMock(
        side_effect=Exception("connection reset by peer")
    )

    with (
        patch.object(mod, "require_org_permission", AsyncMock(return_value=None)),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.put_region(
                body=mod.RegionIn(region="us"),
                org_id=ORG,
                user={"user_id": USER},
                payload={"sub": USER},
            )
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_create_canary_fk_is_404():
    from eden.api.routes import prompt_canary as mod

    client = MagicMock()
    client.execute = AsyncMock(
        side_effect=Exception(
            'insert or update on table "prompt_canary_experiments" '
            "violates foreign key constraint"
        )
    )

    with (
        patch(
            "eden.evaluation.regression_runner.RegressionRunner.require_pass_for_canary",
            AsyncMock(return_value=None),
        ),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        body = mod.CanaryCreateRequest(candidate_version=2, traffic_pct=5)
        with pytest.raises(HTTPException) as ei:
            await mod.create_canary(
                org_id=ORG,
                agent="planner",
                body=body,
                user={"user_id": USER},
            )
        assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_create_canary_unique_is_409():
    from eden.api.routes import prompt_canary as mod

    client = MagicMock()
    client.execute = AsyncMock(
        side_effect=Exception("duplicate key value violates unique constraint")
    )

    with (
        patch(
            "eden.evaluation.regression_runner.RegressionRunner.require_pass_for_canary",
            AsyncMock(return_value=None),
        ),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        body = mod.CanaryCreateRequest(candidate_version=2, traffic_pct=5)
        with pytest.raises(HTTPException) as ei:
            await mod.create_canary(
                org_id=ORG,
                agent="planner",
                body=body,
                user={"user_id": USER},
            )
        assert ei.value.status_code == 409


@pytest.mark.asyncio
async def test_create_canary_other_db_error_is_503():
    from eden.api.routes import prompt_canary as mod

    client = MagicMock()
    client.execute = AsyncMock(side_effect=Exception("server closed the connection"))

    with (
        patch(
            "eden.evaluation.regression_runner.RegressionRunner.require_pass_for_canary",
            AsyncMock(return_value=None),
        ),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
    ):
        body = mod.CanaryCreateRequest(candidate_version=2, traffic_pct=5)
        with pytest.raises(HTTPException) as ei:
            await mod.create_canary(
                org_id=ORG,
                agent="planner",
                body=body,
                user={"user_id": USER},
            )
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_patch_slack_settings_fk_is_404():
    from eden.api.routes import integrations_status as mod

    client = MagicMock()
    client.execute = AsyncMock(
        side_effect=Exception(
            'insert or update on table "org_integrations" violates foreign key constraint'
        )
    )

    with (
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
        patch.object(mod, "_load_slack_config", AsyncMock(return_value={})),
    ):
        body = mod.SlackSettingsIn(webhook_url="https://hooks.slack.com/services/x", enabled=True)
        with pytest.raises(HTTPException) as ei:
            await mod.patch_slack_settings(org_id=ORG, body=body)
        assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_patch_slack_settings_other_db_error_is_503():
    from eden.api.routes import integrations_status as mod

    client = MagicMock()
    client.execute = AsyncMock(side_effect=Exception("disk I/O error"))

    with (
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
        patch.object(mod, "_load_slack_config", AsyncMock(return_value={})),
    ):
        body = mod.SlackSettingsIn(enabled=False)
        with pytest.raises(HTTPException) as ei:
            await mod.patch_slack_settings(org_id=ORG, body=body)
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_create_destination_fk_is_404():
    from eden.api.routes import export_destinations as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=Exception(
            'insert or update on table "export_destinations" violates foreign key constraint'
        )
    )

    with (
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
        patch.object(mod, "encrypt_value", return_value="enc"),
    ):
        body = mod.DestinationIn(
            name="archive",
            type="s3",
            config={"bucket": "b", "region": "us-east-1"},
            credentials={"access_key_id": "A", "secret_access_key": "S"},
        )
        with pytest.raises(HTTPException) as ei:
            await mod.create_destination(
                body=body,
                org_id=ORG,
                member={"user_id": USER},
                _admin={},
            )
        assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_create_destination_bad_uuid_is_400():
    from eden.api.routes import export_destinations as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=Exception('invalid input syntax for type uuid: "org_bad"')
    )

    with (
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
        patch.object(mod, "encrypt_value", return_value="enc"),
    ):
        body = mod.DestinationIn(
            name="archive",
            type="s3",
            config={"bucket": "b", "region": "us-east-1"},
            credentials={"access_key_id": "A", "secret_access_key": "S"},
        )
        with pytest.raises(HTTPException) as ei:
            await mod.create_destination(
                body=body,
                org_id="org_bad",
                member={"user_id": USER},
                _admin={},
            )
        assert ei.value.status_code == 400
