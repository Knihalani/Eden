"""Phase 3 — ingest hot-path batching for ``_route_postgres_many``.

Before this change, ``_route_postgres_many`` built each row via
``asyncio.gather(*(self._prepare_postgres_row(e) for e in events))``,
which meant:

  * N separate ``compress_many`` dispatches (one ``asyncio.to_thread``
    each) instead of one dispatch for the whole batch's 8*N fields.
  * up to 2N separate ``MessageStore`` dedup transactions (one
    ``upsert_request``/``upsert_response`` per event) instead of one
    ``MessageStore.upsert_batch`` executemany for the whole batch.

These tests assert the batched call counts and that row content /
hash-array assignment stay correct under batching.
"""
from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.observability.telemetry_collector import TelemetryCollector, TelemetryEvent


def _event(idx: int, *, request_body=None, response_body=None) -> TelemetryEvent:
    return TelemetryEvent(
        event_id=f"evt-{idx}",
        tenant_id="org-1",
        project_id="proj-1",
        trace_id=f"trace-{idx}",
        realm="production",
        event_type="llm.completion",
        timestamp=datetime.now(UTC).isoformat(),
        request_body=request_body,
        response_body=response_body,
    )


def _collector_with_pg(fake_pg: MagicMock) -> TelemetryCollector:
    collector = TelemetryCollector()
    collector._postgres = fake_pg
    return collector


@pytest.mark.asyncio
async def test_compress_many_called_once_for_whole_batch() -> None:
    """3 events -> ONE compress_many call over 24 (3*8) flattened fields,
    not 3 separate calls."""
    fake_pg = MagicMock()
    fake_pg.executemany = AsyncMock()
    collector = _collector_with_pg(fake_pg)
    events = [
        _event(i, request_body={"messages": [{"role": "user", "content": f"hi {i}"}]})
        for i in range(3)
    ]

    with patch(
        "eden.storage.compression.compress_many",
        return_value=[None] * 24,
    ) as mock_compress, patch(
        "eden.observability.message_store.get_message_store",
    ) as mock_get_store:
        mock_store = MagicMock()
        mock_store.upsert_batch = AsyncMock(return_value=[["h1"], ["h2"], ["h3"]])
        mock_get_store.return_value = mock_store

        await collector._route_postgres_many(events)

    mock_compress.assert_called_once()
    (flat_fields,) = mock_compress.call_args.args
    assert len(flat_fields) == 24
    fake_pg.executemany.assert_awaited_once()


@pytest.mark.asyncio
async def test_dedupe_batch_called_once_not_per_event() -> None:
    """N events each needing request-message dedup -> ONE
    ``MessageStore.upsert_batch`` call carrying all N entries."""
    fake_pg = MagicMock()
    fake_pg.executemany = AsyncMock()
    collector = _collector_with_pg(fake_pg)
    events = [
        _event(i, request_body={"messages": [{"role": "user", "content": f"hi {i}"}]})
        for i in range(4)
    ]

    with patch(
        "eden.storage.compression.compress_many",
        return_value=[None] * 32,
    ), patch(
        "eden.observability.message_store.get_message_store",
    ) as mock_get_store:
        mock_store = MagicMock()
        mock_store.upsert_batch = AsyncMock(
            return_value=[[f"hash-{i}"] for i in range(4)]
        )
        mock_get_store.return_value = mock_store

        await collector._route_postgres_many(events)

        mock_store.upsert_batch.assert_awaited_once()
        (entries,) = mock_store.upsert_batch.await_args.args
        assert len(entries) == 4

    # Hashes must land back on the right event, in order.
    for i, event in enumerate(events):
        assert event.request_message_hashes == [f"hash-{i}"]


@pytest.mark.asyncio
async def test_dedupe_batch_covers_request_and_response_separately() -> None:
    """An event needing BOTH request and response dedup contributes TWO
    entries to the batch call (matching the per-event path's up-to-2-calls
    semantics, just merged into one round trip for the whole batch)."""
    fake_pg = MagicMock()
    fake_pg.executemany = AsyncMock()
    collector = _collector_with_pg(fake_pg)
    events = [
        _event(
            0,
            request_body={"messages": [{"role": "user", "content": "hi"}]},
            response_body={"choices": [{"message": {"role": "assistant", "content": "ok"}}]},
        )
    ]

    with patch(
        "eden.storage.compression.compress_many",
        return_value=[None] * 8,
    ), patch(
        "eden.observability.message_store.get_message_store",
    ) as mock_get_store:
        mock_store = MagicMock()
        mock_store.upsert_batch = AsyncMock(return_value=[["req-hash"], ["resp-hash"]])
        mock_get_store.return_value = mock_store

        await collector._route_postgres_many(events)

        (entries,) = mock_store.upsert_batch.await_args.args
        assert len(entries) == 2

    assert events[0].request_message_hashes == ["req-hash"]
    assert events[0].response_message_hashes == ["resp-hash"]


@pytest.mark.asyncio
async def test_dedupe_skipped_when_kill_switch_off() -> None:
    """``content_dedupe_enabled=False`` must skip the MessageStore call
    entirely for the batch path too."""
    fake_pg = MagicMock()
    fake_pg.executemany = AsyncMock()
    collector = _collector_with_pg(fake_pg)
    events = [
        _event(0, request_body={"messages": [{"role": "user", "content": "hi"}]}),
    ]

    settings = MagicMock()
    settings.content_dedupe_enabled = False

    with patch(
        "eden.storage.compression.compress_many",
        return_value=[None] * 8,
    ), patch(
        "eden.config.get_settings", return_value=settings,
    ), patch(
        "eden.observability.message_store.get_message_store",
    ) as mock_get_store:
        await collector._route_postgres_many(events)

    mock_get_store.assert_not_called()
    assert events[0].request_message_hashes == []


@pytest.mark.asyncio
async def test_no_messages_skips_dedupe_batch_call_entirely() -> None:
    """Events with no request/response body must not trigger
    ``upsert_batch`` at all (matches the empty-entries short circuit)."""
    fake_pg = MagicMock()
    fake_pg.executemany = AsyncMock()
    collector = _collector_with_pg(fake_pg)
    events = [_event(i) for i in range(3)]

    with patch(
        "eden.storage.compression.compress_many",
        return_value=[None] * 24,
    ), patch(
        "eden.observability.message_store.get_message_store",
    ) as mock_get_store:
        await collector._route_postgres_many(events)

    mock_get_store.assert_not_called()


@pytest.mark.asyncio
async def test_rows_preserve_event_order_under_batching() -> None:
    """The flattened-compress + zip-back path must not scramble which
    compressed fields land on which event's row."""
    fake_pg = MagicMock()
    fake_pg.executemany = AsyncMock()
    collector = _collector_with_pg(fake_pg)
    events = [_event(i) for i in range(5)]

    with patch(
        "eden.storage.compression.compress_many",
        return_value=[None] * 40,
    ):
        await collector._route_postgres_many(events)

    fake_pg.executemany.assert_awaited_once()
    _, rows = fake_pg.executemany.await_args.args
    assert [row[0] for row in rows] == [f"evt-{i}" for i in range(5)]


@pytest.mark.asyncio
async def test_single_event_path_unaffected_by_batch_refactor() -> None:
    """``_route_postgres`` (single-event path) must still call
    ``compress_many`` with exactly 8 fields and dedupe per-event via
    ``upsert_request``/``upsert_response`` (not the batch API)."""
    fake_pg = MagicMock()
    fake_pg.execute = AsyncMock()
    collector = _collector_with_pg(fake_pg)
    event = _event(0, request_body={"messages": [{"role": "user", "content": "hi"}]})

    with patch(
        "eden.storage.compression.compress_many",
        return_value=[None] * 8,
    ) as mock_compress, patch(
        "eden.observability.message_store.get_message_store",
    ) as mock_get_store:
        mock_store = MagicMock()
        mock_store.upsert_request = AsyncMock(return_value=["h1"])
        mock_get_store.return_value = mock_store

        await collector._route_postgres(event)

    mock_compress.assert_called_once()
    (fields,) = mock_compress.call_args.args
    assert len(fields) == 8
    mock_store.upsert_request.assert_awaited_once()
    assert event.request_message_hashes == ["h1"]
