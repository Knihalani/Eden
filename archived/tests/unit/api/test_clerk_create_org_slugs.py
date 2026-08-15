"""Clerk create_organization must tolerate instances with slugs disabled."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from eden.api.utils.clerk_client import ClerkAPIError, create_organization


@pytest.mark.asyncio
async def test_create_organization_retries_without_slug_when_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict] = []

    async def _post(_path: str, body: dict, **_kwargs):
        calls.append(dict(body))
        if "slug" in body:
            raise ClerkAPIError(
                "Clerk 403 on /organizations: "
                '{"errors":[{"code":"organization_slugs_disabled",'
                '"message":"organization slugs not enabled"}]}'
            )
        return {"id": "org_retry_ok", "name": body["name"]}

    monkeypatch.setattr(
        "eden.api.utils.clerk_client._post",
        AsyncMock(side_effect=_post),
    )

    result = await create_organization("My workspace", slug="my-workspace")
    assert result["id"] == "org_retry_ok"
    assert calls == [
        {"name": "My workspace", "slug": "my-workspace"},
        {"name": "My workspace"},
    ]


@pytest.mark.asyncio
async def test_create_organization_omits_slug_when_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[dict] = []

    async def _post(_path: str, body: dict, **_kwargs):
        seen.append(dict(body))
        return {"id": "org_noslug"}

    monkeypatch.setattr(
        "eden.api.utils.clerk_client._post",
        AsyncMock(side_effect=_post),
    )

    result = await create_organization("Solo", slug=None)
    assert result["id"] == "org_noslug"
    assert seen == [{"name": "Solo"}]


@pytest.mark.asyncio
async def test_create_organization_reraises_other_clerk_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _post(_path: str, body: dict, **_kwargs):
        raise ClerkAPIError("Clerk 401 on /organizations: unauthorized")

    monkeypatch.setattr(
        "eden.api.utils.clerk_client._post",
        AsyncMock(side_effect=_post),
    )

    with pytest.raises(ClerkAPIError, match="401"):
        await create_organization("X", slug="x")
