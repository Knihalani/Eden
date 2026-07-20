"""Unit tests for N18 issue-driven prompt evolution."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.agents.evolution.components import IssuePromptEvolver


class _FakeIssue:
    agent_id = "support-bot"
    fingerprint = "fp"
    kind = "loop"
    title = "Loop"
    stumble_count = 0
    triage_result = {"summary": "too many tool calls"}


class _FakeRepo:
    async def get_issue(self, org_id: str, issue_id: str):
        return _FakeIssue()


@pytest.mark.asyncio
async def test_evolve_from_issue_skips_without_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    class _NoAgent:
        agent_id = None
        fingerprint = "fp"
        kind = "loop"
        title = "x"
        stumble_count = 0
        triage_result = {}

    async def _get_issue(*_a, **_k):
        return _NoAgent()

    monkeypatch.setattr(
        "eden.issues.repo.IssuesRepo",
        lambda: type("R", (), {"get_issue": _get_issue})(),
    )
    result = await IssuePromptEvolver().evolve_from_issue("org", "iss")
    assert result["created"] == 0
    assert result["reason"] == "no_agent"


@pytest.mark.asyncio
async def test_evolve_from_issue_uses_prompts_v2(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("eden.issues.repo.IssuesRepo", lambda: _FakeRepo())

    svc = MagicMock()
    svc.list_versions = AsyncMock(
        return_value=[{"version": 2, "template": "base"}]
    )
    svc.create_version = AsyncMock(
        return_value={"id": "pv-3", "version": 3, "template": "revised"}
    )
    monkeypatch.setattr(
        "eden.services.prompt_versioning.PromptService",
        lambda: svc,
    )
    canary_mock = AsyncMock(return_value=True)
    monkeypatch.setattr(
        "eden.agents.evolution.components.PromptEvolvers._auto_create_canary",
        canary_mock,
    )

    result = await IssuePromptEvolver().evolve_from_issue("org", "iss-1")
    assert result["created"] == 1
    assert result["version"] == 3
    assert result["prompt_version_id"] == "pv-3"
    assert result["canary_enrolled"] is True

    svc.list_versions.assert_awaited_once_with("org", "support-bot", limit=1)
    svc.create_version.assert_awaited()
    kwargs = svc.create_version.await_args.kwargs
    assert "too many tool calls" in kwargs["template"]
    assert kwargs["model"] == "eden-evolver"
    assert kwargs["params"]["source_issue_id"] == "iss-1"
    assert kwargs["params"]["ab_test_active"] is True
    assert canary_mock.await_args.kwargs.get("org_id") == "org"
    assert canary_mock.await_args.kwargs.get("control_version") == 2


@pytest.mark.asyncio
async def test_evolve_from_issue_fails_closed_when_create_rejects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("eden.issues.repo.IssuesRepo", lambda: _FakeRepo())
    svc = MagicMock()
    svc.list_versions = AsyncMock(return_value=[])
    svc.create_version = AsyncMock(return_value=None)
    monkeypatch.setattr(
        "eden.services.prompt_versioning.PromptService",
        lambda: svc,
    )
    result = await IssuePromptEvolver().evolve_from_issue("org", "iss-1")
    assert result["created"] == 0
    assert result["reason"] == "prompts_v2_create_rejected"
    assert "prompts_v2" in result["error"]


@pytest.mark.asyncio
async def test_evolve_from_issue_reports_canary_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("eden.issues.repo.IssuesRepo", lambda: _FakeRepo())
    svc = MagicMock()
    svc.list_versions = AsyncMock(return_value=[])
    svc.create_version = AsyncMock(
        return_value={"id": "pv-1", "version": 1, "template": "x"}
    )
    monkeypatch.setattr(
        "eden.services.prompt_versioning.PromptService",
        lambda: svc,
    )
    monkeypatch.setattr(
        "eden.agents.evolution.components.PromptEvolvers._auto_create_canary",
        AsyncMock(return_value=False),
    )
    result = await IssuePromptEvolver().evolve_from_issue("org", "iss-1")
    assert result["created"] == 1
    assert result["canary_enrolled"] is False
    assert "canary_error" in result
