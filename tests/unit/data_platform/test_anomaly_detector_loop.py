"""Tests for AnomalyDetectorLoop.tick_once severity-based routing (FEAT-40).

Prior to this change, ``tick_once`` hardcoded
``channels=["in_app"]`` for every anomaly alert regardless of severity,
so a critical alert (e.g. a PII-breach detection from
``AnomalyDetector.check_pii_breach``) never reached anything but the
in-app feed even though ``AnomalyDetector.dispatch_alerts`` already
implements email/websocket/webhook/pagerduty routing.
"""

from __future__ import annotations

import pytest

from eden.data_platform.anomaly_detector_loop import (
    AnomalyDetectorLoop,
    _channels_for_severity,
)


def test_critical_severity_gets_broad_channel_set() -> None:
    channels = _channels_for_severity("critical")
    assert "in_app" in channels
    assert "email" in channels
    assert "webhook" in channels
    assert "pagerduty" in channels


def test_info_severity_stays_in_app_only() -> None:
    assert _channels_for_severity("info") == ["in_app"]


def test_warning_severity_is_broader_than_info_but_not_critical() -> None:
    warning_channels = _channels_for_severity("warning")
    assert "in_app" in warning_channels
    assert "email" not in warning_channels
    assert "pagerduty" not in warning_channels


class _FakeAlert:
    def __init__(self, severity: str) -> None:
        self.severity = severity


class _FakeReport:
    def __init__(self, alerts: list[_FakeAlert]) -> None:
        self.alerts = alerts
        self.alerts_triggered = len(alerts)


class _FakeDetector:
    def __init__(self, alerts: list[_FakeAlert]) -> None:
        self._report = _FakeReport(alerts)
        self.dispatch_calls: list[tuple[list[_FakeAlert], list[str]]] = []

    async def check_all(self) -> _FakeReport:
        return self._report

    async def dispatch_alerts(self, alerts, channels=None) -> dict:  # noqa: ANN001
        self.dispatch_calls.append((alerts, channels))
        return {}


@pytest.mark.asyncio
async def test_tick_once_groups_by_severity_and_routes_critical_broadly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    critical_alert = _FakeAlert("critical")
    info_alert = _FakeAlert("info")
    fake_detector = _FakeDetector([critical_alert, info_alert])

    monkeypatch.setattr(
        "eden.data_platform.anomaly_alerts.AnomalyDetector",
        lambda: fake_detector,
    )
    monkeypatch.setattr(
        "eden.data_platform.anomaly_detector_loop._anomaly_in_cooldown",
        lambda: False,
    )
    cleared = []
    monkeypatch.setattr(
        "eden.data_platform.anomaly_detector_loop._anomaly_clear_cooldown",
        lambda: cleared.append(True),
    )

    loop = AnomalyDetectorLoop()
    triggered = await loop.tick_once()

    assert triggered == 2
    assert cleared == [True]
    # One dispatch_alerts call per distinct severity present.
    assert len(fake_detector.dispatch_calls) == 2
    calls_by_severity = {
        alerts[0].severity: channels for alerts, channels in fake_detector.dispatch_calls
    }
    assert calls_by_severity["critical"] == _channels_for_severity("critical")
    assert calls_by_severity["info"] == ["in_app"]
    # Critical alert must not be limited to in_app-only.
    assert calls_by_severity["critical"] != ["in_app"]
