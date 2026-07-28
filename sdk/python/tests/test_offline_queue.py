"""Tests for ``eden_sdk.offline_queue`` (durable SQLite spill queue)."""

from __future__ import annotations

import logging
from pathlib import Path

import pytest

from eden_sdk.client import EdenClient
from eden_sdk.config import EdenConfig
from eden_sdk.offline_queue import OfflineQueue


def test_overflow_drops_oldest_and_increments_dropped_counter(tmp_path: Path) -> None:
    q = OfflineQueue(tmp_path / "q.sqlite3", max_rows=5)
    for i in range(8):
        q.enqueue("openai", {"i": i})
    assert q.size() == 5
    assert q.dropped == 3
    # Oldest rows (0, 1, 2) must be the ones evicted -- the survivors
    # are the most recent five.
    rows = q.drain(limit=10)
    payloads = [p["i"] for _, _, p in rows]
    assert payloads == [3, 4, 5, 6, 7]
    q.close()


def test_overflow_logs_a_warning(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Overflow drops must be observable in logs.

    Regression: ``_trim_locked`` silently dropped rows with no
    logging, unlike the in-memory queue's back-pressure drop
    (``"eden sdk: queue full, dropped event"``) and the streaming
    chunk buffer's overflow warning -- both of which already log.
    """
    q = OfflineQueue(tmp_path / "q-log.sqlite3", max_rows=2)
    with caplog.at_level(logging.WARNING, logger="eden_sdk.offline_queue"):
        for i in range(5):
            q.enqueue("openai", {"i": i})
    assert any(
        "offline queue full" in rec.getMessage() for rec in caplog.records
    )
    q.close()


def test_enqueue_many_overflow_also_logs_and_counts(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    q = OfflineQueue(tmp_path / "q-batch.sqlite3", max_rows=3)
    with caplog.at_level(logging.WARNING, logger="eden_sdk.offline_queue"):
        q.enqueue_many([("openai", {"i": i}) for i in range(10)])
    assert q.size() == 3
    assert q.dropped == 7
    assert any(
        "offline queue full" in rec.getMessage() for rec in caplog.records
    )
    q.close()


def test_no_overflow_does_not_log_or_increment_dropped(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    q = OfflineQueue(tmp_path / "q-nooverflow.sqlite3", max_rows=10)
    with caplog.at_level(logging.WARNING, logger="eden_sdk.offline_queue"):
        for i in range(3):
            q.enqueue("openai", {"i": i})
    assert q.dropped == 0
    assert not any(
        "offline queue full" in rec.getMessage() for rec in caplog.records
    )
    q.close()


def test_eden_client_surfaces_offline_dropped_stat(tmp_path: Path) -> None:
    """``OfflineQueue.dropped`` must be reachable from ``EdenClient``.

    Previously it was write-only: incremented in ``_trim_locked`` but
    never exposed anywhere, so operators had no way to observe durable
    offline-queue data loss.
    """
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            dry_run=True,
            offline_queue_path=str(tmp_path / "q.sqlite3"),
        )
    )
    assert client._offline is not None
    assert client.offline_dropped == 0
    client._offline.max_rows = 2
    for i in range(5):
        client._offline.enqueue("openai", {"i": i})
    assert client.offline_dropped == 3
    assert client.offline_dropped == client._offline.dropped
    client._offline.close()


def test_offline_dropped_is_zero_without_offline_queue() -> None:
    client = EdenClient(EdenConfig(org_id="o", api_key="k", dry_run=True))
    assert client._offline is None
    assert client.offline_dropped == 0


def test_update_many_updates_in_place_without_inserting(tmp_path: Path) -> None:
    """``update_many`` must overwrite the existing row (same id, same
    total row count) rather than inserting a new one -- this is the
    primitive ``EdenClient._spill_offline`` relies on to avoid
    duplicating an already-durable row on every failing retry cycle.
    """
    q = OfflineQueue(tmp_path / "q-update.sqlite3")
    q.enqueue("openai", {"event_id": "row-a"})
    q.enqueue("openai", {"event_id": "row-b"})
    assert q.size() == 2
    rows = q.drain(limit=10)
    row_a_id = next(rid for rid, _, p in rows if p["event_id"] == "row-a")

    q.update_many([(row_a_id, "anthropic", {"event_id": "row-a-v2"})])

    # Size unchanged -- no new row was inserted.
    assert q.size() == 2
    updated = {rid: (fmt, p) for rid, fmt, p in q.drain(limit=10)}
    assert row_a_id in updated
    fmt, payload = updated[row_a_id]
    assert fmt == "anthropic"
    assert payload == {"event_id": "row-a-v2"}
    q.close()


def test_update_many_is_noop_for_missing_id(tmp_path: Path) -> None:
    """Updating a row id that no longer exists (e.g. already acked)
    must be silently ignored, not raise or insert a phantom row."""
    q = OfflineQueue(tmp_path / "q-update-missing.sqlite3")
    q.enqueue("openai", {"event_id": "row-x"})
    assert q.size() == 1
    rows = q.drain(limit=10)
    row_id = rows[0][0]
    q.ack([row_id])
    assert q.size() == 0

    q.update_many([(row_id, "openai", {"event_id": "row-x-late"})])
    assert q.size() == 0
    assert q.drain(limit=10) == []
    q.close()


def test_update_many_empty_list_is_noop(tmp_path: Path) -> None:
    q = OfflineQueue(tmp_path / "q-update-empty.sqlite3")
    q.enqueue("openai", {"event_id": "row-y"})
    assert q.size() == 1
    q.update_many([])
    assert q.size() == 1
    q.close()
