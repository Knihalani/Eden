"""Cohort analysis primitives.

A *cohort* is a group of users that share a common starting
event (typically their first job creation). The cohort table
shows, for each subsequent week/month, how many of those users
are still active. This module is the §8.2 backend; the portal
visualises the result.

Backed by ClickHouse via the existing analytics engine
(``eden.data_platform.analytics_engine``); falls back to a
Postgres query when ClickHouse is unavailable.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, timedelta

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Cohort:
    """A cohort identified by its start event + start period."""

    name: str
    start_date: date
    size: int


@dataclass(frozen=True)
class CohortRow:
    """One row of the cohort retention table."""

    cohort: str
    start_date: date
    size: int
    retention: dict[int, float]  # weeks_since_start -> fraction active


def _week_key(d: date) -> int:
    """ISO week number, used as the cohort key."""
    return d.isocalendar().week


async def _cohorts_clickhouse(org_id: str, *, weeks: int) -> list[Cohort]:
    try:
        from eden.data_platform.analytics_engine import get_engine
        engine = get_engine()
    except Exception:
        return []
    sql = """
        SELECT
            toStartOfWeek(first_seen_at) AS cohort_start,
            count(DISTINCT user_id) AS size
        FROM user_activity
        WHERE org_id = %(org_id)s
          AND first_seen_at >= now() - INTERVAL %(weeks)s WEEK
        GROUP BY cohort_start
        ORDER BY cohort_start
    """
    rows = await engine.query(sql, {"org_id": org_id, "weeks": weeks})
    return [Cohort(name=f"week-{row['cohort_start']}", start_date=row["cohort_start"], size=int(row["size"])) for row in rows]


async def _cohorts_postgres(org_id: str, *, weeks: int) -> list[Cohort]:
    from eden.storage.postgres import get_postgres_client
    client = await get_postgres_client()
    cutoff = date.today() - timedelta(weeks=weeks)
    rows = await client.fetch(
        """
        SELECT
            date_trunc('week', created_at)::date AS cohort_start,
            count(DISTINCT user_id)::int AS size
        FROM jobs
        WHERE org_id = $1 AND created_at >= $2
        GROUP BY cohort_start
        ORDER BY cohort_start
        """,
        org_id,
        cutoff,
    )
    return [Cohort(name=f"week-{r['cohort_start']}", start_date=r["cohort_start"], size=int(r["size"])) for r in rows]


async def list_cohorts(org_id: str, *, weeks: int = 8) -> list[Cohort]:
    """List the most recent ``weeks`` cohorts for ``org_id``."""
    ch = await _cohorts_clickhouse(org_id, weeks=weeks)
    if ch:
        return ch
    return await _cohorts_postgres(org_id, weeks=weeks)


async def cohort_retention(org_id: str, *, weeks: int = 8) -> list[CohortRow]:
    """Compute retention for the recent cohorts.

    For each cohort, ``retention[w]`` is the fraction of the
    cohort that was active in week ``w`` since the cohort start.
    """
    cohorts = await list_cohorts(org_id, weeks=weeks)
    if not cohorts:
        return []

    # Audit 2026-07-07 — collapsed the N cohorts × W weeks = O(N*W)
    # sequential fetchrow round-trips into a single grouped query
    # plus a Python-side bucketing step. Pre-fix the inner loop ran
    # ``await client.fetchrow(...)`` for every (cohort, week) cell,
    # so a 8-week view of 8 cohorts cost 64 sequential round-trips.
    from eden.storage.postgres import get_postgres_client
    client = await get_postgres_client()
    if client is None:
        return []

    # Earliest cohort start; we walk forward ``weeks`` windows from
    # each. Pull the full window of activity in one query rather than
    # one query per cohort-week pair.
    earliest = min(c.start_date for c in cohorts)
    latest = max(c.start_date for c in cohorts) + timedelta(weeks=weeks)
    sql_rows = await client.fetch(
        """
        SELECT
            date_trunc('week', created_at)::date AS activity_week,
            user_id
        FROM jobs
        WHERE org_id = $1
          AND created_at >= $2
          AND created_at < $3
        GROUP BY activity_week, user_id
        """,
        org_id,
        earliest,
        latest,
    )

    # Bucket users by (activity_week). A user counts toward cohort
    # C, week W if their ``activity_week`` equals
    # ``C + timedelta(weeks=W)`` (Postgres ``date_trunc('week', ...)``
    # and Python ``start_date + timedelta(weeks=W)`` align to the
    # same Monday-anchored bucket).
    activity_by_week: dict[object, set[object]] = {}
    for r in sql_rows:
        activity_by_week.setdefault(r["activity_week"], set()).add(r["user_id"])

    rows_out: list[CohortRow] = []
    for cohort in cohorts:
        retention: dict[int, float] = {}
        for w in range(weeks):
            start = cohort.start_date + timedelta(weeks=w)
            n = len(activity_by_week.get(start, ()))
            retention[w] = n / max(cohort.size, 1)
        rows_out.append(
            CohortRow(
                cohort=cohort.name,
                start_date=cohort.start_date,
                size=cohort.size,
                retention=retention,
            )
        )
    return rows_out


__all__ = ["Cohort", "CohortRow", "cohort_retention", "list_cohorts"]
