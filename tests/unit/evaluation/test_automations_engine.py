"""FEAT-16: webhook/Slack dispatch in the automations engine.

``_execute_action`` used to no-op on ``"webhook"``/``"slack"`` (the two
action types the portal Automations dialog actually offers) and fall
into a generic branch that just echoed a dict with zero dispatch. These
tests pin the real dispatch: outbound HTTP is faked so no network is
touched, and failures must be reported (never raised) so a bad
customer-configured URL can't take down the real-time scoring path.
"""

from __future__ import annotations

import json
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
    async def test_ssrf_guard_unavailable_fails_closed(self) -> None:
        engine = _engine()
        with patch(
            "eden.services.webhook_delivery._assert_public_ip",
            side_effect=ImportError("guard module missing"),
        ):
            result = await engine._execute_action(
                "org-1",
                "webhook",
                {"url": "https://example.com/hook"},
                trace_id="t-1",
                score=0.1,
            )
        assert result["status"] == "error"
        assert "SSRF guard unavailable" in result["error"]

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

class TestAlertAction:
    @pytest.mark.asyncio
    async def test_missing_recipients_errors(self) -> None:
        from eden.alerts.unified import (
            DestinationDispatchResult,
            UnifiedDestinationKind,
            UnifiedDispatchResult,
        )

        engine = _engine()
        with patch(
            "eden.alerts.unified.dispatch_unified_alert",
            AsyncMock(
                return_value=UnifiedDispatchResult(
                    results=[
                        DestinationDispatchResult(
                            kind=UnifiedDestinationKind.EMAIL,
                            status="skipped",
                            error="no alert recipients (org has no owner/admin emails)",
                        )
                    ]
                )
            ),
        ):
            result = await engine._execute_action(
                "org-1", "alert", {}, trace_id="t-1", score=0.1
            )
        assert result["action"] == "alert"
        assert result["status"] == "error"
        assert "recipients" in result["error"]

    @pytest.mark.asyncio
    async def test_sends_email_to_org_admins(self) -> None:
        from eden.alerts.unified import (
            DestinationDispatchResult,
            UnifiedDestinationKind,
            UnifiedDispatchResult,
        )

        engine = _engine()
        dispatch_mock = AsyncMock(
            return_value=UnifiedDispatchResult(
                results=[
                    DestinationDispatchResult(
                        kind=UnifiedDestinationKind.EMAIL,
                        status="sent",
                        detail={"recipient_count": 1},
                    )
                ]
            )
        )
        with patch(
            "eden.alerts.unified.dispatch_unified_alert",
            dispatch_mock,
        ):
            result = await engine._execute_action(
                "org-1",
                "alert",
                {"message": "low score", "severity": "P1"},
                trace_id="t-1",
                score=0.1,
            )
        assert result["action"] == "alert"
        assert result["status"] == "sent"
        assert result["message"] == "low score"
        assert result["recipient_count"] == 1
        dispatch_mock.assert_awaited_once()
        request = dispatch_mock.await_args.args[0]
        assert request.event_kind == "automation_triggered"
        assert request.issue_id == "t-1"


# ── FEAT-133: update / delete / toggle lifecycle ────────────────────


class _FakePG:
    """Minimal fake Postgres client backing a single in-memory automation
    row (plus its runs), enough to exercise org-scoping and partial
    updates without a real database."""

    def __init__(self, row: dict | None = None) -> None:
        self.row = dict(row) if row else None
        self.runs: list[dict] = []

    async def fetchrow(self, sql: str, *args):
        if "FROM automations" in sql:
            org_id, automation_id = args
            if self.row and self.row["org_id"] == org_id and str(self.row["id"]) == str(
                automation_id
            ):
                return dict(self.row)
            return None
        if "count(*)" in sql and "automation_runs" in sql:
            return {"n": len(self.runs)}
        raise AssertionError(f"unexpected fetchrow: {sql}")

    async def fetch(self, sql: str, *args):
        if "FROM automation_runs" in sql:
            return list(self.runs)
        raise AssertionError(f"unexpected fetch: {sql}")

    async def execute(self, sql: str, *args):
        if "UPDATE automations" in sql:
            (
                org_id,
                automation_id,
                name,
                trigger_type,
                trigger_config,
                action_type,
                action_config,
                enabled,
            ) = args
            assert self.row is not None
            assert self.row["org_id"] == org_id
            assert str(self.row["id"]) == str(automation_id)
            self.row.update(
                name=name,
                trigger_type=trigger_type,
                trigger_config=json.loads(trigger_config),
                action_type=action_type,
                action_config=json.loads(action_config),
                enabled=enabled,
            )
            return
        if "DELETE FROM automations" in sql:
            self.row = None
            return
        raise AssertionError(f"unexpected execute: {sql}")


def _row(**overrides) -> dict:
    base = {
        "id": "auto-1",
        "org_id": "org-1",
        "name": "Route low scores",
        "trigger_type": "score_threshold",
        "trigger_config": {"min_score": 0.0, "max_score": 0.5},
        "action_type": "dataset",
        "action_config": {"dataset_name": "review"},
        "enabled": True,
    }
    base.update(overrides)
    return base


class TestUpdateAutomation:
    @pytest.mark.asyncio
    async def test_partial_update_only_changes_given_fields(self) -> None:
        engine = _engine()
        pg = _FakePG(_row())
        with patch.object(engine, "_client", AsyncMock(return_value=pg)):
            updated = await engine.update_automation(
                "org-1", "auto-1", name="Renamed"
            )
        assert updated is not None
        assert updated["name"] == "Renamed"
        # Untouched fields keep their prior values.
        assert updated["action_type"] == "dataset"
        assert updated["trigger_config"] == {"min_score": 0.0, "max_score": 0.5}
        assert updated["enabled"] is True

    @pytest.mark.asyncio
    async def test_update_missing_automation_returns_none(self) -> None:
        engine = _engine()
        pg = _FakePG(None)
        with patch.object(engine, "_client", AsyncMock(return_value=pg)):
            updated = await engine.update_automation("org-1", "missing", name="x")
        assert updated is None

    @pytest.mark.asyncio
    async def test_update_is_org_scoped(self) -> None:
        """An org can't update another org's automation by id."""
        engine = _engine()
        pg = _FakePG(_row(org_id="org-1"))
        with patch.object(engine, "_client", AsyncMock(return_value=pg)):
            updated = await engine.update_automation(
                "org-2", "auto-1", name="hijack"
            )
        assert updated is None
        assert pg.row["name"] == "Route low scores"


class TestToggleAutomation:
    @pytest.mark.asyncio
    async def test_toggle_disables_and_enables(self) -> None:
        engine = _engine()
        pg = _FakePG(_row(enabled=True))
        with patch.object(engine, "_client", AsyncMock(return_value=pg)):
            off = await engine.toggle_automation("org-1", "auto-1", enabled=False)
            assert off is not None
            assert off["enabled"] is False
            on = await engine.toggle_automation("org-1", "auto-1", enabled=True)
            assert on is not None
            assert on["enabled"] is True


class TestDeleteAutomation:
    @pytest.mark.asyncio
    async def test_delete_removes_row(self) -> None:
        engine = _engine()
        pg = _FakePG(_row())
        with patch.object(engine, "_client", AsyncMock(return_value=pg)):
            ok = await engine.delete_automation("org-1", "auto-1")
        assert ok is True
        assert pg.row is None

    @pytest.mark.asyncio
    async def test_delete_missing_automation_returns_false(self) -> None:
        engine = _engine()
        pg = _FakePG(None)
        with patch.object(engine, "_client", AsyncMock(return_value=pg)):
            ok = await engine.delete_automation("org-1", "missing")
        assert ok is False

    @pytest.mark.asyncio
    async def test_delete_is_org_scoped(self) -> None:
        engine = _engine()
        pg = _FakePG(_row(org_id="org-1"))
        with patch.object(engine, "_client", AsyncMock(return_value=pg)):
            ok = await engine.delete_automation("org-2", "auto-1")
        assert ok is False
        assert pg.row is not None


# ── FEAT-170: run history ────────────────────────────────────────────


class TestListRuns:
    @pytest.mark.asyncio
    async def test_lists_runs_for_automation(self) -> None:
        engine = _engine()
        pg = _FakePG(_row())
        pg.runs = [
            {
                "id": "run-1",
                "org_id": "org-1",
                "automation_id": "auto-1",
                "status": "completed",
                "payload": {"action": "dataset"},
                "created_at": "2026-01-01T00:00:00Z",
            }
        ]
        with patch.object(engine, "_client", AsyncMock(return_value=pg)):
            page = await engine.list_runs("org-1", automation_id="auto-1")
        assert page["total"] == 1
        assert len(page["runs"]) == 1
        assert page["runs"][0]["status"] == "completed"

    @pytest.mark.asyncio
    async def test_no_client_returns_empty_page(self) -> None:
        engine = _engine()
        with patch.object(engine, "_client", AsyncMock(return_value=None)):
            page = await engine.list_runs("org-1", automation_id="auto-1")
        assert page == {"runs": [], "total": 0, "limit": 50, "offset": 0}

    @pytest.mark.asyncio
    async def test_limit_is_capped(self) -> None:
        engine = _engine()
        pg = _FakePG(_row())
        with patch.object(engine, "_client", AsyncMock(return_value=pg)):
            page = await engine.list_runs("org-1", automation_id="auto-1", limit=9999)
        assert page["limit"] == 200
