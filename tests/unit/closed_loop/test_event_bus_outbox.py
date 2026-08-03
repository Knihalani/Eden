"""M2 (D4) — durable outbox fallback for the closed-loop event bus."""

from __future__ import annotations

import json
import logging
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop.events import LoopEvent


@pytest.fixture(autouse=True)
def _reset_failure_ts():
    import eden.closed_loop.event_bus as eb

    eb.last_publish_failure_ts = None
    yield
    eb.last_publish_failure_ts = None


def _event(**overrides) -> LoopEvent:
    fields = {
        "type": "verify_passed",
        "org_id": "org-1",
        "issue_id": "00000000-0000-0000-0000-000000000001",
        "ref": "ref-1",
    }
    fields.update(overrides)
    return LoopEvent.from_fields(fields)


@pytest.mark.asyncio
async def test_publish_without_redis_writes_outbox_row(caplog):
    import eden.closed_loop.event_bus as eb

    client = MagicMock()
    client.execute = AsyncMock()
    with (
        patch("eden.storage.redis.get_redis_client", AsyncMock(return_value=None)),
        patch.object(eb, "_pg", AsyncMock(return_value=client)),
        caplog.at_level(logging.ERROR, logger="eden.closed_loop.event_bus"),
    ):
        ok = await eb.publish(_event())

    assert ok is True  # durably queued
    assert eb.last_publish_failure_ts is not None
    assert any(
        r.levelno == logging.ERROR and "publish failed" in r.getMessage()
        for r in caplog.records
    )
    client.execute.assert_awaited_once()
    sql, org_id, event_json = client.execute.await_args.args
    assert "INSERT INTO loop_events_outbox" in sql
    assert org_id == "org-1"
    fields = json.loads(event_json)
    assert fields["type"] == "verify_passed"
    assert fields["issue_id"] == "00000000-0000-0000-0000-000000000001"


@pytest.mark.asyncio
async def test_publish_with_pg_also_down_returns_false(caplog):
    import eden.closed_loop.event_bus as eb

    with (
        patch("eden.storage.redis.get_redis_client", AsyncMock(return_value=None)),
        patch.object(eb, "_pg", AsyncMock(return_value=None)),
        caplog.at_level(logging.ERROR, logger="eden.closed_loop.event_bus"),
    ):
        ok = await eb.publish(_event())

    assert ok is False
    assert eb.last_publish_failure_ts is not None
    assert any("outbox insert failed" in r.getMessage() for r in caplog.records)


@pytest.mark.asyncio
async def test_successful_publish_clears_failure_ts():
    import eden.closed_loop.event_bus as eb

    eb.last_publish_failure_ts = 123.0
    redis = MagicMock()
    redis.xadd = AsyncMock()

    ok = await eb.publish(_event(), redis=redis)

    assert ok is True
    assert eb.last_publish_failure_ts is None
    redis.xadd.assert_awaited_once()
    assert redis.xadd.await_args.args[0] == eb.LOOP_STREAM


@pytest.mark.asyncio
async def test_drain_replays_in_order_once_and_stamps_drained():
    import eden.closed_loop.event_bus as eb

    f1 = _event(ref="a").to_fields()
    f2 = _event(ref="b").to_fields()
    rows = [
        {"id": 1, "event": json.dumps(f1)},  # asyncpg jsonb-as-str
        {"id": 2, "event": dict(f2)},  # jsonb codec configured
    ]
    client = MagicMock()
    client.fetch = AsyncMock(return_value=rows)
    client.execute = AsyncMock()
    redis = MagicMock()
    redis.xadd = AsyncMock()

    with (
        patch.object(eb, "_pg", AsyncMock(return_value=client)),
        patch("eden.storage.redis.get_redis_client", AsyncMock(return_value=redis)),
    ):
        drained = await eb.drain_outbox()

    assert drained == 2
    fetch_sql = client.fetch.await_args.args[0]
    assert "drained_at IS NULL" in fetch_sql
    assert "retry_after_ts IS NULL OR retry_after_ts <= NOW()" in fetch_sql
    assert "ORDER BY id ASC" in fetch_sql
    # Replayed oldest-first, exactly once each.
    assert [c.args[1]["ref"] for c in redis.xadd.await_args_list] == ["a", "b"]
    # drained_at stamped per row.
    stamped = [c.args for c in client.execute.await_args_list]
    assert all("SET drained_at = NOW()" in s[0] for s in stamped)
    assert [s[1] for s in stamped] == [1, 2]


@pytest.mark.asyncio
async def test_drain_stops_on_first_publish_failure():
    import eden.closed_loop.event_bus as eb

    rows = [
        {"id": i, "event": json.dumps(_event(ref=str(i)).to_fields())}
        for i in (1, 2, 3)
    ]
    client = MagicMock()
    client.fetch = AsyncMock(return_value=rows)
    client.execute = AsyncMock()
    redis = MagicMock()
    redis.xadd = AsyncMock(side_effect=[None, ConnectionError("gone"), None])

    with (
        patch.object(eb, "_pg", AsyncMock(return_value=client)),
        patch("eden.storage.redis.get_redis_client", AsyncMock(return_value=redis)),
    ):
        drained = await eb.drain_outbox()

    assert drained == 1
    assert redis.xadd.await_count == 2  # row 3 never attempted
    # Only row 1 stamped.
    assert [c.args[1] for c in client.execute.await_args_list] == [1]


@pytest.mark.asyncio
async def test_drain_without_redis_leaves_rows():
    import eden.closed_loop.event_bus as eb

    client = MagicMock()
    client.fetch = AsyncMock(
        return_value=[{"id": 1, "event": json.dumps(_event().to_fields())}]
    )
    client.execute = AsyncMock()

    with (
        patch.object(eb, "_pg", AsyncMock(return_value=client)),
        patch("eden.storage.redis.get_redis_client", AsyncMock(return_value=None)),
    ):
        drained = await eb.drain_outbox()

    assert drained == 0
    client.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_outbox_depth_counts_undrained():
    import eden.closed_loop.event_bus as eb

    client = MagicMock()
    client.fetchrow = AsyncMock(return_value={"n": 4})
    with patch.object(eb, "_pg", AsyncMock(return_value=client)):
        assert await eb.outbox_depth() == 4
    sql = client.fetchrow.await_args.args[0]
    assert "WHERE drained_at IS NULL" in sql

    with patch.object(eb, "_pg", AsyncMock(return_value=None)):
        assert await eb.outbox_depth() == 0


@pytest.mark.asyncio
async def test_cleanup_deletes_only_old_drained_rows():
    import eden.closed_loop.event_bus as eb

    client = MagicMock()
    client.execute = AsyncMock(return_value="DELETE 3")
    with patch.object(eb, "_pg", AsyncMock(return_value=client)):
        deleted = await eb.cleanup_drained(older_than_days=7)

    assert deleted == 3
    sql, days = client.execute.await_args.args
    assert "drained_at IS NOT NULL" in sql
    assert "drained_at <" in sql
    assert days == "7"
