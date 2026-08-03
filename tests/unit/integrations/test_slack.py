"""Soft Autonomy Phase 5: Slack integration unit tests.

Pins the OAuth URL/exchange contract, signature verification, the
store's encrypted-token round-trip + channel routing precedence, and
the dispatcher's rate-limit / deep-link behaviour. No network, no DB —
Postgres and httpx are faked.
"""

from __future__ import annotations

import hashlib
import hmac
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.integrations.slack import oauth as slack_oauth
from eden.integrations.slack.oauth import (
    SlackConfigError,
    SlackOAuthClient,
    verify_slack_signature,
)


def _settings(**over):
    base = {
        "slack_client_id": "cid-1",
        "slack_client_secret": "secret-1",
        "slack_signing_secret": "signing-1",
        "slack_callback_url": "https://api.eden.test/integrations/slack/callback",
        "slack_bot_token": "",
        "slack_alerts_enabled": True,
        "slack_alert_dedup_minutes": 15,
        "slack_alert_max_per_hour": 30,
        "portal_base_url": "https://portal.eden.test",
        "app_url": "https://portal.eden.test",
        "api_public_url": "https://api.eden.test",
    }
    base.update(over)
    return SimpleNamespace(**base)


# ── OAuth ───────────────────────────────────────────────────────────


class TestSlackOAuth:
    def test_authorize_url_carries_scopes_state_redirect(self) -> None:
        with patch.object(slack_oauth, "get_settings", return_value=_settings()):
            client = SlackOAuthClient()
            url = client.get_authorize_url(state="st-1")
        assert url.startswith("https://slack.com/oauth/v2/authorize?")
        assert "client_id=cid-1" in url
        assert "state=st-1" in url
        assert "chat%3Awrite" in url or "chat:write" in url
        assert "redirect_uri=https%3A%2F%2Fapi.eden.test" in url

    def test_unconfigured_raises(self) -> None:
        with patch.object(
            slack_oauth,
            "get_settings",
            return_value=_settings(slack_client_id="", slack_client_secret="", slack_signing_secret=""),
        ):
            with pytest.raises(SlackConfigError):
                SlackOAuthClient()

    def test_callback_url_falls_back_to_api_public_url(self) -> None:
        with patch.object(
            slack_oauth, "get_settings", return_value=_settings(slack_callback_url="")
        ):
            client = SlackOAuthClient()
        assert client.callback_url == "https://api.eden.test/integrations/slack/callback"

    def test_callback_url_empty_when_no_base(self) -> None:
        with patch.object(
            slack_oauth,
            "get_settings",
            return_value=_settings(
                slack_callback_url="",
                api_public_url="",
                app_url="https://portal.example.com",
                portal_base_url="https://portal.example.com",
            ),
        ):
            client = SlackOAuthClient()
        assert client.callback_url == ""

    @pytest.mark.asyncio
    async def test_exchange_code_rejects_not_ok(self) -> None:
        resp = MagicMock(status_code=200)
        resp.json.return_value = {"ok": False, "error": "invalid_code"}
        http = MagicMock()
        http.post = AsyncMock(return_value=resp)
        http.is_closed = False
        with (
            patch.object(slack_oauth, "get_settings", return_value=_settings()),
            patch.object(slack_oauth, "_HTTPX", http),
        ):
            client = SlackOAuthClient()
            with pytest.raises(slack_oauth.SlackAPIError):
                await client.exchange_code("bad-code")


# ── Signature verification ──────────────────────────────────────────


def _sign(secret: str, ts: str, body: bytes) -> str:
    base = b"v0:" + ts.encode() + b":" + body
    return "v0=" + hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()


class TestSignature:
    def test_valid_signature(self) -> None:
        body = b'{"type":"event_callback"}'
        ts = str(int(time.time()))
        sig = _sign("signing-1", ts, body)
        assert verify_slack_signature(
            body=body, timestamp=ts, signature=sig, secret="signing-1"
        )

    def test_rejects_wrong_secret(self) -> None:
        body = b"{}"
        ts = str(int(time.time()))
        sig = _sign("other", ts, body)
        assert not verify_slack_signature(
            body=body, timestamp=ts, signature=sig, secret="signing-1"
        )

    def test_rejects_stale_timestamp(self) -> None:
        body = b"{}"
        ts = str(int(time.time()) - 600)
        sig = _sign("signing-1", ts, body)
        assert not verify_slack_signature(
            body=body, timestamp=ts, signature=sig, secret="signing-1"
        )

    def test_rejects_malformed(self) -> None:
        assert not verify_slack_signature(
            body=b"{}", timestamp="now", signature="v0=x", secret="signing-1"
        )
        assert not verify_slack_signature(
            body=b"{}", timestamp=str(int(time.time())), signature="", secret="signing-1"
        )
        assert not verify_slack_signature(
            body=b"{}", timestamp=str(int(time.time())), signature="v1=abc", secret="s"
        )


# ── Store ───────────────────────────────────────────────────────────


class TestStore:
    @pytest.mark.asyncio
    async def test_upsert_encrypts_token(self) -> None:
        from eden.integrations.slack import store

        captured: dict = {}

        class _PG:
            async def fetchrow(self, sql, *args):
                captured["args"] = args
                return {
                    "id": args[0],
                    "org_id": args[1],
                    "team_id": args[2],
                    "team_name": args[3],
                    "bot_user_id": args[5],
                    "installed_at": "2026-08-01",
                    "revoked_at": None,
                }

        with patch.object(store, "_pg", AsyncMock(return_value=_PG())):
            row = await store.upsert_install(
                "org-1",
                team_id="T1",
                team_name="Acme",
                bot_token="xoxb-secret-token",
            )
        assert row is not None
        token_arg = captured["args"][4]
        assert token_arg != "xoxb-secret-token"
        assert "xoxb" not in token_arg  # encrypted at rest

    @pytest.mark.asyncio
    async def test_get_bot_token_decrypts(self) -> None:
        from eden.api.utils.encryption import encrypt_value
        from eden.integrations.slack import store

        enc = encrypt_value("xoxb-real-token")

        class _PG:
            async def fetchval(self, sql, *args):
                return enc

        with patch.object(store, "_pg", AsyncMock(return_value=_PG())):
            token = await store.get_bot_token("org-1")
        assert token == "xoxb-real-token"

    @pytest.mark.asyncio
    async def test_get_bot_token_falls_back_to_env(self) -> None:
        from eden.integrations.slack import store

        class _PG:
            async def fetchval(self, sql, *args):
                return None

        with (
            patch.object(store, "_pg", AsyncMock(return_value=_PG())),
            patch("eden.config.get_settings", return_value=_settings(slack_bot_token="xoxb-dev")),
        ):
            token = await store.get_bot_token("org-no-install")
        assert token == "xoxb-dev"

    @pytest.mark.asyncio
    async def test_agent_channel_beats_org_default(self) -> None:
        from eden.integrations.slack import store

        calls: list[tuple] = []

        class _PG:
            async def fetchrow(self, sql, *args):
                calls.append((sql, args))
                if "agent_id = $2" in sql:
                    return {"channel_id": "C-agent", "channel_name": "agent-alerts"}
                return {"channel_id": "C-org", "channel_name": "general"}

        with patch.object(store, "_pg", AsyncMock(return_value=_PG())):
            out = await store.get_channel("org-1", agent_id="agent-9")
        assert out is not None and out["channel_id"] == "C-agent"

    @pytest.mark.asyncio
    async def test_org_default_used_when_no_agent_row(self) -> None:
        from eden.integrations.slack import store

        class _PG:
            async def fetchrow(self, sql, *args):
                if "agent_id = $2" in sql:
                    return None
                return {"channel_id": "C-org", "channel_name": "general"}

        with patch.object(store, "_pg", AsyncMock(return_value=_PG())):
            out = await store.get_channel("org-1", agent_id="agent-unknown")
        assert out is not None and out["channel_id"] == "C-org"


# ── Dispatcher ──────────────────────────────────────────────────────


class TestDispatcher:
    @pytest.mark.asyncio
    async def test_issue_alert_skips_p2(self) -> None:
        from eden.services import slack_notify

        result = await slack_notify.notify_issue_detected(
            "org-1", issue_id="i-1", title="minor", severity="P2"
        )
        assert result["status"] == "skipped_severity"

    @pytest.mark.asyncio
    async def test_pr_opened_deep_links_to_portal_not_slack_approve(self) -> None:
        """The Approve action must be a portal deep link — no Slack action."""
        from eden.services import slack_notify

        sent: dict = {}

        class _FakeSlack:
            def __init__(self, token):
                pass

            async def post_message(self, *, channel, text, blocks=None):
                sent["blocks"] = blocks
                return {"ok": True, "ts": "1.2"}

        with (
            patch.object(slack_notify, "_allow_send", AsyncMock(return_value=True)),
            patch(
                "eden.integrations.slack.store.get_channel",
                AsyncMock(return_value={"channel_id": "C1", "channel_name": "alerts"}),
            ),
            patch(
                "eden.integrations.slack.store.get_bot_token",
                AsyncMock(return_value="xoxb-t"),
            ),
            patch("eden.integrations.slack.client.SlackClient", _FakeSlack),
            patch.object(slack_notify, "get_settings", return_value=_settings()),
        ):
            result = await slack_notify.notify_pr_opened(
                "org-1",
                plan_id="plan-1",
                pr_url="https://github.com/acme/repo/pull/42",
                title="Fix checkout loop",
                agent_id="agent-1",
            )
        assert result["status"] == "sent"
        blocks = sent["blocks"]
        actions = [b for b in blocks if b.get("type") == "actions"]
        assert actions, "expected a deep-link button"
        url = actions[0]["elements"][0]["url"]
        assert url == "https://portal.eden.test/improve?plan=plan-1"
        # No Slack-side approval: the only element is a URL button.
        assert "action_id" not in actions[0]["elements"][0]

    @pytest.mark.asyncio
    async def test_send_no_channel_is_graceful(self) -> None:
        from eden.services import slack_notify

        with (
            patch.object(slack_notify, "_allow_send", AsyncMock(return_value=True)),
            patch(
                "eden.integrations.slack.store.get_channel",
                AsyncMock(return_value=None),
            ),
        ):
            # Fix-now kinds proceed past the Improve-later Slack skip.
            result = await slack_notify.notify_needs_approval(
                "org-1",
                plan_id="p-1",
                title="t",
                kind="code_patch",
                queue="fix_now",
            )
        assert result["status"] == "no_channel"

    @pytest.mark.asyncio
    async def test_rate_limit_blocks_duplicate(self) -> None:
        from eden.services import slack_notify

        with patch.object(slack_notify, "_allow_send", AsyncMock(return_value=False)):
            result = await slack_notify.notify_issue_detected(
                "org-1", issue_id="i-1", title="t", severity="P1"
            )
        assert result["status"] == "rate_limited"

    @pytest.mark.asyncio
    async def test_regression_message_mentions_action(self) -> None:
        from eden.services import slack_notify

        sent: dict = {}

        class _FakeSlack:
            def __init__(self, token):
                pass

            async def post_message(self, *, channel, text, blocks=None):
                sent["blocks"] = blocks
                return {"ok": True, "ts": "1.2"}

        with (
            patch.object(slack_notify, "_allow_send", AsyncMock(return_value=True)),
            patch(
                "eden.integrations.slack.store.get_channel",
                AsyncMock(return_value={"channel_id": "C1", "channel_name": "alerts"}),
            ),
            patch(
                "eden.integrations.slack.store.get_bot_token",
                AsyncMock(return_value="xoxb-t"),
            ),
            patch("eden.integrations.slack.client.SlackClient", _FakeSlack),
            patch.object(slack_notify, "get_settings", return_value=_settings()),
        ):
            result = await slack_notify.notify_regression(
                "org-1",
                plan_id="plan-1",
                issue_id="i-9",
                title="Error rate spiked after merge",
                action="revert",
            )
        assert result["status"] == "sent"
        body = next(b for b in sent["blocks"] if b.get("type") == "section")
        assert "revert" in body["text"]["text"].lower()
