"""Wave 9 — $0-cost ledger writes are buffered and flushed in one executemany.

``record_cost_event`` with cost_usd == 0 (classifier savings markers on the
always-on ``trace.finalized`` path) used to cost one ``execute()`` round-trip
per event. The batched path buffers them in-process and writes the whole
buffer in a single ``executemany`` — with an inline flush at
``cost_ledger_batch_max`` and a periodic flusher for trickling markers.
Cost > 0 events must stay write-through (billing-critical: budget + alert
round-trips), and the flag-off path must behave identically to before.
"""

from __future__ import annotations

import asyncio
import contextlib
import threading
from typing import Any
from unittest.mock import AsyncMock

import pytest

from eden.llmops import cost_ledger as cl


class _FakeClient:
    """Counts round-trips and captures what was written."""

    def __init__(self) -> None:
        self.execute_calls = 0
        self.executemany_calls = 0
        self.batches: list[list[tuple[Any, ...]]] = []
        self.fail_executemany = False

    async def execute(self, *args: Any, **kwargs: Any) -> None:
        self.execute_calls += 1

    async def executemany(self, sql: str, rows: list[tuple[Any, ...]]) -> None:
        self.executemany_calls += 1
        if self.fail_executemany:
            raise RuntimeError("simulated flush failure")
        self.batches.append(rows)


@pytest.fixture(autouse=True)
def _clean_ledger():
    cl.reset_zero_cost_buffer_for_tests()
    cl.reset_event_loop_binding()
    yield
    cl.reset_zero_cost_buffer_for_tests()
    cl.reset_event_loop_binding()


def _zero_event(*, org: str = "org-1", feature: str = "signal_classifier") -> cl.CostEvent:
    return cl.CostEvent(
        org_id=org,
        feature=feature,
        model="f34_logistic",
        cost_usd=0.0,
    )


def _patch_pg(monkeypatch: pytest.MonkeyPatch, client: _FakeClient) -> None:
    import eden.storage.postgres as pg_mod

    monkeypatch.setattr(pg_mod, "get_postgres_client", AsyncMock(return_value=client))


async def test_zero_cost_events_are_buffered_not_written(monkeypatch) -> None:
    client = _FakeClient()
    _patch_pg(monkeypatch, client)

    ok = await cl.record_cost_event(_zero_event())
    assert ok is True
    assert client.execute_calls == 0, "$0 event must not touch Postgres per-event"
    assert client.executemany_calls == 0
    assert cl.pending_zero_cost_event_count() == 1


async def test_flush_writes_all_in_one_executemany(monkeypatch) -> None:
    client = _FakeClient()
    _patch_pg(monkeypatch, client)

    for i in range(50):
        await cl.record_cost_event(_zero_event(org=f"org-{i % 3}"))

    written = await cl.flush_zero_cost_events()
    assert written == 50
    assert cl.pending_zero_cost_event_count() == 0
    assert client.executemany_calls == 1, "flush must be ONE executemany"
    assert client.execute_calls == 0
    rows = client.batches[0]
    assert len(rows) == 50
    # Row shape: (id, org_id, feature, model, cost, in, out, total, ...)
    assert rows[0][1] == "org-0"
    assert rows[0][2] == "signal_classifier"
    assert rows[0][3] == "f34_logistic"
    assert rows[0][4] == 0.0
    # Features unknown to KNOWN_FEATURES normalize to "unknown" — same as
    # the write-through path.
    await cl.record_cost_event(_zero_event(feature="bogus_feature"))
    await cl.flush_zero_cost_events()
    assert client.batches[-1][0][2] == "unknown"


async def test_positive_cost_stays_write_through(monkeypatch) -> None:
    client = _FakeClient()
    _patch_pg(monkeypatch, client)
    import eden.services.budget_service as bs

    record_usage = AsyncMock()
    eval_alerts = AsyncMock()
    monkeypatch.setattr(bs, "record_usage", record_usage)
    monkeypatch.setattr(bs, "evaluate_budget_alerts", eval_alerts)

    ok = await cl.record_cost_event(
        cl.CostEvent(org_id="org-1", feature="gateway", model="gpt-4o", cost_usd=0.5)
    )
    assert ok is True
    assert client.execute_calls == 1
    assert client.executemany_calls == 0
    record_usage.assert_awaited_once()
    eval_alerts.assert_awaited_once()
    assert cl.pending_zero_cost_event_count() == 0


async def test_inline_flush_at_threshold(monkeypatch) -> None:
    client = _FakeClient()
    _patch_pg(monkeypatch, client)
    monkeypatch.setattr(cl, "_zero_cost_batch_max", lambda: 2)

    await cl.record_cost_event(_zero_event())
    assert cl.pending_zero_cost_event_count() == 1
    assert client.executemany_calls == 0

    await cl.record_cost_event(_zero_event())
    # Second append crosses the threshold -> inline flush.
    assert client.executemany_calls == 1
    assert len(client.batches[0]) == 2
    assert cl.pending_zero_cost_event_count() == 0


async def test_flag_off_keeps_write_through(monkeypatch) -> None:
    client = _FakeClient()
    _patch_pg(monkeypatch, client)
    monkeypatch.setattr(cl, "_zero_cost_batching_enabled", lambda: False)

    ok = await cl.record_cost_event(_zero_event())
    assert ok is True
    assert client.execute_calls == 1, "flag off must write through exactly like before"
    assert client.executemany_calls == 0
    assert cl.pending_zero_cost_event_count() == 0


async def test_concurrent_appends_are_race_safe(monkeypatch) -> None:
    client = _FakeClient()
    _patch_pg(monkeypatch, client)

    async def _append(i: int) -> None:
        await cl.record_cost_event(_zero_event(org=f"org-{i % 5}"))

    await asyncio.gather(*(_append(i) for i in range(100)))
    assert cl.pending_zero_cost_event_count() == 100

    written = await cl.flush_zero_cost_events()
    assert written == 100
    assert client.executemany_calls == 1
    assert len(client.batches[0]) == 100


async def test_flush_failure_drops_without_raising(monkeypatch) -> None:
    client = _FakeClient()
    client.fail_executemany = True
    _patch_pg(monkeypatch, client)

    await cl.record_cost_event(_zero_event())
    # Must not raise, must not wedge the buffer forever (best-effort).
    written = await cl.flush_zero_cost_events()
    assert written == 0
    assert cl.pending_zero_cost_event_count() == 0
    assert client.executemany_calls == 1


async def test_flusher_loop_flushes_on_interval(monkeypatch) -> None:
    client = _FakeClient()
    _patch_pg(monkeypatch, client)
    monkeypatch.setattr(cl, "_zero_cost_batch_interval", lambda: 0.05)

    task = cl.start_zero_cost_flusher()
    assert task is not None
    try:
        await cl.record_cost_event(_zero_event())
        assert cl.pending_zero_cost_event_count() == 1
        for _ in range(50):
            if client.executemany_calls:
                break
            await asyncio.sleep(0.02)
        assert client.executemany_calls == 1, "periodic flusher must write buffered rows"
        assert cl.pending_zero_cost_event_count() == 0
    finally:
        await cl.stop_zero_cost_flusher(task)
    assert task.done()


async def test_stop_flusher_does_final_flush(monkeypatch) -> None:
    client = _FakeClient()
    _patch_pg(monkeypatch, client)

    task = cl.start_zero_cost_flusher()
    assert task is not None
    await cl.record_cost_event(_zero_event())
    await cl.stop_zero_cost_flusher(task)
    assert client.executemany_calls == 1, "shutdown must flush buffered rows"
    assert cl.pending_zero_cost_event_count() == 0


async def test_start_flusher_returns_none_when_disabled(monkeypatch) -> None:
    monkeypatch.setattr(cl, "_zero_cost_batching_enabled", lambda: False)
    assert cl.start_zero_cost_flusher() is None


async def test_cross_thread_zero_event_buffers_not_dropped(monkeypatch) -> None:
    """A $0 write from a worker thread lands in the buffer (not dropped)."""
    client = _FakeClient()
    _patch_pg(monkeypatch, client)

    cl.bind_event_loop()

    def in_thread() -> None:
        cl.schedule_record_from_usage(
            model="tencent/hy3",
            cost_usd=0.0,
            org_id="org-thread",
            feature="signal_classifier",
        )

    await asyncio.to_thread(in_thread)
    for _ in range(20):
        if cl.pending_zero_cost_event_count():
            break
        await asyncio.sleep(0.01)
    assert cl.pending_zero_cost_event_count() == 1
    assert client.execute_calls == 0


async def test_zero_event_without_org_is_dropped(monkeypatch) -> None:
    """The org guard still applies before buffering — unattributable $0
    markers must not accumulate forever against nobody."""
    client = _FakeClient()
    _patch_pg(monkeypatch, client)

    ok = await cl.record_cost_event(
        cl.CostEvent(
            org_id="", feature="signal_classifier", model="f34_logistic", cost_usd=0.0
        )
    )
    assert ok is False
    assert cl.pending_zero_cost_event_count() == 0
