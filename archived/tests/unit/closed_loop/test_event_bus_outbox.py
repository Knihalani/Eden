"""N5 — Postgres outbox is the primary closed-loop queue.

Covers publish (insert + pending-key dedup), drain (claim / dispatch /
backoff / dead-letter), depth, oldest-pending age, and TTL cleanup.
"""

from __future__ import annotations

import json
import logging
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import eden.closed_loop.event_bus as eb
from eden.closed_loop.events import LoopEvent


@pytest.fixture(autouse=True)
def _reset_bus_state():
    eb.last_publish_failure_ts = None
    eb._seen.clear()
    yield
    eb.last_publish_failure_ts = None
    eb._seen.clear()


def _event(**overrides) -> LoopEvent:
    fields = {
        "type": "verify_passed",
        "org_id": "org-1",
        "issue_id": "00000000-0000-0000-0000-000000000001",
        "ref": "ref-1",
    }
    fields.update(overrides)
    return LoopEvent.from_fields(fields)


def _rows(*refs: str, attempts: int = 0) -> list[dict]:
    return [
        {
            "id": i + 1,
            "event": json.dumps(_event(ref=ref).to_fields()),
            "attempts": attempts,
        }
        for i, ref in enumerate(refs)
    ]


# ── publish ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_publish_writes_outbox_row():
    client = MagicMock()
    client.execute = AsyncMock()
    with patch.object(eb, "_pg", AsyncMock(return_value=client)):
        ok = await eb.publish(_event())

    assert ok is True
    assert eb.last_publish_failure_ts is None
    client.execute.assert_awaited_once()
    sql, org_id, event_json, idem_key = client.execute.await_args.args
    assert "INSERT INTO loop_events_outbox" in sql
    assert "ON CONFLICT (idempotency_key) WHERE drained_at IS NULL" in sql
    assert org_id == "org-1"
    fields = json.loads(event_json)
    assert fields["type"] == "verify_passed"
    assert fields["issue_id"] == "00000000-0000-0000-0000-000000000001"
    assert idem_key == "00000000-0000-0000-0000-000000000001:verify_passed:ref-1"


@pytest.mark.asyncio
async def test_publish_with_pg_down_returns_false(caplog):
    with (
        patch.object(eb, "_pg", AsyncMock(return_value=None)),
        caplog.at_level(logging.ERROR, logger="eden.closed_loop.event_bus"),
    ):
        ok = await eb.publish(_event())

    assert ok is False
    assert eb.last_publish_failure_ts is not None
    assert any("publish failed" in r.getMessage() for r in caplog.records)


@pytest.mark.asyncio
async def test_successful_publish_clears_failure_ts():
    eb.last_publish_failure_ts = 123.0
    client = MagicMock()
    client.execute = AsyncMock()
    with patch.object(eb, "_pg", AsyncMock(return_value=client)):
        ok = await eb.publish(_event())

    assert ok is True
    assert eb.last_publish_failure_ts is None


@pytest.mark.asyncio
async def test_schedule_retry_sets_future_retry_after():
    client = MagicMock()
    client.execute = AsyncMock()
    with patch.object(eb, "_pg", AsyncMock(return_value=client)):
        ok = await eb.schedule_retry(_event(), delay_seconds=90)

    assert ok is True
    sql = client.execute.await_args.args[0]
    assert "retry_after_ts" in sql
    assert "ON CONFLICT" in sql


# ── drain ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_drain_dispatches_in_order_and_stamps_drained():
    orch = MagicMock()
    orch.on_event = AsyncMock()
    client = MagicMock()
    client.fetch = AsyncMock(return_value=_rows("a", "b"))
    client.execute = AsyncMock()

    with patch.object(eb, "_pg", AsyncMock(return_value=client)):
        handled = await eb.drain_outbox(orchestrator=orch)

    assert handled == 2
    fetch_sql = client.fetch.await_args.args[0]
    assert "drained_at IS NULL" in fetch_sql
    assert "retry_after_ts IS NULL OR retry_after_ts <= NOW()" in fetch_sql
    assert "ORDER BY id ASC" in fetch_sql
    assert "FOR UPDATE SKIP LOCKED" in fetch_sql
    # Dispatched oldest-first, exactly once each.
    assert [c.args[0].ref for c in orch.on_event.await_args_list] == ["a", "b"]
    stamped = [c.args for c in client.execute.await_args_list]
    assert all("SET drained_at = NOW()" in s[0] for s in stamped)
    assert [s[1] for s in stamped] == [1, 2]


@pytest.mark.asyncio
async def test_drain_failure_increments_attempts_and_requeues():
    orch = MagicMock()
    orch.on_event = AsyncMock(side_effect=RuntimeError("handler boom"))
    client = MagicMock()
    client.fetch = AsyncMock(return_value=_rows("a", attempts=1))
    client.execute = AsyncMock()

    with patch.object(eb, "_pg", AsyncMock(return_value=client)):
        handled = await eb.drain_outbox(orchestrator=orch)

    assert handled == 0  # nothing handled successfully
    sql, row_id, attempts, err, backoff = client.execute.await_args.args
    assert "SET attempts = $2" in sql
    assert "retry_after_ts" in sql
    assert row_id == 1
    assert attempts == 2
    assert "handler boom" in err
    assert int(backoff) >= 10


@pytest.mark.asyncio
async def test_drain_dead_letters_after_max_deliveries(caplog):
    orch = MagicMock()
    orch.on_event = AsyncMock(side_effect=RuntimeError("handler boom"))
    client = MagicMock()
    client.fetch = AsyncMock(
        return_value=_rows("a", attempts=eb._MAX_DELIVERIES - 1)
    )
    client.execute = AsyncMock()

    with (
        patch.object(eb, "_pg", AsyncMock(return_value=client)),
        caplog.at_level(logging.ERROR, logger="eden.closed_loop.event_bus"),
    ):
        handled = await eb.drain_outbox(orchestrator=orch)

    assert handled == 0
    sql, row_id, attempts, err = client.execute.await_args.args
    # Dead-lettered via a drained stamp (GC'd by cleanup_drained later).
    assert "SET drained_at = NOW()" in sql
    assert attempts == eb._MAX_DELIVERIES
    assert any("dead-letter" in r.getMessage() for r in caplog.records)


@pytest.mark.asyncio
async def test_drain_skips_seen_idempotency_key():
    orch = MagicMock()
    orch.on_event = AsyncMock()
    client = MagicMock()
    client.fetch = AsyncMock(return_value=_rows("a"))
    client.execute = AsyncMock()

    with patch.object(eb, "_pg", AsyncMock(return_value=client)):
        assert await eb.drain_outbox(orchestrator=orch) == 1
    assert orch.on_event.await_count == 1

    # Same key again within the window → acknowledged, not re-dispatched.
    orch.on_event.reset_mock()
    client.execute.reset_mock()
    with patch.object(eb, "_pg", AsyncMock(return_value=client)):
        assert await eb.drain_outbox(orchestrator=orch) == 1

    orch.on_event.assert_not_awaited()
    stamped = [c.args for c in client.execute.await_args_list]
    assert all("SET drained_at = NOW()" in s[0] for s in stamped)


@pytest.mark.asyncio
async def test_drain_without_pg_returns_zero():
    with patch.object(eb, "_pg", AsyncMock(return_value=None)):
        assert await eb.drain_outbox() == 0


@pytest.mark.asyncio
async def test_drain_defaults_to_real_orchestrator():
    """No explicit orchestrator → the singleton orchestrator is used."""
    client = MagicMock()
    client.fetch = AsyncMock(return_value=_rows("a"))
    client.execute = AsyncMock()

    from eden.closed_loop.orchestrator import get_orchestrator

    real = get_orchestrator()
    with patch.object(eb, "_pg", AsyncMock(return_value=client)):
        assert await eb.drain_outbox() == 1
    client.execute.assert_awaited_once()
    assert real is not None


# ── depth / age / cleanup ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_outbox_depth_counts_undrained():
    client = MagicMock()
    client.fetchrow = AsyncMock(return_value={"n": 4})
    with patch.object(eb, "_pg", AsyncMock(return_value=client)):
        assert await eb.outbox_depth() == 4
    sql = client.fetchrow.await_args.args[0]
    assert "WHERE drained_at IS NULL" in sql

    with patch.object(eb, "_pg", AsyncMock(return_value=None)):
        assert await eb.outbox_depth() == 0


@pytest.mark.asyncio
async def test_oldest_pending_age_s():
    client = MagicMock()
    client.fetchrow = AsyncMock(return_value={"age": 42.5})
    with patch.object(eb, "_pg", AsyncMock(return_value=client)):
        assert await eb.oldest_pending_age_s() == 42.5

    client.fetchrow = AsyncMock(return_value={"age": None})
    with patch.object(eb, "_pg", AsyncMock(return_value=client)):
        assert await eb.oldest_pending_age_s() is None

    with patch.object(eb, "_pg", AsyncMock(return_value=None)):
        assert await eb.oldest_pending_age_s() is None


@pytest.mark.asyncio
async def test_cleanup_deletes_only_old_drained_rows():
    client = MagicMock()
    client.execute = AsyncMock(return_value="DELETE 3")
    with patch.object(eb, "_pg", AsyncMock(return_value=client)):
        deleted = await eb.cleanup_drained(older_than_days=7)

    assert deleted == 3
    sql, days = client.execute.await_args.args
    assert "drained_at IS NOT NULL" in sql
    assert "drained_at <" in sql
    assert days == "7"
