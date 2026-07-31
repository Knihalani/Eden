"""A 413 must split the batch, not destroy it.

``_send_format`` classified status codes as retryable only for 408, 429 and 5xx.
413 therefore fell into the "permanent 4xx" branch, whose reasoning is sound for
auth and validation errors and wrong for this one:

    # Only spill transient failures. Permanent 4xx (auth/validation)
    # would poison the offline queue with payloads that can never succeed.
    ...
    self._mark_rows_resolved(row_ids)
    return True

So an oversized batch was counted as failed, deliberately **not** spilled, and its
offline row ids were marked *resolved* — acked away as though delivered. One 413
silently and permanently destroyed every event in the batch, including durable
replay rows whose whole purpose is to survive failure.

But 413 says nothing about the events; it is a statement about *this batch's
size*. The same events sent as two smaller batches succeed. The chunk path has
known that since it was written — ``_post_chunk_batch`` bisects on 413 — and the
main event path never got the same treatment.

Recursing through ``_send_format`` rather than looping keeps the per-row
bookkeeping exact, and drives a genuinely oversized single event down to a batch
of one, where the permanent-failure verdict is finally the right one.
"""

from __future__ import annotations

import gzip
import json
from typing import Any

import httpx
import pytest

from eden_sdk.client import EdenClient
from eden_sdk.config import EdenConfig
from eden_sdk.trace import TraceEvent


class _SizeLimitTransport(httpx.AsyncBaseTransport):
    """413s any request carrying more than ``max_events`` events."""

    def __init__(self, max_events: int) -> None:
        self.max_events = max_events
        self.batch_sizes: list[int] = []
        self.accepted: list[dict[str, Any]] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        body = gzip.decompress(request.content)
        parsed = json.loads(body)
        events = parsed if isinstance(parsed, list) else [parsed]
        self.batch_sizes.append(len(events))
        if len(events) > self.max_events:
            return httpx.Response(413, text="payload too large")
        self.accepted.extend(events)
        return httpx.Response(200, json={"accepted": len(events)})


def _client(transport: httpx.AsyncBaseTransport, **overrides: object) -> EdenClient:
    cfg: dict[str, Any] = dict(
        org_id="o",
        api_key="k",
        base_url="http://test.invalid",
        dry_run=False,
        max_queue=500,
        batch_size=200,
        flush_interval_ms=10,
    )
    cfg.update(overrides)
    return EdenClient(EdenConfig(**cfg), transport=transport)


def _events(n: int) -> list[TraceEvent]:
    return [
        TraceEvent(payload={"event_id": f"e{i}"}, source_format="openai")
        for i in range(n)
    ]


class TestBisectDelivers:
    @pytest.mark.asyncio
    async def test_every_event_arrives_despite_a_413(self) -> None:
        """The regression: all eight used to be discarded."""
        transport = _SizeLimitTransport(max_events=2)
        client = _client(transport)
        client.start()
        try:
            for ev in _events(8):
                client.enqueue(ev)
            client.flush(timeout=10.0)
        finally:
            client.shutdown(timeout=5.0)

        got = {e["event_id"] for e in transport.accepted}
        assert got == {f"e{i}" for i in range(8)}, (
            f"events lost to a 413: missing {sorted({f'e{i}' for i in range(8)} - got)}"
        )

    @pytest.mark.asyncio
    async def test_it_halves_rather_than_retrying_the_same_size(self) -> None:
        transport = _SizeLimitTransport(max_events=2)
        client = _client(transport)
        client.start()
        try:
            for ev in _events(8):
                client.enqueue(ev)
            client.flush(timeout=10.0)
        finally:
            client.shutdown(timeout=5.0)

        assert 8 in transport.batch_sizes, "the first attempt should be the whole batch"
        assert any(s in (4, 3) for s in transport.batch_sizes), (
            f"no halved attempt observed: {transport.batch_sizes}"
        )
        assert max(transport.batch_sizes) == 8, "a batch grew rather than shrank"

    @pytest.mark.asyncio
    async def test_sent_total_counts_the_delivered_events(self) -> None:
        transport = _SizeLimitTransport(max_events=2)
        client = _client(transport)
        client.start()
        try:
            for ev in _events(4):
                client.enqueue(ev)
            client.flush(timeout=10.0)
        finally:
            client.shutdown(timeout=5.0)
        assert client.sent == 4


class TestOfflineRowsSurvive:
    @pytest.mark.asyncio
    async def test_a_replay_row_is_not_acked_away_by_a_413(
        self, tmp_path: Any
    ) -> None:
        """The worst part of the old behaviour: durable rows acked as delivered.

        A row that a 413 destroyed was marked *resolved*, so ``flush_offline``
        read it as proof of delivery and deleted it from SQLite. The event whose
        durability the offline queue exists to guarantee was the one it lost.
        """
        transport = _SizeLimitTransport(max_events=1)
        client = _client(
            transport,
            offline_queue_path=str(tmp_path / "offline.sqlite3"),
        )
        assert client._offline is not None
        client._offline.enqueue("openai", {"event_id": "r1"})
        client._offline.enqueue("openai", {"event_id": "r2"})

        client.start()
        try:
            acked = client.flush_offline(limit=10, timeout=10.0)
        finally:
            client.shutdown(timeout=5.0)

        # Both rows are delivered via the bisect, so both may be acked.
        got = {e["event_id"] for e in transport.accepted}
        assert got == {"r1", "r2"}, f"a durable replay row was lost: {got}"
        assert acked == 2, f"expected both rows acked after delivery, got {acked}"
        assert client._offline.size() == 0


class TestSingleEventStillFailsPermanently:
    @pytest.mark.asyncio
    async def test_a_lone_oversized_event_is_not_retried_forever(self) -> None:
        """Bisecting to one event must terminate.

        A batch of one that still 413s genuinely cannot be sent, so the
        permanent-failure path is correct there — and the recursion must stop
        rather than splitting an empty list.
        """
        transport = _SizeLimitTransport(max_events=0)  # 413 everything
        client = _client(transport)
        client.start()
        try:
            for ev in _events(4):
                client.enqueue(ev)
            client.flush(timeout=10.0)
        finally:
            client.shutdown(timeout=5.0)

        assert transport.accepted == []
        # 4 -> 2+2 -> 1+1+1+1 == 7 requests. The important property is that it
        # terminated at all rather than recursing without bound.
        assert 1 in transport.batch_sizes, "never bisected down to a single event"
        assert len(transport.batch_sizes) < 32, (
            f"suspiciously many attempts ({len(transport.batch_sizes)}) — the "
            "bisect may not be terminating"
        )


class TestParity:
    def test_both_send_paths_handle_413(self) -> None:
        """The chunk path had this for ages; the event path did not."""
        import inspect

        from eden_sdk import client as mod

        chunk = inspect.getsource(mod.EdenClient._post_chunk_batch)
        batch = inspect.getsource(mod.EdenClient._send_batch)
        assert "413" in chunk, "the chunk path lost its bisect"
        assert "413" in batch, (
            "the main event path does not handle 413, so an oversized batch is "
            "classified as a permanent 4xx and destroyed"
        )
