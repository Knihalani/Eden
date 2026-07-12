"""F47 — Slack Block Kit issue alerts + storm caps (Wave 7)."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.integrations.slack import alerts


def _settings(**kw: Any) -> Any:
    s = MagicMock()
    s.issue_alerts_enabled = kw.get("enabled", True)
    s.issue_alert_dedup_minutes = kw.get("dedup", 15)
    s.issue_alert_max_per_hour = kw.get("max_hr", 30)
    s.slack_webhook_url = kw.get("webhook", "https://hooks.slack.test/x")
    return s


class _Redis:
    """Fake redis where SET NX always succeeds and INCR counts up."""

    def __init__(self) -> None:
        self.counters: dict[str, int] = {}
        self.sets: set[str] = set()

    async def set(self, key: str, val: str, ex: int = 0, nx: bool = False) -> bool | None:
        if nx and key in self.sets:
            return None
        self.sets.add(key)
        return True

    async def incr(self, key: str) -> int:
        self.counters[key] = self.counters.get(key, 0) + 1
        return self.counters[key]

    async def expire(self, key: str, ttl: int) -> None:
        return None


@pytest.mark.asyncio
async def test_p1_issue_created_posts_block_kit() -> None:
    posted: dict[str, Any] = {}

    async def _post(webhook: str, blocks: list[dict], event: str, severity: str) -> bool:
        posted["blocks"] = blocks
        posted["event"] = event
        return True

    with patch("eden.config.get_settings", return_value=_settings()), patch.object(
        alerts, "_redis", new=AsyncMock(return_value=_Redis())
    ), patch.object(alerts, "_resolve_webhook", new=AsyncMock(return_value="https://x")), patch.object(
        alerts, "_post", new=_post
    ):
        ok = await alerts.alert_issue_event(
            "org_test",
            issue_id="iss-1",
            payload={"severity": "p1", "kind": "tool_error", "title": "boom"},
        )

    assert ok is True
    assert posted["event"] == "issue_created"
    assert posted["blocks"][0]["type"] == "header"


@pytest.mark.asyncio
async def test_p3_issue_created_not_paged() -> None:
    with patch("eden.config.get_settings", return_value=_settings()), patch.object(
        alerts, "_resolve_webhook", new=AsyncMock(return_value="https://x")
    ), patch.object(alerts, "_post", new=AsyncMock(return_value=True)) as post:
        ok = await alerts.alert_issue_event(
            "org_test",
            issue_id="iss-1",
            payload={"severity": "p3", "kind": "loop"},
        )
    assert ok is False
    post.assert_not_awaited()


@pytest.mark.asyncio
async def test_human_escalation_always_paged() -> None:
    with patch("eden.config.get_settings", return_value=_settings()), patch.object(
        alerts, "_redis", new=AsyncMock(return_value=_Redis())
    ), patch.object(alerts, "_resolve_webhook", new=AsyncMock(return_value="https://x")), patch.object(
        alerts, "_post", new=AsyncMock(return_value=True)
    ) as post:
        ok = await alerts.alert_issue_event(
            "org_test",
            issue_id="iss-1",
            payload={"severity": "p3"},
            human_escalation=True,
        )
    assert ok is True
    post.assert_awaited_once()


@pytest.mark.asyncio
async def test_dedup_suppresses_second_identical_alert() -> None:
    redis = _Redis()
    with patch("eden.config.get_settings", return_value=_settings()), patch.object(
        alerts, "_redis", new=AsyncMock(return_value=redis)
    ), patch.object(alerts, "_resolve_webhook", new=AsyncMock(return_value="https://x")), patch.object(
        alerts, "_post", new=AsyncMock(return_value=True)
    ):
        first = await alerts.alert_issue_event(
            "org_test", issue_id="iss-1", payload={"severity": "p0"}
        )
        second = await alerts.alert_issue_event(
            "org_test", issue_id="iss-1", payload={"severity": "p0"}
        )
    assert first is True
    assert second is False  # deduped


@pytest.mark.asyncio
async def test_rate_cap_suppresses_after_max() -> None:
    redis = _Redis()
    with patch("eden.config.get_settings", return_value=_settings(max_hr=2)), patch.object(
        alerts, "_redis", new=AsyncMock(return_value=redis)
    ), patch.object(alerts, "_resolve_webhook", new=AsyncMock(return_value="https://x")), patch.object(
        alerts, "_post", new=AsyncMock(return_value=True)
    ):
        results = [
            await alerts.alert_issue_event(
                "org_test", issue_id=f"iss-{i}", payload={"severity": "p0"}
            )
            for i in range(4)
        ]
    # max 2/hr → first two deliver, rest suppressed
    assert results[:2] == [True, True]
    assert results[2:] == [False, False]


@pytest.mark.asyncio
async def test_no_webhook_noops() -> None:
    with patch("eden.config.get_settings", return_value=_settings(webhook="")), patch.object(
        alerts, "_resolve_webhook", new=AsyncMock(return_value="")
    ), patch.object(alerts, "_post", new=AsyncMock(return_value=True)) as post:
        ok = await alerts.alert_issue_event(
            "org_test", issue_id="iss-1", payload={"severity": "p0"}
        )
    assert ok is False
    post.assert_not_awaited()
