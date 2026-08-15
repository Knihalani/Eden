"""Point 12: setup page watch + notify Slack channels."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.integrations.slack import store as slack_store
from eden.integrations.slack.store import is_forbidden_channel_id

CANNOT_TELL = "We cannot tell if it helped."
LISTENING = "Listening. No leftover work yet. That is unknown, not helped."
INVITE = (
    "Invite `/invite @Eden` in the channels where this job happens. "
    "We read new messages there. We do not keep a chat archive. Kick the bot and we stop."
)


def test_forbidden_channel_ids() -> None:
    assert is_forbidden_channel_id("D0123")
    assert is_forbidden_channel_id("UOWNER")
    assert is_forbidden_channel_id("W0123")
    assert is_forbidden_channel_id("")
    assert is_forbidden_channel_id("   ")
    assert not is_forbidden_channel_id("C0123OPS")
    assert not is_forbidden_channel_id("G0123PRIV")


class _MemPG:
    """In-memory stand-in for agent_slack_channels (AsyncMock _pg)."""

    def __init__(self) -> None:
        self.rows: list[dict] = []

    async def execute(self, sql: str, *args):
        text = " ".join(sql.split())
        if "DELETE FROM agent_slack_channels" in text:
            org_id, agent_id = args[0], args[1]
            self.rows = [
                r
                for r in self.rows
                if not (r["org_id"] == org_id and r["agent_id"] == agent_id)
            ]
            return
        if "INSERT INTO agent_slack_channels" in text:
            self.rows.append(
                {
                    "id": args[0],
                    "org_id": args[1],
                    "agent_id": args[2],
                    "channel_id": args[3],
                    "channel_name": args[4],
                    "set_by_user_id": args[5],
                    "is_notify": args[6],
                }
            )

    async def fetchrow(self, sql: str, *args):
        text = " ".join(sql.split())
        if "agent_id = $2" in text:
            matches = [
                r
                for r in self.rows
                if r["org_id"] == args[0] and r["agent_id"] == args[1]
            ]
            matches.sort(key=lambda r: (0 if r["is_notify"] else 1))
            if not matches:
                return None
            top = matches[0]
            return {"channel_id": top["channel_id"], "channel_name": top["channel_name"]}
        if "agent_id IS NULL" in text:
            matches = [
                r for r in self.rows if r["org_id"] == args[0] and r["agent_id"] is None
            ]
            if not matches:
                return None
            top = matches[0]
            return {"channel_id": top["channel_id"], "channel_name": top["channel_name"]}
        return None


@pytest.mark.asyncio
async def test_save_agent_channels_persists_notify_for_get_channel() -> None:
    pg = _MemPG()
    with patch.object(slack_store, "_pg", AsyncMock(return_value=pg)):
        ok = await slack_store.save_agent_channels(
            "org-1",
            agent_id="agent-9",
            watch=[
                {"channel_id": "C-watch", "channel_name": "ops"},
                {"channel_id": "C-notify", "channel_name": "alerts"},
                {"channel_id": "D-dm", "channel_name": "dm"},
                {"channel_id": "UOWNER", "channel_name": "person"},
            ],
            notify_channel_id="C-notify",
            notify_channel_name="alerts",
        )
        out = await slack_store.get_channel("org-1", agent_id="agent-9")

    assert ok is True
    assert out is not None and out["channel_id"] == "C-notify"
    channel_ids = {r["channel_id"] for r in pg.rows}
    assert channel_ids == {"C-watch", "C-notify"}
    notify_flags = {r["channel_id"]: r["is_notify"] for r in pg.rows}
    assert notify_flags["C-notify"] is True
    assert notify_flags["C-watch"] is False


@pytest.mark.asyncio
async def test_get_channel_prefers_notify_over_watch_only() -> None:
    pg = _MemPG()
    pg.rows = [
        {
            "id": "1",
            "org_id": "org-1",
            "agent_id": "agent-9",
            "channel_id": "C-watch",
            "channel_name": "ops",
            "set_by_user_id": None,
            "is_notify": False,
        },
        {
            "id": "2",
            "org_id": "org-1",
            "agent_id": "agent-9",
            "channel_id": "C-notify",
            "channel_name": "alerts",
            "set_by_user_id": None,
            "is_notify": True,
        },
    ]
    with patch.object(slack_store, "_pg", AsyncMock(return_value=pg)):
        out = await slack_store.get_channel("org-1", agent_id="agent-9")
    assert out is not None
    assert out["channel_id"] == "C-notify"


@pytest.mark.asyncio
async def test_set_channel_rejects_dm() -> None:
    with patch.object(slack_store, "_pg", AsyncMock(return_value=MagicMock())):
        assert await slack_store.set_channel("org-1", agent_id="a1", channel_id="D0123") is False
        assert await slack_store.set_channel("org-1", agent_id="a1", channel_id="UOWNER") is False
        assert await slack_store.set_channel("org-1", agent_id="a1", channel_id="W0123") is False


def test_setup_page_has_no_file_picker() -> None:
    page = Path("clients/portal/src/app/(portal)/agents/new/setup-client.tsx").read_text()
    assert 'type="file"' not in page
    assert "AGENTS.md" not in page
    assert "target_path" not in page
    assert "code_change_enabled" not in page
    assert "SlackWatchPicker" in page
    assert "SlackNotifyPicker" in page
    copy = Path("clients/portal/src/app/(portal)/agents/help-copy.ts").read_text()
    assert CANNOT_TELL in copy
    assert LISTENING in copy
    assert INVITE in copy


def test_help_status_banners_are_normative() -> None:
    routes = Path("src/eden/api/routes/agent_sessions.py").read_text()
    assert CANNOT_TELL in routes
    assert LISTENING in routes
    panel = Path("clients/portal/src/app/(portal)/agents/help-panel.tsx").read_text()
    assert "CANNOT_TELL_BANNER" in panel
    assert "LISTENING_BANNER" in panel
    assert "INVITE_EDEN_COPY" in panel
    assert "No extra work seen — unknown, not helped." not in panel


@pytest.mark.asyncio
async def test_help_status_cannot_tell_when_not_invited() -> None:
    from eden.api.routes.agent_sessions import help_status

    with (
        patch.object(slack_store, "get_install", AsyncMock(return_value=None)),
        patch.object(slack_store, "list_channels", AsyncMock(return_value=[])),
        patch.object(slack_store, "get_current_help_contract", AsyncMock(return_value=None)),
        patch.object(slack_store, "list_leftover_events", AsyncMock(return_value=[])),
        patch.object(
            slack_store,
            "help_counts",
            AsyncMock(return_value={"leftover_7d": 0, "helped": 0, "not_helped": 0, "unknown": 0}),
        ),
    ):
        out = await help_status(org_id="org-1", agent_id="agent-9")
    assert out["data"]["install_bar"]["copy"] == CANNOT_TELL


@pytest.mark.asyncio
async def test_help_status_cannot_tell_when_unmapped() -> None:
    from eden.api.routes.agent_sessions import help_status

    with (
        patch.object(
            slack_store,
            "get_install",
            AsyncMock(return_value={"granted_scopes": "chat:write", "history_consented_at": "t"}),
        ),
        patch.object(slack_store, "list_channels", AsyncMock(return_value=[])),
        patch.object(slack_store, "needs_reconsent", return_value=False),
        patch.object(
            slack_store,
            "get_current_help_contract",
            AsyncMock(return_value={"sentence": "take refunds off Y"}),
        ),
        patch.object(slack_store, "list_leftover_events", AsyncMock(return_value=[])),
        patch.object(
            slack_store,
            "help_counts",
            AsyncMock(return_value={"leftover_7d": 0, "helped": 0, "not_helped": 0, "unknown": 0}),
        ),
    ):
        out = await help_status(org_id="org-1", agent_id="agent-9")
    assert out["data"]["install_bar"]["copy"] == CANNOT_TELL


@pytest.mark.asyncio
async def test_help_status_listening_when_zero_leftover() -> None:
    from eden.api.routes.agent_sessions import help_status

    with (
        patch.object(
            slack_store,
            "get_install",
            AsyncMock(return_value={"granted_scopes": "chat:write", "history_consented_at": "t"}),
        ),
        patch.object(
            slack_store,
            "list_channels",
            AsyncMock(return_value=[{"agent_id": "agent-9", "channel_id": "C1", "is_notify": True}]),
        ),
        patch.object(slack_store, "needs_reconsent", return_value=False),
        patch.object(
            slack_store,
            "get_current_help_contract",
            AsyncMock(return_value={"sentence": "take refunds off Y"}),
        ),
        patch.object(slack_store, "list_leftover_events", AsyncMock(return_value=[])),
        patch.object(
            slack_store,
            "help_counts",
            AsyncMock(return_value={"leftover_7d": 0, "helped": 0, "not_helped": 0, "unknown": 0}),
        ),
    ):
        out = await help_status(org_id="org-1", agent_id="agent-9")
    assert out["data"]["install_bar"]["copy"] == LISTENING


@pytest.mark.asyncio
async def test_stop_watch_channel_deletes_mapping_and_buffer() -> None:
    pg = MagicMock()
    pg.execute = AsyncMock(side_effect=["DELETE 1", "DELETE 2"])
    with patch.object(slack_store, "_pg", AsyncMock(return_value=pg)):
        out = await slack_store.stop_watch_channel("org-1", "C-watch")
    assert out["unmapped"] == 1
    assert out["buffer_deleted"] == 2
    sqls = " ".join(call.args[0] for call in pg.execute.await_args_list)
    assert "agent_slack_channels" in sqls
    assert "extra_work_candidates" in sqls


@pytest.mark.asyncio
async def test_kick_stops_only_when_the_bot_left() -> None:
    from eden.api.routes import slack as slack_routes

    stop = AsyncMock()
    with (
        patch.object(
            slack_store,
            "get_install",
            AsyncMock(return_value={"bot_user_id": "U-bot"}),
        ),
        patch.object(slack_store, "stop_watch_channel", stop),
    ):
        await slack_routes._stop_channel_on_kick(
            "org-1", channel_id="C-watch", leaving_user="U-human"
        )
        stop.assert_not_awaited()
        await slack_routes._stop_channel_on_kick(
            "org-1", channel_id="C-watch", leaving_user="U-bot"
        )
        stop.assert_awaited_once_with("org-1", "C-watch")
        stop.reset_mock()
        await slack_routes._stop_channel_on_kick(
            "org-1", channel_id="C-watch", leaving_user=""
        )
        stop.assert_awaited_once_with("org-1", "C-watch")
        stop.reset_mock()
        with patch.object(slack_store, "get_install", AsyncMock(return_value={})):
            await slack_routes._stop_channel_on_kick(
                "org-1", channel_id="C-watch", leaving_user="U-human"
            )
        stop.assert_not_awaited()


def test_manifest_has_history_and_events_not_im_history() -> None:
    text = Path("integrations/slack/manifest.json").read_text()
    assert "channels:history" in text
    assert "groups:history" in text
    assert "member_left_channel" in text
    assert "im:history" not in text
    assert "/integrations/slack/events" in text
    assert "/integrations/slack/interactions" in text
