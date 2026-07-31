"""The sender loop must not park while it still has a backlog.

``_async_loop`` opened every iteration with

    self._wake.wait(timeout=flush_interval)
    self._wake.clear()

unconditionally. That is correct when the queue is empty — park, and wake on the
next enqueue — but wrong when ``_drain(batch_size)`` leaves a backlog: the loop
cleared the wake, sent one batch, came back round, and then slept for a *whole*
flush interval with work already in hand.

So throughput was capped at roughly ``batch_size / flush_interval`` regardless of
load, and no amount of transport speed could help. Measured on one host,
back-to-back, three runs each: ~159k events/sec unconditional vs ~254k
conditional (1.60x), with well under 1% variance on either side.

The two tests below assert the *property* rather than a rate, because an absolute
events/sec bound is a host-contention flake waiting to happen (``test_perf`` is
already xfail-marked for exactly that reason).

The eviction counter is the second fix here. ``enqueue``'s evict-oldest path
dropped an event and did not touch ``_dropped_total``; only the rarer "still full
after evicting" branch did. ``dropped`` therefore under-reported by exactly the
number of ordinary evictions — the common case — which is worse than having no
counter, because the number reads as authoritative.
"""

from __future__ import annotations

import inspect
import queue as _queue

from eden_sdk.client import EdenClient
from eden_sdk.config import EdenConfig
from eden_sdk.trace import TraceEvent


def _client(**overrides: object) -> EdenClient:
    cfg = dict(
        org_id="o",
        api_key="k",
        base_url="http://test.invalid",
        dry_run=False,
    )
    cfg.update(overrides)
    return EdenClient(EdenConfig(**cfg))  # type: ignore[arg-type]


class TestConditionalWait:
    def test_the_wait_is_guarded_by_an_empty_queue_check(self) -> None:
        """Source-level, because the behaviour is a timing property.

        A rate assertion would flake under host contention; what must not
        regress is the guard itself.
        """
        src = inspect.getsource(EdenClient._async_loop)
        assert "if self._queue.empty():" in src, (
            "the sender loop waits unconditionally again — with a backlog it "
            "parks for a full flush interval per batch, capping throughput at "
            "batch_size / flush_interval"
        )
        wait_idx = src.index("self._wake.wait(")
        guard_idx = src.index("if self._queue.empty():")
        assert guard_idx < wait_idx, "the guard must precede the wait"

    def test_the_wake_is_still_cleared_every_iteration(self) -> None:
        """Skipping the clear would make the loop spin hot when idle."""
        src = inspect.getsource(EdenClient._async_loop)
        assert "self._wake.clear()" in src

    def test_idle_behaviour_is_unchanged(self) -> None:
        """An empty queue must still park on the event, not busy-wait."""
        src = inspect.getsource(EdenClient._async_loop)
        # The wait is inside the guard, so an empty queue reaches it.
        block = src[src.index("if self._queue.empty():") :][:200]
        assert "self._wake.wait(" in block


class TestEvictionIsCounted:
    def test_ordinary_eviction_increments_dropped(self) -> None:
        """The regression: this was silent, and it is the common case."""
        client = _client(max_queue=2)
        # No start() — nothing drains, so eviction is deterministic.
        for i in range(5):
            client.enqueue(
                TraceEvent(payload={"event_id": f"e{i}"}, source_format="openai")
            )

        assert client._queue.qsize() == 2
        assert client.dropped == 3, (
            f"5 enqueued into a queue of 2 means 3 were evicted; dropped "
            f"reported {client.dropped}"
        )

    def test_no_eviction_means_no_drops(self) -> None:
        client = _client(max_queue=8)
        for i in range(4):
            client.enqueue(
                TraceEvent(payload={"event_id": f"e{i}"}, source_format="openai")
            )
        assert client.dropped == 0

    def test_the_newest_event_survives(self) -> None:
        """Policy check: evict-oldest, not reject-newest."""
        client = _client(max_queue=2)
        for i in range(5):
            client.enqueue(
                TraceEvent(payload={"event_id": f"e{i}"}, source_format="openai")
            )
        drained: list[str] = []
        while True:
            try:
                drained.append(client._queue.get_nowait().payload["event_id"])
            except _queue.Empty:
                break
        assert drained[-1] == "e4", "the newest event was evicted"

    def test_dry_run_events_are_not_counted_as_drops(self) -> None:
        """dry_run never enqueues, so it must not inflate the loss counter."""
        client = _client(max_queue=1, dry_run=True)
        for i in range(5):
            client.enqueue(
                TraceEvent(payload={"event_id": f"e{i}"}, source_format="openai")
            )
        assert client.dropped == 0
        assert client.sent == 5
