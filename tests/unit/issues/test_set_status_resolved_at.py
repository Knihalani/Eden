"""BUG-14 — ``IssuesRepo.set_status`` must clear ``resolved_at`` on reopen.

Before this fix, ``set_status`` only ever set ``resolved_at = NOW()`` when
``set_resolved_at=True`` and never cleared it otherwise. Reopening an issue
(``status="open"``, ``set_resolved_at=False``) left a stale ``resolved_at``
from a prior resolve, so a reopened issue still looked "resolved at ..." to
anything reading that column directly.
"""

from __future__ import annotations

from typing import Any

import pytest

from eden.issues.repo import IssuesRepo


class _FakePG:
    """Fake Postgres client that just records the executed SQL + args."""

    def __init__(self) -> None:
        self.last_sql: str | None = None
        self.last_args: tuple[Any, ...] | None = None

    async def execute(self, sql: str, *args: Any) -> str:
        self.last_sql = " ".join(sql.split())
        self.last_args = args
        return "UPDATE 1"


async def _async_return(value: Any) -> Any:
    return value


@pytest.mark.asyncio
async def test_set_status_open_clears_resolved_at() -> None:
    """Reopening (status="open", set_resolved_at default False) must clear
    resolved_at rather than leave it untouched."""
    fake = _FakePG()
    repo = IssuesRepo()
    repo._client = lambda: _async_return(fake)  # type: ignore[method-assign]

    ok = await repo.set_status("org_test", "issue-1", "open")

    assert ok is True
    assert fake.last_sql is not None
    assert "resolved_at = NULL" in fake.last_sql
    assert "resolved_at = NOW()" not in fake.last_sql


@pytest.mark.asyncio
async def test_set_status_resolved_still_sets_now() -> None:
    """Resolving still stamps resolved_at = NOW() as before."""
    fake = _FakePG()
    repo = IssuesRepo()
    repo._client = lambda: _async_return(fake)  # type: ignore[method-assign]

    ok = await repo.set_status(
        "org_test", "issue-1", "resolved", set_resolved_at=True
    )

    assert ok is True
    assert fake.last_sql is not None
    assert "resolved_at = NOW()" in fake.last_sql
    assert "resolved_at = NULL" not in fake.last_sql


@pytest.mark.asyncio
async def test_set_status_other_statuses_leave_resolved_at_untouched() -> None:
    """Non-open, non-resolving transitions (e.g. "triaged") shouldn't touch
    resolved_at at all — only an explicit reopen (status="open") clears it."""
    fake = _FakePG()
    repo = IssuesRepo()
    repo._client = lambda: _async_return(fake)  # type: ignore[method-assign]

    ok = await repo.set_status("org_test", "issue-1", "triaged")

    assert ok is True
    assert fake.last_sql is not None
    assert "resolved_at" not in fake.last_sql
