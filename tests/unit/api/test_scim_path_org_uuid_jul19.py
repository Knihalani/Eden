"""W4-A: SCIM path org_id must resolve to Eden UUID before SQL."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from eden.api.routes import scim


@pytest.mark.asyncio
async def test_get_current_org_scim_resolves_clerk_path_to_eden_uuid(monkeypatch):
    captured: dict[str, str] = {}
    client = MagicMock()

    async def _fetchrow(query: str, *args):
        captured["org_id"] = args[0]
        if "scim_token_hash" in query:
            import hashlib

            token_hash = hashlib.sha256(b"tok").hexdigest()
            return {"scim_token_hash": token_hash, "scim_enabled": True}
        return {"name": "Acme"}

    client.fetchrow = AsyncMock(side_effect=_fetchrow)
    monkeypatch.setattr(scim, "get_postgres_client", AsyncMock(return_value=client))
    monkeypatch.setattr(
        scim,
        "resolve_eden_org_id",
        AsyncMock(return_value="f4dc4575-ebd5-47a2-8541-42b9e41c1148"),
    )

    ctx = await scim.get_current_org_scim(
        "org_2xClerkStylePathId999",
        authorization="Bearer tok",
    )
    assert ctx["org_id"] == "f4dc4575-ebd5-47a2-8541-42b9e41c1148"
    assert captured["org_id"] == "f4dc4575-ebd5-47a2-8541-42b9e41c1148"


@pytest.mark.asyncio
async def test_get_current_org_scim_unknown_org_is_404_not_500(monkeypatch):
    monkeypatch.setattr(scim, "resolve_eden_org_id", AsyncMock(return_value=None))
    with pytest.raises(HTTPException) as exc:
        await scim.get_current_org_scim(
            "org_missing",
            authorization="Bearer tok",
        )
    assert exc.value.status_code == 404
