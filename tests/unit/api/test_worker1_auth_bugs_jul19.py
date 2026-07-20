"""Worker-1 Jul 19: auth/deps/org/middleware regression tests.

Covers bugs found in scoped API auth surface:
- require_org_owner must be owner-only (not admin)
- get_optional_org must not pass cookie string as JWT payload
- orgs invite accept/decline invitee+path checks (IDOR)
- mcp_keys path-scoped admin (IDOR via Header-only Depends)
- tenant_rate_limit Clerk Bearer org resolution
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from fastapi.params import Depends as DependsParam
from starlette.requests import Request

from eden.api.deps import (
    get_current_org,
    get_optional_org,
    require_org_member,
    require_org_owner,
)
from eden.api.routes.mcp_keys import list_mcp_keys
from eden.api.routes.orgs import _assert_invitation_for_caller


@pytest.mark.asyncio
async def test_require_org_owner_rejects_admin_role(monkeypatch):
    """Eden ``admin`` must not satisfy owner-only gates (delete org, etc.)."""
    monkeypatch.setattr(
        "eden.api.deps.get_current_org",
        AsyncMock(
            return_value={
                "org_id": "org-1",
                "role": "admin",
                "name": "Org",
                "slug": "org",
            }
        ),
    )
    with pytest.raises(HTTPException) as exc_info:
        await require_org_owner("org-1", {"sub": "u1"})
    assert exc_info.value.status_code == 403
    assert "Owner" in exc_info.value.detail


@pytest.mark.asyncio
async def test_require_org_owner_allows_owner_role(monkeypatch):
    monkeypatch.setattr(
        "eden.api.deps.get_current_org",
        AsyncMock(
            return_value={
                "org_id": "org-1",
                "role": "owner",
                "name": "Org",
                "slug": "org",
            }
        ),
    )
    org = await require_org_owner("org-1", {"sub": "u1"})
    assert org["role"] == "owner"


@pytest.mark.asyncio
async def test_require_org_owner_bare_await_is_403_not_500():
    """Unresolved Depends payload → 403, never AttributeError."""
    sentinel = DependsParam(lambda: None)
    with pytest.raises(HTTPException) as exc_info:
        await require_org_owner("org-1", sentinel)  # type: ignore[arg-type]
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_get_optional_org_rejects_raw_cookie_string(monkeypatch):
    """Passing a cookie string as payload must not 500 or unlock auth."""
    called = {"get_current_org": False}

    async def _boom(*_a, **_k):
        called["get_current_org"] = True
        raise AssertionError("get_current_org must not run on non-dict payload")

    monkeypatch.setattr("eden.api.deps.get_current_org", _boom)
    # Simulate the old footgun: cookie string as 2nd arg.
    result = await get_current_org("org-1", "raw.jwt.cookie")  # type: ignore[arg-type]
    assert result is None
    assert called["get_current_org"] is False


@pytest.mark.asyncio
async def test_get_optional_org_uses_resolved_payload(monkeypatch):
    monkeypatch.setattr(
        "eden.api.deps.get_current_org",
        AsyncMock(return_value={"org_id": "org-1", "role": "member"}),
    )
    org = await get_optional_org(
        x_org_id="org-1",
        x_org_api_key=None,
        payload={"sub": "u1", "current_org_id": "org-1"},
    )
    assert org is not None
    assert org["org_id"] == "org-1"


@pytest.mark.asyncio
async def test_require_org_member_wrong_kwarg_authorization_raises_typeerror():
    """The old ``authorization=None`` call site was a TypeError → 500."""
    with pytest.raises(TypeError):
        await require_org_member("org-1", authorization=None)  # type: ignore[call-arg]


@pytest.mark.asyncio
async def test_assert_invitation_rejects_email_mismatch(monkeypatch):
    mock_client = MagicMock()
    mock_client.fetchrow = AsyncMock(
        return_value={
            "id": "inv-1",
            "org_id": "org-1",
            "email": "invitee@example.com",
            "status": "pending",
        }
    )
    monkeypatch.setattr(
        "eden.api.routes.orgs.get_postgres_client",
        AsyncMock(return_value=mock_client),
    )
    monkeypatch.setattr(
        "eden.api.routes.orgs.resolve_eden_org_id",
        AsyncMock(side_effect=lambda oid: oid),
    )
    monkeypatch.setattr(
        "eden.api.routes.orgs.get_eden_user_row_from_auth",
        AsyncMock(return_value={"id": "u1", "email": "other@example.com"}),
    )
    with pytest.raises(HTTPException) as exc_info:
        await _assert_invitation_for_caller(
            org_id="org-1",
            invitation_id="inv-1",
            user={"user_id": "u1"},
        )
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_assert_invitation_rejects_org_path_mismatch(monkeypatch):
    mock_client = MagicMock()
    mock_client.fetchrow = AsyncMock(
        return_value={
            "id": "inv-1",
            "org_id": "org-real",
            "email": "invitee@example.com",
            "status": "pending",
        }
    )
    monkeypatch.setattr(
        "eden.api.routes.orgs.get_postgres_client",
        AsyncMock(return_value=mock_client),
    )
    monkeypatch.setattr(
        "eden.api.routes.orgs.resolve_eden_org_id",
        AsyncMock(side_effect=lambda oid: oid),
    )
    with pytest.raises(HTTPException) as exc_info:
        await _assert_invitation_for_caller(
            org_id="org-other",
            invitation_id="inv-1",
            user={"user_id": "u1"},
        )
    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_list_mcp_keys_path_scoped_admin_blocks_cross_org(monkeypatch):
    """Admin of JWT org A must not list keys for path org B."""
    monkeypatch.setattr(
        "eden.api.routes.mcp_keys.require_org_admin",
        AsyncMock(
            side_effect=HTTPException(status_code=403, detail="Not a member")
        ),
    )
    with pytest.raises(HTTPException) as exc_info:
        await list_mcp_keys(
            org_id="org-b",
            user={"user_id": "u1"},
            payload={"sub": "u1", "o": {"id": "org-a", "rol": "admin"}},
        )
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_tenant_rate_limit_resolves_clerk_bearer_org():
    from eden.api.middleware.tenant_rate_limit import TenantRateLimitMiddleware

    mw = TenantRateLimitMiddleware(app=AsyncMock())
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "path": "/v1/traces",
        "raw_path": b"/v1/traces",
        "query_string": b"",
        "headers": [
            (b"authorization", b"Bearer clerk.jwt.token"),
        ],
        "client": ("127.0.0.1", 123),
        "server": ("test", 80),
    }
    request = Request(scope)

    with patch(
        "eden.api.utils.clerk_auth.verify_clerk_token",
        new_callable=AsyncMock,
        return_value={"sub": "user_1", "o": {"id": "org_clerk_1", "rol": "admin"}},
    ), patch(
        "eden.api.utils.clerk_auth.extract_org_id",
        return_value="org_clerk_1",
    ):
        org_id, key_id = await mw._resolve_org_and_api_key(request)

    assert org_id == "org_clerk_1"
    assert key_id is None


@pytest.mark.asyncio
async def test_tenant_rate_limit_ignores_spoofed_x_org_id_without_auth():
    from eden.api.middleware.tenant_rate_limit import TenantRateLimitMiddleware

    mw = TenantRateLimitMiddleware(app=AsyncMock())
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "path": "/v1/traces",
        "raw_path": b"/v1/traces",
        "query_string": b"",
        "headers": [
            (b"x-org-id", b"victim-org"),
        ],
        "client": ("127.0.0.1", 123),
        "server": ("test", 80),
    }
    request = Request(scope)
    org_id, key_id = await mw._resolve_org_and_api_key(request)
    assert org_id is None
    assert key_id is None
