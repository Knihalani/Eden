"""Worker-4 backend bugfix regression tests.

Covers: MCP write-auth gate, alert override org scoping,
GitHub webhook empty-secret rejection, vector client SearchResults unwrap.

Phase 0 (2026-07-23) — the Slack interactive-bot tests that used to live
here were removed along with ``eden.integrations.slack``.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.mcp_server.auth import McpAuthContext
from eden.mcp_server.server import call_tool
from eden.storage.qdrant import SearchResult, SearchResults


@pytest.mark.asyncio
async def test_mcp_write_tool_requires_api_key() -> None:
    class _Client:
        async def run_autofix(self, org_id: str, issue_id: str, *, dry_run: bool = True):
            return {"issue_id": issue_id, "dry_run": dry_run}

    denied = await call_tool(
        "run_autofix",
        {"org_id": "org_1", "issue_id": "iss_1"},
        client=_Client(),
    )
    assert denied["status"] == "error"
    assert "API key required" in denied["error"]

    allowed = await call_tool(
        "run_autofix",
        {"org_id": "org_1", "issue_id": "iss_1"},
        client=_Client(),
        auth=McpAuthContext(
            api_key="k",
            base_url="http://127.0.0.1:8000",
            scopes=("mcp:read", "mcp:debug", "mcp:fix"),
        ),
    )
    assert allowed["status"] == "ok"


@pytest.mark.asyncio
async def test_mcp_read_tool_allows_empty_key_smoke() -> None:
    class _Client:
        async def search_traces(self, org_id: str, **kwargs):
            return {"traces": []}

    out = await call_tool(
        "search_traces",
        {"org_id": "org_1", "query": "x"},
        client=_Client(),
    )
    assert out["status"] == "ok"


@pytest.mark.asyncio
async def test_record_triage_feedback_rejects_cross_org() -> None:
    from eden.alerts import repo

    client = MagicMock()
    client.fetchrow = AsyncMock(return_value=None)
    client.execute = AsyncMock()
    with patch(
        "eden.alerts.repo.get_postgres_client",
        new=AsyncMock(return_value=client),
    ):
        out = await repo.record_triage_feedback(
            alert_event_id="alert-other",
            human_verdict="benign",
            created_by="u1",
            org_id="org-a",
        )
    assert out is None
    client.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_record_triage_feedback_updates_when_owned() -> None:
    from eden.alerts import repo

    client = MagicMock()
    client.fetchrow = AsyncMock(return_value={"id": "alert-1"})
    client.execute = AsyncMock()
    with patch(
        "eden.alerts.repo.get_postgres_client",
        new=AsyncMock(return_value=client),
    ):
        out = await repo.record_triage_feedback(
            alert_event_id="alert-1",
            human_verdict="real_incident",
            created_by="u1",
            org_id="org-a",
        )
    assert out is not None
    assert out["human_verdict"] == "real_incident"
    assert client.execute.await_count == 2


def test_verify_webhook_signature_rejects_empty_secret() -> None:
    from eden.integrations.github.oauth import verify_webhook_signature

    assert (
        verify_webhook_signature(
            body=b"{}",
            signature_header="sha256=deadbeef",
            secret="",
        )
        is False
    )


@pytest.mark.asyncio
async def test_vector_client_unwraps_search_results() -> None:
    from eden.kb.semantic.vector_client import SemanticVectorClient

    wrapped = SearchResults(
        results=[
            SearchResult(id="a", score=0.9, payload={"org_id": "o1"}),
            SearchResult(id="b", score=0.8, payload={"org_id": "o2"}),
        ],
        total=2,
    )
    client = MagicMock()
    client.search_async = AsyncMock(return_value=wrapped)
    with (
        patch(
            "eden.kb.semantic.vector_client.get_qdrant_client",
            return_value=client,
        ),
        patch(
            "eden.kb.semantic.vector_client.get_retrieval_logger",
            side_effect=RuntimeError("skip log"),
        ),
    ):
        out = await SemanticVectorClient().search(
            "semantic",
            [0.1, 0.2],
            filter_conditions={"org_id": "o1"},
            limit=10,
        )
    assert isinstance(out, list)
    assert len(out) == 2  # server-side filter; client returns filtered set as-is
    assert out[0].id == "a"


@pytest.mark.asyncio
async def test_vector_client_hybrid_applies_filter_conditions() -> None:
    from eden.kb.semantic.vector_client import SemanticVectorClient

    wrapped = SearchResults(
        results=[
            SearchResult(id="a", score=0.9, payload={"org_id": "o1"}),
            SearchResult(id="b", score=0.8, payload={"org_id": "o2"}),
        ],
        total=2,
    )
    client = MagicMock()
    client.search_async = AsyncMock(return_value=wrapped)
    client.search_hybrid_async = AsyncMock(return_value=wrapped)
    with (
        patch(
            "eden.kb.semantic.vector_client.get_qdrant_client",
            return_value=client,
        ),
        patch(
            "eden.kb.semantic.vector_client.get_retrieval_logger",
            side_effect=RuntimeError("skip log"),
        ),
    ):
        out = await SemanticVectorClient().search_hybrid(
            "semantic",
            [0.1, 0.2],
            "hello",
            filter_conditions={"org_id": "o1"},
            limit=10,
        )
    assert [r.id for r in out] == ["a"]
    client.search_async.assert_awaited()
