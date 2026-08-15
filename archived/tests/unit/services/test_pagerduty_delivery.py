"""Tests for the PagerDuty Events API v2 sender (FEAT-42).

Prior to this change, ``_dispatch_pagerduty`` in ``alert_stream.py`` and
the ``pagerduty`` branch of ``AnomalyDetector.dispatch_alerts`` were both
log-only no-ops. This exercises the real sender in isolation: routing-key
resolution (not-configured skip), a successful first attempt, and a
failed first attempt scheduling a background retry.
"""

from __future__ import annotations

import pytest

from eden.services import pagerduty_delivery as pd


@pytest.mark.asyncio
async def test_send_skips_when_not_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _no_key(_org_id: str | None) -> str | None:
        return None

    monkeypatch.setattr(
        "eden.integrations.pagerduty.store.get_routing_key", _no_key
    )

    ok = await pd.send_pagerduty_event(
        org_id="org_1",
        summary="test alert",
        source="eden",
        severity="critical",
    )
    assert ok is False


@pytest.mark.asyncio
async def test_send_succeeds_on_first_attempt(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _key(_org_id: str | None) -> str | None:
        return "R0UTING-KEY"

    monkeypatch.setattr(
        "eden.integrations.pagerduty.store.get_routing_key", _key
    )

    calls: list[dict] = []

    async def _post_once(body: dict) -> tuple[bool, int | None, str | None]:
        calls.append(body)
        return True, 202, None

    monkeypatch.setattr(pd, "_post_once", _post_once)

    ok = await pd.send_pagerduty_event(
        org_id="org_1",
        summary="Sandbox Security Alert: job-1",
        source="job-1",
        severity="critical",
        dedup_key="rule_sandbox_escape:job-1",
    )
    assert ok is True
    assert len(calls) == 1
    body = calls[0]
    assert body["routing_key"] == "R0UTING-KEY"
    assert body["event_action"] == "trigger"
    assert body["dedup_key"] == "rule_sandbox_escape:job-1"
    assert body["payload"]["severity"] == "critical"
    assert body["payload"]["source"] == "job-1"


@pytest.mark.asyncio
async def test_send_schedules_retry_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _key(_org_id: str | None) -> str | None:
        return "R0UTING-KEY"

    monkeypatch.setattr(
        "eden.integrations.pagerduty.store.get_routing_key", _key
    )

    async def _post_once(body: dict) -> tuple[bool, int | None, str | None]:
        return False, 500, "server error"

    monkeypatch.setattr(pd, "_post_once", _post_once)

    scheduled: list[tuple] = []

    async def _fake_retry(body, *, org_id, attempt, last_error) -> None:  # noqa: ANN001
        scheduled.append((org_id, attempt, last_error))

    monkeypatch.setattr(pd, "_retry_until_dlq", _fake_retry)

    # send_pagerduty_event uses asyncio.ensure_future to fire-and-forget
    # the retry continuation; capture the coroutine instead of letting the
    # real event loop drive it so the test controls exactly when it runs.
    import asyncio

    fired: list = []

    def _capture_ensure_future(coro):  # noqa: ANN001
        fired.append(coro)
        return None

    monkeypatch.setattr(asyncio, "ensure_future", _capture_ensure_future)

    ok = await pd.send_pagerduty_event(
        org_id="org_1",
        summary="anomaly",
        source="silver_events",
        severity="warning",
    )
    assert ok is False
    assert len(fired) == 1
    # Run the captured retry coroutine to confirm it was scheduled correctly.
    await fired[0]
    assert scheduled == [("org_1", 1, "HTTP 500: server error")]


def test_severity_map_covers_pagerduty_enum() -> None:
    for src, expected in [
        ("critical", "critical"),
        ("high", "error"),
        ("warning", "warning"),
        ("info", "info"),
        ("debug", "info"),
        ("unknown-thing", "warning"),
    ]:
        assert pd._to_pd_severity(src) == expected
