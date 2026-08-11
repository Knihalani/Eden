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


# Canonical funnel-step vocabulary for the ``session_summaries``-backed
# Postgres fallback (FEAT-53). See the ``funnel`` docstring/comment below
# for the mapping rationale. Values are trusted, hard-coded SQL boolean
# expressions (never built from caller input), so string-interpolating
# them into the query is safe.
_SESSION_STEP_PREDICATES: dict[str, str] = {
    "session_started": "TRUE",
    "engaged": "turn_count > 1",
    "stumbled": "had_stumble",
    "completed": "outcome = 'success'",
    "failed": "outcome = 'fail'",
}


async def _funnel_clickhouse(org_id: str, steps: list[str], *, window_days: int) -> FunnelResult | None:
    try:
        from eden.data_platform.analytics_engine import get_engine
        engine = get_engine()
    except Exception:
        # ClickHouse optional — fall back to the Postgres path below.
        logger.debug("clickhouse engine unavailable for funnels", exc_info=True)
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
    # Postgres fallback — FEAT-53: repointed at ``session_summaries``
    # (142_session_summaries.py) instead of ``org_audit_log``. Audit logs
    # never modeled funnel/session progress; ``session_summaries`` is the
    # real N12 rollup (eden.sessions.rollup.SessionRollupIndexer) with one
    # row per (org_id, session_id), so a funnel step here means "sessions
    # that reached this stage", not "distinct users who fired an action".
    #
    # Mapping chosen (judgement call — session_summaries has no free-form
    # event log, just fixed aggregate columns, so steps are a fixed
    # canonical vocabulary rather than arbitrary caller-supplied action
    # names):
    #   session_started -> every summarized session (a row only exists
    #                       once the rollup has aggregated >=1 turn).
    #   engaged         -> session ran more than one turn, i.e. the
    #                       conversation continued past the opener
    #                       (turn_count > 1).
    #   stumbled        -> session recorded >=1 agent_stumbles hit
    #                       (had_stumble).
    #   completed       -> session settled with outcome = 'success'.
    #   failed          -> session settled with outcome = 'fail'.
    # Callers passing unrecognized/legacy step names (e.g. old audit-log
    # action strings) get a count of 0 for that step — same
    # degrade-gracefully behavior the old action-matching query had for
    # actions nobody logged.
    known_steps = [s for s in steps if s in _SESSION_STEP_PREDICATES]
    counts: dict[str, int] = dict.fromkeys(steps, 0)
    if known_steps:
        from eden.storage.postgres import get_postgres_client
        client = await get_postgres_client()
        select_clauses = ", ".join(
            f"count(*) FILTER (WHERE {_SESSION_STEP_PREDICATES[s]}) AS step_{i}"
            for i, s in enumerate(known_steps)
        )
        row = await client.fetchrow(
            f"""
            SELECT {select_clauses}
            FROM session_summaries
            WHERE org_id = $1
              AND session_start >= NOW() - ($2::int || ' days')::interval
            """,
            org_id,
            window_days,
        )
        if row is not None:
            for i, s in enumerate(known_steps):
                counts[s] = int(row[f"step_{i}"] or 0)
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
