"""W4-6 trace bookmarks — unit tests.

Covers:
* Bookmark round-trip (PUT and DELETE) with a mocked Postgres client.
* ``_list_traces_from_summaries`` includes the trace_bookmarks subquery
  only when ``bookmarked=True`` (legacy path idem).
* Bookmark filter is absent from the WHERE string when ``bookmarked=False``.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from eden.api.routes.observability import (
    BookmarkResponse,
    _list_traces_from_summaries,
    router,
)


# ── helpers ──────────────────────────────────────────────────────────────────


def _make_pg_client(*, fetch_result: list[Any] | None = None, fetchval: Any = None) -> MagicMock:
    """Return a mock asyncpg client with controlled fetch / execute results."""
    client = MagicMock()
    client.fetch = AsyncMock(return_value=fetch_result or [])
    client.fetchval = AsyncMock(return_value=fetchval)
    client.execute = AsyncMock(return_value="INSERT 0 1")
    return client


def _trace_summary_row(trace_id: str = "t-1") -> MagicMock:
    """Minimal asyncpg Record-like object for a trace_summaries row."""
    row = MagicMock()
    row.__getitem__ = lambda self, k: {
        "trace_id": trace_id,
        "started_at": None,
        "realm": "production",
        "agent_id": "agent-1",
        "model": "gpt-4o",
        "provider": "openai",
        "session_id": None,
        "outcome": "success",
        "error_type": None,
        "attr_error": None,
        "input_tokens": 0,
        "output_tokens": 0,
        "cost_usd": 0.0,
        "span_count": 1,
        "duration_ms": 100.0,
        "tags": [],
        "agent_session_id": None,
    }[k]
    return row


# ── _list_traces_from_summaries SQL shape ────────────────────────────────────


@pytest.mark.asyncio
async def test_list_traces_from_summaries_no_bookmark_filter() -> None:
    """Without bookmarked=True the WHERE clause has no trace_bookmarks join."""
    captured: list[str] = []
    client = MagicMock()

    async def _fetch(sql: str, *args: Any, **kwargs: Any) -> list[Any]:
        captured.append(sql)
        return [_trace_summary_row()]

    client.fetch = _fetch
    client.fetchval = AsyncMock(return_value=True)

    # Probe for trace_summaries presence.
    with patch(
        "eden.api.routes.observability._trace_summaries_known",
        new=AsyncMock(return_value=True),
    ):
        rows, total = await _list_traces_from_summaries(
            client,
            org_id="org-1",
            batch_ids=None,
            trace_id=None,
            since=None,
            realm=None,
            agent_id=None,
            outcome=None,
            bookmarked=False,
            user_id="user-1",
            limit=10,
            offset=0,
        )

    # No SQL should mention trace_bookmarks when bookmarked=False.
    assert all("trace_bookmarks" not in sql for sql in captured), (
        "trace_bookmarks subquery must be absent when bookmarked=False"
    )
    assert rows is not None


@pytest.mark.asyncio
async def test_list_traces_from_summaries_with_bookmark_filter() -> None:
    """With bookmarked=True the WHERE clause joins trace_bookmarks."""
    captured: list[str] = []
    client = MagicMock()

    async def _fetch(sql: str, *args: Any, **kwargs: Any) -> list[Any]:
        captured.append(sql)
        return [_trace_summary_row()]

    client.fetch = _fetch

    with patch(
        "eden.api.routes.observability._trace_summaries_known",
        new=AsyncMock(return_value=True),
    ):
        rows, total = await _list_traces_from_summaries(
            client,
            org_id="org-1",
            batch_ids=None,
            trace_id=None,
            since=None,
            realm=None,
            agent_id=None,
            outcome=None,
            bookmarked=True,
            user_id="user-42",
            limit=10,
            offset=0,
        )

    # At least one SQL call must reference trace_bookmarks.
    assert any("trace_bookmarks" in sql for sql in captured), (
        "trace_bookmarks subquery must appear when bookmarked=True"
    )


@pytest.mark.asyncio
async def test_list_traces_from_summaries_bookmark_filter_ignored_without_user() -> None:
    """bookmarked=True with no user_id must NOT inject the subquery."""
    captured: list[str] = []
    client = MagicMock()

    async def _fetch(sql: str, *args: Any, **kwargs: Any) -> list[Any]:
        captured.append(sql)
        return []

    client.fetch = _fetch

    with patch(
        "eden.api.routes.observability._trace_summaries_known",
        new=AsyncMock(return_value=True),
    ):
        rows, _ = await _list_traces_from_summaries(
            client,
            org_id="org-1",
            batch_ids=None,
            trace_id=None,
            since=None,
            realm=None,
            agent_id=None,
            outcome=None,
            bookmarked=True,
            user_id=None,
            limit=10,
            offset=0,
        )

    # No user → no bookmark filter even though bookmarked=True.
    assert all("trace_bookmarks" not in sql for sql in captured)


# ── bookmark PUT / DELETE via HTTP ───────────────────────────────────────────


def _build_app() -> FastAPI:
    """Minimal FastAPI app with the observability router mounted."""
    from eden.api.deps import get_current_user, require_path_org_access

    app = FastAPI()

    async def _org_override(org_id: str = "org-1") -> str:  # type: ignore[override]
        return "org-1"

    async def _user_override() -> dict:
        return {"sub": "user-test-1"}

    app.dependency_overrides[require_path_org_access] = _org_override
    app.dependency_overrides[get_current_user] = _user_override
    app.include_router(router)
    return app


@pytest.mark.asyncio
async def test_bookmark_trace_calls_insert() -> None:
    """PUT /traces/{id}/bookmark executes an INSERT into trace_bookmarks."""
    executed_sqls: list[str] = []
    mock_client = MagicMock()

    async def _execute(sql: str, *args: Any) -> str:
        executed_sqls.append(sql)
        return "INSERT 0 1"

    mock_client.execute = _execute

    app = _build_app()

    with (
        patch(
            "eden.api.routes.observability.require_path_org_access",
            new=lambda: None,
        ),
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=mock_client),
        ),
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            resp = await client.put("/orgs/org-1/observability/traces/t-abc/bookmark")

    assert resp.status_code == 200
    data = resp.json()
    assert data["bookmarked"] is True
    assert data["trace_id"] == "t-abc"
    assert any("INSERT INTO trace_bookmarks" in sql for sql in executed_sqls), (
        "PUT bookmark must INSERT into trace_bookmarks"
    )


@pytest.mark.asyncio
async def test_unbookmark_trace_calls_delete() -> None:
    """DELETE /traces/{id}/bookmark executes a DELETE from trace_bookmarks."""
    executed_sqls: list[str] = []
    mock_client = MagicMock()

    async def _execute(sql: str, *args: Any) -> str:
        executed_sqls.append(sql)
        return "DELETE 1"

    mock_client.execute = _execute

    app = _build_app()

    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=mock_client),
        ),
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            resp = await client.delete("/orgs/org-1/observability/traces/t-abc/bookmark")

    assert resp.status_code == 200
    data = resp.json()
    assert data["bookmarked"] is False
    assert data["trace_id"] == "t-abc"
    assert any("DELETE FROM trace_bookmarks" in sql for sql in executed_sqls), (
        "DELETE bookmark must DELETE from trace_bookmarks"
    )


# ── BookmarkResponse schema ───────────────────────────────────────────────────


def test_bookmark_response_schema() -> None:
    """BookmarkResponse has the expected shape."""
    r = BookmarkResponse(bookmarked=True, trace_id="t-xyz")
    assert r.bookmarked is True
    assert r.trace_id == "t-xyz"

    r2 = BookmarkResponse(bookmarked=False, trace_id="t-xyz")
    assert r2.bookmarked is False
