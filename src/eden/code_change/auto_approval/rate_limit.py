"""AutoApprovalRateLimiter — enforce the per-day + per-file-per-week caps.

Per the v1.6 cat spec, the limiter enforces
``max_auto_approvals_per_day`` and
``max_auto_approvals_per_file_per_week``. Backed by
``auto_approval_events`` (count the rows in the last 24h / 7d
for the org / file).

When the rate limit is hit, the next patch that would have
auto-approved is **denied** (not queued) with a
``reason: "rate_limit_exceeded"``. The
:class:`AgentActivityFeed` emits a
``auto_approval_rate_limited`` event so the admin can see the
cap was hit.

STUB mode (Gate 4a) is a pure function: it takes the
per-day/per-week counters and returns the allow/deny
verdict. No persistence (the real Gate-4a implementation
counts the ``auto_approval_events`` rows).
"""

from __future__ import annotations

import logging
from typing import Any

from .._common import _new_id, _ok_envelope

logger = logging.getLogger(__name__)


class AutoApprovalRateLimiter:
    """Enforce the per-day + per-file-per-week auto-approval caps."""

    name = "auto_approval_rate_limiter"

    async def check(
        self,
        org_id: str,
        per_day_count: int,
        per_file_per_week_count: int,
        max_per_day: int,
        max_per_file_per_week: int,
    ) -> dict[str, Any]:
        """Return the allow/deny verdict + the remaining counts.

        STUB: pure function. The real Gate-4a implementation
        will count ``auto_approval_events`` rows.
        """
        per_day_exceeded = per_day_count >= max_per_day
        per_file_exceeded = per_file_per_week_count >= max_per_file_per_week
        allowed = not (per_day_exceeded or per_file_exceeded)

        return _ok_envelope(
            self.name,
            {
                "allowed": allowed,
                "per_day": {
                    "current": per_day_count,
                    "max": max_per_day,
                    "remaining_today": max(0, max_per_day - per_day_count),
                    "exceeded": per_day_exceeded,
                },
                "per_file_per_week": {
                    "current": per_file_per_week_count,
                    "max": max_per_file_per_week,
                    "remaining_this_week": max(
                        0, max_per_file_per_week - per_file_per_week_count
                    ),
                    "exceeded": per_file_exceeded,
                },
                "limit_id": _new_id("aa_rl"),
                "message": (
                    "Stub limiter — Gate 4a will count "
                    "auto_approval_events rows."
                ),
            },
        )
