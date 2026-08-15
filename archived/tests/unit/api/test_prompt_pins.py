"""Unit tests for prompt env pins / deploy / rollback routes."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException


def test_normalize_env_maps_production_to_prod() -> None:
    from eden.prompts.deploy import normalize_env

    assert normalize_env("production") == "prod"
    assert normalize_env("Production") == "prod"
    assert normalize_env("prod") == "prod"
    assert normalize_env("staging") == "staging"
    assert normalize_env("dev") == "dev"
    assert normalize_env(None) == ""


@pytest.mark.asyncio
async def test_get_pins_shapes_canonical_keys() -> None:
    from eden.api.routes import prompts_v2 as mod

    envs = [
        {"env": "dev", "version": 1, "prompt_name": "summarise"},
        {"env": "production", "version": 4, "prompt_name": "summarise"},
        {"env": "staging", "version": 2, "prompt_name": "summarise"},
    ]
    svc = AsyncMock()
    svc.list_environments = AsyncMock(return_value=envs)

    with patch.object(mod, "PromptDeployService", return_value=svc):
        result = await mod.get_pins(org_id="org-1", name="summarise")

    assert result["pins"] == {"dev": 1, "prod": 4, "staging": 2}
    assert result["environments"] == envs
    svc.list_environments.assert_awaited_once_with("org-1", "summarise")


@pytest.mark.asyncio
async def test_put_pin_normalizes_production_and_deploys() -> None:
    from eden.api.routes import prompts_v2 as mod

    svc = AsyncMock()
    svc.deploy = AsyncMock(
        return_value={"prompt_name": "summarise", "env": "prod", "version": 3}
    )

    with patch.object(mod, "PromptDeployService", return_value=svc):
        result = await mod.put_pin(
            org_id="org-1",
            name="summarise",
            env="production",
            body=mod.PinEnvRequest(version=3),
            user={"user_id": "user-9"},
        )

    assert result["status"] == "ok"
    assert result["data"]["env"] == "prod"
    svc.deploy.assert_awaited_once_with(
        "org-1",
        prompt_name="summarise",
        env="prod",
        version=3,
        deployed_by="user-9",
    )


@pytest.mark.asyncio
async def test_put_pin_rejects_unknown_env() -> None:
    from eden.api.routes import prompts_v2 as mod

    with pytest.raises(HTTPException) as ei:
        await mod.put_pin(
            org_id="org-1",
            name="summarise",
            env="qa",
            body=mod.PinEnvRequest(version=1),
            user={"user_id": "u"},
        )
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_rollback_defaults_to_prod_and_calls_service() -> None:
    from eden.api.routes import prompts_v2 as mod

    svc = AsyncMock()
    svc.rollback = AsyncMock(
        return_value={
            "prompt_name": "summarise",
            "env": "prod",
            "version": 2,
            "rolled_back_from": 3,
        }
    )

    with patch.object(mod, "PromptDeployService", return_value=svc):
        result = await mod.rollback_pin(
            org_id="org-1",
            name="summarise",
            body=None,
            user={"user_id": "user-1"},
        )

    assert result["data"]["version"] == 2
    svc.rollback.assert_awaited_once_with(
        "org-1",
        prompt_name="summarise",
        env="prod",
        deployed_by="user-1",
    )


@pytest.mark.asyncio
async def test_rollback_maps_value_error_to_400() -> None:
    from eden.api.routes import prompts_v2 as mod

    svc = AsyncMock()
    svc.rollback = AsyncMock(side_effect=ValueError("No previous version"))

    with patch.object(mod, "PromptDeployService", return_value=svc):
        with pytest.raises(HTTPException) as ei:
            await mod.rollback_pin(
                org_id="org-1",
                name="summarise",
                body=mod.RollbackRequest(env="prod"),
                user={"user_id": "u"},
            )
    assert ei.value.status_code == 400
    assert "No previous version" in str(ei.value.detail)


@pytest.mark.asyncio
async def test_deploy_service_normalize_on_deploy_call() -> None:
    """PromptDeployService.deploy stores canonical env (production → prod)."""
    from eden.prompts.deploy import PromptDeployService

    svc = PromptDeployService()
    client = AsyncMock()
    client.execute = AsyncMock()
    client.fetchrow = AsyncMock(return_value=None)

    with (
        patch.object(svc, "_client", AsyncMock(return_value=client)),
        patch.object(svc, "resolve", AsyncMock(return_value=None)),
        patch.object(svc, "_reload_gateway_filter", AsyncMock()),
    ):
        result = await svc.deploy(
            "org-1",
            prompt_name="p",
            env="production",
            version=5,
            deployed_by="u",
        )

    assert result == {"prompt_name": "p", "env": "prod", "version": 5}
    # First execute is the pin INSERT — uses normalized env.
    insert_args = client.execute.await_args_list[0].args
    assert insert_args[3] == "prod"
