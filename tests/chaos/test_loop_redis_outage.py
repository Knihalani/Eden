"""Chaos — Redis killed mid-loop (closed-loop event bus, M2/D4).

Kills Redis under ``eden.closed_loop.event_bus.publish`` (the client
raises ``ConnectionError``) and asserts the loop degrades *durably*:

1. events land in the ``loop_events_outbox`` Postgres table,
2. ``last_publish_failure_ts`` is stamped (feeds the loop-health probe),
3. ``outbox_depth()`` reflects the queued events,
4. ``drain_outbox`` replays them in order once Redis comes back, and
5. the ``loop_dead_alert`` idle chore (verify worker) turns a stale
   failure stamp into an actual alert artifact — end-to-end from the
   bus probe to alert emission (the chore's internals are covered by
   ``tests/unit/closed_loop/test_loop_dead_alerting.py``).

Same conventions as the rest of ``tests/chaos``: no real Redis or
Postgres — a stateful in-memory outbox stands in for PG and the Redis
client is a hand-rolled fake, mirroring the fixtures in
``tests/unit/closed_loop/test_event_bus_outbox.py``.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.closed_loop.events import LoopEvent


class DeadRedis:
    """Redis client whose stream writes fail — 'killed mid-loop'."""

    def __init__(self) -> None:
        self.attempts = 0

    async def xadd(self, *args: Any, **kwargs: Any) -> None:
        self.attempts += 1
        raise ConnectionError("chaos: redis killed mid-loop")


class RecordingRedis:
    """Healthy Redis stand-in that records every XADD."""

    def __init__(self) -> None:
        self.stream: list[tuple[str, dict[str, Any]]] = []

    async def xadd(self, stream: str, fields: dict[str, Any], **kwargs: Any) -> str:
        self.stream.append((stream, dict(fields)))
        return f"{len(self.stream)}-0"


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
                    "drained_at": None,
                }
            )
            self._next_id += 1
            return "INSERT 0 1"
        if s.startswith("UPDATE loop_events_outbox SET drained_at"):
            for r in self.rows:
                if r["id"] == args[0]:
                    r["drained_at"] = time.time()
            return "UPDATE 1"
        raise AssertionError(f"unexpected SQL against fake outbox: {s}")

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        assert "FROM loop_events_outbox" in sql
        limit = int(args[0]) if args else 500
        return [
            {"id": r["id"], "event": r["event"]} for r in self._undrained()
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
    yield
    eb.last_publish_failure_ts = None


@pytest.mark.asyncio
async def test_redis_kill_midloop_events_survive_in_outbox_and_drain(caplog):
    import eden.closed_loop.event_bus as eb

    pg = FakeOutboxPG()
    dead = DeadRedis()

    # ── Phase 1: Redis dies mid-loop; three events are published ────
    with (
        patch.object(eb, "_pg", AsyncMock(return_value=pg)),
        caplog.at_level(logging.ERROR, logger="eden.closed_loop.event_bus"),
    ):
        results = [
            await eb.publish(_event(ref=ref), redis=dead)
            for ref in ("a", "b", "c")
        ]

        # Durably queued — publish reports success, not silent loss.
        assert results == [True, True, True]
        assert dead.attempts == 3

        # The bus probe is stamped for the loop-health surface.
        assert eb.last_publish_failure_ts is not None
        assert eb.last_publish_failure_ts == pytest.approx(time.time(), abs=30)

        # Failure was loud (ERROR), one log per failed XADD.
        publish_errors = [
            r for r in caplog.records if "publish failed" in r.getMessage()
        ]
        assert len(publish_errors) == 3

        # Every event landed in the durable outbox, in order.
        assert [json.loads(r["event"])["ref"] for r in pg.rows] == ["a", "b", "c"]
        assert await eb.outbox_depth() == 3

    # ── Phase 2: Redis returns; the outbox drains oldest-first ──────
    recorder = RecordingRedis()
    with (
        patch.object(eb, "_pg", AsyncMock(return_value=pg)),
        patch(
            "eden.storage.redis.get_redis_client",
            AsyncMock(return_value=recorder),
        ),
    ):
        drained = await eb.drain_outbox()
        assert drained == 3
        assert [s for s, _ in recorder.stream] == [eb.LOOP_STREAM] * 3
        assert [f["ref"] for _, f in recorder.stream] == ["a", "b", "c"]
        assert await eb.outbox_depth() == 0

        # A second drain is a no-op — nothing is replayed twice.
        assert await eb.drain_outbox() == 0
        assert len(recorder.stream) == 3

    # A successful publish clears the failure stamp (probe goes green).
    assert await eb.publish(_event(ref="d"), redis=recorder) is True
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

    The failure stamp is produced by the REAL publish path (Redis
    raising), then aged past the 120s threshold; the chore must turn
    it into an alert artifact carrying the probe values.
    """
    import eden.closed_loop.event_bus as eb
    from eden.closed_loop import verify

    alert_events, slack_msgs = alert_sinks
    pg = FakeOutboxPG()

    with patch.object(eb, "_pg", AsyncMock(return_value=pg)):
        # Production stamp: publish fails against a dead Redis and
        # falls back to the outbox — no hand-crafted probe values.
        assert await eb.publish(_event(ref="stale"), redis=DeadRedis()) is True
        assert eb.last_publish_failure_ts is not None

        # Healthy loop first: a fresh failure must NOT page.
        assert await verify.loop_dead_alert_check() is False
        assert alert_events == []

        # Age the genuine stamp past the 120s default threshold.
        eb.last_publish_failure_ts -= 300

        fired = await verify.loop_dead_alert_check()
        assert fired is True

    # One alert artifact, sourced from the watchdog, carrying the
    # bus probe values (failure age + outbox depth of the real row).
    assert len(alert_events) == 1
    evt = alert_events[0]
    assert evt["org_id"] == "org-chaos"
    assert evt["severity"] == "critical"
    assert evt["payload"]["source"] == "loop_dead_watchdog"
    assert evt["payload"]["publish_failure_age_s"] >= 120
    assert evt["payload"]["outbox_depth"] == 1
    assert any("publish failing" in r for r in evt["payload"]["reasons"])
    assert len(slack_msgs) == 1

    # Debounce: the chore pages once per cooldown window, not per tick.
    with patch.object(eb, "_pg", AsyncMock(return_value=pg)):
        assert await verify.loop_dead_alert_check() is False
    assert len(alert_events) == 1
