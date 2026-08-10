"""Chaos — Postgres killed mid-loop (closed-loop event bus, N5).

Kills Postgres under ``eden.closed_loop.event_bus.publish`` (the client
is unavailable / raises) and asserts the loop fails *loudly* and
recovers:

1. ``publish`` returns False and stamps ``last_publish_failure_ts`` —
   events are dropped *honestly* (the outbox *is* the queue; there is
   no second store to buffer into),
2. the ``loop_dead_alert`` idle chore (verify worker) turns a stale
   failure stamp into an actual alert artifact — end-to-end from the
   bus probe to alert emission (the chore's internals are covered by
   ``tests/unit/closed_loop/test_loop_dead_alerting.py``), and
3. once Postgres returns, a successful publish clears the stamp and a
   crash-left pending row is re-claimed and dispatched on the next
   drain (at-least-once delivery via ``FOR UPDATE SKIP LOCKED``).

Same conventions as the rest of ``tests/chaos``: no real Postgres — a
stateful in-memory outbox stands in for PG and a dead client raises on
every call, mirroring the fixtures in
``tests/unit/closed_loop/test_event_bus_outbox.py``.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop.events import LoopEvent


class DeadPG:
    """Postgres stand-in whose calls all raise — 'killed mid-loop'."""

    def __init__(self) -> None:
        self.attempts = 0

    async def execute(self, *args: Any, **kwargs: Any) -> str:
        self.attempts += 1
        raise ConnectionError("chaos: postgres killed mid-loop")

    async def fetch(self, *args: Any, **kwargs: Any) -> list[Any]:
        self.attempts += 1
        raise ConnectionError("chaos: postgres killed mid-loop")

    async def fetchrow(self, *args: Any, **kwargs: Any) -> dict[str, Any] | None:
        self.attempts += 1
        raise ConnectionError("chaos: postgres killed mid-loop")


class FakeOutboxPG:
    """In-memory ``loop_events_outbox`` honoring the bus's real SQL."""

    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self._next_id = 1

    def _undrained(self) -> list[dict[str, Any]]:
        return [r for r in self.rows if r["drained_at"] is None]

    async def execute(self, sql: str, *args: Any) -> str:
        s = " ".join(sql.split())
        if s.startswith("INSERT INTO loop_events_outbox"):
            self.rows.append(
                {
                    "id": self._next_id,
                    "org_id": args[0],
                    "event": args[1],
                    "attempts": 0,
                    "drained_at": None,
                }
            )
            self._next_id += 1
            return "INSERT 0 1"
        if "SET drained_at = NOW()" in s and "attempts = $2" in s:
            # dead-letter stamp
            for r in self.rows:
                if r["id"] == args[0]:
                    r["drained_at"] = time.time()
                    r["attempts"] = args[1]
            return "UPDATE 1"
        if "SET drained_at = NOW()" in s:
            for r in self.rows:
                if r["id"] == args[0]:
                    r["drained_at"] = time.time()
            return "UPDATE 1"
        if "SET attempts = $2" in s:
            for r in self.rows:
                if r["id"] == args[0]:
                    r["attempts"] = args[1]
            return "UPDATE 1"
        raise AssertionError(f"unexpected SQL against fake outbox: {s}")

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        assert "FROM loop_events_outbox" in sql
        limit = int(args[0]) if args else 500
        return [
            {"id": r["id"], "event": r["event"], "attempts": r["attempts"]}
            for r in self._undrained()
        ][:limit]

    async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any]:
        assert "COUNT(*)" in sql
        return {"n": len(self._undrained())}


def _event(**overrides: Any) -> LoopEvent:
    fields = {
        "type": "verify_passed",
        "org_id": "org-chaos",
        "issue_id": "00000000-0000-0000-0000-000000000001",
        "ref": "ref-1",
    }
    fields.update(overrides)
    return LoopEvent.from_fields(fields)


@pytest.fixture(autouse=True)
def _reset_bus_state():
    import eden.closed_loop.event_bus as eb

    eb.last_publish_failure_ts = None
    eb._seen.clear()
    yield
    eb.last_publish_failure_ts = None
    eb._seen.clear()


@pytest.mark.asyncio
async def test_pg_kill_midloop_fails_loudly_and_recovers(caplog):
    import eden.closed_loop.event_bus as eb

    dead = DeadPG()
    with (
        patch.object(eb, "_pg", AsyncMock(return_value=dead)),
        caplog.at_level(logging.ERROR, logger="eden.closed_loop.event_bus"),
    ):
        results = [
            await eb.publish(_event(ref=ref)) for ref in ("a", "b", "c")
        ]

        # Honest drop: publish reports failure — nothing silently buffered.
        assert results == [False, False, False]
        assert dead.attempts >= 3

        # The bus probe is stamped for the loop-health surface.
        assert eb.last_publish_failure_ts is not None
        assert eb.last_publish_failure_ts == pytest.approx(time.time(), abs=30)

        # Failure was loud (ERROR), one log per failed publish.
        publish_errors = [
            r for r in caplog.records if "publish failed" in r.getMessage()
        ]
        assert len(publish_errors) == 3

    # Recovery: a healthy Postgres clears the failure stamp (probe green).
    pg = FakeOutboxPG()
    with patch.object(eb, "_pg", AsyncMock(return_value=pg)):
        assert await eb.publish(_event(ref="d")) is True
    assert eb.last_publish_failure_ts is None


@pytest.fixture()
def alert_sinks(monkeypatch):
    """Capture alert + Slack emissions; point the watchdog at an org.

    Mirrors the ``sinks`` fixture in
    ``tests/unit/closed_loop/test_loop_dead_alerting.py``.
    """
    from eden.closed_loop import event_bus, verify

    verify._reset_state_for_tests()
    monkeypatch.setattr(event_bus, "last_publish_failure_ts", None)

    alert_events: list[dict] = []
    slack_msgs: list[dict] = []

    async def _fake_alert_event(**kwargs):
        alert_events.append(kwargs)
        return {"id": "evt-1", **kwargs}

    async def _fake_slack(org_id, **kwargs):
        slack_msgs.append({"org_id": org_id, **kwargs})
        return {"status": "sent"}

    monkeypatch.setattr(
        "eden.alerts.repo.create_alert_event", _fake_alert_event
    )
    monkeypatch.setattr(
        "eden.services.slack_notify.notify_loop_dead", _fake_slack
    )
    from eden.config import get_settings

    monkeypatch.setattr(
        get_settings(), "loop_dead_alert_org_id", "org-chaos", raising=False
    )
    yield alert_events, slack_msgs
    verify._reset_state_for_tests()


@pytest.mark.asyncio
async def test_stale_publish_failure_reaches_alert_artifact(alert_sinks):
    """Bus probe → loop_dead_alert chore, end to end.

    The failure stamp is produced by the REAL publish path (Postgres
    raising), then aged past the 120s threshold; the chore must turn
    it into an alert artifact carrying the probe values.
    """
    import eden.closed_loop.event_bus as eb
    from eden.closed_loop import verify

    alert_events, slack_msgs = alert_sinks
    dead = DeadPG()

    with patch.object(eb, "_pg", AsyncMock(return_value=dead)):
        # Production stamp: publish fails against a dead Postgres.
        assert await eb.publish(_event(ref="stale")) is False
        assert eb.last_publish_failure_ts is not None

        # Healthy loop first: a fresh failure must NOT page.
        assert await verify.loop_dead_alert_check() is False
        assert alert_events == []

        # Age the genuine stamp past the 120s default threshold.
        eb.last_publish_failure_ts -= 300

        fired = await verify.loop_dead_alert_check()
        assert fired is True

    # One alert artifact, sourced from the watchdog, carrying the
    # bus probe values (failure age + outbox depth).
    assert len(alert_events) == 1
    evt = alert_events[0]
    assert evt["org_id"] == "org-chaos"
    assert evt["severity"] == "critical"
    assert evt["payload"]["source"] == "loop_dead_watchdog"
    assert evt["payload"]["publish_failure_age_s"] >= 120
    assert any("publish failing" in r for r in evt["payload"]["reasons"])
    assert len(slack_msgs) == 1

    # Debounce: the chore pages once per cooldown window, not per tick.
    assert await verify.loop_dead_alert_check() is False
    assert len(alert_events) == 1


@pytest.mark.asyncio
async def test_crash_left_pending_row_reclaimed_on_next_drain():
    """At-least-once: a crash mid-dispatch leaves the row undrained; the
    next drain re-claims and dispatches it (and counts the failure)."""
    import eden.closed_loop.event_bus as eb

    pg = FakeOutboxPG()
    with patch.object(eb, "_pg", AsyncMock(return_value=pg)):
        # Event queued, then the consumer crashes mid-dispatch.
        assert await eb.publish(_event(ref="crash")) is True
        assert await eb.outbox_depth() == 1

        # First drain: dispatch fails (transient) → row re-queued.
        failing = MagicMock()
        failing.on_event = AsyncMock(side_effect=RuntimeError("transient boom"))
        assert await eb.drain_outbox(orchestrator=failing) == 0
        assert await eb.outbox_depth() == 1  # still pending
        assert pg.rows[0]["attempts"] == 1

        # Second drain: healthy → dispatched and stamped drained.
        ok = MagicMock()
        ok.on_event = AsyncMock()
        assert await eb.drain_outbox(orchestrator=ok) == 1
        assert await eb.outbox_depth() == 0
        ok.on_event.assert_awaited_once()
        # The recovered event is exactly the queued one.
        assert ok.on_event.await_args.args[0].ref == "crash"

    assert json.loads(pg.rows[0]["event"])["ref"] == "crash"
