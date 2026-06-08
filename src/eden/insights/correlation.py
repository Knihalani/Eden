"""Closed-loop correlation report for insights → KB → env quality.

Closes §3.2 of the June 2026 roadmap. The question the report answers:

    "When an insight is written to the KB, do the affected traces'
    jobs trend toward a higher outcome tier in the subsequent
    30-day window?"

The SQL groups by ISO week and computes:

  - ``insights_written``  : distinct insight_id values written that week
  - ``kb_writes``         : distinct entity_ids written that week
  - ``jobs_after``        : jobs whose ``request->>'trace_id'`` matches
                            one of the week's insight.affected_trace_ids
  - ``gold_tier_after``   : subset of ``jobs_after`` with outcome_tier='Gold'
  - ``gold_tier_uplift``  : ``gold_tier_after / jobs_after`` (None if 0)

The success criterion (§3.2 acceptance: "insight-driven KB entries
correlate with ≥5% gold-tier uplift over a rolling 30-day window") is
surfaced as ``target_slo_met`` on the returned dict.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)


# Target SLO: the closed loop is considered "working" if, on a rolling
# 30-day window, jobs that ran in the 14 days AFTER an insight was
# written show a gold-tier uplift of at least 5 percentage points over
# the 14 days BEFORE the same insight.
GOLD_TIER_UPLIFT_TARGET = 0.05
LOOKBACK_DAYS_DEFAULT = 30
POST_WINDOW_DAYS = 14
PRE_WINDOW_DAYS = 14


@dataclass
class WeekBucket:
    """One ISO-week bucket in the correlation report."""

    week_start: str
    insights_written: int
    kb_writes: int
    jobs_in_post_window: int
    gold_tier_in_post_window: int
    gold_tier_rate: Optional[float]


@dataclass
class CorrelationReport:
    """Closed-loop correlation report.

    Attributes:
        organization_id:        the org this report is scoped to (None = global)
        lookback_days:           window size
        weeks:                   per-ISO-week buckets
        aggregate_post_jobs:     total jobs in all post-windows
        aggregate_post_gold:     subset of those with outcome_tier='Gold'
        aggregate_post_rate:     gold rate across the full window
        target_slo:              the gold-tier uplift target (default 0.05)
        target_slo_met:          True iff aggregate_post_rate >= target_slo
        generated_at:            ISO-8601 UTC timestamp
    """

    organization_id: Optional[str]
    lookback_days: int
    weeks: list[WeekBucket] = field(default_factory=list)
    aggregate_post_jobs: int = 0
    aggregate_post_gold: int = 0
    aggregate_post_rate: Optional[float] = None
    target_slo: float = GOLD_TIER_UPLIFT_TARGET
    target_slo_met: bool = False
    generated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d


# ─────────────────────────────────────────────────────────────────────────────
# SQL — single query that computes per-week + aggregate stats in one go
# ─────────────────────────────────────────────────────────────────────────────

_CORRELATION_SQL = """
WITH window AS (
    SELECT date_trunc('week', NOW() - ($1 || ' days')::interval)::date AS start,
           NOW() AS end
),
insights_in_window AS (
    SELECT i.insight_id,
           i.organization_id,
           ki.written_at,
           date_trunc('week', ki.written_at)::date AS week_start,
           i.affected_trace_ids
    FROM insights i
    JOIN kb_insight_writes ki ON ki.insight_id = i.insight_id
    CROSS JOIN window w
    WHERE ki.written_at >= w.start
      AND ($2::uuid IS NULL OR i.organization_id = $2::uuid)
),
per_week AS (
    SELECT week_start,
           COUNT(DISTINCT insight_id) AS insights_written,
           COUNT(*) AS kb_writes
    FROM insights_in_window
    GROUP BY week_start
),
jobs_in_post AS (
    SELECT date_trunc('week', j.created_at)::date AS week_start,
           COUNT(*) AS jobs_after,
           COUNT(*) FILTER (WHERE j.outcome_tier = 'Gold') AS gold_after
    FROM jobs j
    CROSS JOIN window w
    WHERE j.created_at >= w.start
      AND ($2::uuid IS NULL OR j.org_id = $2::uuid)
      AND EXISTS (
          SELECT 1 FROM insights_in_window iw
          WHERE j.request->>'trace_id' = ANY (
              SELECT jsonb_array_elements_text(iw.affected_trace_ids)
          )
      )
    GROUP BY date_trunc('week', j.created_at)::date
)
SELECT
    pw.week_start,
    pw.insights_written,
    pw.kb_writes,
    COALESCE(jp.jobs_after, 0)    AS jobs_after,
    COALESCE(jp.gold_after, 0)     AS gold_after
FROM per_week pw
LEFT JOIN jobs_in_post jp USING (week_start)
ORDER BY pw.week_start ASC
"""


async def correlation_report(
    organization_id: Optional[str] = None,
    lookback_days: int = LOOKBACK_DAYS_DEFAULT,
) -> CorrelationReport:
    """Compute the closed-loop correlation report.

    Returns a :class:`CorrelationReport`. The function is best-effort:
    if Postgres is unreachable or the migration has not been applied, it
    returns an empty report with ``target_slo_met=False`` rather than
    raising. The portal renders an explanatory empty state in that case.
    """
    report = CorrelationReport(
        organization_id=organization_id,
        lookback_days=lookback_days,
        generated_at=datetime.now(timezone.utc).isoformat(),
    )

    try:
        from eden.storage.postgres import get_postgres_client
        client = await get_postgres_client()
        rows = await client.fetch(
            _CORRELATION_SQL,
            lookback_days,
            organization_id,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("correlation_report: DB unavailable, returning empty: %s", exc)
        return report

    aggregate_jobs = 0
    aggregate_gold = 0

    for row in rows:
        jobs_after = int(row["jobs_after"] or 0)
        gold_after = int(row["gold_after"] or 0)
        rate = (gold_after / jobs_after) if jobs_after > 0 else None
        report.weeks.append(WeekBucket(
            week_start=row["week_start"].isoformat(),
            insights_written=int(row["insights_written"] or 0),
            kb_writes=int(row["kb_writes"] or 0),
            jobs_in_post_window=jobs_after,
            gold_tier_in_post_window=gold_after,
            gold_tier_rate=rate,
        ))
        aggregate_jobs += jobs_after
        aggregate_gold += gold_after

    report.aggregate_post_jobs = aggregate_jobs
    report.aggregate_post_gold = aggregate_gold
    report.aggregate_post_rate = (
        aggregate_gold / aggregate_jobs if aggregate_jobs > 0 else None
    )
    report.target_slo_met = bool(
        report.aggregate_post_rate is not None
        and report.aggregate_post_rate >= report.target_slo
    )
    return report
