"""M2 — idle-chores registry piggybacking on the verify worker tick."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from eden.closed_loop import verify


@pytest.fixture(autouse=True)
def _clean_registry():
    verify._reset_state_for_tests()
    yield
    verify._reset_state_for_tests()


class _Clock:
    """Deterministic monotonic clock the registry reads."""

    def __init__(self) -> None:
        self.now = 1_000.0

    def monotonic(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch) -> _Clock:
    c = _Clock()
    monkeypatch.setattr(verify.time, "monotonic", c.monotonic)
    return c


@pytest.mark.asyncio
async def test_due_chores_run(clock):
    fn = AsyncMock()
    verify.register_idle_chore("c1", 60.0, fn)

    await verify._run_idle_chores()

    fn.assert_awaited_once()


@pytest.mark.asyncio
async def test_interval_respected(clock):
    fn = AsyncMock()
    verify.register_idle_chore("c1", 60.0, fn)

    await verify._run_idle_chores()
    clock.now += 30.0
    await verify._run_idle_chores()
    assert fn.await_count == 1  # not due yet

    clock.now += 31.0
    await verify._run_idle_chores()
    assert fn.await_count == 2


@pytest.mark.asyncio
async def test_failing_chore_is_isolated(clock, caplog):
    bad = AsyncMock(side_effect=RuntimeError("boom"))
    good = AsyncMock()
    verify.register_idle_chore("bad", 60.0, bad)
    verify.register_idle_chore("good", 60.0, good)

    await verify._run_idle_chores()  # must not raise

    bad.assert_awaited_once()
    good.assert_awaited_once()
    assert any("idle chore bad failed" in r.getMessage() for r in caplog.records)

    # The failure consumed the interval slot; neither reruns immediately.
    await verify._run_idle_chores()
    assert bad.await_count == 1
    assert good.await_count == 1


@pytest.mark.asyncio
async def test_register_replaces_by_name(clock):
    first = AsyncMock()
    second = AsyncMock()
    verify.register_idle_chore("c1", 60.0, first)
    verify.register_idle_chore("c1", 60.0, second)

    await verify._run_idle_chores()

    first.assert_not_awaited()
    second.assert_awaited_once()
    assert len(verify._IDLE_CHORES) == 1


def test_reset_state_clears_registry():
    verify.register_idle_chore("c1", 60.0, AsyncMock())
    verify._CHORE_LAST_RUN["c1"] = 1.0

    verify._reset_state_for_tests()

    assert verify._IDLE_CHORES == []
    assert verify._CHORE_LAST_RUN == {}


def test_default_chores_registered():
    verify._register_default_chores()

    by_name = {c.name: c for c in verify._IDLE_CHORES}
    assert set(by_name) == {
        "outbox_drain",
        "outbox_ttl_cleanup",
        "fix_pending_janitor",  # M3
        "stale_plans_janitor",  # M13 §6.6
    }
    assert by_name["outbox_drain"].interval_s == 60.0
    assert by_name["outbox_ttl_cleanup"].interval_s == 6 * 3600.0
    assert by_name["fix_pending_janitor"].interval_s == 300.0
    assert by_name["stale_plans_janitor"].interval_s == 3600.0

    from eden.closed_loop import event_bus

    assert by_name["outbox_drain"].fn is event_bus.drain_outbox
    assert by_name["outbox_ttl_cleanup"].fn is event_bus.cleanup_drained
    assert by_name["fix_pending_janitor"].fn is verify.fix_pending_janitor
    assert by_name["stale_plans_janitor"].fn is verify.stale_plans_janitor
