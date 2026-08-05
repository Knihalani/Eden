"""FEAT-16: webhook/Slack dispatch in the automations engine.

``_execute_action`` used to no-op on ``"webhook"``/``"slack"`` (the two
action types the portal Automations dialog actually offers) and fall
into a generic branch that just echoed a dict with zero dispatch. These
tests pin the real dispatch: outbound HTTP is faked so no network is
touched, and failures must be reported (never raised) so a bad
customer-configured URL can't take down the real-time scoring path.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.automations.engine import AutomationsEngine


def _engine() -> AutomationsEngine:
    return AutomationsEngine(pg=object())


# ── webhook ─────────────────────────────────────────────────────────


class TestWebhookAction:
    @pytest.mark.asyncio
    async def test_missing_url_errors_without_dispatch(self) -> None:
        engine = _engine()
        result = await engine._execute_action(
            "org-1", "webhook", {}, trace_id="t-1", score=0.2
        )
        assert result["action"] == "webhook"
        assert result["status"] == "error"
        assert "url" in result["error"]

    @pytest.mark.asyncio
    async def test_posts_payload_to_configured_url(self) -> None:
        engine = _engine()
        resp = MagicMock(status_code=200)
        http_client = MagicMock()
        http_client.post = AsyncMock(return_value=resp)
        http_client.__aenter__ = AsyncMock(return_value=http_client)
        http_client.__aexit__ = AsyncMock(return_value=False)

        with (
            patch(
                "eden.services.webhook_delivery._assert_public_ip",
                return_value=None,
            ),
            patch("httpx.AsyncClient", return_value=http_client),
        ):
            result = await engine._execute_action(
                "org-1",
                "webhook",
                {
                    "url": "https://example.com/hook",
                    "headers": {"X-Custom": "1"},
                    "payload": {"note": "low score"},
                },
                trace_id="t-1",
                score=0.12,
            )

        assert result["status"] == "sent"
        assert result["action"] == "webhook"
        assert result["url"] == "https://example.com/hook"
        http_client.post.assert_awaited_once()
        _, kwargs = http_client.post.call_args
        assert kwargs["headers"]["X-Custom"] == "1"
        import json as _json

        body = _json.loads(kwargs["content"])
        assert body["trace_id"] == "t-1"
        assert body["org_id"] == "org-1"
        assert body["score"] == 0.12
        assert body["note"] == "low score"

    @pytest.mark.asyncio
    async def test_ssrf_guard_blocks_private_url(self) -> None:
        engine = _engine()
        with patch(
            "eden.services.webhook_delivery._assert_public_ip",
            side_effect=ValueError("private IP"),
        ):
            result = await engine._execute_action(
                "org-1",
                "webhook",
                {"url": "https://internal.local/hook"},
                trace_id="t-1",
                score=0.1,
            )
        assert result["status"] == "error"
        assert "rejected" in result["error"]

    @pytest.mark.asyncio
    async def test_transport_failure_is_caught_and_retried(self) -> None:
        engine = _engine()
        http_client = MagicMock()
        http_client.post = AsyncMock(side_effect=RuntimeError("connection refused"))
        http_client.__aenter__ = AsyncMock(return_value=http_client)
        http_client.__aexit__ = AsyncMock(return_value=False)

        with (
            patch(
                "eden.services.webhook_delivery._assert_public_ip",
                return_value=None,
            ),
            patch("httpx.AsyncClient", return_value=http_client),
            patch("asyncio.sleep", AsyncMock(return_value=None)),
        ):
            result = await engine._execute_action(
                "org-1",
                "webhook",
                {"url": "https://example.com/hook"},
                trace_id="t-1",
                score=0.1,
            )
        assert result["status"] == "error"
        assert "connection refused" in result["error"]
        # One initial attempt + one retry.
        assert http_client.post.await_count == 2


# ── slack ───────────────────────────────────────────────────────────


class TestSlackAction:
    @pytest.mark.asyncio
    async def test_incoming_webhook_url_posts_slack_text(self) -> None:
        engine = _engine()
        resp = MagicMock(status_code=200)
        http_client = MagicMock()
        http_client.post = AsyncMock(return_value=resp)
        http_client.__aenter__ = AsyncMock(return_value=http_client)
        http_client.__aexit__ = AsyncMock(return_value=False)

        with (
            patch(
                "eden.services.webhook_delivery._assert_public_ip",
                return_value=None,
            ),
            patch("httpx.AsyncClient", return_value=http_client),
        ):
            result = await engine._execute_action(
                "org-1",
                "slack",
                {
                    "webhook_url": "https://hooks.slack.com/services/T/B/xyz",
                    "message": "score breached",
                },
                trace_id="t-2",
                score=0.05,
            )

        assert result["status"] == "sent"
        assert result["channel"] == "incoming_webhook"
        import json as _json

        _, kwargs = http_client.post.call_args
        assert _json.loads(kwargs["content"])["text"] == "score breached"

    @pytest.mark.asyncio
    async def test_falls_back_to_connected_slack_app(self) -> None:
        """No webhook_url configured: reuse the org's connected Slack App
        (migration 131 / eden.integrations.slack), same path
        slack_notify uses for issue/PR alerts."""
        engine = _engine()

        class _FakeSlackClient:
            def __init__(self, token: str) -> None:
                self.token = token

            async def post_message(self, *, channel, text, blocks=None):
                assert channel == "C-default"
                return {"ok": True, "ts": "111.222"}

        with (
            patch(
                "eden.integrations.slack.store.get_channel",
                AsyncMock(return_value={"channel_id": "C-default"}),
            ),
            patch(
                "eden.integrations.slack.store.get_bot_token",
                AsyncMock(return_value="xoxb-test"),
            ),
            patch(
                "eden.integrations.slack.client.SlackClient", _FakeSlackClient
            ),
        ):
            result = await engine._execute_action(
                "org-1", "slack", {}, trace_id="t-3", score=0.4
            )

        assert result["status"] == "sent"
        assert result["channel_id"] == "C-default"
        assert result["ts"] == "111.222"

    @pytest.mark.asyncio
    async def test_not_connected_reports_error_without_crashing(self) -> None:
        engine = _engine()
        with (
            patch(
                "eden.integrations.slack.store.get_channel",
                AsyncMock(return_value=None),
            ),
        ):
            result = await engine._execute_action(
                "org-1", "slack", {}, trace_id="t-4", score=0.4
            )
        assert result["action"] == "slack"
        assert result["status"] == "error"
        assert "channel" in result["error"]

    @pytest.mark.asyncio
    async def test_missing_bot_token_reports_error(self) -> None:
        engine = _engine()
        with (
            patch(
                "eden.integrations.slack.store.get_channel",
                AsyncMock(return_value={"channel_id": "C-default"}),
            ),
            patch(
                "eden.integrations.slack.store.get_bot_token",
                AsyncMock(return_value=None),
            ),
        ):
            result = await engine._execute_action(
                "org-1", "slack", {}, trace_id="t-5", score=0.4
            )
        assert result["status"] == "error"
        assert "not connected" in result["error"]


# ── run-status persistence ─────────────────────────────────────────


class TestRunStatus:
    @pytest.mark.asyncio
    async def test_failed_dispatch_marks_run_failed(self) -> None:
        """`_log_run` should surface a failed webhook/slack dispatch on
        `automation_runs.status` so it's visible without grepping logs."""
        engine = _engine()
        captured: dict = {}

        class _PG:
            async def execute(self, sql, *args):
                captured["sql"] = sql
                captured["args"] = args

        with patch.object(engine, "_client", AsyncMock(return_value=_PG())):
            await engine._log_run(
                "org-1",
                "auto-1",
                {"action": "webhook", "status": "error", "error": "boom"},
            )
        assert captured["args"][3] == "failed"

    @pytest.mark.asyncio
    async def test_successful_dispatch_marks_run_completed(self) -> None:
        engine = _engine()
        captured: dict = {}

        class _PG:
            async def execute(self, sql, *args):
                captured["args"] = args

        with patch.object(engine, "_client", AsyncMock(return_value=_PG())):
            await engine._log_run(
                "org-1",
                "auto-1",
                {"action": "webhook", "status": "sent", "http_status": 200},
            )
        assert captured["args"][3] == "completed"

    @pytest.mark.asyncio
    async def test_legacy_error_shape_without_status_key_marks_failed(self) -> None:
        """Older action results (e.g. the dataset action) only ever set
        an ``error`` key, never a ``status`` key — must still count as
        failed."""
        engine = _engine()
        captured: dict = {}

        class _PG:
            async def execute(self, sql, *args):
                captured["args"] = args

        with patch.object(engine, "_client", AsyncMock(return_value=_PG())):
            await engine._log_run(
                "org-1", "auto-1", {"action": "dataset", "error": "promote failed"}
            )
        assert captured["args"][3] == "failed"


# ── unaffected action types still behave ────────────────────────────


class TestUnchangedActions:
    @pytest.mark.asyncio
    async def test_queue_action_unchanged(self) -> None:
        engine = _engine()
        result = await engine._execute_action(
            "org-1", "queue", {"queue_id": "q-1"}, trace_id="t-1", score=0.1
        )
        assert result["action"] == "queue"
        assert result["queue_id"] == "q-1"
        assert result["status"] == "completed"

    @pytest.mark.asyncio
    async def test_alert_action_unchanged(self) -> None:
        engine = _engine()
        result = await engine._execute_action(
            "org-1", "alert", {}, trace_id="t-1", score=0.1
        )
        assert result["action"] == "alert"
        assert result["message"] == "score threshold breached"
