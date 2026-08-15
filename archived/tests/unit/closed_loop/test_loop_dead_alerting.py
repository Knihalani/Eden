"""M2 loop-dead alerting — verify worker idle chore pages when the loop dies."""

from __future__ import annotations

import time

import pytest

from eden.closed_loop import event_bus, verify


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    verify._reset_state_for_tests()
    monkeypatch.setattr(event_bus, "last_publish_failure_ts", None)
    yield
    verify._reset_state_for_tests()


@pytest.fixture()
def sinks(monkeypatch):
    """Capture alerts-pipeline and Slack emissions; point alerts at org-1."""
    alert_events: list[dict] = []
    slack_msgs: list[dict] = []

    async def _fake_alert_event(**kwargs):
        alert_events.append(kwargs)
        return {"id": "evt-1", **kwargs}

    async def _fake_slack(org_id, **kwargs):
        slack_msgs.append({"org_id": org_id, **kwargs})
        return {"status": "sent"}

    async def _depth_zero():
        return 0

    monkeypatch.setattr(
        "eden.alerts.repo.create_alert_event", _fake_alert_event
    )
    monkeypatch.setattr(
        "eden.services.slack_notify.notify_loop_dead", _fake_slack
    )
    monkeypatch.setattr(event_bus, "outbox_depth", _depth_zero)
    from eden.config import get_settings

    monkeypatch.setattr(
        get_settings(), "loop_dead_alert_org_id", "org-1"
    )
    return alert_events, slack_msgs


@pytest.mark.asyncio
async def test_healthy_loop_no_alert(sinks) -> None:
    alert_events, slack_msgs = sinks
    fired = await verify.loop_dead_alert_check()
    assert fired is False
    assert alert_events == []
    assert slack_msgs == []


@pytest.mark.asyncio
async def test_stale_publish_failure_triggers_one_alert(
    sinks, monkeypatch
) -> None:
    alert_events, slack_msgs = sinks
    monkeypatch.setattr(
        event_bus, "last_publish_failure_ts", time.time() - 300
    )
    fired = await verify.loop_dead_alert_check()
    assert fired is True
    assert len(alert_events) == 1
    evt = alert_events[0]
    assert evt["org_id"] == "org-1"
    assert evt["severity"] == "critical"
    assert evt["payload"]["source"] == "loop_dead_watchdog"
    assert evt["payload"]["publish_failure_age_s"] >= 120
    assert len(slack_msgs) == 1
    assert slack_msgs[0]["org_id"] == "org-1"


@pytest.mark.asyncio
async def test_debounce_suppresses_second_alert(sinks, monkeypatch) -> None:
    alert_events, slack_msgs = sinks
    monkeypatch.setattr(
        event_bus, "last_publish_failure_ts", time.time() - 300
    )
    assert await verify.loop_dead_alert_check() is True
    assert await verify.loop_dead_alert_check() is False  # within cooldown
    assert len(alert_events) == 1
    assert len(slack_msgs) == 1


@pytest.mark.asyncio
async def test_debounce_expiry_allows_realert(sinks, monkeypatch) -> None:
    alert_events, _ = sinks
    monkeypatch.setattr(
        event_bus, "last_publish_failure_ts", time.time() - 300
    )
    assert await verify.loop_dead_alert_check() is True
    # Age the debounce stamp past the cooldown window.
    verify._LOOP_DEAD_LAST_ALERT_MONO -= 31 * 60
    assert await verify.loop_dead_alert_check() is True
    assert len(alert_events) == 2


@pytest.mark.asyncio
async def test_outbox_depth_triggers_alert(sinks, monkeypatch) -> None:
    alert_events, _ = sinks

    async def _deep():
        return 50_000

    monkeypatch.setattr(event_bus, "outbox_depth", _deep)
    fired = await verify.loop_dead_alert_check()
    assert fired is True
    assert alert_events[0]["payload"]["outbox_depth"] == 50_000
    assert "outbox depth" in alert_events[0]["title"]


@pytest.mark.asyncio
async def test_recent_failure_below_threshold_no_alert(
    sinks, monkeypatch
) -> None:
    alert_events, _ = sinks
    monkeypatch.setattr(
        event_bus, "last_publish_failure_ts", time.time() - 10
    )
    assert await verify.loop_dead_alert_check() is False
    assert alert_events == []


@pytest.mark.asyncio
async def test_no_org_configured_logs_only(sinks, monkeypatch, caplog) -> None:
    alert_events, slack_msgs = sinks
    from eden.config import get_settings

    monkeypatch.setattr(get_settings(), "loop_dead_alert_org_id", "")
    monkeypatch.setattr(
        event_bus, "last_publish_failure_ts", time.time() - 300
    )
    import logging

    with caplog.at_level(logging.ERROR, logger="eden.closed_loop.verify"):
        assert await verify.loop_dead_alert_check() is True
    assert alert_events == []
    assert slack_msgs == []
    assert any("loop-dead watchdog" in r.getMessage() for r in caplog.records)


def test_chore_registered() -> None:
    verify._register_default_chores()
    names = {c.name for c in verify._IDLE_CHORES}
    assert "loop_dead_alert" in names
