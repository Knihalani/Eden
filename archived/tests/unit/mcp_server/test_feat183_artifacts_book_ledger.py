"""FEAT-183 — MCP read tools for Artifacts / Book / Ledger."""

from __future__ import annotations

from typing import Any

import pytest

from eden.mcp_server.auth import McpAuthContext
from eden.mcp_server.server import _HANDLERS, call_tool, list_tools


class _FakeClient:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    async def get_book(self, org_id: str, agent_id: str) -> dict[str, Any]:
        self.calls.append(("get_book", org_id, agent_id))
        return {"status": "ok", "feature": "agent_book", "data": {"book": {}}}

    async def list_artifacts(
        self,
        org_id: str,
        *,
        agent_id: str | None = None,
        mode: str | None = None,
    ) -> dict[str, Any]:
        self.calls.append(("list_artifacts", org_id, agent_id, mode))
        return {"status": "ok", "artifacts": []}

    async def list_ledgers(self, org_id: str) -> dict[str, Any]:
        self.calls.append(("list_ledgers", org_id))
        return {"status": "ok", "ledgers": []}

    async def get_ledger(self, org_id: str, agent_id: str) -> dict[str, Any]:
        self.calls.append(("get_ledger", org_id, agent_id))
        return {"status": "ok", "ledger": {}}


def _read_auth() -> McpAuthContext:
    return McpAuthContext(
        api_key="test-key",
        base_url="http://127.0.0.1:8000",
        org_id="org-1",
        scopes=("mcp:read",),
    )


def test_feat183_tools_registered() -> None:
    listed = {t["name"] for t in list_tools()}
    for name in ("get_book", "list_artifacts", "get_ledger"):
        assert name in listed
        assert name in _HANDLERS


@pytest.mark.asyncio
async def test_get_book_forwards_to_client() -> None:
    fake = _FakeClient()
    out = await call_tool(
        "get_book",
        {"org_id": "org-1", "agent_id": "agent-a"},
        client=fake,
        auth=_read_auth(),
    )
    assert out["status"] == "ok"
    assert out["tool"] == "get_book"
    assert out["result"]["feature"] == "agent_book"
    assert fake.calls == [("get_book", "org-1", "agent-a")]


@pytest.mark.asyncio
async def test_list_artifacts_forwards_filters() -> None:
    fake = _FakeClient()
    out = await call_tool(
        "list_artifacts",
        {"org_id": "org-1", "agent_id": "agent-a", "mode": "nudge"},
        client=fake,
        auth=_read_auth(),
    )
    assert out["status"] == "ok"
    assert out["tool"] == "list_artifacts"
    assert fake.calls == [("list_artifacts", "org-1", "agent-a", "nudge")]


@pytest.mark.asyncio
async def test_get_ledger_without_agent_id_lists_ledgers() -> None:
    fake = _FakeClient()
    out = await call_tool(
        "get_ledger",
        {"org_id": "org-1"},
        client=fake,
        auth=_read_auth(),
    )
    assert out["status"] == "ok"
    assert out["tool"] == "get_ledger"
    assert out["result"]["ledgers"] == []
    assert fake.calls == [("list_ledgers", "org-1")]


@pytest.mark.asyncio
async def test_get_ledger_with_agent_id_fetches_detail() -> None:
    fake = _FakeClient()
    out = await call_tool(
        "get_ledger",
        {"org_id": "org-1", "agent_id": "agent-a"},
        client=fake,
        auth=_read_auth(),
    )
    assert out["status"] == "ok"
    assert out["tool"] == "get_ledger"
    assert out["result"]["ledger"] == {}
    assert fake.calls == [("get_ledger", "org-1", "agent-a")]


@pytest.mark.asyncio
async def test_feat183_read_tools_require_read_scope() -> None:
    no_read = McpAuthContext(
        api_key="test-key",
        base_url="http://127.0.0.1:8000",
        org_id="org-1",
        scopes=(),
    )
    for tool_name, args in (
        ("get_book", {"org_id": "org-1", "agent_id": "agent-a"}),
        ("list_artifacts", {"org_id": "org-1"}),
        ("get_ledger", {"org_id": "org-1"}),
    ):
        out = await call_tool(
            tool_name,
            args,
            client=_FakeClient(),
            auth=no_read,
        )
        assert out["status"] == "error"
        assert "mcp:read" in out["error"]


@pytest.mark.asyncio
async def test_http_client_feat183_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    """HttpEdenClient FEAT-183 methods hit the learn-router paths."""
    from eden.mcp_server.client import HttpEdenClient

    captured: list[tuple[str, str, dict[str, Any] | None]] = []

    async def _fake_request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        captured.append((method, path, params))
        return {"status": "ok"}

    monkeypatch.setattr(HttpEdenClient, "_request", _fake_request)

    client = HttpEdenClient(auth=_read_auth())
    await client.get_book("org-1", "agent-a")
    await client.list_artifacts("org-1", agent_id="agent-a", mode="nudge")
    await client.list_ledgers("org-1")
    await client.get_ledger("org-1", "agent-a")

    assert captured == [
        ("GET", "/orgs/org-1/agents/agent-a/book", None),
        (
            "GET",
            "/orgs/org-1/artifacts",
            {"agent_id": "agent-a", "mode": "nudge"},
        ),
        ("GET", "/orgs/org-1/ledger", None),
        ("GET", "/orgs/org-1/agents/agent-a/ledger", None),
    ]
