"""User sessions + goals (Cat 9 v0).

Two services, both backed by the ``user_sessions`` and
``user_goals`` tables from migration 024 / 020:

* :class:`SessionAnalytics` — aggregate session metrics
  (``POST /orgs/{org_id}/intelligence/user/sessions/aggregate``).
  Reads ``user_sessions`` and returns
  ``total_sessions``/``active_users``/``dormant_users``/
  ``returned_users_7d``/``single_turn_abandonment_rate``/
  ``regeneration_rate``/``median_session_length_turns``.
  The "active" vs "dormant" vs "returned" classification is
  derived in-Python from the session's ``last_event_at`` —
  active = last event within the window, dormant = no event
  in 30 days, returned = previously dormant and has a new
  event in the last 7 days.
* :class:`GoalTracker` — track a user's multi-turn goal
  (``POST /orgs/{org_id}/intelligence/user/goals``). Persists
  to ``user_goals`` with status ``active``. The companion
  ``mark_achieved`` / ``mark_abandoned`` methods flip the
  status. Per the appendix, the goal tracker is *multi-turn
  inferred intent* — the SDK writes a row when it detects a
  new goal; the service lists active / completed / abandoned
  goals for a user.

Per the appendix's failure-mode table:

* **Silent user** — defaults to "no signal"; the
  behavioural signal covers the silent majority.
* **Single-turn sessions** — counted in
  ``single_turn_abandonment_rate``; if the rate exceeds the
  per-tenant threshold, the dashboard surfaces it as
  ``alert: "high abandonment"``.

The package degrades gracefully — an empty ``user_sessions``
table returns a "no session data" envelope.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from ._common import (
    _bad_request_envelope,
    _get_client,
    _new_id,
    _ok_envelope,
    _parse_window,
)

logger = logging.getLogger(__name__)


#: A user is "active" if their last session ended within
#: this many days. Default 7 days matches the
#: ``7d`` window default.
ACTIVE_DAYS: int = 7

#: A user is "dormant" if their last session ended more
#: than this many days ago. Default 30 days.
DORMANT_DAYS: int = 30

#: A "returned" user is one who was previously dormant
#: (no event in :data:`DORMANT_DAYS` days) and has a new
#: session within :data:`RETURN_WINDOW_DAYS` days.
RETURN_WINDOW_DAYS: int = 7


# ── Session metrics (read paths) ─────────────────────────────────────


async def _fetch_sessions_in_window(
    org_id: str, interval_sql: str
) -> list[dict[str, Any]]:
    """All ``user_sessions`` rows for the org in the given
    window. Returns ``[]`` on failure / empty. Each row is a
    dict with the column names from the migration."""
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT id, user_id, session_id, first_event_at,
                   last_event_at, n_turns, n_traces, abandoned,
                   first_value_at
              FROM user_sessions
             WHERE org_id = $1
               AND first_event_at > NOW() - $2::interval
            """,
            org_id,
            interval_sql,
        )
    except Exception as exc:
        logger.debug("user_intel: fetch_sessions failed: %s", exc)
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r) if not isinstance(r, dict) else r
        out.append(
            {
                "id": d.get("id"),
                "user_id": d.get("user_id"),
                "session_id": d.get("session_id"),
                "first_event_at": d.get("first_event_at"),
                "last_event_at": d.get("last_event_at"),
                "n_turns": int(d.get("n_turns") or 0),
                "n_traces": int(d.get("n_traces") or 0),
                "abandoned": bool(d.get("abandoned")),
                "first_value_at": d.get("first_value_at"),
            }
        )
    return out


# ── Service: SessionAnalytics ────────────────────────────────────────


class SessionAnalytics:
    """Aggregate session metrics for the org.

    Computes the 7 metrics the front-end renders in the user
    dashboard. The classification (active / dormant /
    returned) is per-user, derived in-Python from the
    session's ``last_event_at`` timestamp.

    The "single_turn_abandonment_rate" is computed as
    ``sessions where n_turns == 1 and abandoned == true``
    divided by ``total_sessions``. Per the appendix, a
    high single-turn abandonment rate is a quality signal —
    the user is dropping off before they even see a useful
    response.
    """

    name = "session_analytics"

    async def aggregate(
        self,
        org_id: str,
        *,
        window: str = "7d",
        user_segment_id: str | None = None,
    ) -> dict[str, Any]:
        interval = _parse_window(window)
        if interval is None:
            return _bad_request_envelope(
                self.name,
                f"invalid window {window!r}; expected e.g. '7d', '30d', '24h'",
            )

        sessions = await _fetch_sessions_in_window(org_id, interval)
        if not sessions:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "window": window,
                    "total_sessions": 0,
                    "active_users": 0,
                    "dormant_users": 0,
                    "returned_users_7d": 0,
                    "single_turn_abandonment_rate": None,
                    "regeneration_rate": None,
                    "median_session_length_turns": None,
                    "message": "no session data",
                },
            )

        # Per-user rollup: track the latest event + the
        # earliest event for the user so we can classify
        # them as active / dormant / returned.
        # ``user_stats[user_id] = {
        #     "last_event_at": max,
        #     "first_event_at": min,
        #     "session_count": int,
        #     "n_turns_sum": int,
        # }
        user_stats: dict[str, dict[str, Any]] = {}
        # For "returned": a user is "returned" if they have
        # ≥ 1 session in the first half of the window AND ≥ 1
        # session in the second half. Simple proxy without a
        # dormant flag in the schema.
        user_has_session_in_first_half: set[str] = set()
        user_has_session_in_second_half: set[str] = set()
        # We need the window midpoint for the "returned"
        # check. Compute the window length in seconds via
        # the interval string. The window-start is
        # ``now - interval``; midpoint is start + interval/2.
        # We use a simple heuristic: "returned" = user has
        # ≥ 1 session > half the window ago (i.e. older)
        # AND ≥ 1 session in the last half of the window
        # (i.e. newer).
        # To compute "half the window ago" we need the
        # window length. The interval string tells us:
        # "7 days" → half is 3.5 days. Easiest: just use
        # the time-since ``last_event_at`` of the user's
        # *oldest* session in the window — if it's > half
        # the window AND the user has a *newer* session too,
        # they're "returned".
        # For simplicity we use a boolean per user: have
        # they been around long enough to be "returned"?
        # If the user's earliest session in the window is
        # > (window/2) ago AND they have a session in the
        # last (window/2), they are returned.
        # We compute the window midpoint by parsing the
        # interval string.
        midpoint: datetime | None = None
        try:
            # Parse "7 days" → 7
            parts = interval.split()
            if len(parts) == 2 and parts[0].isdigit():
                n = int(parts[0])
                # Convert to seconds
                unit = parts[1].rstrip("s")
                mult = {
                    "second": 1,
                    "minute": 60,
                    "hour": 3600,
                    "day": 86400,
                }.get(unit, 86400)
                half_seconds = (n * mult) / 2
                now = datetime.now(UTC)
                from datetime import timedelta

                midpoint = now - timedelta(seconds=half_seconds)
        except Exception:
            midpoint = None

        total_sessions = len(sessions)
        n_turns_list: list[int] = []
        abandoned_single_turn = 0
        for s in sessions:
            user_id = str(s["user_id"])
            n_turns = int(s["n_turns"])
            n_turns_list.append(n_turns)
            if s["abandoned"] and n_turns == 1:
                abandoned_single_turn += 1
            if user_id not in user_stats:
                user_stats[user_id] = {
                    "last_event_at": s["last_event_at"],
                    "first_event_at": s["first_event_at"],
                    "session_count": 0,
                    "n_turns_sum": 0,
                }
            # Max of last_event_at
            le = s["last_event_at"]
            cur_le = user_stats[user_id]["last_event_at"]
            if cur_le is None or (le is not None and le > cur_le):
                user_stats[user_id]["last_event_at"] = le
            # Min of first_event_at
            fe = s["first_event_at"]
            cur_fe = user_stats[user_id]["first_event_at"]
            if cur_fe is None or (fe is not None and fe < cur_fe):
                user_stats[user_id]["first_event_at"] = fe
            user_stats[user_id]["session_count"] += 1
            user_stats[user_id]["n_turns_sum"] += n_turns

            # Classify first-half vs second-half.
            if midpoint is not None and le is not None:
                # ``le`` is a datetime; compare to midpoint
                # (aware or naive). Try: convert both to
                # ISO and compare as strings — works for
                # ISO-8601 with consistent tz.
                le_str = (
                    le.isoformat() if hasattr(le, "isoformat") else str(le)
                )
                mid_str = midpoint.isoformat()
                if le_str >= mid_str:
                    user_has_session_in_second_half.add(user_id)
                else:
                    user_has_session_in_first_half.add(user_id)

        # Classify each user.
        now = datetime.now(UTC)
        from datetime import timedelta

        active_cutoff = now - timedelta(days=ACTIVE_DAYS)
        dormant_cutoff = now - timedelta(days=DORMANT_DAYS)
        active_users = 0
        dormant_users = 0
        for _user_id, stats in user_stats.items():
            le = stats["last_event_at"]
            if le is None:
                continue
            le_str = le.isoformat() if hasattr(le, "isoformat") else str(le)
            ac_str = active_cutoff.isoformat()
            if le_str >= ac_str:
                active_users += 1
            elif le_str < dormant_cutoff.isoformat():
                dormant_users += 1

        returned = user_has_session_in_first_half & user_has_session_in_second_half

        # Single-turn abandonment rate.
        abandonment_rate: float | None = (
            abandoned_single_turn / total_sessions
            if total_sessions > 0
            else None
        )

        # Median session length (turns).
        median_turns: float | None = None
        if n_turns_list:
            sorted_turns = sorted(n_turns_list)
            n = len(sorted_turns)
            mid = n // 2
            if n % 2 == 1:
                median_turns = float(sorted_turns[mid])
            else:
                median_turns = (
                    float(sorted_turns[mid - 1]) + float(sorted_turns[mid])
                ) / 2.0

        # ``regeneration_rate`` is a write-path signal that
        # :class:`behavioural.RegenerationRateTracker` would
        # surface. The aggregate layer reads
        # ``user_behavioural_signals`` to compute the
        # per-session regeneration rate. Best-effort: if
        # the table is empty / not yet populated, we return
        # ``None`` and the front-end renders "no data".
        regen_rate = await _fetch_regeneration_rate(org_id, interval)

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "window": window,
                "user_segment_id": user_segment_id,
                "total_sessions": total_sessions,
                "active_users": active_users,
                "dormant_users": dormant_users,
                "returned_users_7d": len(returned),
                "single_turn_abandonment_rate": (
                    round(abandonment_rate, 4)
                    if abandonment_rate is not None
                    else None
                ),
                "regeneration_rate": regen_rate,
                "median_session_length_turns": (
                    round(median_turns, 2)
                    if median_turns is not None
                    else None
                ),
            },
        )


async def _fetch_regeneration_rate(
    org_id: str, interval_sql: str
) -> float | None:
    """Fraction of traces in the window with
    ``user_behavioural_signals.regenerated = true``. Returns
    ``None`` when the table is empty / not yet populated."""
    client = await _get_client()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            SELECT
                COALESCE(SUM(CASE WHEN regenerated THEN 1 ELSE 0 END), 0)::int
                    AS regen_count,
                COUNT(*)::int AS total
              FROM user_behavioural_signals
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
            """,
            org_id,
            interval_sql,
        )
    except Exception as exc:
        logger.debug("user_intel: regen_rate failed: %s", exc)
        return None
    if row is None:
        return None
    if isinstance(row, dict):
        regen_count = int(row.get("regen_count") or 0)
        total = int(row.get("total") or 0)
    else:
        regen_count = int(row["regen_count"] or 0)
        total = int(row["total"] or 0)
    if total == 0:
        return None
    return round(regen_count / total, 4)


# ── Service: GoalTracker ─────────────────────────────────────────────


class GoalTracker:
    """Track multi-turn inferred intent.

    The SDK writes a row to ``user_goals`` when it detects a
    new goal ("summarise the Q4 board deck", "draft a
    cover letter"). The service persists the row with
    status ``active``; ``mark_achieved`` and
    ``mark_abandoned`` flip the status. ``list_for_user``
    returns all goals for a user grouped by status.

    Per the appendix's failure-mode table, the goal tracker
    is *diagnostic, not vanity* — the goal-completion rate
    per user is a quality signal, but a low completion rate
    on a specific user is a UX signal, not a model signal.
    """

    name = "user_goals"

    async def track(
        self,
        org_id: str,
        *,
        user_id: str,
        goal: str,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        if not user_id or not isinstance(user_id, str):
            return _bad_request_envelope(
                self.name, "user_id is required"
            )
        if not goal or not isinstance(goal, str):
            return _bad_request_envelope(
                self.name, "goal is required"
            )
        # Cap the goal string at 1k chars so a careless
        # caller can't blow up the column.
        goal = goal[:1024]
        goal_id = _new_id("goal")
        client = await _get_client()
        if client is not None:
            try:
                await client.execute(
                    """
                    INSERT INTO user_goals
                        (id, org_id, user_id, session_id, goal, achieved)
                    VALUES ($1, $2, $3, $4, $5, NULL)
                    """,
                    goal_id,
                    org_id,
                    user_id,
                    session_id,
                    goal,
                )
            except Exception as exc:
                logger.debug("user_intel: goal insert failed: %s", exc)
        return _ok_envelope(
            self.name,
            {
                "goal_id": goal_id,
                "org_id": org_id,
                "user_id": user_id,
                "session_id": session_id,
                "goal": goal,
                "status": "active",
            },
        )

    async def mark_achieved(
        self,
        org_id: str,
        *,
        goal_id: str,
    ) -> dict[str, Any]:
        if not goal_id or not isinstance(goal_id, str):
            return _bad_request_envelope(
                self.name, "goal_id is required"
            )
        client = await _get_client()
        if client is not None:
            try:
                await client.execute(
                    """
                    UPDATE user_goals
                       SET achieved = TRUE
                     WHERE id = $1 AND org_id = $2
                    """,
                    goal_id,
                    org_id,
                )
            except Exception as exc:
                logger.debug(
                    "user_intel: mark_achieved failed: %s", exc
                )
        return _ok_envelope(
            self.name,
            {
                "goal_id": goal_id,
                "status": "achieved",
            },
        )

    async def mark_abandoned(
        self,
        org_id: str,
        *,
        goal_id: str,
    ) -> dict[str, Any]:
        if not goal_id or not isinstance(goal_id, str):
            return _bad_request_envelope(
                self.name, "goal_id is required"
            )
        client = await _get_client()
        if client is not None:
            try:
                await client.execute(
                    """
                    UPDATE user_goals
                       SET achieved = FALSE
                     WHERE id = $1 AND org_id = $2
                    """,
                    goal_id,
                    org_id,
                )
            except Exception as exc:
                logger.debug(
                    "user_intel: mark_abandoned failed: %s", exc
                )
        return _ok_envelope(
            self.name,
            {
                "goal_id": goal_id,
                "status": "abandoned",
            },
        )

    async def list_for_user(
        self,
        org_id: str,
        *,
        user_id: str,
    ) -> dict[str, Any]:
        if not user_id or not isinstance(user_id, str):
            return _bad_request_envelope(
                self.name, "user_id is required"
            )
        client = await _get_client()
        if client is None:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "user_id": user_id,
                    "active": [],
                    "achieved": [],
                    "abandoned": [],
                    "counts": {
                        "active": 0,
                        "achieved": 0,
                        "abandoned": 0,
                    },
                    "message": "no goal data",
                },
            )
        try:
            rows = await client.fetch(
                """
                SELECT id, goal, achieved, created_at
                  FROM user_goals
                 WHERE org_id = $1 AND user_id = $2
                 ORDER BY created_at DESC
                 LIMIT 500
                """,
                org_id,
                user_id,
            )
        except Exception as exc:
            logger.debug("user_intel: list_goals failed: %s", exc)
            rows = []

        active: list[dict[str, Any]] = []
        achieved: list[dict[str, Any]] = []
        abandoned: list[dict[str, Any]] = []
        for r in rows:
            d = dict(r) if not isinstance(r, dict) else r
            entry = {
                "goal_id": d.get("id"),
                "goal": d.get("goal"),
                "inferred_at": (
                    d.get("created_at").isoformat()
                    if hasattr(d.get("created_at"), "isoformat")
                    else str(d.get("created_at"))
                ),
            }
            achv = d.get("achieved")
            if achv is True:
                achieved.append(entry)
            elif achv is False:
                abandoned.append(entry)
            else:
                active.append(entry)

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "user_id": user_id,
                "active": active,
                "achieved": achieved,
                "abandoned": abandoned,
                "counts": {
                    "active": len(active),
                    "achieved": len(achieved),
                    "abandoned": len(abandoned),
                },
            },
        )
