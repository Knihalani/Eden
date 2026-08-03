"""Phase 3 (ingest hot-path batching): ``UsageService.track_events_batch``.

``_emit_billing_events`` used to call ``track_event`` once per billable
event in an ingest batch, each opening its own single-row INSERT
transaction. ``track_events_batch`` collects the whole batch into one
``executemany`` — the same pattern ``bronze_sink.py`` already uses for
its Bronze-layer buffer flush.

``track_event`` itself is untouched and still used by non-batch callers
(job/storage/sandbox metering); it is not re-tested here.
"""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.services.usage_service import UsageService


class _FakeConn:
    def __init__(self) -> None:
        self.executemany_calls: list[tuple[str, list[tuple]]] = []

    async def executemany(self, query: str, rows: Any) -> None:
        self.executemany_calls.append((query, list(rows)))


class _FakeAcquireCtx:
    def __init__(self, conn: _FakeConn) -> None:
        self._conn = conn

    async def __aenter__(self) -> _FakeConn:
        return self._conn

    async def __aexit__(self, *exc: Any) -> None:
        return None


class _FakeClient:
    def __init__(self) -> None:
        self.conn = _FakeConn()

    def acquire(self) -> _FakeAcquireCtx:
        return _FakeAcquireCtx(self.conn)


def _entry(**overrides: Any) -> dict[str, Any]:
    base = {
        "org_id": "org_1",
        "event_type": "llm_call",
        "resource": "gpt-4o",
        "quantity": 150.0,
        "unit": "tokens",
        "model": "gpt-4o",
        "cost_usd": 0.001,
        "metadata": {"event_id": "evt_1"},
        "correlation_id": "evt_1",
    }
    base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_empty_batch_is_a_noop() -> None:
    service = UsageService()
    client = _FakeClient()
    with patch(
        "eden.services.usage_service.get_postgres_client",
        new=AsyncMock(return_value=client),
    ):
        n = await service.track_events_batch([])
    assert n == 0
    assert client.conn.executemany_calls == []


@pytest.mark.asyncio
async def test_batch_issues_one_executemany_for_all_rows() -> None:
    service = UsageService()
    client = _FakeClient()
    events = [_entry(correlation_id=f"evt_{i}", metadata={"event_id": f"evt_{i}"}) for i in range(5)]

    with patch(
        "eden.services.usage_service.get_postgres_client",
        new=AsyncMock(return_value=client),
    ):
        n = await service.track_events_batch(events)

    assert n == 5
    assert len(client.conn.executemany_calls) == 1, (
        "a batch of N events must issue exactly one executemany, not N inserts"
    )
    query, rows = client.conn.executemany_calls[0]
    assert "INSERT INTO usage_events" in query
    assert len(rows) == 5
    # Row order: org_id, user_id, event_type, resource, quantity, unit,
    # model, cost_usd, metadata, correlation_id.
    first = rows[0]
    assert first[0] == "org_1"
    assert first[1] is None  # user_id defaults to None
    assert first[2] == "llm_call"
    assert first[3] == "gpt-4o"
    assert first[4] == 150.0
    assert first[5] == "tokens"
    assert first[6] == "gpt-4o"
    assert first[7] == 0.001
    assert json.loads(first[8]) == {"event_id": "evt_0"}
    assert first[9] == "evt_0"


@pytest.mark.asyncio
async def test_batch_defaults_missing_optional_fields() -> None:
    service = UsageService()
    client = _FakeClient()
    entry = {
        "org_id": "org_1",
        "event_type": "job_start",
        "resource": "jobs",
        "quantity": 1,
        "unit": "count",
    }

    with patch(
        "eden.services.usage_service.get_postgres_client",
        new=AsyncMock(return_value=client),
    ):
        n = await service.track_events_batch([entry])

    assert n == 1
    _, rows = client.conn.executemany_calls[0]
    row = rows[0]
    assert row[1] is None  # user_id
    assert row[6] is None  # model
    assert row[7] is None  # cost_usd
    assert json.loads(row[8]) == {}  # metadata defaults to {}
    assert row[9] is None  # correlation_id


@pytest.mark.asyncio
async def test_batch_write_failure_returns_zero_not_raise() -> None:
    """Usage tracking must never break the ingest hot path."""
    service = UsageService()

    async def _boom() -> None:
        raise RuntimeError("db down")

    with patch(
        "eden.services.usage_service.get_postgres_client",
        new=AsyncMock(side_effect=RuntimeError("db down")),
    ):
        n = await service.track_events_batch([_entry()])

    assert n == 0


@pytest.mark.asyncio
async def test_track_event_still_single_row() -> None:
    """The single-row entry point must be untouched by the batch addition."""
    service = UsageService()
    client = MagicMock()
    client.insert_usage_event = AsyncMock(
        return_value="11111111-1111-1111-1111-111111111111"
    )

    with patch(
        "eden.services.usage_service.get_postgres_client",
        new=AsyncMock(return_value=client),
    ):
        event_id = await service.track_event(
            org_id="org_1",
            event_type="job_start",
            resource="jobs",
            quantity=1,
            unit="count",
        )
    assert event_id == "11111111-1111-1111-1111-111111111111"
    client.insert_usage_event.assert_awaited_once()
