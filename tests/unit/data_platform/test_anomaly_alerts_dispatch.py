"""Tests for AnomalyDetector.dispatch_alerts channel routing (FEAT-42).

``pagerduty`` used to be a bare log-only no-op alongside ``slack`` in
``dispatch_alerts``. This confirms ``pagerduty`` now actually calls the
real sender (``_dispatch_pagerduty``) while ``slack`` remains the
documented no-op — out of scope per FEAT-40/42.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from eden.data_platform.anomaly_alerts import AnomalyAlert, AnomalyDetector


def _alert(severity: str = "critical") -> AnomalyAlert:
    return AnomalyAlert(
        alert_id="a1",
        alert_type="pii_breach",
        severity=severity,
        table="silver_events",
        metric="pii_hit_rate",
        observed_value=0.9,
        expected_range=(0.0, 0.05),
        deviation_percent=1700.0,
        message="PII breach detected",
        timestamp=datetime.now(UTC).isoformat(),
        context={"org_id": "org_1"},
    )


@pytest.mark.asyncio
async def test_dispatch_alerts_routes_pagerduty_to_real_sender(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    detector = AnomalyDetector()

    called: list[AnomalyAlert] = []

    async def _fake_pagerduty(alert: AnomalyAlert) -> bool:
        called.append(alert)
        return True

    monkeypatch.setattr(detector, "_dispatch_pagerduty", _fake_pagerduty)

    dispatched = await detector.dispatch_alerts([_alert()], channels=["pagerduty"])

    assert len(called) == 1
    assert dispatched["pagerduty"] == 1


@pytest.mark.asyncio
async def test_dispatch_alerts_slack_stays_a_documented_noop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    detector = AnomalyDetector()

    dispatched = await detector.dispatch_alerts([_alert()], channels=["slack"])

    # slack is intentionally out of scope for FEAT-40/42 — still a no-op.
    assert dispatched.get("slack", 0) == 0


@pytest.mark.asyncio
async def test_dispatch_pagerduty_resolves_org_id_from_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    detector = AnomalyDetector()

    seen: dict = {}

    async def _fake_send(**kwargs):  # noqa: ANN003
        seen.update(kwargs)
        return True

    monkeypatch.setattr(
        "eden.services.pagerduty_delivery.send_pagerduty_event", _fake_send
    )

    ok = await detector._dispatch_pagerduty(_alert())

    assert ok is True
    assert seen["org_id"] == "org_1"
    assert seen["severity"] == "critical"
