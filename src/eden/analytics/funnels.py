"""Funnel analysis.

A *funnel* is an ordered list of events; the result is the
count of distinct users who triggered each event, with
drop-off between consecutive steps. Like the cohort module,
this is §8.2 and falls back to ClickHouse when available.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class FunnelStep:
    name: str
    count: int
    conversion_from_previous: float  # 0.0 - 1.0; 1.0 for the first step


@dataclass(frozen=True)
class FunnelResult:
    name: str
    steps: list[FunnelStep]
    overall_conversion: float  # last step / first step


async def _funnel_clickhouse(org_id: str, steps: list[str], *, window_days: int) -> FunnelResult | None:
    try:
        from eden.data_platform.analytics_engine import get_engine
        engine = get_engine()
    except Exception:
        return None
    sql = f"""
        WITH events AS (
            SELECT user_id, event_name
            FROM user_events
            WHERE org_id = %(org_id)s
              AND created_at >= now() - INTERVAL %(window_days)s DAY
        ),
        per_step AS (
            SELECT step_name, count(DISTINCT user_id) AS n
            FROM (
                SELECT user_id,
                       CASE
                           {' '.join(f'WHEN event_name = %(s_{i})s THEN %(s_{i})s' for i in range(len(steps)))}
                       END AS step_name
                FROM events
            )
            WHERE step_name IS NOT NULL
            GROUP BY step_name
        )
        SELECT step_name, n FROM per_step
    """
    params: dict[str, Any] = {"org_id": org_id, "window_days": window_days}
    for i, s in enumerate(steps):
        params[f"s_{i}"] = s
    rows = await engine.query(sql, params)
    if not rows:
        return None
    counts = {row["step_name"]: int(row["n"]) for row in rows}
    funnel_steps: list[FunnelStep] = []
    previous = None
    for s in steps:
        n = counts.get(s, 0)
        conv = 1.0 if previous is None or previous == 0 else n / previous
        funnel_steps.append(FunnelStep(name=s, count=n, conversion_from_previous=conv))
        previous = n
    overall = 0.0
    if funnel_steps and funnel_steps[0].count > 0:
        overall = funnel_steps[-1].count / funnel_steps[0].count
    return FunnelResult(name=steps[0], steps=funnel_steps, overall_conversion=overall)


async def funnel(org_id: str, steps: list[str], *, window_days: int = 30) -> FunnelResult:
    """Compute a funnel over ``steps`` for ``org_id``."""
    if len(steps) < 2:
        raise ValueError("funnel needs at least 2 steps")
    ch = await _funnel_clickhouse(org_id, steps, window_days=window_days)
    if ch is not None:
        return ch
    # Postgres fallback — collapsed the per-step sequential
    # fetchrow round-trips into a single grouped query (one
    # round-trip instead of ``len(steps)``). Audit 2026-07-07.
    from eden.storage.postgres import get_postgres_client
    client = await get_postgres_client()
    rows = await client.fetch(
        """
        SELECT action, count(DISTINCT user_id)::int AS n
        FROM audit_log
        WHERE org_id = $1
          AND action = ANY($2::text[])
          AND created_at >= NOW() - ($3::int || ' days')::interval
        GROUP BY action
        """,
        org_id,
        list(steps),
        window_days,
    )
    counts = {r["action"]: int(r["n"]) for r in rows}
    funnel_steps: list[FunnelStep] = []
    previous: int | None = None
    for s in steps:
        n = counts.get(s, 0)
        conv = 1.0 if previous is None or previous == 0 else n / previous
        funnel_steps.append(FunnelStep(name=s, count=n, conversion_from_previous=conv))
        previous = n
    overall = 0.0
    if funnel_steps and funnel_steps[0].count > 0:
        overall = funnel_steps[-1].count / funnel_steps[0].count
    return FunnelResult(name=steps[0], steps=funnel_steps, overall_conversion=overall)


__all__ = ["FunnelResult", "FunnelStep", "funnel"]
