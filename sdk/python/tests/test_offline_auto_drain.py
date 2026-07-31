"""The durable offline queue must drain itself.

``flush_offline()`` was correct and complete — and nothing ever called it. Events
spilled to SQLite while the collector was unreachable stayed there indefinitely
unless the application happened to invoke it by hand. For a feature whose entire
purpose is "do not lose events when the network is down", never draining is
equivalent to never having had it.

It cannot simply be called from the worker: ``flush_offline`` calls
``self.flush()``, which waits for the queue to drain, and the worker *is* what
drains the queue. Invoking it from inside the loop deadlocks until the 5s
timeout, on every tick. So the same work is split across ticks — ack the
previous slice, then pull the next while idle.

The lock in these tests is not incidental. ``OfflineQueue.drain`` is a plain
``SELECT ... LIMIT``; it does not claim rows, and rows stay until acked. Adding
the automatic drain alongside the existing manual one therefore created a real
duplicate-send, which five pre-existing tests caught immediately by observing a
single row delivered twice.
"""

from __future__ import annotations

import threading
from typing import Any

import pytest

from eden_sdk.client import EdenClient
from eden_sdk.config import EdenConfig
from eden_sdk.trace import TraceEvent


def _client(tmp_path: Any, **overrides: object) -> EdenClient:
    cfg: dict[str, Any] = dict(
        org_id="o",
        api_key="k",
        base_url="http://test.invalid",
        dry_run=False,
        max_queue=100,
        flush_interval_ms=10,
        offline_queue_path=str(tmp_path / "offline.sqlite3"),
    )
    cfg.update(overrides)
    return EdenClient(EdenConfig(**cfg))


class TestAckThenPull:
    def test_pull_enqueues_rows_and_tracks_them(self, tmp_path: Any) -> None:
        client = _client(tmp_path)
        assert client._offline is not None
        client._offline.enqueue("openai", {"event_id": "a"})
        client._offline.enqueue("openai", {"event_id": "b"})

        client._auto_drain_offline()

        assert client._queue.qsize() == 2, "rows were not re-enqueued"
        assert len(client._offline_inflight) == 2
        assert client._offline.size() == 2, "rows must stay until acked"

    def test_a_second_call_does_not_double_pull(self, tmp_path: Any) -> None:
        """In-flight rows block a new slice; otherwise the same row is resent."""
        client = _client(tmp_path)
        client._offline.enqueue("openai", {"event_id": "a"})

        client._auto_drain_offline()
        client._offline_next_drain_at = 0.0  # defeat the interval gate
        client._auto_drain_offline()

        assert client._queue.qsize() == 1, "the same row was pulled twice"

    def test_ack_removes_resolved_rows(self, tmp_path: Any) -> None:
        client = _client(tmp_path)
        client._offline.enqueue("openai", {"event_id": "a"})
        client._auto_drain_offline()
        assert client._offline.size() == 1

        # Simulate the worker having sent them: queue empty, generation caught
        # up, nothing marked unresolved.
        while not client._queue.empty():
            client._queue.get_nowait()
        client._processed_generation = client._generation
        client._offline_next_drain_at = 0.0

        client._auto_drain_offline()

        assert client._offline.size() == 0, "a delivered row was not acked"
        assert client._offline_inflight == []

    def test_an_unresolved_row_is_not_acked(self, tmp_path: Any) -> None:
        """A failed send must leave the row in SQLite for a later attempt."""
        client = _client(tmp_path)
        client._offline.enqueue("openai", {"event_id": "a"})
        client._auto_drain_offline()
        rid = client._offline_inflight[0]

        while not client._queue.empty():
            client._queue.get_nowait()
        client._processed_generation = client._generation
        client._unresolved_offline_rows.add(rid)
        client._offline_next_drain_at = 0.0

        client._auto_drain_offline()

        assert client._offline.size() == 1, (
            "an unresolved row was acked away — the event is lost"
        )

    def test_no_pull_while_live_traffic_is_queued(self, tmp_path: Any) -> None:
        """Replay must not compete with live events for the batch window."""
        client = _client(tmp_path)
        client._offline.enqueue("openai", {"event_id": "a"})
        client.enqueue(TraceEvent(payload={"event_id": "live"}, source_format="openai"))

        client._auto_drain_offline()

        assert client._offline_inflight == []
        assert client._queue.qsize() == 1, "a replay row jumped the live queue"

    def test_the_interval_gate_limits_sqlite_hits(self, tmp_path: Any) -> None:
        """Without it the worker queries SQLite on every idle tick."""
        client = _client(tmp_path)
        calls: list[int] = []
        real_drain = client._offline.drain

        def _counting_drain(limit: int = 100):
            calls.append(limit)
            return real_drain(limit=limit)

        client._offline.drain = _counting_drain  # type: ignore[method-assign]
        for _ in range(5):
            client._auto_drain_offline()

        assert len(calls) == 1, f"drained {len(calls)} times without waiting"

    def test_nothing_to_drain_is_harmless(self, tmp_path: Any) -> None:
        client = _client(tmp_path)
        client._auto_drain_offline()
        assert client._offline_inflight == []
        assert client._queue.qsize() == 0

    def test_disabled_offline_queue_is_a_no_op(self, tmp_path: Any) -> None:
        client = _client(tmp_path, offline_queue_path=None)
        assert client._offline is None
        client._auto_drain_offline()  # must not raise


class TestMutualExclusion:
    def test_auto_drain_skips_while_a_manual_flush_holds_the_lock(
        self, tmp_path: Any
    ) -> None:
        """The duplicate-send guard. ``drain`` does not claim rows."""
        client = _client(tmp_path)
        client._offline.enqueue("openai", {"event_id": "a"})

        client._offline_replay_lock.acquire()
        try:
            client._auto_drain_offline()
        finally:
            client._offline_replay_lock.release()

        assert client._queue.qsize() == 0, (
            "the automatic drain pulled rows while a manual flush held the "
            "replay lock — both would send the same row"
        )

    def test_auto_drain_does_not_block_waiting_for_the_lock(
        self, tmp_path: Any
    ) -> None:
        """A blocking acquire would stall the whole sender loop."""
        client = _client(tmp_path)
        client._offline.enqueue("openai", {"event_id": "a"})
        client._offline_replay_lock.acquire()
        done = threading.Event()

        def _run() -> None:
            client._auto_drain_offline()
            done.set()

        t = threading.Thread(target=_run, daemon=True)
        t.start()
        try:
            assert done.wait(timeout=2.0), (
                "the automatic drain blocked on the replay lock instead of "
                "skipping the tick — the sender loop would stall behind a "
                "manual flush"
            )
        finally:
            client._offline_replay_lock.release()
            t.join(timeout=2.0)

    def test_the_lock_is_released_even_if_the_body_raises(
        self, tmp_path: Any
    ) -> None:
        client = _client(tmp_path)

        def _boom() -> None:
            raise RuntimeError("nope")

        client._auto_drain_offline_locked = _boom  # type: ignore[method-assign]
        with pytest.raises(RuntimeError):
            client._auto_drain_offline()
        assert client._offline_replay_lock.acquire(blocking=False), (
            "the replay lock leaked — every later replay would be skipped"
        )
        client._offline_replay_lock.release()


class TestWiring:
    def test_the_loop_calls_the_auto_drain(self) -> None:
        """A method nothing calls is what this whole change is fixing."""
        import inspect

        src = inspect.getsource(EdenClient._async_loop)
        assert "self._auto_drain_offline()" in src, (
            "the sender loop never triggers the offline replay, so the durable "
            "queue only drains if the application calls flush_offline by hand"
        )

    def test_the_auto_drain_does_not_call_flush(self) -> None:
        """``flush()`` waits for the worker; calling it from the worker deadlocks."""
        import inspect

        src = inspect.getsource(EdenClient._auto_drain_offline_locked)
        assert "self.flush(" not in src, (
            "the automatic drain calls flush(), which waits for the very "
            "thread it runs on — that deadlocks until the timeout every tick"
        )
