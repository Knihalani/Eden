"""BUG-12 — list_stumbles agent_id filter semantics for NULL agent rows."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from eden.issues.repo import UNATTRIBUTED_AGENT_FILTER, IssuesRepo


class _FakePG:
    def __init__(self, stumbles: list[dict[str, Any]]) -> None:
        self.stumbles = stumbles
        self.last_sql: str | None = None
        self.last_args: tuple[Any, ...] = ()

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        self.last_sql = " ".join(sql.split())
        self.last_args = args
        org_id = args[0]
        rows = [r for r in self.stumbles if r["org_id"] == org_id]
        if "agent_id IS NULL" in self.last_sql:
            rows = [r for r in rows if r.get("agent_id") is None]
        elif "agent_id = $" in self.last_sql:
            agent_id = args[1]
            rows = [r for r in rows if r.get("agent_id") == agent_id]
        return rows


@pytest.fixture
def repo(monkeypatch: pytest.MonkeyPatch) -> IssuesRepo:
    issues_repo = IssuesRepo()

    async def _client() -> _FakePG:
        return _FakePG(
            [
                {
                    "id": "s1",
                    "org_id": "org_test",
                    "trace_id": "t1",
                    "session_id": None,
                    "user_id": "u1",
                    "agent_id": "agent-a",
                    "span_id": None,
                    "kind": "tool_error",
                    "fingerprint": "fp1",
                    "title": "a",
                    "detail": {},
                    "severity": "p2",
                    "detected_by": "test",
                    "detected_at": datetime.now(UTC),
                },
                {
                    "id": "s2",
                    "org_id": "org_test",
                    "trace_id": "t2",
                    "session_id": None,
                    "user_id": "u2",
                    "agent_id": None,
                    "span_id": None,
                    "kind": "tool_error",
                    "fingerprint": "fp2",
                    "title": "b",
                    "detail": {},
                    "severity": "p2",
                    "detected_by": "test",
                    "detected_at": datetime.now(UTC),
                },
            ]
        )

    monkeypatch.setattr(issues_repo, "_client", _client)
    return issues_repo


@pytest.mark.asyncio
async def test_list_stumbles_without_agent_filter_includes_null_rows(
    repo: IssuesRepo,
) -> None:
    rows = await repo.list_stumbles("org_test")
    assert len(rows) == 2


@pytest.mark.asyncio
async def test_list_stumbles_agent_filter_excludes_null_rows(repo: IssuesRepo) -> None:
    rows = await repo.list_stumbles("org_test", agent_id="agent-a")
    assert len(rows) == 1
    assert rows[0]["agent_id"] == "agent-a"


@pytest.mark.asyncio
async def test_list_stumbles_unattributed_sentinel_returns_null_rows(
    repo: IssuesRepo,
) -> None:
    rows = await repo.list_stumbles(
        "org_test", agent_id=UNATTRIBUTED_AGENT_FILTER
    )
    assert len(rows) == 1
    assert rows[0]["agent_id"] is None
