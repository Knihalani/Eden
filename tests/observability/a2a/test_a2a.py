"""D.12.2 A2A protocol tests — service + routes + SDK + hook (10 tests).

Covers:
* Service: register_link, get_links_for_trace,
  get_invocation_graph, mark_failed
* Routes: GET /v1/traces/{id}/a2a, POST /v1/a2a/{org}/links,
  GET /v1/a2a/{org}/invocations/{trace_id},
  POST /v1/a2a/{org}/links/{id}/fail
* SDK: wrap_a2a_invocation happy + failure classification

Auth stubs use ``app.dependency_overrides`` (the proven
FastAPI pattern from the D.14 onboarding tests).
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient


# ── helpers ───────────────────────────────────────────────────────────


_PARENT_TID = "00000000-0000-0000-0000-000000000099"
_CHILD_TID = "00000000-0000-0000-0000-0000000000aa"
_SPAN_ID = "00000000-0000-0000-0000-000000000098"
_PARENT_AGENT = "00000000-0000-0000-0000-0000000000b1"
_CHILD_AGENT = "00000000-0000-0000-0000-0000000000b2"


def _link_row(
    parent_tid: str = _PARENT_TID,
    child_tid: str = _CHILD_TID,
    response_status: str | None = None,
    error_kind: str | None = None,
    depth: int = 0,
):
    now = datetime.now(UTC)
    return {
        "id": "00000000-0000-0000-0000-000000000077",
        "org_id": "org-1",
        "parent_trace_id": parent_tid,
        "child_trace_id": child_tid,
        "parent_agent_id": _PARENT_AGENT,
        "child_agent_id": _CHILD_AGENT,
        "parent_span_id": _SPAN_ID,
        "invocation_type": "a2a.send_message",
        "response_status": response_status,
        "error_kind": error_kind,
        "created_at": now,
        "depth": depth,
    }


async def _fake_user() -> dict:
    return {"id": "u-1", "email": "t@test.io", "sub": "u-1"}


async def _fake_member() -> dict:
    return {"id": "u-1", "role": "member"}


async def _fake_admin() -> dict:
    return {"id": "u-1", "role": "admin"}


@pytest.fixture
def a2a_client(mock_postgres_client: MagicMock) -> TestClient:
    """TestClient with the A2A route's auth deps stubbed."""
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


class TestA2AService:
    """4 service-level tests."""

    async def test_register_link_returns_id(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_a2a_service
        svc = get_a2a_service()
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "id": "00000000-0000-0000-0000-000000000077",
        })
        link_id = await svc.register_link(
            "org-1",
            parent_trace_id=_PARENT_TID,
            child_trace_id=_CHILD_TID,
            parent_agent_id=_PARENT_AGENT,
            child_agent_id=_CHILD_AGENT,
            parent_span_id=_SPAN_ID,
            invocation_type="a2a.send_message",
            response_status="ok",
        )
        assert link_id == "00000000-0000-0000-0000-000000000077"

    async def test_get_links_for_trace_splits_parent_children(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_a2a_service
        svc = get_a2a_service()
        mock_postgres_client.fetch = AsyncMock(return_value=[
            _link_row(parent_tid=_PARENT_TID, child_tid=_CHILD_TID),
            _link_row(parent_tid=_CHILD_TID, child_tid="00000000-0000-0000-0000-0000000000cc"),
        ])
        data = await svc.get_links_for_trace(_CHILD_TID, org_id="org-1")
        assert len(data["parent"]) == 1
        assert data["parent"][0]["parent_trace_id"] == _PARENT_TID
        assert len(data["children"]) == 1
        assert data["children"][0]["child_trace_id"] == "00000000-0000-0000-0000-0000000000cc"

    async def test_get_invocation_graph_returns_nodes_and_edges(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_a2a_service
        svc = get_a2a_service()
        mock_postgres_client.fetch = AsyncMock(return_value=[
            _link_row(depth=0),
        ])
        graph = await svc.get_invocation_graph(
            _PARENT_TID, org_id="org-1", max_depth=3,
        )
        assert _PARENT_TID in graph["nodes"]
        assert _CHILD_TID in graph["nodes"]
        assert graph["nodes"][_PARENT_TID]["is_root"] is True
        assert len(graph["edges"]) == 1

    async def test_mark_failed_updates_and_fires_hook(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_a2a_service
        svc = get_a2a_service()
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "id": "00000000-0000-0000-0000-000000000077",
            "org_id": "org-1",
            "parent_trace_id": _PARENT_TID,
            "child_trace_id": _CHILD_TID,
            "invocation_type": "a2a.send_message",
        })
        ok = await svc.mark_failed(
            "00000000-0000-0000-0000-000000000077", error_kind="timeout",
        )
        assert ok is True


# ── route tests ───────────────────────────────────────────────────────


class TestA2ARoutes:
    """4 route tests."""

    def test_get_trace_a2a_returns_parent_and_children(
        self, mock_postgres_client: MagicMock, a2a_client: TestClient,
    ):
        mock_postgres_client.fetch = AsyncMock(return_value=[
            _link_row(parent_tid=_PARENT_TID, child_tid=_CHILD_TID),
        ])
        resp = a2a_client.get(
            f"/v1/traces/{_CHILD_TID}/a2a",
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert len(body["data"]["parent"]) == 1
        assert len(body["data"]["children"]) == 0

    def test_post_link_registers(
        self, mock_postgres_client: MagicMock, a2a_client: TestClient,
    ):
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "id": "00000000-0000-0000-0000-000000000077",
        })
        resp = a2a_client.post(
            "/v1/a2a/org-1/links",
            json={
                "parent_trace_id": _PARENT_TID,
                "child_trace_id": _CHILD_TID,
                "parent_agent_id": _PARENT_AGENT,
                "child_agent_id": _CHILD_AGENT,
                "parent_span_id": _SPAN_ID,
                "invocation_type": "a2a.send_message",
                "response_status": "ok",
            },
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["id"] == "00000000-0000-0000-0000-000000000077"

    def test_get_invocation_graph(
        self, mock_postgres_client: MagicMock, a2a_client: TestClient,
    ):
        mock_postgres_client.fetch = AsyncMock(return_value=[
            _link_row(depth=0),
        ])
        resp = a2a_client.get(
            f"/v1/a2a/org-1/invocations/{_PARENT_TID}",
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["edge_count"] == 1
        assert _PARENT_TID in body["data"]["nodes"]

    def test_post_link_fail_marks_failed(
        self, mock_postgres_client: MagicMock, a2a_client: TestClient,
    ):
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "id": "00000000-0000-0000-0000-000000000077",
            "org_id": "org-1",
            "parent_trace_id": _PARENT_TID,
            "child_trace_id": _CHILD_TID,
            "invocation_type": "a2a.send_message",
        })
        resp = a2a_client.post(
            "/v1/a2a/org-1/links/00000000-0000-0000-0000-000000000077/fail",
            json={"error_kind": "timeout"},
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["marked_failed"] is True


# ── SDK tests ─────────────────────────────────────────────────────────


class TestA2ASdk:
    """2 SDK tests."""

    async def test_wrap_a2a_invocation_attributes(self):
        from eden.sdk.a2a import wrap_a2a_invocation

        async with wrap_a2a_invocation(
            org_id="org-1",
            parent_trace_id=_PARENT_TID,
            parent_span_id=_SPAN_ID,
            child_trace_id=_CHILD_TID,
            parent_agent_id=_PARENT_AGENT,
            child_agent_id=_CHILD_AGENT,
            invocation_type="a2a.send_message",
        ) as ctx:
            attrs = ctx.attributes()
        assert attrs["parent_agent_span_id"] == _SPAN_ID
        assert attrs["child_agent_trace_id"] == _CHILD_TID
        assert attrs["a2a"]["invocation_type"] == "a2a.send_message"
        assert attrs["a2a"]["parent_agent_id"] == _PARENT_AGENT
        assert attrs["a2a"]["child_agent_id"] == _CHILD_AGENT

    def test_classify_error(self):
        from eden.sdk.a2a import _classify_error

        assert _classify_error(TimeoutError("timed out")) == "timeout"
        assert _classify_error(RuntimeError("401 Unauthorized")) == "unauthorized"
        assert _classify_error(RuntimeError("rate limit exceeded")) == "rate_limited"
        assert _classify_error(RuntimeError("connection refused")) == "connection_reset"
        assert _classify_error(RuntimeError("something else")) == "unknown"