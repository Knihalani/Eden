"""Regression tests for FEAT-52.

``eden.analytics.cohorts`` used to query the ``jobs`` table for
cohort membership and retention — the wrong table for session-based
cohort analysis. It now queries ``session_summaries`` (see
``src/eden/db_migrations/versions/142_session_summaries.py`` for the
real column schema: ``org_id``, ``session_id``, ``user_id``,
``session_start``, ``session_end``, ...).

These tests assert the SQL passed to the Postgres client references
``session_summaries`` (not ``jobs``), and that the retention math is
still correct against the new table's semantics (a user is "active"
in a week if they have a session whose ``session_start`` falls in
that week).
"""
from __future__ import annotations

import datetime as dt
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.analytics.cohorts import cohort_retention, list_cohorts


class FakePg:
    """Records every ``fetch`` call and returns queued batches in order."""

    def __init__(self, batches: list[list[dict[str, Any]]]) -> None:
        self._batches = list(batches)
        self.queries: list[tuple[str, tuple[Any, ...]]] = []

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        self.queries.append((query, args))
        if self._batches:
            return self._batches.pop(0)
        return []


def _no_clickhouse():
    """Force the ClickHouse branch to fail so the Postgres fallback runs.

    ``eden.data_platform.analytics_engine.get_engine`` does not exist
    today, so the existing ``try/except Exception`` around the local
    import already falls through to Postgres with zero mocking. We
    patch it explicitly anyway (via ``create=True``) so this test
    doesn't silently start hitting the ClickHouse branch if/when
    ``get_engine`` is implemented.
    """
    import eden.data_platform.analytics_engine as ae

    def _raise() -> Any:
        raise RuntimeError("no clickhouse in test")

    return patch.object(ae, "get_engine", _raise, create=True)


async def test_list_cohorts_queries_session_summaries_not_jobs() -> None:
    fake = FakePg([[{"cohort_start": dt.date(2026, 1, 5), "size": 3}]])
    with _no_clickhouse(), patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=fake),
    ):
        cohorts = await list_cohorts("org-1", weeks=4)

    assert len(fake.queries) == 1
    sql, args = fake.queries[0]
    assert "FROM session_summaries" in sql
    assert "FROM jobs" not in sql
    assert args[0] == "org-1"
    assert len(cohorts) == 1
    assert cohorts[0].size == 3


async def test_cohort_retention_queries_session_summaries_for_activity() -> None:
    cohort_rows = [{"cohort_start": dt.date(2026, 1, 5), "size": 2}]
    activity_rows = [
        {"activity_week": dt.date(2026, 1, 5), "user_id": "u1"},
        {"activity_week": dt.date(2026, 1, 5), "user_id": "u2"},
        {"activity_week": dt.date(2026, 1, 12), "user_id": "u1"},
    ]
    fake = FakePg([cohort_rows, activity_rows])
    with _no_clickhouse(), patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=fake),
    ):
        rows = await cohort_retention("org-1", weeks=2)

    # One query for cohort membership, one for activity — both against
    # session_summaries, never jobs.
    assert len(fake.queries) == 2
    for sql, _args in fake.queries:
        assert "session_summaries" in sql
        assert "FROM jobs" not in sql

    assert len(rows) == 1
    row = rows[0]
    assert row.size == 2
    # Week 0 (cohort start week): both cohort members have a session
    # starting that week -> 2/2 active.
    assert row.retention[0] == pytest.approx(1.0)
    # Week 1: only u1 has a session starting that week -> 1/2 active.
    assert row.retention[1] == pytest.approx(0.5)
