"""D6 — failure fixture export tests."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.issues.fixture_export import _redact, export_issue_fixture


def test_redact_sensitive_keys() -> None:
    data = {"api_key": "secret", "nested": {"token": "x", "ok": 1}}
    out = _redact(data)
    assert out["api_key"] == "[REDACTED]"
    assert out["nested"]["token"] == "[REDACTED]"
    assert out["nested"]["ok"] == 1


def test_redact_value_level_ghp_in_message() -> None:
    """M12 (§7.2): ghp_ tokens in non-sensitive keys are pattern-redacted."""
    token = "ghp_LeakCanaryToken0000000000001"
    out = _redact({"error": f"denied {token}"})
    assert token not in out["error"]
    assert "[REDACTED:ghp_]" in out["error"]


@pytest.mark.asyncio
async def test_export_issue_fixture_not_found() -> None:
    with patch("eden.issues.repo.IssuesRepo") as repo_cls:
        repo_cls.return_value.get_issue = AsyncMock(return_value=None)
        result = await export_issue_fixture("org_1", "missing")
    assert result["status"] == "not_found"


@pytest.mark.asyncio
async def test_export_issue_fixture_ok() -> None:
    issue = SimpleNamespace(
        id="iss_1",
        fingerprint="fp",
        kind="tool_error",
        title="boom",
        agent_id="agent_a",
        severity="p2",
    )
    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=issue)
    repo.list_stumbles = AsyncMock(
        return_value=[
            {
                "trace_id": "trc_1",
                "kind": "tool_error",
                "detail": {"api_key": "leak"},
            }
        ]
    )

    with (
        patch("eden.issues.repo.IssuesRepo", return_value=repo),
        patch("eden.issues.fixture_export._client", AsyncMock(return_value=None)),
    ):
        result = await export_issue_fixture("org_1", "iss_1")

    assert result["status"] == "ok"
    bundle = result["fixture"]
    assert bundle["format"] == "eden-failure-fixture-v1"
    assert bundle["issue"]["id"] == "iss_1"
    assert bundle["traces"][0]["stumble"]["kind"] == "tool_error"
