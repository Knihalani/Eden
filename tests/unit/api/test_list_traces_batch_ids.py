"""K5 — list_traces optional ``trace_ids`` batch filter."""

from __future__ import annotations

import inspect
import textwrap
from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.api.routes import observability


def test_list_traces_source_supports_trace_ids_any() -> None:
    source = textwrap.dedent(inspect.getsource(observability.list_traces))
    non_comment = "\n".join(
        line for line in source.splitlines() if not line.lstrip().startswith("#")
    )
    assert "trace_ids" in non_comment
    assert "ANY($2::text[])" in non_comment
    assert "[:100]" in non_comment


def test_list_traces_sql_matches_prod_telemetry_schema() -> None:
    """Prod has error_type + JSONB tags + cost in metrics — not bare columns."""
    source = textwrap.dedent(inspect.getsource(observability.list_traces))
    assert "max(error) AS error" not in source
    assert "sum(cost_usd)" not in source
    assert "unnest(e2.tags)" not in source
    assert "jsonb_array_elements_text" in source
    assert "error_type" in source
    assert "metrics->>'cost_usd'" in source


@pytest.mark.asyncio
async def test_list_traces_batch_ids_skips_days_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fetch_sqls: list[str] = []
    fetch_args: list[tuple[Any, ...]] = []

    client = MagicMock()

    async def _fetch(sql: str, *args: Any) -> list[dict[str, Any]]:
        fetch_sqls.append(sql)
        fetch_args.append(args)
        return [
            {
                "trace_id": "t-a",
                "started_at": datetime(2020, 1, 1, tzinfo=UTC),
                "realm": "production",
                "agent_id": None,
                "model": None,
                "provider": None,
                "session_id": None,
                "agent_session_id": None,
                "outcome": "ok",
                "error_type": None,
                "attr_error": None,
                "input_tokens": 1,
                "output_tokens": 2,
                "cost_usd": 0.01,
                "span_count": 1,
                "duration_ms": 10.0,
                "tags": [],
            }
        ]

    async def _fetchval(sql: str, *args: Any) -> int:
        return 1

    client.fetch = _fetch
    client.fetchval = _fetchval

    import eden.storage.postgres as real_pg

    monkeypatch.setattr(
        real_pg, "get_postgres_client", AsyncMock(return_value=client)
    )

    result = await observability.list_traces(
        org_id="org-1",
        trace_ids=["t-a", "t-b", ""] + [f"x{i}" for i in range(120)],
        limit=50,
        offset=0,
        days=7,
        user={"sub": "u"},
    )

    assert result.total == 1
    assert len(result.traces) == 1
    assert result.traces[0].trace_id == "t-a"
    assert len(fetch_sqls) == 1
    assert "timestamp >=" not in fetch_sqls[0]
    assert "ANY($2::text[])" in fetch_sqls[0]
    # empty string dropped; cap 100
    ids_arg = fetch_args[0][1]
    assert ids_arg[0] == "t-a"
    assert ids_arg[1] == "t-b"
    assert len(ids_arg) == 100


@pytest.mark.asyncio
async def test_list_traces_postgres_none_is_503_not_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Wave-1 defect: PG missing must not soft-empty the traces hub."""
    from fastapi import HTTPException

    import eden.storage.postgres as real_pg

    monkeypatch.setattr(
        real_pg, "get_postgres_client", AsyncMock(return_value=None)
    )

    with pytest.raises(HTTPException) as ei:
        await observability.list_traces(
            org_id="org-1",
            realm=None,
            outcome=None,
            agent_id=None,
            trace_id=None,
            trace_ids=None,
            limit=50,
            offset=0,
            days=7,
            user={"sub": "u"},
        )
    assert ei.value.status_code == 503
    assert ei.value.headers.get("Retry-After") == "5"


@pytest.mark.asyncio
async def test_list_traces_postgres_raise_is_503_not_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from fastapi import HTTPException

    import eden.storage.postgres as real_pg

    monkeypatch.setattr(
        real_pg,
        "get_postgres_client",
        AsyncMock(side_effect=RuntimeError("connection refused")),
    )

    with pytest.raises(HTTPException) as ei:
        await observability.list_traces(
            org_id="org-1",
            realm=None,
            outcome=None,
            agent_id=None,
            trace_id=None,
            trace_ids=None,
            limit=50,
            offset=0,
            days=7,
            user={"sub": "u"},
        )
    assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_list_traces_query_failure_is_503_not_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from fastapi import HTTPException

    import eden.storage.postgres as real_pg

    client = MagicMock()
    client.fetch = AsyncMock(side_effect=RuntimeError("query timeout"))
    client.fetchval = AsyncMock(side_effect=RuntimeError("query timeout"))
    monkeypatch.setattr(
        real_pg, "get_postgres_client", AsyncMock(return_value=client)
    )

    with pytest.raises(HTTPException) as ei:
        await observability.list_traces(
            org_id="org-1",
            realm=None,
            outcome=None,
            agent_id=None,
            trace_id=None,
            trace_ids=None,
            limit=50,
            offset=0,
            days=7,
            user={"sub": "u"},
        )
    assert ei.value.status_code == 503
