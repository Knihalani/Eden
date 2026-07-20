"""Alerts path-org access: no false 404 for org creators / sync lag."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from fastapi import FastAPI

from eden.api.deps import get_current_user, resolve_path_org_access
from eden.api.routes import replay


@pytest.mark.asyncio
async def test_resolve_path_org_access_uses_get_current_org(monkeypatch):
    monkeypatch.setattr(
        "eden.api.deps.eden_user_id_from_auth",
        AsyncMock(return_value="user-eden"),
    )
    monkeypatch.setattr(
        "eden.api.deps.get_current_org",
        AsyncMock(
            return_value={
                "org_id": "f4dc4575-ebd5-47a2-8541-42b9e41c1148",
                "role": "owner",
                "name": "Mine",
                "slug": "mine",
            }
        ),
    )
    user_id, org_id = await resolve_path_org_access(
        "f4dc4575-ebd5-47a2-8541-42b9e41c1148",
        {"user_id": "user-eden"},
        {"sub": "user_clerk"},
    )
    assert user_id == "user-eden"
    assert org_id == "f4dc4575-ebd5-47a2-8541-42b9e41c1148"


@pytest.mark.asyncio
async def test_resolve_path_org_access_missing_user_is_401_not_404(monkeypatch):
    monkeypatch.setattr(
        "eden.api.deps.eden_user_id_from_auth",
        AsyncMock(return_value=None),
    )
    with pytest.raises(HTTPException) as exc:
        await resolve_path_org_access("org-1", {"user_id": "user_x"}, {})
    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_resolve_path_org_access_foreign_org_no_upsert(monkeypatch):
    """Foreign path org_id must 403 before ensure_clerk_membership."""
    from eden.api import deps as deps_mod

    payload = {
        "sub": "user_clerk_1",
        "o": {"id": "org_mine"},
        "org_id": "org_mine",
    }
    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=[
            {"id": "eden-other"},  # organizations lookup for path org
        ]
    )

    async def _resolve(oid: str | None) -> str | None:
        mapping = {"org_mine": "eden-mine", "org_other": "eden-other"}
        return mapping.get(oid or "", oid)

    monkeypatch.setattr(
        deps_mod, "eden_user_id_from_auth", AsyncMock(return_value="u1")
    )
    monkeypatch.setattr(deps_mod, "get_current_org", AsyncMock(return_value=None))
    monkeypatch.setattr(
        deps_mod, "get_postgres_client", AsyncMock(return_value=client)
    )
    monkeypatch.setattr(deps_mod, "_is_clerk_payload_public", lambda _p: True)
    monkeypatch.setattr(deps_mod, "extract_org_id", lambda _p: "org_mine")
    monkeypatch.setattr(deps_mod, "extract_org_role", lambda _p: "org:admin")
    monkeypatch.setattr(deps_mod, "resolve_eden_org_id", AsyncMock(side_effect=_resolve))
    upsert = AsyncMock()
    monkeypatch.setattr(deps_mod, "ensure_clerk_membership", upsert)

    with pytest.raises(HTTPException) as ei:
        await resolve_path_org_access("org_other", {"user_id": "u1"}, payload)

    assert ei.value.status_code == 403
    assert "does not match session organization" in str(ei.value.detail)
    upsert.assert_not_called()


@pytest.mark.asyncio
async def test_resolve_eden_org_id_does_not_cache_none_on_db_error(monkeypatch):
    from eden.api import deps as deps_mod

    deps_mod._org_id_cache.clear()
    monkeypatch.setattr(
        "eden.api.deps.get_postgres_client",
        AsyncMock(side_effect=RuntimeError("connection reset")),
    )
    result = await deps_mod.resolve_eden_org_id("org-blip")
    assert result is None
    assert "org-blip" not in deps_mod._org_id_cache


@pytest.mark.asyncio
async def test_list_alerts_returns_empty_200_for_member(monkeypatch):
    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=[
            {"total": 0},
            {"unread": 0},
        ]
    )
    client.fetch = AsyncMock(return_value=[])

    monkeypatch.setattr(replay, "get_postgres_client", AsyncMock(return_value=client))
    monkeypatch.setattr(
        replay,
        "eden_user_id_from_auth",
        AsyncMock(return_value="user-1"),
    )

    application = FastAPI()
    application.dependency_overrides[get_current_user] = lambda: {
        "user_id": "user-1",
    }
    application.dependency_overrides[replay.require_path_org_access] = (
        lambda: "org-eden-1"
    )
    application.include_router(replay.router)

    transport = ASGITransport(app=application)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        resp = await http.get("/orgs/org-eden-1/alerts")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["alerts"] == []
    assert body["total"] == 0


@pytest.mark.asyncio
async def test_list_alerts_clerk_path_uses_eden_uuid_not_500(monkeypatch):
    """Clerk-style path org_id must rewrite to Eden UUID for SQL (not 500)."""
    captured: dict[str, str] = {}
    client = MagicMock()

    async def _fetchrow(query: str, *args):
        if args:
            captured["org_id"] = args[1] if len(args) > 1 else args[0]
        return {"total": 0} if "total" in query else {"unread": 0}

    async def _fetch(query: str, *args):
        if len(args) >= 2:
            captured["org_id"] = args[1]
        return []

    client.fetchrow = AsyncMock(side_effect=_fetchrow)
    client.fetch = AsyncMock(side_effect=_fetch)

    monkeypatch.setattr(replay, "get_postgres_client", AsyncMock(return_value=client))
    monkeypatch.setattr(
        replay, "eden_user_id_from_auth", AsyncMock(return_value="user-1")
    )

    eden = "f4dc4575-ebd5-47a2-8541-42b9e41c1148"
    application = FastAPI()
    application.dependency_overrides[get_current_user] = lambda: {"user_id": "user-1"}
    application.dependency_overrides[replay.require_path_org_access] = lambda: eden
    application.include_router(replay.router)

    transport = ASGITransport(app=application)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        resp = await http.get("/orgs/org_2xClerkStylePathId999/alerts")

    assert resp.status_code == 200, resp.text
    assert captured["org_id"] == eden
