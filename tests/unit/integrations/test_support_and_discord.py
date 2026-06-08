"""Unit tests for the support webhook + Discord integrations."""
from __future__ import annotations

import pytest

from eden.integrations.support_webhook import (
    SupportTicketError,
    forward_to_support_webhook,
    validate_ticket,
)


# ────────────────────────────────────────────────────────────────────────
# validate_ticket
# ────────────────────────────────────────────────────────────────────────


def test_validate_ticket_happy_path():
    payload = {
        "subject": "I cannot see my jobs",
        "body": "After upgrading, the jobs page is empty. Can you check?",
        "user_email": "user@example.com",
        "severity": "normal",
        "tags": ["jobs", "ui"],
    }
    out = validate_ticket(payload)
    assert out["subject"] == "I cannot see my jobs"
    assert out["severity"] == "normal"
    assert out["tags"] == ["jobs", "ui"]


def test_validate_ticket_rejects_too_short_subject():
    with pytest.raises(SupportTicketError):
        validate_ticket({
            "subject": "hi",
            "body": "long enough body",
            "user_email": "a@b.com",
        })


def test_validate_ticket_rejects_invalid_email():
    with pytest.raises(SupportTicketError):
        validate_ticket({
            "subject": "valid subject here",
            "body": "long enough body",
            "user_email": "not-an-email",
        })


def test_validate_ticket_rejects_invalid_severity():
    with pytest.raises(SupportTicketError):
        validate_ticket({
            "subject": "valid subject here",
            "body": "long enough body",
            "user_email": "a@b.com",
            "severity": "yelling",
        })


def test_validate_ticket_rejects_non_list_tags():
    with pytest.raises(SupportTicketError):
        validate_ticket({
            "subject": "valid subject here",
            "body": "long enough body",
            "user_email": "a@b.com",
            "tags": "not-a-list",
        })


def test_validate_ticket_truncates_tags_to_10():
    payload = {
        "subject": "valid subject here",
        "body": "long enough body",
        "user_email": "a@b.com",
        "tags": [f"tag-{i}" for i in range(20)],
    }
    out = validate_ticket(payload)
    assert len(out["tags"]) == 10


# ────────────────────────────────────────────────────────────────────────
# forward_to_support_webhook
# ────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_forward_returns_false_when_webhook_url_empty():
    ok = await forward_to_support_webhook({"subject": "x", "body": "y"}, webhook_url="")
    assert ok is False
