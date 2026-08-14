"""P0 Slack Events API + ambient Stages 0–3 (keywords + optional on-box embed)."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from eden.integrations.slack.ambient import classify
from eden.integrations.slack.oauth import verify_slack_signature


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


def _sign(secret: str, ts: str, body: bytes) -> str:
    base = b"v0:" + ts.encode() + b":" + body
    return "v0=" + hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()


class _Req:
    def __init__(self, body: bytes, headers: dict[str, str]):
        self._body = body
        self.headers = headers

    async def body(self) -> bytes:
        return self._body


def _signed_req(payload: dict, *, secret: str = "signing-1") -> _Req:
    body = json.dumps(payload).encode()
    ts = str(int(time.time()))
    return _Req(
        body,
        {
            "X-Slack-Request-Timestamp": ts,
            "X-Slack-Signature": _sign(secret, ts, body),
        },
    )


CONTRACT = {
    "id": "11111111-1111-1111-1111-111111111111",
    "org_id": "org-1",
    "agent_id": "agent-9",
    "sentence": "take the checkout refunds off my plate",
    "x_job": "refunds",
    "x_keywords": ["refund", "checkout"],
    "y_slack_user_id": "U-Y",
}


def _message_envelope(
    *,
    text: str,
    user: str = "U-Y",
    channel: str = "C1",
    channel_type: str = "channel",
    event_id: str = "Ev1",
    bot_id: str | None = None,
    subtype: str | None = None,
) -> dict:
    event: dict = {
        "type": "message",
        "text": text,
        "user": user,
        "channel": channel,
        "channel_type": channel_type,
        "ts": "1710000000.000100",
    }
    if bot_id:
        event["bot_id"] = bot_id
    if subtype:
        event["subtype"] = subtype
    return {
        "type": "event_callback",
        "team_id": "T1",
        "event_id": event_id,
        "event": event,
    }


async def _call(req: _Req, store_mocks: dict | None = None):
    from eden.api.routes import slack as slack_routes
    from eden.integrations.slack import store as store_mod

    store = store_mocks or {}
    defaults = {
        "get_org_id_for_team": AsyncMock(return_value="org-1"),
        "event_id_seen": AsyncMock(return_value=False),
        "get_agent_for_channel": AsyncMock(
            return_value={"agent_id": "agent-9", "channel_id": "C1", "channel_name": "ops"}
        ),
        "get_current_help_contract": AsyncMock(return_value=dict(CONTRACT)),
        "insert_extra_work_event": AsyncMock(return_value={"id": "e1"}),
        "insert_candidate": AsyncMock(return_value={"id": "c1"}),
    }
    defaults.update(store)
    cosine_fn = defaults.pop("_stage3_cosine", lambda *a, **k: None)
    with (
        patch("eden.config.get_settings", return_value=_settings()),
        patch.object(store_mod, "get_org_id_for_team", defaults["get_org_id_for_team"]),
        patch.object(store_mod, "event_id_seen", defaults["event_id_seen"]),
        patch.object(store_mod, "get_agent_for_channel", defaults["get_agent_for_channel"]),
        patch.object(
            store_mod,
            "get_current_help_contract",
            defaults["get_current_help_contract"],
        ),
        patch.object(
            store_mod,
            "insert_extra_work_event",
            defaults["insert_extra_work_event"],
        ),
        patch.object(
            store_mod,
            "insert_candidate",
            defaults["insert_candidate"],
        ),
        patch(
            "eden.integrations.slack.ambient._stage3_cosine",
            cosine_fn,
        ),
    ):
        defaults["_stage3_cosine"] = cosine_fn
        return await slack_routes.slack_events(req), defaults


# ── ambient classify (pure) ─────────────────────────────────────────


class TestAmbientClassify:
    def test_bot_drops(self) -> None:
        d = classify(event={"text": "refund please", "bot_id": "B1"}, contract=CONTRACT)
        assert d.action == "drop"

    def test_channel_join_drops(self) -> None:
        d = classify(
            event={"text": "x joined", "subtype": "channel_join"},
            contract=CONTRACT,
        )
        assert d.action == "drop"

    def test_empty_drops(self) -> None:
        assert classify(event={"text": "  "}, contract=CONTRACT).action == "drop"

    def test_emoji_only_drops(self) -> None:
        assert classify(event={"text": ":wave: ✅"}, contract=CONTRACT).action == "drop"

    def test_thanks_drops(self) -> None:
        assert classify(event={"text": "thanks!"}, contract=CONTRACT).action == "drop"
        assert classify(event={"text": "lgtm"}, contract=CONTRACT).action == "drop"

    def test_no_contract_drops(self) -> None:
        d = classify(event={"text": "refund the checkout", "user": "U1"}, contract=None)
        assert d.action == "drop"
        assert d.reason == "stage3_no_contract"

    def test_keyword_y_user_fires_medium(self) -> None:
        d = classify(
            event={"text": "I will do the refund myself", "user": "U-Y"},
            contract=CONTRACT,
        )
        assert d.action == "fire"
        assert d.kind == "human_did_agents_job"
        assert d.confidence == "medium"
        assert d.polarity == "extra_work"
        assert d.path == "ambient"

    def test_keyword_not_y_fires_low(self) -> None:
        d = classify(
            event={"text": "refund stuck on checkout", "user": "U-OTHER"},
            contract=CONTRACT,
        )
        assert d.action == "fire"
        assert d.confidence == "low"

    def test_unrelated_drops(self) -> None:
        d = classify(
            event={"text": "lunch plans later?", "user": "U-Y"},
            contract=CONTRACT,
        )
        assert d.action == "drop"


# ── Events API route ────────────────────────────────────────────────


class TestSlackEventsRoute:
    @pytest.mark.asyncio
    async def test_url_verification_returns_challenge(self) -> None:
        req = _signed_req({"type": "url_verification", "challenge": "abc-123"})
        resp, _ = await _call(req)
        assert resp.status_code == 200
        assert json.loads(resp.body) == {"challenge": "abc-123"}

    @pytest.mark.asyncio
    async def test_bad_signature_401(self) -> None:
        from fastapi import HTTPException

        from eden.api.routes import slack as slack_routes

        req = _signed_req({"type": "url_verification", "challenge": "x"}, secret="wrong")
        with patch("eden.config.get_settings", return_value=_settings()):
            with pytest.raises(HTTPException) as ei:
                await slack_routes.slack_events(req)
        assert ei.value.status_code == 401

    @pytest.mark.asyncio
    async def test_bot_no_insert(self) -> None:
        req = _signed_req(_message_envelope(text="refund please", bot_id="B1"))
        _, mocks = await _call(req)
        mocks["insert_extra_work_event"].assert_not_awaited()

    @pytest.mark.asyncio
    async def test_channel_join_no_insert(self) -> None:
        req = _signed_req(_message_envelope(text="joined", subtype="channel_join"))
        _, mocks = await _call(req)
        mocks["insert_extra_work_event"].assert_not_awaited()

    @pytest.mark.asyncio
    async def test_empty_and_emoji_no_insert(self) -> None:
        for text in ("", "   ", ":wave:", "✅"):
            req = _signed_req(_message_envelope(text=text, event_id=f"Ev-{text or 'empty'}"))
            _, mocks = await _call(req)
            mocks["insert_extra_work_event"].assert_not_awaited()

    @pytest.mark.asyncio
    async def test_unmapped_channel_no_insert(self) -> None:
        req = _signed_req(_message_envelope(text="refund please"))
        _, mocks = await _call(
            req,
            {"get_agent_for_channel": AsyncMock(return_value=None)},
        )
        mocks["insert_extra_work_event"].assert_not_awaited()

    @pytest.mark.asyncio
    async def test_thanks_lgtm_no_insert(self) -> None:
        for text in ("thanks", "lgtm", "thank you"):
            req = _signed_req(_message_envelope(text=text, event_id=f"Ev-{text}"))
            _, mocks = await _call(req)
            mocks["insert_extra_work_event"].assert_not_awaited()

    @pytest.mark.asyncio
    async def test_keyword_y_user_inserts_medium(self) -> None:
        req = _signed_req(_message_envelope(text="I handled the refund", user="U-Y"))
        resp, mocks = await _call(req)
        assert resp.status_code == 200
        mocks["insert_extra_work_event"].assert_awaited()
        kwargs = mocks["insert_extra_work_event"].await_args.kwargs
        assert kwargs["kind"] == "human_did_agents_job"
        assert kwargs["confidence"] == "medium"
        assert kwargs["session_id"] is None
        assert kwargs["surface"] == "slack"
        assert kwargs["path"] == "ambient"

    @pytest.mark.asyncio
    async def test_keyword_not_y_inserts_low(self) -> None:
        req = _signed_req(_message_envelope(text="refund stuck", user="U-OTHER"))
        _, mocks = await _call(req)
        kwargs = mocks["insert_extra_work_event"].await_args.kwargs
        assert kwargs["confidence"] == "low"

    @pytest.mark.asyncio
    async def test_duplicate_event_id_one_insert(self) -> None:
        req = _signed_req(_message_envelope(text="refund stuck", event_id="Ev-dup"))
        _, mocks = await _call(
            req,
            {"event_id_seen": AsyncMock(return_value=True)},
        )
        mocks["insert_extra_work_event"].assert_not_awaited()

    @pytest.mark.asyncio
    async def test_message_im_ignored(self) -> None:
        req = _signed_req(
            _message_envelope(text="refund please", channel="D1", channel_type="im")
        )
        _, mocks = await _call(req)
        mocks["insert_extra_work_event"].assert_not_awaited()
        mocks["get_org_id_for_team"].assert_not_awaited()


class TestMigrationDoesNotRetaskOutcome:
    def test_173_does_not_alter_outcome(self) -> None:
        from pathlib import Path

        sql = Path(
            "src/eden/db_migrations/versions/173_help_extra_work.py"
        ).read_text()
        assert "ADD COLUMN IF NOT EXISTS helped" in sql
        assert "ALTER TABLE session_summaries" in sql
        # Must not retask the existing outcome column.
        assert "ALTER COLUMN outcome" not in sql
        assert "DROP COLUMN outcome" not in sql
        assert "outcome =" not in sql
        assert "helped VARCHAR(16)" in sql
        assert "DEFAULT 'unknown'" in sql
        # Reconsent columns live in 174, not 173.
        assert "granted_scopes" not in sql
        assert "history_consented_at" not in sql


def test_signature_helper_still_pinned() -> None:
    body = b'{"type":"event_callback"}'
    ts = str(int(time.time()))
    sig = _sign("signing-1", ts, body)
    assert verify_slack_signature(
        body=body, timestamp=ts, signature=sig, secret="signing-1"
    )

# ── Stage 3 on-box embed (P1.4) ─────────────────────────────────────


class TestStage3Embed:
    def test_keyword_related_y_fires_medium(self) -> None:
        d = classify(
            event={"text": "I will do the refund myself", "user": "U-Y"},
            contract=CONTRACT,
            cosine=0.72,
        )
        assert d.action == "fire"
        assert d.kind == "human_did_agents_job"
        assert d.confidence == "medium"
        assert d.reason == "stage3_keyword_embed"
        assert d.cosine == 0.72

    def test_keyword_unrelated_drops(self) -> None:
        d = classify(
            event={"text": "refund stuck on checkout", "user": "U-Y"},
            contract=CONTRACT,
            cosine=0.10,
        )
        assert d.action == "drop"
        assert d.reason == "stage3_unrelated"
        assert d.kind == ""

    def test_keyword_mid_buffers(self) -> None:
        d = classify(
            event={"text": "refund stuck on checkout", "user": "U-Y"},
            contract=CONTRACT,
            cosine=0.40,
        )
        assert d.action == "buffer"
        assert d.reason == "stage3_uncertain"
        assert d.kind == ""

    def test_no_keyword_related_buffers_not_fire(self) -> None:
        d = classify(
            event={"text": "I will just handle the money-back myself", "user": "U-Y"},
            contract=CONTRACT,
            cosine=0.81,
        )
        assert d.action == "buffer"
        assert d.reason == "stage3_uncertain"

    def test_embed_unavailable_keywords_only_fire(self) -> None:
        d = classify(
            event={"text": "I will do the refund myself", "user": "U-Y"},
            contract=CONTRACT,
            cosine=None,
        )
        assert d.action == "fire"
        assert d.reason == "stage3_keyword"
        assert d.confidence == "medium"

    def test_no_cloud_llm_imports_in_ambient(self) -> None:
        from pathlib import Path

        src = Path("src/eden/integrations/slack/ambient.py").read_text()
        lowered = src.lower()
        assert "openai" not in lowered
        assert "anthropic" not in lowered
        assert "openrouter" not in lowered
        assert "real_embeddings" in src
        assert "Stage 4 (cloud LLM) stays OFF" in src or "Stage 4 (LLM) stays off" in src

    @pytest.mark.asyncio
    async def test_mid_cosine_inserts_candidate_not_event(self) -> None:
        req = _signed_req(_message_envelope(text="refund stuck", event_id="Ev-mid"))
        _, mocks = await _call(
            req,
            {"_stage3_cosine": lambda *a, **k: 0.40},
        )
        mocks["insert_candidate"].assert_awaited()
        mocks["insert_extra_work_event"].assert_not_awaited()
        payload = mocks["insert_candidate"].await_args.kwargs["payload"]
        assert payload["stage"] == 3
        assert payload["reason"] == "stage3_uncertain"

    @pytest.mark.asyncio
    async def test_related_keyword_still_inserts_event(self) -> None:
        req = _signed_req(_message_envelope(text="I handled the refund", user="U-Y"))
        _, mocks = await _call(
            req,
            {"_stage3_cosine": lambda *a, **k: 0.66},
        )
        mocks["insert_extra_work_event"].assert_awaited()
        mocks["insert_candidate"].assert_not_awaited()
        kwargs = mocks["insert_extra_work_event"].await_args.kwargs
        assert kwargs["kind"] == "human_did_agents_job"
        assert kwargs["confidence"] == "medium"

    @pytest.mark.asyncio
    async def test_embed_raises_falls_back_to_keywords(self) -> None:
        def _boom(*a, **k):
            raise RuntimeError("no gpu")

        req = _signed_req(_message_envelope(text="I handled the refund", user="U-Y"))
        _, mocks = await _call(req, {"_stage3_cosine": _boom})
        mocks["insert_extra_work_event"].assert_awaited()
        mocks["insert_candidate"].assert_not_awaited()
