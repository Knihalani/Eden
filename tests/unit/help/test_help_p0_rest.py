
"""P0 remainder: notify_help_miss, Path B, complete(), extra_work webhook, rollup."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.integrations.slack.store import parse_permalink_ts
from eden.services.session_contract import accepted_outcome, pointer_from_payload
from eden.sessions.rollup import derive_helped


def test_permalink_parse() -> None:
    assert parse_permalink_ts("p135854651500008") == "1358546515.000008"
    assert parse_permalink_ts("https://x.slack.com/archives/C1/p135854651500008") == "1358546515.000008"
    assert parse_permalink_ts("1358546515.000008") == "1358546515.000008"
    assert parse_permalink_ts("") is None
    assert parse_permalink_ts("C123") is None


def test_accepted_outcome_rejects_agent_and_missing_source() -> None:
    assert accepted_outcome("helped", "person") == "helped"
    assert accepted_outcome("not_helped", "product") == "not_helped"
    assert accepted_outcome("helped", "agent") is None
    assert accepted_outcome("helped", None) is None
    assert accepted_outcome("helped", "") is None
    assert accepted_outcome("yes", "person") is None


def test_pointer_requires_channel_and_ts() -> None:
    assert pointer_from_payload({"slack": {"channel": "C1", "ts": "1.2"}}) == ("C1", "1.2")
    assert pointer_from_payload({"slack": {"channel": "C1"}}) == (None, None)
    assert pointer_from_payload({"slack_channel": "C1"}) == (None, None)
    assert pointer_from_payload({}) == (None, None)


def test_derive_helped_precedence() -> None:
    assert derive_helped([]) == "unknown"
    assert derive_helped([{"source": "person", "value": "not_helped", "explicit": True}]) == "not_helped"
    assert derive_helped(
        [
            {"source": "person", "value": "helped", "explicit": True},
            {"polarity": "extra_work", "confidence": "medium"},
        ]
    ) == "helped"
    assert derive_helped([{"polarity": "extra_work", "confidence": "medium"}]) == "not_helped"
    assert derive_helped([{"polarity": "extra_work", "confidence": "low"}]) == "unknown"
    assert derive_helped([{"source": "product", "value": "helped", "explicit": True}]) == "helped"
    # agent success is not an input
    assert derive_helped([{"success": True}]) == "unknown"


def test_pointer_classifiers() -> None:
    from eden.integrations.slack.ambient import (
        classify_pointer_message,
        classify_pointer_replies,
    )

    mention = classify_pointer_message(
        message={"user": "U1", "text": "hey <@UOWNER> can you take this", "ts": "2.0", "thread_ts": "1.0"},
        y_slack_user_id="UOWNER",
        bot_ts="1.0",
    )
    assert mention is not None
    assert mention.kind == "mention_intended_owner"
    assert mention.path == "pointer_thread"
    assert mention.confidence == "medium"

    thanks = classify_pointer_message(
        message={"user": "U1", "text": "thanks", "ts": "2.0", "thread_ts": "1.0"},
        bot_ts="1.0",
    )
    assert thanks is not None
    assert thanks.action == "drop"

    takeover = classify_pointer_message(
        message={"user": "U1", "text": "I'll just do the refund", "ts": "2.0", "thread_ts": "1.0"},
        bot_ts="1.0",
    )
    assert takeover is not None
    assert takeover.kind == "thread_takeover"
    assert takeover.confidence == "low"
    assert takeover.polarity == "unscored"

    cleanup = classify_pointer_message(
        message={"user": "U1", "text": "see p135854651500008", "ts": "9.0"},
        bot_ts="1358546515.000008",
    )
    assert cleanup is not None
    assert cleanup.kind == "cleanup_thread"

    hits = classify_pointer_replies(
        replies=[{"ts": "1.0", "user": "BOT", "text": "hi"}, {"ts": "2.0", "user": "U1", "text": "thanks", "thread_ts": "1.0"}],
        bot_user_id="BOT",
        bot_ts="1.0",
    )
    assert all(h.action != "fire" or h.kind != "human_did_agents_job" for h in hits)


@pytest.mark.asyncio
async def test_notify_help_miss_dedup_and_no_approve() -> None:
    from eden.services import slack_notify

    captured: dict = {}

    async def fake_send(org_id, **kwargs):
        captured.update(kwargs)
        captured["org_id"] = org_id
        return {"status": "sent", "ts": "9.9", "channel": "C1"}

    with patch.object(slack_notify, "_send", fake_send):
        result = await slack_notify.notify_help_miss(
            "org1",
            agent_id="agent-a",
            fingerprint="fp1",
            sentence="take refunds off Y",
            channel_name="ops",
            snippet="I'll just do it",
            session_id="sess-1",
        )
    assert result["status"] == "sent"
    assert captured["dedupe_key"] == "helpmiss:agent-a:fp1"
    blob = json.dumps(captured["blocks"])
    assert "Approve" not in blob
    assert "didn’t help" in blob or "didn't help" in blob or "didn" in blob
    assert "Review change" in blob
    assert "Open session" in blob


@pytest.mark.asyncio
async def test_send_persists_pointer_channel_ts() -> None:
    from eden.integrations.slack import store as slack_store
    from eden.services import slack_notify

    slack_store._POINTERS.clear()
    channel = {"channel_id": "C99", "channel_name": "ops"}
    client = MagicMock()
    client.post_message = AsyncMock(return_value={"ok": True, "ts": "11.22", "channel": "C99"})

    with (
        patch.object(slack_notify, "_allow_send", AsyncMock(return_value=True)),
        patch("eden.integrations.slack.store.get_channel", AsyncMock(return_value=channel)),
        patch("eden.integrations.slack.store.get_bot_token", AsyncMock(return_value="xoxb-t")),
        patch("eden.integrations.slack.client.SlackClient", return_value=client),
    ):
        result = await slack_notify._send(
            "org1",
            agent_id="ag",
            dedupe_key="k",
            text="hi",
            blocks=[],
            session_id="s1",
        )
    assert result["status"] == "sent"
    assert result["ts"] == "11.22"
    assert result["channel"] == "C99"
    ptrs = slack_store.get_pointers("org1", session_id="s1")
    assert ptrs and ptrs[0]["ts"] == "11.22" and ptrs[0]["channel_id"] == "C99"


@pytest.mark.asyncio
async def test_complete_rejects_agent_source_still_ends() -> None:
    from eden.services.agent_sessions import AgentSessionService

    svc = AgentSessionService()
    session = await svc.start("org1", agent_id="ag", session_id="11111111-1111-1111-1111-111111111111")
    ended = await svc.complete(
        "org1",
        session.id,
        success=True,
        outcome="helped",
        source="agent",
    )
    assert ended is not None
    assert ended.success is True
    assert slack_outcomes_empty(session.id)


def slack_outcomes_empty(session_id: str) -> bool:
    from eden.integrations.slack import store as slack_store

    return slack_store.memory_outcomes("org1", session_id) == []


@pytest.mark.asyncio
async def test_complete_person_outcome_does_not_copy_success() -> None:
    from eden.integrations.slack import store as slack_store
    from eden.services.agent_sessions import AgentSessionService

    slack_store._OUTCOMES.clear()
    svc = AgentSessionService()
    session = await svc.start("org1", agent_id="ag", session_id="22222222-2222-2222-2222-222222222222")
    ended = await svc.complete(
        "org1",
        session.id,
        success=True,
        outcome="not_helped",
        source="person",
        reason="thumbs_down",
        explicit=True,
    )
    assert ended is not None
    assert ended.success is True  # success stays agent-declared
    rows = slack_store.memory_outcomes("org1", session.id)
    assert rows and rows[0]["value"] == "not_helped"
    assert rows[0]["source"] == "person"


@pytest.mark.asyncio
async def test_python_sdk_complete_omits_rejected_outcome() -> None:
    from eden_sdk.session import AgentSession

    posted: dict = {}

    def fake_notify(phase, payload, *, wait=False):
        posted["phase"] = phase
        posted["payload"] = payload

    session = AgentSession(session_id="s", org_id="o", agent_id="a")
    with patch("eden_sdk.session._notify_session", fake_notify):
        session.complete(success=True, outcome="helped", source="agent")
    assert posted["phase"] == "end"
    assert posted["payload"]["success"] is True
    assert "outcome" not in posted["payload"]

    session2 = AgentSession(session_id="s2", org_id="o", agent_id="a")
    with patch("eden_sdk.session._notify_session", fake_notify):
        session2.complete(
            success=False,
            outcome="helped",
            source="person",
            slack={"channel": "C1", "ts": "1.2"},
        )
    assert posted["payload"]["outcome"] == "helped"
    assert posted["payload"]["source"] == "person"
    assert posted["payload"]["slack"] == {"channel": "C1", "ts": "1.2"}
    assert posted["payload"]["success"] is False


@pytest.mark.asyncio
async def test_webhook_extra_work_persists_and_skips_telemetry() -> None:
    from eden.observability.ingestion.attribution import Attribution
    from eden.observability.ingestion.errors import SchemaInvalidError
    from eden.observability.ingestion.webhook import WebhookDecoder

    captured: dict = {}

    async def fake_insert(org_id, **kwargs):
        captured["org_id"] = org_id
        captured.update(kwargs)
        return {"id": "e1"}

    body = json.dumps(
        {
            "event_type": "extra_work",
            "surface": "linear",
            "kind": "human_did_agents_job",
            "agent_id": "ag",
            "session_id": None,
            "join_key": {"system": "linear", "object_id": "ENG-123"},
            "snippet": "I'll just do the refund myself",
            "observed_at": "2026-08-14T00:00:00Z",
        }
    ).encode()
    with patch(
        "eden.integrations.slack.store.insert_extra_work_event",
        fake_insert,
    ):
        events = await WebhookDecoder().decode(
            body, Attribution(tenant_id="org_abc", source_format="webhook")
        )
    assert events == []
    assert captured["path"] == "customer_webhook"
    assert captured["confidence"] == "high"
    assert captured["agent_id"] == "ag"
    assert captured.get("outcome") is None

    with pytest.raises(SchemaInvalidError, match="event_type"):
        await WebhookDecoder().decode(
            json.dumps({"surface": "linear", "kind": "human_did_agents_job"}).encode(),
            Attribution(tenant_id="org_abc", source_format="webhook"),
        )


@pytest.mark.asyncio
async def test_webhook_span_outcome_not_mapped_to_help() -> None:
    from eden.observability.ingestion.attribution import Attribution
    from eden.observability.ingestion.webhook import WebhookDecoder

    events = await WebhookDecoder().decode(
        json.dumps({"event_type": "span", "outcome": "success", "agent_id": "ag"}).encode(),
        Attribution(tenant_id="org_abc", source_format="webhook"),
    )
    assert len(events) == 1
    assert events[0].event_type == "span"
    assert not hasattr(events[0], "helped") or getattr(events[0], "helped", None) in (None, "unknown")


def test_no_help_route_in_portal() -> None:
    from pathlib import Path

    routes = Path("clients/portal/src/lib/portal-routes.ts").read_text()
    assert '"/help"' not in routes
    assert "'/help'" not in routes
    assert '"/agents"' in routes


def test_conversations_replies_not_history() -> None:
    src = Path("src/eden/integrations/slack/client.py").read_text()
    assert "conversations.replies" in src
    # history may exist for invite backfill later; extra-work reader must be replies
    assert "async def conversations_replies" in src


def test_loud_install_bar_copy() -> None:
    panel = Path("clients/portal/src/app/(portal)/agents/help-panel.tsx").read_text()
    assert "Do not sign the design-partner week" in panel
    assert "We can see this agent run. We cannot tell if it helped" in panel
    assert "no extra work seen" in panel
    routes = Path("src/eden/api/routes/agent_sessions.py").read_text()
    assert "Do not sign the design-partner week" in routes


@pytest.mark.asyncio
async def test_close_pointer_zero_extra_work_writes_nothing() -> None:
    from eden.integrations.slack.ambient import close_pointer_windows

    class _C:
        async def conversations_replies(self, **kwargs):
            return [{"ts": "1.0", "user": "BOT", "text": "hi"}]

    captured = []

    async def fake_insert(*a, **k):
        captured.append(k)
        return {"id": "x"}

    with (
        patch("eden.integrations.slack.client.SlackClient", return_value=_C()),
        patch("eden.integrations.slack.store.insert_extra_work_event", fake_insert),
    ):
        fired = await close_pointer_windows(
            "org1",
            token="xoxb",
            pointers=[{"channel_id": "C1", "ts": "1.0", "session_id": "s1", "agent_id": "ag"}],
            bot_user_id="BOT",
        )
    assert fired == []
    assert captured == []


@pytest.mark.asyncio
async def test_close_pointer_mention_y_fires() -> None:
    from eden.integrations.slack.ambient import close_pointer_windows

    class _C:
        async def conversations_replies(self, **kwargs):
            assert kwargs["channel"] == "C1"
            assert kwargs["ts"] == "1.0"
            return [
                {"ts": "1.0", "user": "BOT", "text": "posted"},
                {"ts": "2.0", "user": "U1", "text": "hey <@UOWNER> take this", "thread_ts": "1.0"},
            ]

    captured = []

    async def fake_insert(org_id, **kwargs):
        captured.append(kwargs)
        return {"id": "e2", "kind": kwargs["kind"]}

    with (
        patch("eden.integrations.slack.client.SlackClient", return_value=_C()),
        patch("eden.integrations.slack.store.insert_extra_work_event", fake_insert),
        patch("eden.sessions.rollup.recompute_session_helped", AsyncMock()),
    ):
        fired = await close_pointer_windows(
            "org1",
            token="xoxb",
            pointers=[{"channel_id": "C1", "ts": "1.0", "session_id": "s1", "agent_id": "ag"}],
            y_slack_user_id="UOWNER",
            bot_user_id="BOT",
        )
    assert fired
    assert captured[0]["kind"] == "mention_intended_owner"
    assert captured[0]["path"] == "pointer_thread"
    assert captured[0]["session_id"] == "s1"


def test_session_rollup_has_helped_not_outcome() -> None:
    contracts = Path("src/eden/api/portal_contracts.py").read_text()
    assert "helped: Literal" in contracts
    assert 'SessionOutcome = Literal["ok", "error", "mixed"]' in contracts
    lens = Path("clients/portal/src/lab/traces-session-lens.tsx").read_text()
    assert "HelpChip" in lens
    mapping = Path("src/eden/api/routes/portal.py").read_text()
    assert 'helped=str(summary.get("helped")' in mapping



def test_reconsent_columns_and_history_scopes() -> None:
    from eden.integrations.slack.oauth import BOT_SCOPES, HISTORY_SCOPES
    from eden.integrations.slack.store import needs_reconsent

    assert HISTORY_SCOPES == ("channels:history", "groups:history", "mpim:history")
    assert set(HISTORY_SCOPES).issubset(set(BOT_SCOPES))
    assert "im:history" not in BOT_SCOPES
    sql173 = Path("src/eden/db_migrations/versions/173_help_extra_work.py").read_text()
    assert "granted_scopes" not in sql173
    assert "history_consented_at" not in sql173
    sql174 = Path("src/eden/db_migrations/versions/174_help_windows_backfill.py").read_text()
    assert "granted_scopes" in sql174
    assert "history_consented_at" in sql174
    assert "history_backfilled_at" in sql174
    assert needs_reconsent(None) is True
    assert needs_reconsent({"granted_scopes": "chat:write", "history_consented_at": None}) is True
    assert needs_reconsent({
        "granted_scopes": "chat:write,channels:history,groups:history,mpim:history",
        "history_consented_at": None,
    }) is True
    assert needs_reconsent({
        "granted_scopes": "chat:write,channels:history,groups:history,mpim:history",
        "history_consented_at": "2026-08-14T00:00:00Z",
    }) is False


def test_channel_picker_bound_on_agents() -> None:
    panel = Path("clients/portal/src/app/(portal)/agents/help-panel.tsx").read_text()
    assert "slackApi.setRoute" in panel
    assert "Map a Slack channel" in panel
    assert "x_keywords" in panel
    assert "y_slack_user_id" in panel
    assert "Y Slack user id" in panel
    assert "Stage 1 drop" in panel
    assert "Do not sign the design-partner week" in panel


def test_help_chip_unknown_not_styled_helped() -> None:
    panel = Path("clients/portal/src/app/(portal)/agents/help-panel.tsx").read_text()
    assert 'data-help-tone={tone}' in panel
    assert "Unknown · invite" in panel
    assert "Unknown · map" in panel
    assert 'unknownReason === "no extra work seen"' in panel
    assert "Unknown · no extra work seen" in panel
    lens = Path("clients/portal/src/lab/traces-session-lens.tsx").read_text()
    assert "HelpChip" in lens
    assert "data-severity={" in lens
    assert "session.helped" not in lens.split("data-severity")[1][:200]


def test_pointer_worker_reuses_maintenance() -> None:
    cron = Path("src/eden/workers/cron_tick.py").read_text()
    assert "_run_pointer_window_close" in cron
    assert "pointer_window_close" in cron
    ambient = Path("src/eden/integrations/slack/ambient.py").read_text()
    assert "async def close_due_pointer_windows" in ambient
    assert "conversations_replies" in ambient
    client = Path("src/eden/integrations/slack/client.py").read_text()
    assert "async def conversations_replies" in client
    # history exists only for invite backfill
    assert "async def conversations_history" in client


def test_invite_backfill_constant_and_stop() -> None:
    ambient = Path("src/eden/integrations/slack/ambient.py").read_text()
    assert "INVITE_BACKFILL_HOURS = 24" in ambient
    assert "async def backfill_on_invite" in ambient
    assert "conversations_history" in ambient
    routes = Path("src/eden/api/routes/slack.py").read_text()
    assert "member_joined_channel" in routes
    assert "backfill_on_invite" in routes


@pytest.mark.asyncio
async def test_invite_backfill_runs_stage_pipeline_once() -> None:
    from eden.integrations.slack import ambient as amb

    amb._BACKFILLED_CHANNELS.clear()
    amb._INVITE_EVENTS_SEEN.clear()
    processed = []

    class _C:
        async def conversations_history(self, **kwargs):
            assert "oldest" in kwargs
            return [
                {"ts": "1.0", "user": "U-Y", "text": "refund stuck", "channel": "C1"},
            ]

    async def fake_process(**kwargs):
        processed.append(kwargs)
        return None

    with (
        patch("eden.integrations.slack.store.get_install", AsyncMock(return_value={"bot_user_id": "BOT"})),
        patch("eden.integrations.slack.store.get_bot_token", AsyncMock(return_value="xoxb")),
        patch("eden.integrations.slack.client.SlackClient", return_value=_C()),
        patch.object(amb, "process_message", fake_process),
    ):
        first = await amb.backfill_on_invite(
            "org1", channel_id="C1", joining_user="BOT", event_id="Ev-inv"
        )
        second = await amb.backfill_on_invite(
            "org1", channel_id="C1", joining_user="BOT", event_id="Ev-inv"
        )
    assert first.get("backfilled") == 1
    assert second.get("skipped") is True
    assert processed[0]["event_id"].startswith("backfill:C1:")


@pytest.mark.asyncio
async def test_close_due_zero_extra_work_unknown() -> None:
    from datetime import UTC, datetime, timedelta

    from eden.integrations.slack import ambient as amb
    from eden.integrations.slack import store as slack_store

    slack_store._POINTERS.clear()
    slack_store._POINTERS.append(
        {
            "org_id": "org1",
            "channel_id": "C1",
            "ts": "1.0",
            "agent_id": "ag",
            "session_id": "s1",
            "opened_at": (datetime.now(UTC) - timedelta(minutes=45)).isoformat(),
            "window_closed_at": None,
        }
    )
    captured = []

    class _C:
        async def conversations_replies(self, **kwargs):
            return [{"ts": "1.0", "user": "BOT", "text": "hi"}]

    async def fake_insert(*a, **k):
        captured.append(k)
        return {"id": "x"}

    with (
        patch("eden.integrations.slack.store.get_bot_token", AsyncMock(return_value="xoxb")),
        patch("eden.integrations.slack.store.get_install", AsyncMock(return_value={"bot_user_id": "BOT"})),
        patch("eden.integrations.slack.store.get_current_help_contract", AsyncMock(return_value=None)),
        patch("eden.integrations.slack.store.list_due_pointers_from_sessions", AsyncMock(return_value=[])),
        patch("eden.integrations.slack.client.SlackClient", return_value=_C()),
        patch("eden.integrations.slack.store.insert_extra_work_event", fake_insert),
    ):
        out = await amb.close_due_pointer_windows()
    assert captured == []
    assert out["closed"] == 1
    assert out["fired"] == 0
    assert slack_store._POINTERS[0]["window_closed_at"]


def test_portal_unknown_reason_mapping() -> None:
    mapping = Path("src/eden/api/routes/portal.py").read_text()
    assert 'unknownReason = "invite"' in mapping
    assert 'unknownReason = "map"' in mapping
    assert 'unknownReason = "no extra work seen"' in mapping
    assert "_annotate_session_help" in mapping
    assert "s.success = success_map.get" in mapping
