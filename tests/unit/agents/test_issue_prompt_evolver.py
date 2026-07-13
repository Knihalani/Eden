"""Unit tests for N18 issue-driven prompt evolution."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from eden.agents.evolution.components import IssuePromptEvolver


class _FakeIssue:
    agent_id = "support-bot"
    fingerprint = "fp"
    kind = "loop"
    title = "Loop"
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
        triage_result = {}

    monkeypatch.setattr(
        "eden.issues.repo.IssuesRepo",
        lambda: type("R", (), {"get_issue": lambda *a, **k: _NoAgent()})(),
    )
    result = await IssuePromptEvolver().evolve_from_issue("org", "iss")
    assert result["created"] == 0


@pytest.mark.asyncio
async def test_evolve_from_issue_inserts_variant(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("eden.issues.repo.IssuesRepo", lambda: _FakeRepo())
    evolver = IssuePromptEvolver()
    pv = AsyncMock()
    pv.get_active_version = AsyncMock(return_value={"version": 2, "prompt": "base"})
    pv.insert_version = AsyncMock(return_value=True)
    evolver.prompt_versions = pv
    evolver._auto_create_canary = AsyncMock(return_value=True)  # type: ignore[method-assign]
    monkeypatch.setattr(
        "eden.agents.evolution.components.PromptEvolvers._auto_create_canary",
        AsyncMock(return_value=True),
    )
    result = await evolver.evolve_from_issue("org", "iss-1")
    assert result["created"] == 1
    pv.insert_version.assert_awaited()
