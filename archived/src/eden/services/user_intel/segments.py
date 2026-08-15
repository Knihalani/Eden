"""User segmentation (Cat 9 v0).

:class:`UserSegmentationService` — assigns a user to a
cohort (new / active / power / enterprise / dormant) based
on the volume + recency of their sessions. The segmentation
is deterministic and *read-only* — the service writes the
result to the ``user_segments`` table so the front-end
dashboard can group by it.

Per the appendix:

* Segments are recomputed on demand (no background job);
  the segment table is small (one row per active user) so
  the recompute is cheap.
* The thresholds (``power_user_min_sessions`` /
  ``enterprise_min_sessions``) are configurable in
  ``organizations.features``; the defaults are 50 / 500
  sessions in the last 30 days.
* The service is *diagnostic, not vanity* — segments
  surface the "what cohort is this user in" question; the
  *satisfaction* signal comes from
  :class:`SatisfactionSignalService`.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from ._common import _bad_request_envelope, _get_client, _ok_envelope

logger = logging.getLogger(__name__)


#: Default thresholds. Tunable in ``organizations.features``.
#: A "power user" is one with ≥ 50 sessions in the last
#: 30 days; an "enterprise user" is one with ≥ 500.
DEFAULT_POWER_USER_MIN_SESSIONS: int = 50
DEFAULT_ENTERPRISE_MIN_SESSIONS: int = 500

#: Window for the segmentation count. 30 days matches
#: the appendix's default.
SEGMENT_WINDOW_DAYS: int = 30


#: Segment buckets, in priority order. The first matching
#: bucket is the user's segment. A user with ≥ 500 sessions
#: is "enterprise"; ≥ 50 is "power"; ≥ 1 is "active"; 0 in
#: the last 30 days but with any historical session is
#: "dormant"; never had a session is "new".
def _classify(
    sessions_in_window: int,
    total_sessions: int,
    last_event_at: datetime | None,
) -> str:
    if sessions_in_window >= DEFAULT_ENTERPRISE_MIN_SESSIONS:
        return "enterprise"
    if sessions_in_window >= DEFAULT_POWER_USER_MIN_SESSIONS:
        return "power"
    if sessions_in_window > 0:
        return "active"
    if total_sessions == 0:
        return "new"
    return "dormant"


class UserSegmentationService:
    """Cohort assignment for a single user.

    Recomputes the user's segment on demand. The
    classification is deterministic: the same
    (sessions_in_window, total_sessions, last_event_at)
    tuple always yields the same segment.
    """

    name = "user_segments"

    async def segment(
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
                    "segment": "unknown",
                    "sessions_in_window": 0,
                    "total_sessions": 0,
                    "last_event_at": None,
                    "message": "no session data",
                },
            )

        now = datetime.now(UTC)
        window_start = now - timedelta(days=SEGMENT_WINDOW_DAYS)

        # Total sessions (all time) + sessions in the
        # 30-day window + the most-recent event.
        total = 0
        in_window = 0
        last_event: datetime | None = None
        try:
            row = await client.fetchrow(
                """
                SELECT COUNT(*)::int                            AS total,
                       COUNT(*) FILTER (
                         WHERE first_event_at > $3
                       )::int                                  AS in_window,
                       MAX(last_event_at)                       AS last_event
                  FROM user_sessions
                 WHERE org_id = $1 AND user_id = $2
                """,
                org_id,
                user_id,
                window_start,
            )
            if row is not None:
                if isinstance(row, dict):
                    total = int(row.get("total") or 0)
                    in_window = int(row.get("in_window") or 0)
                    last_event = row.get("last_event")
                else:
                    total = int(row["total"] or 0)
                    in_window = int(row["in_window"] or 0)
                    last_event = row["last_event"]
        except Exception as exc:
            logger.debug("user_intel: segment fetch failed: %s", exc)

        seg = _classify(in_window, total, last_event)

        # Persist the segment so the dashboard can GROUP BY.
        try:
            # Clear prior rows for this user, then insert.
            await client.execute(
                """
                DELETE FROM user_segments
                 WHERE org_id = $1 AND user_id = $2
                """,
                org_id,
                user_id,
            )
            await client.execute(
                """
                INSERT INTO user_segments
                    (id, org_id, user_id, segment, computed_at)
                VALUES (gen_random_uuid(), $1, $2, $3, NOW())
                """,
                org_id,
                user_id,
                seg,
            )
        except Exception as exc:
            logger.debug("user_intel: segment write failed: %s", exc)

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "user_id": user_id,
                "segment": seg,
                "sessions_in_window": in_window,
                "total_sessions": total,
                "last_event_at": (
                    last_event.isoformat()
                    if hasattr(last_event, "isoformat")
                    else (str(last_event) if last_event else None)
                ),
                "window_days": SEGMENT_WINDOW_DAYS,
            },
        )
