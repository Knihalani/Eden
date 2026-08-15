"""FEAT-92 — issue fix-PR wiring tests."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.agents.evolution.issue_fix_pr import attempt_issue_prompt_fix_pr


@dataclass
class _FakePR:
    number: int = 42
    url: str = "https://github.com/acme/repo/pull/42"
    branch: str = "eden/issue-prompt-iss-1"
    base: str = "main"
    state: str = "open"
    title: str = "fix"
    created_at: datetime = datetime.now(tz=UTC)


@pytest.mark.asyncio
async def test_attempt_fix_pr_stamps_repo_not_connected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stamped: list[tuple[str, str]] = []

    async def _stamp(org_id, issue_id, *, reason, message):
        stamped.append((reason, message))

    monkeypatch.setattr(
        "eden.improvement.issue_patch_trigger.stamp_patch_blocked",
        _stamp,
    )
    monkeypatch.setattr(
        "eden.providers.factory.resolve_active_repo_id",
        AsyncMock(return_value=None),
    )

    result = await attempt_issue_prompt_fix_pr(
        "org",
        "iss-1",
        agent="support-bot",
        prompt_template="revised",
        issue_title="Loop",
        fingerprint="fp",
    )

    assert result["status"] == "blocked"
    assert result["reason"] == "repo_not_connected"
    assert stamped == [
        (
            "repo_not_connected",
            "Connect a GitHub repo for this agent so Eden can open fix PRs",
        )
    ]


@pytest.mark.asyncio
async def test_attempt_fix_pr_opens_draft_pr(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    create_mock = AsyncMock(return_value=_FakePR())
    monkeypatch.setattr(
        "eden.providers.factory.resolve_active_repo_id",
        AsyncMock(return_value="conn-1"),
    )
    monkeypatch.setattr(
        "eden.integrations.github.is_configured",
        lambda: True,
    )
    monkeypatch.setattr(
        "eden.providers.factory.get_pr_provider_for_org",
        AsyncMock(return_value=MagicMock(create_pr=create_mock)),
    )
    monkeypatch.setattr(
        "eden.providers.factory.get_repo_provider_for_org",
        AsyncMock(return_value=MagicMock()),
    )
    monkeypatch.setattr(
        "eden.providers.factory.resolve_pr_base_branch",
        AsyncMock(return_value="main"),
    )

    issue = MagicMock()
    issue.triage_result = {"patch_blocked": {"reason": "old", "message": "old"}}
    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=issue)
    repo.set_triage_result = AsyncMock()
    monkeypatch.setattr(
        "eden.issues.repo.IssuesRepo",
        lambda: repo,
    )

    result = await attempt_issue_prompt_fix_pr(
        "org",
        "iss-1",
        agent="support-bot",
        prompt_template="revised prompt",
        issue_title="Loop",
        fingerprint="fp",
    )

    assert result["status"] == "opened"
    assert result["pr_number"] == 42
    assert "github.com" in result["pr_url"]
    create_mock.assert_awaited_once()
    req = create_mock.await_args.args[0]
    assert req.draft is True
    assert req.files[0].path == "prompts/support-bot.md"
    assert req.files[0].content == "revised prompt"

    triage = repo.set_triage_result.await_args.args[2]
    assert "patch_blocked" not in triage
    assert triage["fix_pr"]["url"] == result["pr_url"]


@pytest.mark.asyncio
async def test_attempt_fix_pr_stamps_github_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stamped: list[str] = []

    async def _stamp(_org, _iss, *, reason, message):
        stamped.append(reason)

    monkeypatch.setattr(
        "eden.improvement.issue_patch_trigger.stamp_patch_blocked",
        _stamp,
    )
    monkeypatch.setattr(
        "eden.providers.factory.resolve_active_repo_id",
        AsyncMock(return_value="conn-1"),
    )
    monkeypatch.setattr(
        "eden.integrations.github.is_configured",
        lambda: False,
    )

    result = await attempt_issue_prompt_fix_pr(
        "org",
        "iss-1",
        agent="bot",
        prompt_template="x",
        issue_title="t",
        fingerprint="fp",
    )

    assert result["reason"] == "github_not_configured"
    assert stamped == ["github_not_configured"]


@pytest.mark.asyncio
async def test_evolve_from_issue_wires_fix_pr_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from eden.agents.evolution.components import IssuePromptEvolver

    class _Issue:
        agent_id = "support-bot"
        fingerprint = "fp"
        title = "Loop"
        stumble_count = 0
        triage_result = {}

    async def _get_issue(*_a, **_k):
        return _Issue()

    monkeypatch.setattr(
        "eden.issues.repo.IssuesRepo",
        lambda: type("R", (), {"get_issue": _get_issue})(),
    )
    svc = MagicMock()
    svc.get_prompt = AsyncMock(return_value={"id": "p1", "name": "support-bot"})
    svc.list_versions = AsyncMock(return_value=[{"version": 1, "template": "base"}])
    svc.create_version = AsyncMock(
        return_value={"id": "pv-2", "version": 2, "template": "revised"}
    )
    monkeypatch.setattr(
        "eden.services.prompt_versioning.PromptService",
        lambda: svc,
    )
    monkeypatch.setattr(
        "eden.agents.evolution.components.PromptEvolvers._auto_create_canary",
        AsyncMock(return_value=True),
    )
    fix_pr_mock = AsyncMock(
        return_value={"status": "opened", "pr_url": "https://github.com/o/r/pull/1"}
    )
    monkeypatch.setattr(
        "eden.agents.evolution.issue_fix_pr.attempt_issue_prompt_fix_pr",
        fix_pr_mock,
    )

    result = await IssuePromptEvolver().evolve_from_issue("org", "iss-1")

    assert result["created"] == 1
    assert result["fix_pr"]["status"] == "opened"
    fix_pr_mock.assert_awaited_once()
    kwargs = fix_pr_mock.await_args.kwargs
    assert kwargs["agent"] == "support-bot"
    assert "Loop" in kwargs["issue_title"]
