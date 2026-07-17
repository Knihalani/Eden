"""F06 — signal cluster + backfill tests."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.signals import backfill as bf
from eden.signals import clusterer as cl


class _FakePg:
    def __init__(self) -> None:
        self.executed: list[tuple[str, tuple[Any, ...]]] = []
        self._events: list[dict[str, Any]] = []

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        if "FROM signal_events" in sql and "matched = TRUE" in sql:
            return self._events
        if "DISTINCT trace_id" in sql and "telemetry_events" in sql:
            return [{"trace_id": f"t{i}"} for i in range(3)]
        if "signal_backfill_jobs" in sql and "status IN" in sql:
            return []
        return []

    async def execute(self, sql: str, *args: Any) -> str:
        self.executed.append((sql, args))
        return "UPDATE 1"

    async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
        if "COUNT(DISTINCT trace_id)" in sql:
            return {"n": 42}
        return None


def test_estimate_backfill_cost() -> None:
    assert bf.estimate_backfill_cost(100) == 1.0
    assert bf.estimate_backfill_cost(0) == 0.0


@pytest.mark.asyncio
async def test_enqueue_backfill_creates_job() -> None:
    pg = _FakePg()
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        with patch.object(bf, "count_traces_in_window", AsyncMock(return_value=10)):
            job = await bf.enqueue_backfill("org-1", str(uuid.uuid4()), window_days=7)
    assert job["traces_total"] == 10
    assert job["estimated_cost_usd"] == 0.1
    assert any("INSERT INTO signal_backfill_jobs" in sql for sql, _ in pg.executed)


@pytest.mark.asyncio
async def test_clusterer_groups_similar_events() -> None:
    pg = _FakePg()
    now = datetime.now(UTC)
    pg._events = [
        {
            "id": uuid.uuid4(),
            "trace_id": "t1",
            "payload": {"evidence": "user frustrated wrong answer"},
            "detected_at": now,
        },
        {
            "id": uuid.uuid4(),
            "trace_id": "t2",
            "payload": {"evidence": "user frustrated wrong answer again"},
            "detected_at": now - timedelta(hours=1),
        },
    ]
    clusterer = cl.SignalEventClusterer()
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        with patch.object(clusterer, "_embed", AsyncMock(return_value=[[1.0, 0.0], [0.99, 0.01]])):
            created = await clusterer.cluster_signal("org", str(uuid.uuid4()))
    assert created == 1
    assert any("INSERT INTO signal_clusters" in sql for sql, _ in pg.executed)


@pytest.mark.asyncio
async def test_resolve_quiet_clusters() -> None:
    pg = _FakePg()
    clusterer = cl.SignalEventClusterer()
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        n = await clusterer.resolve_quiet_clusters("org-1")
    assert n == 1
