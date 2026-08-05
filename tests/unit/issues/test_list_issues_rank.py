"""FEAT-11 — composite issue ranking in ``IssuesRepo.list_issues``.

Exercises both the SQL-generation contract (default stays recency-only;
``sort="rank"`` swaps in the composite-priority ``ORDER BY``) and the
resulting ordering semantics using a fake Postgres client that mimics the
real ``ORDER BY`` clauses in Python.
"""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from eden.issues.repo import IssuesRepo


def _rank_score(row: dict[str, Any]) -> float:
    weight = {"p0": 4, "p1": 3, "p2": 2}.get(row["severity"], 1)
    user_count = max(row.get("user_count", 1), 1)
    stumble_count = max(row.get("stumble_count", 1), 1)
    triage_result = row.get("triage_result")
    confidence = 0.5
    if triage_result:
        tr = json.loads(triage_result) if isinstance(triage_result, str) else triage_result
        if tr and tr.get("confidence") is not None:
            confidence = float(tr["confidence"])
    return (
        weight
        * math.log(user_count + 1)
        * math.log(stumble_count + 1)
        * confidence
    )


class _FakePG:
    """Fake Postgres client that respects the ORDER BY the SQL requests.

    Only understands the two ``list_issues`` shapes (recency vs. rank) —
    enough to assert the query-building contract without a real database.
    """

    def __init__(self, issues: list[dict[str, Any]]) -> None:
        self.issues = issues
        self.last_sql: str | None = None

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        self.last_sql = " ".join(sql.split())
        org_id = args[0]
        rows = [r for r in self.issues if r["org_id"] == org_id]
        if "CASE severity" in self.last_sql:
            rows = sorted(rows, key=_rank_score, reverse=True)
        else:
            rows = sorted(rows, key=lambda r: r["last_seen"], reverse=True)
        return rows


def _issue(
    iid: str,
    *,
    severity: str,
    user_count: int,
    stumble_count: int,
    confidence: float | None,
    last_seen: datetime,
) -> dict[str, Any]:
    triage_result = (
        json.dumps({"confidence": confidence}) if confidence is not None else None
    )
    return {
        "id": iid,
        "org_id": "org_test",
        "fingerprint": f"fp-{iid}",
        "kind": "tool_error",
        "title": f"issue {iid}",
        "status": "open",
        "severity": severity,
        "stumble_count": stumble_count,
        "user_count": user_count,
        "repetition_count": 1,
        "agent_id": "agent-a",
        "example_stumble_ids": [],
        "triage_result": triage_result,
        "first_seen": last_seen,
        "last_seen": last_seen,
    }


@pytest.fixture
def fixture_issues() -> list[dict[str, Any]]:
    now = datetime.now(UTC)
    return [
        # Old, moderate-severity, but huge blast radius (100 users /
        # 100 stumbles, high triage confidence) — should win under rank
        # despite being the oldest issue.
        _issue(
            "issue-a",
            severity="p2",
            user_count=100,
            stumble_count=100,
            confidence=0.9,
            last_seen=now - timedelta(days=10),
        ),
        # Most recent, top severity, but a tiny, low-confidence blip
        # (2 users / 2 stumbles) — wins under recency, loses under rank.
        _issue(
            "issue-b",
            severity="p0",
            user_count=2,
            stumble_count=2,
            confidence=None,  # untriaged -> COALESCE(..., 0.5)
            last_seen=now,
        ),
        # Middle-aged, mid severity/volume — lands in between on rank.
        _issue(
            "issue-c",
            severity="p1",
            user_count=10,
            stumble_count=10,
            confidence=0.8,
            last_seen=now - timedelta(days=5),
        ),
    ]


@pytest.mark.asyncio
async def test_list_issues_default_sort_is_recency(
    fixture_issues: list[dict[str, Any]],
) -> None:
    """Default (no ``sort``) preserves the historical last_seen-DESC order."""
    fake = _FakePG(fixture_issues)
    repo = IssuesRepo()
    repo._client = lambda: _async_return(fake)  # type: ignore[method-assign]

    issues = await repo.list_issues("org_test")

    assert [i.id for i in issues] == ["issue-b", "issue-c", "issue-a"]
    assert fake.last_sql is not None
    assert "ORDER BY last_seen DESC" in fake.last_sql
    assert "CASE severity" not in fake.last_sql


@pytest.mark.asyncio
async def test_list_issues_sort_recency_explicit_matches_default(
    fixture_issues: list[dict[str, Any]],
) -> None:
    fake = _FakePG(fixture_issues)
    repo = IssuesRepo()
    repo._client = lambda: _async_return(fake)  # type: ignore[method-assign]

    issues = await repo.list_issues("org_test", sort="recency")

    assert [i.id for i in issues] == ["issue-b", "issue-c", "issue-a"]


@pytest.mark.asyncio
async def test_list_issues_sort_rank_uses_composite_score(
    fixture_issues: list[dict[str, Any]],
) -> None:
    """``sort="rank"`` orders by severity x log-dampened volume x confidence.

    issue-a (p2, 100 users/stumbles, 0.9 confidence) has a far larger
    composite score than issue-b (p0 but only 2 users/stumbles,
    untriaged -> 0.5 confidence) despite being 10 days older, which is
    exactly the "old-but-severe-and-widespread issues shouldn't sink to
    the bottom" bug this fix addresses.
    """
    fake = _FakePG(fixture_issues)
    repo = IssuesRepo()
    repo._client = lambda: _async_return(fake)  # type: ignore[method-assign]

    issues = await repo.list_issues("org_test", sort="rank")

    assert [i.id for i in issues] == ["issue-a", "issue-c", "issue-b"]
    assert fake.last_sql is not None
    assert "CASE severity" in fake.last_sql
    assert "ln(GREATEST(user_count, 1) + 1)" in fake.last_sql
    assert "ln(GREATEST(stumble_count, 1) + 1)" in fake.last_sql
    assert "COALESCE((triage_result->>'confidence')::double precision, 0.5)" in fake.last_sql
    # Still tie-breaks on last_seen DESC after the composite score.
    assert fake.last_sql.rstrip().split("ORDER BY", 1)[1].strip().endswith(
        "last_seen DESC LIMIT $2 OFFSET $3"
    )


async def _async_return(value: Any) -> Any:
    return value
