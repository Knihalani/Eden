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
    """Fake redis where SET NX always succeeds and INCR counts up.

    Storm-cap code uses ``pipeline().incr().expire().execute()``;
    the fake mirrors that so rate-cap tests exercise the real path.
    """

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

    def pipeline(self, transaction: bool = False) -> "_RedisPipeline":
        return _RedisPipeline(self)


class _RedisPipeline:
    """Minimal async pipeline matching redis.asyncio pipe.incr/expire/execute."""

    def __init__(self, redis: _Redis) -> None:
        self._redis = redis
        self._ops: list[tuple[str, tuple]] = []

    def incr(self, key: str) -> "_RedisPipeline":
        self._ops.append(("incr", (key,)))
        return self

    def expire(self, key: str, ttl: int) -> "_RedisPipeline":
        self._ops.append(("expire", (key, ttl)))
        return self

    async def execute(self) -> list[Any]:
        out: list[Any] = []
        for op, args in self._ops:
            if op == "incr":
                out.append(await self._redis.incr(args[0]))
            elif op == "expire":
                await self._redis.expire(args[0], args[1])
                out.append(True)
        return out


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
async def test_p0_block_kit_includes_user_count_and_actions() -> None:
    """F29/F47 AC: P0 alert carries user_count + Cursor deep link button."""
    posted: dict[str, Any] = {}

    async def _post(webhook: str, blocks: list[dict], event: str, severity: str) -> bool:
        posted["blocks"] = blocks
        return True

    with patch("eden.config.get_settings", return_value=_settings()), patch.object(
        alerts, "_redis", new=AsyncMock(return_value=_Redis())
    ), patch.object(alerts, "_resolve_webhook", new=AsyncMock(return_value="https://x")), patch.object(
        alerts, "_post", new=_post
    ):
        ok = await alerts.alert_issue_event(
            "org_test",
            issue_id="iss-42",
            payload={
                "severity": "p0",
                "kind": "tool_error",
                "title": "checkout bash loop",
                "user_count": 12,
                "stumble_count": 47,
                "agent_id": "checkout-v2",
            },
        )

    assert ok is True
    blocks = posted["blocks"]
    # Block Kit structurally valid.
    assert alerts.validate_blocks(blocks) == []
    # user_count rendered.
    field_texts = [
        f["text"]
        for b in blocks
        if b["type"] == "section"
        for f in b.get("fields", [])
    ]
    assert any("Users affected" in t and "12" in t for t in field_texts)
    # actions block with a cursor:// deep link.
    actions = [b for b in blocks if b["type"] == "actions"]
    assert actions
    urls = [e.get("url", "") for e in actions[0]["elements"]]
    assert any(u.startswith("cursor://") for u in urls)
    assert any("/issues/iss-42" in u for u in urls)


def test_validate_blocks_flags_bad_structure() -> None:
    bad = [
        {"type": "header", "text": {"type": "mrkdwn", "text": "x"}},  # header must be plain_text
        {"type": "bogus"},
        {"type": "actions", "elements": []},
    ]
    errors = alerts.validate_blocks(bad)
    assert errors
    assert any("header" in e for e in errors)
    assert any("invalid type" in e for e in errors)


def test_cursor_deep_link_format() -> None:
    link = alerts.cursor_deep_link("org1", "iss-9")
    assert link == "cursor://eden.triage/issue?org=org1&issue=iss-9"


@pytest.mark.asyncio
async def test_issue_created_to_slack_post_under_60s() -> None:
    """F47 AC: alert dispatch stays within the 60s issue-path budget."""
    import time

    from eden.integrations.slack import alerts

    posted: dict[str, Any] = {}

    async def _post(webhook: str, blocks: list[dict], event: str, severity: str) -> bool:
        posted["blocks"] = blocks
        return True

    samples: list[float] = []
    with patch("eden.config.get_settings", return_value=_settings()), patch.object(
        alerts, "_redis", new=AsyncMock(return_value=_Redis())
    ), patch.object(alerts, "_resolve_webhook", new=AsyncMock(return_value="https://x")), patch.object(
        alerts, "_post", new=_post
    ):
        for i in range(20):
            t0 = time.perf_counter()
            ok = await alerts.alert_issue_event(
                "org_test",
                issue_id=f"iss-{i}",
                payload={
                    "severity": "p0",
                    "kind": "tool_error",
                    "title": "checkout bash loop",
                    "user_count": 12,
                    "stumble_count": 47,
                },
            )
            samples.append(time.perf_counter() - t0)
            assert ok is True

    samples.sort()
    p95_idx = min(len(samples) - 1, int(0.95 * len(samples)))
    assert samples[p95_idx] < 60.0, f"p95 alert latency too high: {samples[p95_idx]:.3f}s"


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
