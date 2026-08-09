"""BUG-12 — list_issues agent_id filter semantics for NULL agent rows."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from eden.issues.repo import UNATTRIBUTED_AGENT_FILTER, IssuesRepo


class _FakePG:
    def __init__(self, issues: list[dict[str, Any]]) -> None:
        self.issues = issues
        self.last_sql: str | None = None
        self.last_args: tuple[Any, ...] = ()

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        self.last_sql = " ".join(sql.split())
        self.last_args = args
        org_id = args[0]
        rows = [r for r in self.issues if r["org_id"] == org_id]
        if "agent_id IS NULL" in self.last_sql:
            rows = [r for r in rows if r.get("agent_id") is None]
        elif "agent_id = $" in self.last_sql:
            agent_id = args[1]
            rows = [r for r in rows if r.get("agent_id") == agent_id]
        return rows


def _issue_row(
    *,
    issue_id: str,
    agent_id: str | None,
) -> dict[str, Any]:
    now = datetime.now(UTC)
    return {
        "id": issue_id,
        "org_id": "org_test",
        "fingerprint": f"fp-{issue_id}",
        "kind": "tool_error",
        "title": issue_id,
        "status": "open",
        "severity": "p2",
        "stumble_count": 1,
        "user_count": 1,
        "repetition_count": 0,
        "agent_id": agent_id,
        "example_stumble_ids": [],
        "triage_result": {},
        "first_seen": now,
        "last_seen": now,
        "created_at": now,
        "updated_at": now,
        "resolved_at": None,
    }


@pytest.fixture
def repo(monkeypatch: pytest.MonkeyPatch) -> IssuesRepo:
    issues_repo = IssuesRepo()

    async def _client() -> _FakePG:
        return _FakePG(
            [
                _issue_row(issue_id="i1", agent_id="agent-a"),
                _issue_row(issue_id="i2", agent_id=None),
            ]
        )

    monkeypatch.setattr(issues_repo, "_client", _client)
    return issues_repo


@pytest.mark.asyncio
async def test_list_issues_without_agent_filter_includes_null_rows(
    repo: IssuesRepo,
) -> None:
    issues = await repo.list_issues("org_test")
    assert len(issues) == 2


@pytest.mark.asyncio
async def test_list_issues_agent_filter_excludes_null_rows(repo: IssuesRepo) -> None:
    issues = await repo.list_issues("org_test", agent_id="agent-a")
    assert len(issues) == 1
    assert issues[0].id == "i1"


@pytest.mark.asyncio
async def test_list_issues_unattributed_sentinel_returns_null_rows(
    repo: IssuesRepo,
) -> None:
    issues = await repo.list_issues(
        "org_test", agent_id=UNATTRIBUTED_AGENT_FILTER
    )
    assert len(issues) == 1
    assert issues[0].id == "i2"
    assert issues[0].agent_id is None
