"""BUG-32 / OPT-61 — RCA trace fetch SQL columns and tier-aware rehydrate."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.insights.rca import _common as rca_common
from eden.insights.rca._common import (
    _TRACE_EVENTS_COLUMNS_FULL,
    _TRACE_EVENTS_COLUMNS_THIN,
    _fetch_failed_traces_in_window,
    _fetch_trace_events,
    _load_trace_events_from_archive,
    _project_trace_event_columns,
    _trace_events_cold_rehydrates,
    _trace_events_hot_hits,
    _trace_events_misses,
)
from eden.observability.simple_metrics import reset_for_tests


@pytest.fixture(autouse=True)
def _reset_metrics() -> None:
    reset_for_tests()
    yield
    reset_for_tests()


@pytest.fixture(autouse=True)
def _reset_tier_counters() -> None:
    rca_common._trace_events_hot_hits = 0
    rca_common._trace_events_cold_rehydrates = 0
    rca_common._trace_events_misses = 0
    yield


def test_trace_event_column_lists_use_error_type_not_error() -> None:
    assert "error_type" in _TRACE_EVENTS_COLUMNS_FULL
    assert "error_type" in _TRACE_EVENTS_COLUMNS_THIN
    # Bare ``error`` column was never migrated onto telemetry_events.
    for columns in (_TRACE_EVENTS_COLUMNS_FULL, _TRACE_EVENTS_COLUMNS_THIN):
        parts = {p.strip() for p in columns.split(",")}
        assert "error_type" in parts
        assert "error" not in parts


def test_project_trace_event_columns_thin_strips_payload() -> None:
    rows = [
        {
            "span_id": "s1",
            "payload": {"big": True},
            "error_type": "Timeout",
            "agent_id": "agent-1",
        }
    ]
    projected = _project_trace_event_columns(rows, _TRACE_EVENTS_COLUMNS_THIN)
    assert "payload" not in projected[0]
    assert projected[0]["error_type"] == "Timeout"
    assert projected[0]["agent_id"] == "agent-1"


@pytest.mark.asyncio
async def test_fetch_trace_events_hot_hit_skips_archive() -> None:
    mock_client = MagicMock()
    mock_client.fetch = AsyncMock(
        return_value=[{"span_id": "s1", "trace_id": "trc_1", "outcome": "success"}]
    )
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=mock_client),
        ),
        patch(
            "eden.insights.rca._common._load_trace_events_from_archive",
            AsyncMock(return_value=[]),
        ) as cold,
    ):
        rows = await _fetch_trace_events("org_1", "trc_1")
    assert len(rows) == 1
    cold.assert_not_called()


@pytest.mark.asyncio
async def test_fetch_trace_events_cold_rehydrate_on_hot_miss() -> None:
    mock_client = MagicMock()
    mock_client.fetch = AsyncMock(return_value=[])
    archived = [
        {
            "span_id": "s-cold",
            "trace_id": "trc_cold",
            "timestamp": "2026-01-01T00:00:00Z",
            "outcome": "failure",
            "error_type": "ArchiveErr",
            "agent_id": "agent-cold",
            "payload": {"ignored": True},
        }
    ]
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=mock_client),
        ),
        patch(
            "eden.insights.rca._common._load_trace_events_from_archive",
            AsyncMock(return_value=archived),
        ),
    ):
        rows = await _fetch_trace_events("org_1", "trc_cold", thin=True)
    assert len(rows) == 1
    assert rows[0]["span_id"] == "s-cold"
    assert rows[0]["error_type"] == "ArchiveErr"
    assert "payload" not in rows[0]


@pytest.mark.asyncio
async def test_fetch_trace_events_true_miss_when_hot_and_cold_empty() -> None:
    mock_client = MagicMock()
    mock_client.fetch = AsyncMock(return_value=[])
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=mock_client),
        ),
        patch(
            "eden.insights.rca._common._load_trace_events_from_archive",
            AsyncMock(return_value=[]),
        ),
    ):
        rows = await _fetch_trace_events("org_1", "trc_missing")
    assert rows == []


@pytest.mark.asyncio
async def test_fetch_failed_traces_sql_uses_error_type_filter() -> None:
    fetch_calls: list[str] = []

    async def _capture_fetch(sql: str, *args: Any) -> list[dict[str, Any]]:
        fetch_calls.append(sql)
        if "telemetry_events" in sql:
            return [{"trace_id": "trc_fail"}]
        return []

    mock_client = MagicMock()
    mock_client.fetch = _capture_fetch
    mock_client.fetchrow = AsyncMock(
        return_value={"window_start": datetime.now(UTC) - timedelta(hours=24)}
    )
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=mock_client),
        ),
        patch(
            "eden.insights.rca._common._load_trace_events_from_archive",
            AsyncMock(return_value=[]),
        ),
    ):
        trace_ids = await _fetch_failed_traces_in_window("org_1", "24 hours")
    assert trace_ids == ["trc_fail"]
    hot_sql = next(sql for sql in fetch_calls if "telemetry_events" in sql)
    assert "error_type IS NOT NULL" in hot_sql
    assert "error IS NOT NULL" not in hot_sql


@pytest.mark.asyncio
async def test_load_trace_events_from_archive_delegates_to_archive_service() -> None:
    with patch(
        "eden.services.data_platform.ArchiveService",
    ) as archive_cls:
        archive_cls.return_value.rehydrate = AsyncMock(
            return_value=[{"span_id": "s1"}]
        )
        rows = await _load_trace_events_from_archive("org_1", "trc_1")
    assert rows == [{"span_id": "s1"}]
    archive_cls.return_value.rehydrate.assert_awaited_once_with(
        "trc_1", org_id="org_1"
    )


@pytest.mark.asyncio
async def test_fetch_trace_events_cold_rehydrate_increments_metrics() -> None:
    mock_client = MagicMock()
    mock_client.fetch = AsyncMock(return_value=[])
    archived = [
        {
            "span_id": "s-cold",
            "trace_id": "trc_cold",
            "timestamp": "2026-01-01T00:00:00Z",
            "outcome": "failure",
            "error_type": "ArchiveErr",
        }
    ]
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=mock_client),
        ),
        patch(
            "eden.insights.rca._common._load_trace_events_from_archive",
            AsyncMock(return_value=archived),
        ),
    ):
        await _fetch_trace_events("org_1", "trc_cold")

    assert rca_common._trace_events_cold_rehydrates == 1
    from eden.observability.metrics_endpoint import metrics

    text = (await metrics()).body.decode("utf-8")
    assert "eden_rca_trace_events_cold_rehydrates_total" in text
    assert "eden_rca_trace_events_cold_rehydrates_total 1" in text


@pytest.mark.asyncio
async def test_fetch_failed_traces_supplements_from_archive_index() -> None:
    window_start = datetime.now(UTC) - timedelta(hours=1)
    fetch_calls: list[str] = []

    async def _fetch(sql: str, *args: Any) -> list[dict[str, Any]]:
        fetch_calls.append(sql)
        if "telemetry_events" in sql:
            return [{"trace_id": "trc_hot"}]
        if "trace_archive_index" in sql:
            return [{"trace_id": "trc_cold_fail"}, {"trace_id": "trc_cold_ok"}]
        return []

    async def _fetchrow(sql: str, *args: Any) -> dict[str, Any]:
        return {"window_start": window_start}

    mock_client = MagicMock()
    mock_client.fetch = _fetch
    mock_client.fetchrow = _fetchrow

    async def _rehydrate(org_id: str, trace_id: str) -> list[dict[str, Any]]:
        if trace_id == "trc_cold_fail":
            return [
                {
                    "span_id": "s1",
                    "trace_id": trace_id,
                    "timestamp": datetime.now(UTC).isoformat(),
                    "outcome": "failure",
                    "error_type": "ColdErr",
                }
            ]
        return [
            {
                "span_id": "s2",
                "trace_id": trace_id,
                "timestamp": datetime.now(UTC).isoformat(),
                "outcome": "success",
            }
        ]

    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=mock_client),
        ),
        patch(
            "eden.insights.rca._common._load_trace_events_from_archive",
            side_effect=_rehydrate,
        ),
    ):
        trace_ids = await _fetch_failed_traces_in_window("org_1", "24 hours")

    assert trace_ids == ["trc_cold_fail", "trc_hot"]
    assert any("trace_archive_index" in sql for sql in fetch_calls)


def test_tier_counters_module_exists() -> None:
    """OPT-61 counters are importable and wired to simple_metrics."""
    assert isinstance(_trace_events_hot_hits, int)
    assert isinstance(_trace_events_cold_rehydrates, int)
    assert isinstance(_trace_events_misses, int)
    assert rca_common._TRACE_EVENTS_COLD_REHYDRATES is not None
