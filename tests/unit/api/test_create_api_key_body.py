"""CreateApiKeyBody / empty-body tolerance for portal create 422s."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from starlette.requests import Request


def test_create_api_key_body_defaults_when_empty_or_partial() -> None:
    from eden.api.routes.api_keys import CreateApiKeyBody, _DEFAULT_CREATE_SCOPES

    empty = CreateApiKeyBody.model_validate({})
    assert empty.name == "SDK"
    assert empty.scopes == _DEFAULT_CREATE_SCOPES

    no_scopes = CreateApiKeyBody.model_validate({"name": "prod"})
    assert no_scopes.name == "prod"
    assert no_scopes.scopes == _DEFAULT_CREATE_SCOPES

    empty_scopes = CreateApiKeyBody.model_validate({"name": "x", "scopes": []})
    assert empty_scopes.name == "SDK"  # too-short name coerced
    assert empty_scopes.scopes == _DEFAULT_CREATE_SCOPES

    singular = CreateApiKeyBody.model_validate(
        {"name": "CI", "scope": ["ingest:write"]},
    )
    assert singular.scopes == ["ingest:write"]


@pytest.mark.asyncio
async def test_parse_create_api_key_body_accepts_empty_raw() -> None:
    from eden.api.routes.api_keys import (
        CreateApiKeyBody,
        _DEFAULT_CREATE_SCOPES,
        _parse_create_api_key_body,
    )

    async def empty_receive() -> dict:
        return {"type": "http.request", "body": b"", "more_body": False}

    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/orgs/o/api-keys",
            "headers": [(b"content-type", b"application/json")],
        },
        empty_receive,
    )
    body = await _parse_create_api_key_body(request)
    assert isinstance(body, CreateApiKeyBody)
    assert body.name == "SDK"
    assert body.scopes == _DEFAULT_CREATE_SCOPES


@pytest.mark.asyncio
async def test_parse_create_api_key_body_accepts_partial_json() -> None:
    from eden.api.routes.api_keys import _DEFAULT_CREATE_SCOPES, _parse_create_api_key_body

    raw = b'{"name":"Quickstart"}'

    async def receive() -> dict:
        return {"type": "http.request", "body": raw, "more_body": False}

    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/orgs/o/api-keys",
            "headers": [(b"content-type", b"application/json")],
        },
        receive,
    )
    body = await _parse_create_api_key_body(request)
    assert body.name == "Quickstart"
    assert body.scopes == _DEFAULT_CREATE_SCOPES


@pytest.mark.asyncio
async def test_create_api_key_from_body_inserts_with_defaults() -> None:
    from unittest.mock import patch

    from eden.api.routes import api_keys as mod

    client = MagicMock()
    client.execute = AsyncMock(return_value="INSERT 0 1")

    with (
        patch.object(mod, "require_org_admin", AsyncMock(return_value=None)),
        patch.object(mod, "_check_api_key_create_rate_limit", AsyncMock(return_value=None)),
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
        patch.object(mod, "log_audit_event", AsyncMock(return_value=None)),
    ):
        result = await mod.create_api_key_from_body(
            org_id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            body=mod.CreateApiKeyBody(),
            user={"user_id": "user_clerk_1"},
            payload={"sub": "user_clerk_1"},
        )

    assert result["name"] == "SDK"
    assert result["scopes"] == mod._DEFAULT_CREATE_SCOPES
    assert result["raw_key"].startswith("eden_api_key_")
    assert client.execute.await_count == 1
