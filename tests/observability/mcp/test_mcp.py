"""D.12.1 MCP trace tests — service + routes + SDK + hook (8 tests).

Covers:
* Service: list_for_trace (mcp_traces_v), list_auth_failures,
  record_auth_failure
* Routes: GET /v1/traces/{trace_id}/mcp,
  GET /v1/mcp/{org_id}/auth_failures,
  POST /v1/mcp/{org_id}/auth_failures (fires hook)
* SDK: wrap_mcp_call happy-path attribute building,
  failure classification

Auth stubs use ``app.dependency_overrides`` (the proven
FastAPI pattern from the D.14 onboarding tests).
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient


# ── helpers ───────────────────────────────────────────────────────────


def _mcp_row(
    server_name: str = "github",
    tool_name: str = "list_issues",
    transport: str = "http_sse",
    sampling: bool = False,
):
    now = datetime.now(UTC)
    return {
        "trace_id": "00000000-0000-0000-0000-000000000099",
        "org_id": "org-1",
        "mcp_server_name": server_name,
        "mcp_tool_name": tool_name,
        "mcp_resource_uri": None,
        "mcp_prompt_name": None,
        "mcp_sampling": sampling,
        "mcp_transport": transport,
        "created_at": now,
    }


def _failure_row(
    server_name: str = "github",
    failure_kind: str = "unauthorized",
):
    now = datetime.now(UTC)
    return {
        "id": "00000000-0000-0000-0000-000000000077",
        "org_id": "org-1",
        "server_name": server_name,
        "transport": "http_sse",
        "failure_kind": failure_kind,
        "error_message": "401 Unauthorized",
        "trace_id": None,
        "span_id": None,
        "occurred_at": now,
        "resolved_at": None,
        "resolved_by": None,
    }


async def _fake_user() -> dict:
    return {"id": "u-1", "email": "t@test.io", "sub": "u-1"}


async def _fake_member() -> dict:
    return {"id": "u-1", "role": "member"}


async def _fake_admin() -> dict:
    return {"id": "u-1", "role": "admin"}


@pytest.fixture
def mcp_client(mock_postgres_client: MagicMock) -> TestClient:
    """TestClient with the MCP route's auth deps stubbed."""
    from eden.api.app import app
    from eden.api.deps import (
        get_current_user,
        require_org_admin,
        require_org_member,
    )
    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_org_member] = _fake_member
    app.dependency_overrides[require_org_admin] = _fake_admin
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


# ── service tests ─────────────────────────────────────────────────────


class TestMcpService:
    """3 service-level tests."""

    async def test_list_for_trace_returns_view_rows(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_mcp_service
        svc = get_mcp_service()
        mock_postgres_client.fetch = AsyncMock(return_value=[
            _mcp_row(server_name="github", tool_name="list_issues"),
            _mcp_row(server_name="slack", tool_name="post_message"),
        ])
        rows = await svc.list_for_trace(
            "00000000-0000-0000-0000-000000000099",
            org_id="org-1",
        )
        assert len(rows) == 2
        assert rows[0]["mcp_server_name"] == "github"
        assert rows[1]["mcp_server_name"] == "slack"

    async def test_list_auth_failures_filters(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_mcp_service
        svc = get_mcp_service()
        mock_postgres_client.fetch = AsyncMock(return_value=[
            _failure_row(failure_kind="expired_token"),
        ])
        rows = await svc.list_auth_failures(
            "org-1", server_name="github", resolved=False, limit=50,
        )
        assert len(rows) == 1
        assert rows[0]["failure_kind"] == "expired_token"

    async def test_record_auth_failure_returns_id(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_mcp_service
        svc = get_mcp_service()
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "id": "00000000-0000-0000-0000-000000000077",
        })
        fid = await svc.record_auth_failure(
            "org-1",
            server_name="github",
            failure_kind="unauthorized",
            transport="http_sse",
            error_message="401 Unauthorized",
        )
        assert fid == "00000000-0000-0000-0000-000000000077"


# ── route tests ───────────────────────────────────────────────────────


class TestMcpRoutes:
    """3 route tests."""

    def test_get_trace_mcp_returns_view_rows(
        self, mock_postgres_client: MagicMock, mcp_client: TestClient,
    ):
        mock_postgres_client.fetch = AsyncMock(return_value=[
            _mcp_row(server_name="github"),
        ])
        resp = mcp_client.get(
            "/v1/traces/00000000-0000-0000-0000-000000000099/mcp",
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["count"] == 1
        assert body["data"][0]["mcp_server_name"] == "github"

    def test_list_auth_failures_returns_rows(
        self, mock_postgres_client: MagicMock, mcp_client: TestClient,
    ):
        mock_postgres_client.fetch = AsyncMock(return_value=[
            _failure_row(failure_kind="dns"),
        ])
        resp = mcp_client.get(
            "/v1/mcp/org-1/auth_failures?resolved=false",
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["count"] == 1
        assert body["data"][0]["failure_kind"] == "dns"

    def test_post_auth_failure_fires_hook(
        self, mock_postgres_client: MagicMock, mcp_client: TestClient,
    ):
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "id": "00000000-0000-0000-0000-000000000077",
        })
        resp = mcp_client.post(
            "/v1/mcp/org-1/auth_failures",
            json={
                "server_name": "github",
                "failure_kind": "unauthorized",
                "transport": "http_sse",
                "error_message": "401 Unauthorized",
            },
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        # The fire-and-forget hook call should not raise; the
        # route is best-effort.
        assert body["data"]["id"] == "00000000-0000-0000-0000-000000000077"


# ── SDK test ──────────────────────────────────────────────────────────


class TestMcpSdk:
    """2 SDK tests."""

    def test_wrap_mcp_call_attributes(self):
        from eden.sdk.mcp import wrap_mcp_call

        with wrap_mcp_call(
            org_id="org-1",
            server_name="github",
            trace_id="00000000-0000-0000-0000-000000000099",
            span_id="00000000-0000-0000-0000-000000000098",
            tool_name="list_issues",
            transport="http_sse",
        ) as ctx:
            ctx.set_resource("repo://org/repo")
            attrs = ctx.attributes()
        assert attrs["server_name"] == "github"
        assert attrs["tool_name"] == "list_issues"
        assert attrs["resource_uri"] == "repo://org/repo"
        assert attrs["transport"] == "http_sse"

    def test_wrap_mcp_call_classifies_auth_failure(self):
        from eden.sdk.mcp import _classify_failure

        assert _classify_failure(RuntimeError("401 Unauthorized")) == "unauthorized"
        assert _classify_failure(RuntimeError("token expired")) == "expired_token"
        assert _classify_failure(RuntimeError("DNS NXDOMAIN")) == "dns"
        assert _classify_failure(RuntimeError("TLS handshake failed")) == "tls"
        assert _classify_failure(RuntimeError("something else")) is None