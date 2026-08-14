"""P1.2 assignment surfaces: customer-forwarded ExtraWorkEvent on extra_work webhook."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.errors import SchemaInvalidError
from eden.observability.ingestion.webhook import WebhookDecoder
from eden.sessions.rollup import derive_helped


def _attr() -> Attribution:
    return Attribution(tenant_id="org_abc", source_format="webhook")


async def _decode(payload: dict, captured: dict) -> list:
    async def fake_insert(org_id, **kwargs):
        captured["org_id"] = org_id
        captured.update(kwargs)
        captured["called"] = True
        return {"id": "e1", **kwargs}

    with patch(
        "eden.integrations.slack.store.insert_extra_work_event",
        fake_insert,
    ):
        return await WebhookDecoder().decode(json.dumps(payload).encode(), _attr())


@pytest.mark.asyncio
async def test_linear_comment_persists_extra_work() -> None:
    captured: dict = {}
    events = await _decode(
        {
            "event_type": "extra_work",
            "surface": "linear",
            "kind": "human_comment",
            "agent_id": "ag",
            "session_id": None,
            "join_key": {"system": "linear", "object_id": "ENG-123"},
            "snippet": "I'll just do the refund myself",
            "observed_at": "2026-08-14T00:00:00Z",
        },
        captured,
    )
    assert events == []
    assert captured.get("called") is True
    assert captured["path"] == "customer_webhook"
    assert captured["surface"] == "linear"
    assert captured["kind"] == "human_comment"
    assert captured["join_key"]["system"] == "linear"
    assert captured["join_key"]["object_id"] == "ENG-123"
    assert captured["confidence"] == "high"
    assert captured["polarity"] == "extra_work"
    assert captured.get("outcome") is None


@pytest.mark.asyncio
async def test_missing_event_type_rejected() -> None:
    with pytest.raises(SchemaInvalidError, match="event_type"):
        await WebhookDecoder().decode(
            json.dumps(
                {
                    "surface": "linear",
                    "kind": "human_comment",
                    "agent_id": "ag",
                    "join_key": {"system": "linear", "object_id": "ENG-123"},
                }
            ).encode(),
            _attr(),
        )


@pytest.mark.asyncio
async def test_intercom_assumed_resolution_is_unknown() -> None:
    captured: dict = {}
    events = await _decode(
        {
            "event_type": "extra_work",
            "surface": "intercom",
            "kind": "assumed_resolution",
            "agent_id": "ag",
            "join_key": {"system": "intercom", "object_id": "conv_1"},
            "assumed_resolution": True,
        },
        captured,
    )
    assert events == []
    assert captured.get("called") is None
    assert derive_helped([]) == "unknown"


@pytest.mark.asyncio
async def test_zendesk_session_ended_alone_is_unknown() -> None:
    captured: dict = {}
    events = await _decode(
        {
            "event_type": "extra_work",
            "surface": "zendesk",
            "agent_id": "ag",
            "join_key": {"system": "zendesk", "object_id": "42"},
            "snippet": "Session ended",
        },
        captured,
    )
    assert events == []
    assert captured.get("called") is None
    assert derive_helped([]) == "unknown"


@pytest.mark.asyncio
async def test_zendesk_escalate_is_not_helped() -> None:
    captured: dict = {}
    events = await _decode(
        {
            "event_type": "extra_work",
            "surface": "zendesk",
            "kind": "escalate",
            "agent_id": "ag",
            "session_id": "sess_1",
            "join_key": {"system": "zendesk", "object_id": "99"},
            "snippet": "escalated to human",
        },
        captured,
    )
    assert events == []
    assert captured.get("called") is True
    assert captured["kind"] == "escalate"
    assert captured["surface"] == "zendesk"
    assert captured["polarity"] == "extra_work"
    assert captured["confidence"] == "high"
    assert (
        derive_helped(
            [{"polarity": captured["polarity"], "confidence": captured["confidence"]}]
        )
        == "not_helped"
    )


@pytest.mark.asyncio
async def test_assignment_surface_requires_object_id() -> None:
    captured: dict = {}
    events = await _decode(
        {
            "event_type": "extra_work",
            "surface": "linear",
            "kind": "human_comment",
            "agent_id": "ag",
            "join_key": {"system": "linear"},
        },
        captured,
    )
    assert events == []
    assert captured.get("called") is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "surface,kind,object_id",
    [
        ("jira", "human_comment", "PROJ-9"),
        ("github", "human_comment", "pr:12"),
        ("intercom", "customer_posted", "conv_9"),
    ],
)
async def test_other_assignment_surfaces_persist(
    surface: str, kind: str, object_id: str
) -> None:
    captured: dict = {}
    events = await _decode(
        {
            "event_type": "extra_work",
            "surface": surface,
            "kind": kind,
            "agent_id": "ag",
            "join_key": {"system": surface, "object_id": object_id},
            "snippet": "human still doing the job",
        },
        captured,
    )
    assert events == []
    assert captured.get("called") is True
    assert captured["surface"] == surface
    assert captured["kind"] == kind
    assert captured["join_key"]["object_id"] == object_id
    assert captured["path"] == "customer_webhook"


@pytest.mark.asyncio
async def test_unknown_surface_does_not_persist() -> None:
    captured: dict = {}
    events = await _decode(
        {
            "event_type": "extra_work",
            "surface": "salesforce",
            "kind": "human_comment",
            "agent_id": "ag",
            "join_key": {"system": "salesforce", "object_id": "x"},
        },
        captured,
    )
    assert events == []
    assert captured.get("called") is None


@pytest.mark.asyncio
async def test_linear_project_pick_resolves_agent_without_vendor_app() -> None:
    captured: dict = {}

    async def fake_insert(org_id, **kwargs):
        captured.update(kwargs)
        captured["called"] = True
        return {"id": "e1", **kwargs}

    with (
        patch(
            "eden.integrations.slack.store.agent_id_for_assignment",
            AsyncMock(return_value="ag-linear"),
        ),
        patch(
            "eden.integrations.slack.store.insert_extra_work_event",
            fake_insert,
        ),
    ):
        events = await WebhookDecoder().decode(
            json.dumps(
                {
                    "event_type": "extra_work",
                    "surface": "linear",
                    "kind": "human_comment",
                    "join_key": {
                        "system": "linear",
                        "object_id": "ENG-123",
                        "team_id": "team-ops",
                    },
                    "snippet": "I'll just do the refund myself",
                }
            ).encode(),
            _attr(),
        )
    assert events == []
    assert captured["called"] is True
    assert captured["agent_id"] == "ag-linear"
    assert captured["surface"] == "linear"
