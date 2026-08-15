"""Tests for the webhook (catch-all) decoder."""

import json

import pytest

from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.errors import (
    BodyTooLargeError,
    SchemaInvalidError,
)
from eden.observability.ingestion.webhook import WebhookDecoder


def _webhook_payload(**overrides) -> dict:
    p = {
        "event_id": "whk_1",
        "trace_id": "trace_1",
        "event_type": "custom.event",
        "timestamp": "2024-01-01T00:00:00Z",
        "name": "my-event",
        "realm": "production",
        "payload": {"x": 1},
    }
    p.update(overrides)
    return p


def test_webhook_detect_positive():
    body = json.dumps(_webhook_payload()).encode()
    assert WebhookDecoder().detect(body, None) is True


def test_webhook_detect_list():
    body = json.dumps([_webhook_payload(), _webhook_payload()]).encode()
    assert WebhookDecoder().detect(body, None) is True


def test_webhook_detect_negative():
    assert WebhookDecoder().detect(b"not json", None) is False
    assert WebhookDecoder().detect(json.dumps("just a string").encode(), None) is False


@pytest.mark.asyncio
async def test_webhook_decode_minimum():
    events = await WebhookDecoder().decode(
        json.dumps(_webhook_payload()).encode(),
        Attribution(tenant_id="org_abc", source_format="webhook"),
    )
    assert len(events) == 1
    e = events[0]
    assert e.event_type == "custom.event"
    assert e.source_format == "webhook"
    assert e.event_id == "whk_1"
    assert e.trace_id == "trace_1"
    assert e.name == "my-event"
    assert e.payload == {"x": 1}


@pytest.mark.asyncio
async def test_webhook_decode_list_input():
    body = json.dumps([
        _webhook_payload(event_id="a"),
        _webhook_payload(event_id="b"),
    ]).encode()
    events = await WebhookDecoder().decode(
        body, Attribution(tenant_id="org_abc", source_format="webhook")
    )
    assert len(events) == 2
    assert events[0].event_id == "a"
    assert events[1].event_id == "b"


@pytest.mark.asyncio
async def test_webhook_decode_missing_event_type_raises():
    payload = _webhook_payload()
    del payload["event_type"]
    with pytest.raises(SchemaInvalidError, match="event_type"):
        await WebhookDecoder().decode(
            json.dumps(payload).encode(),
            Attribution(tenant_id="org_abc", source_format="webhook"),
        )


@pytest.mark.asyncio
async def test_webhook_decode_empty_event_type_raises():
    payload = _webhook_payload(event_type="")
    with pytest.raises(SchemaInvalidError, match="event_type"):
        await WebhookDecoder().decode(
            json.dumps(payload).encode(),
            Attribution(tenant_id="org_abc", source_format="webhook"),
        )


@pytest.mark.asyncio
async def test_webhook_decode_optional_fields_default():
    """Only event_type is required; everything else can be absent."""
    events = await WebhookDecoder().decode(
        json.dumps({"event_type": "minimal.event"}).encode(),
        Attribution(tenant_id="org_abc", source_format="webhook"),
    )
    assert len(events) == 1
    # event_id and trace_id synthesized.
    assert events[0].event_id.startswith("ing_")
    assert events[0].trace_id.startswith("trace_")


@pytest.mark.asyncio
async def test_webhook_decode_invalid_json_raises():
    with pytest.raises(SchemaInvalidError, match="not valid JSON"):
        await WebhookDecoder().decode(
            b"not json",
            Attribution(tenant_id="org_abc", source_format="webhook"),
        )


@pytest.mark.asyncio
async def test_webhook_decode_body_too_large_raises():
    settings_mod = pytest.MonkeyPatch()
    # The hard cap is 8 MiB — generate a body just over it.
    huge = b'{"event_type": "x", "payload": "' + b"a" * (8 * 1024 * 1024) + b'"}'
    with pytest.raises(BodyTooLargeError):
        await WebhookDecoder().decode(
            huge,
            Attribution(tenant_id="org_abc", source_format="webhook"),
        )
    settings_mod.undo()


@pytest.mark.asyncio
async def test_webhook_decode_hard_cap_enforced():
    """The hard cap (8 MiB) is enforced even when settings is permissive."""
    from eden.observability.ingestion.webhook import _MAX_BODY_HARD_CAP

    # Build a body just over the hard cap.
    body = b'{"event_type": "x", "payload": {"padding": "' + b"a" * (_MAX_BODY_HARD_CAP + 100) + b'"}}'
    assert len(body) > _MAX_BODY_HARD_CAP
    with pytest.raises(BodyTooLargeError, match="hard cap"):
        await WebhookDecoder().decode(
            body,
            Attribution(tenant_id="org_abc", source_format="webhook"),
        )


@pytest.mark.asyncio
async def test_webhook_decode_per_item_source_format_override():
    """A per-item source_format overrides the path's format."""
    events = await WebhookDecoder().decode(
        json.dumps({**_webhook_payload(), "source_format": "my_custom_format"}).encode(),
        Attribution(tenant_id="org_abc", source_format="webhook"),
    )
    assert events[0].source_format == "my_custom_format"
