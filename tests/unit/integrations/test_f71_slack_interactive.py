"""F71 — Slack interactive bot tests."""

from __future__ import annotations

import hashlib
import hmac
import time
from unittest.mock import AsyncMock, patch

import pytest

from eden.integrations.slack import interactive as slack


def test_verify_slack_signature_valid() -> None:
    secret = "test-secret"
    body = b"token=x&command=%2Feden&text=issue+abc"
    ts = str(int(time.time()))
    base = f"v0:{ts}:{body.decode()}"
    sig = "v0=" + hmac.new(secret.encode(), base.encode(), hashlib.sha256).hexdigest()
    assert slack.verify_slack_signature(
        signing_secret=secret,
        timestamp=ts,
        body=body,
        signature=sig,
    )


@pytest.mark.asyncio
async def test_slash_command_unknown() -> None:
    with patch(
        "eden.integrations.slack.interactive.resolve_eden_org_for_slack_team",
        new=AsyncMock(return_value="org-eden"),
    ):
        out = await slack.handle_slash_command(
            {"text": "nope", "team_id": "T1"}
        )
    assert out["response_type"] == "ephemeral"
    assert "Unknown command" in out["text"]


def test_verify_slack_signature_rejects_empty_secret() -> None:
    assert (
        slack.verify_slack_signature(
            signing_secret="",
            timestamp=str(int(time.time())),
            body=b"x",
            signature="v0=abc",
        )
        is False
    )


@pytest.mark.asyncio
async def test_ack_issue_updates_triage() -> None:
    issue = AsyncMock()
    issue.status = "open"
    issue.triage_result = {}
    repo = AsyncMock()
    repo.get_issue = AsyncMock(return_value=issue)
    repo.set_triage_result = AsyncMock(return_value=True)
    repo.set_status = AsyncMock(return_value=True)
    with patch("eden.issues.repo.IssuesRepo", return_value=repo):
        out = await slack._ack_issue("org", "iss-1", user_id="U123")
    assert "Acknowledged" in out["text"]
    repo.set_triage_result.assert_awaited_once()
