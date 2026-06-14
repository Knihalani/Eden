"""PostMergeMonitor — watch the telemetry at 1h/6h/24h/7d post-merge.

Watches the telemetry for the affected code path at **1h, 6h,
24h, and 7d windows** after merge. The 4-window schedule matches
the Cat 11 :class:`OutcomeTracker` window schedule and the
A/B-testing literature on detecting short-vs-long-term
regressions. For each window, computes the median of the
affected metrics over the window (success rate, judge scores,
latency, cost) and compares against the pre-merge baseline
(median over the matching 1h/6h/24h/7d window *before* merge,
with a 7-day historical floor to handle weekly seasonality).

A regression is a >``revert_threshold_pct`` (default 10%) drop
on ANY of the tracked metrics, OR a statistically-significant
drop (p<0.05 via Welch's t-test) on the COMBINED metric.
Persists to ``post_merge_windows``. Fires
:func:`CodeChangeHook.post_merge_degraded` on regression. The
monitor respects ``min_post_merge_window_hours`` — a
``revert_threshold_pct=10%`` regression detected at 1h is "too
early to revert"; at 24h it fires.

STUB mode (Gate 4b — manual revert) returns the live envelope
with the 4-window schedule. The real implementation will
schedule the 4 window checks via the existing task scheduler.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import _new_id, _ok_envelope

logger = logging.getLogger(__name__)


# The 4 post-merge windows. Order matters: the monitor schedules
# the checks in chronological order (1h first, 7d last).
POST_MERGE_WINDOWS_HOURS: tuple[int, ...] = (1, 6, 24, 168)


class PostMergeMonitor:
    """Watch the telemetry at 1h/6h/24h/7d post-merge windows."""

    name = "post_merge_monitor"

    async def start_watching(
        self,
        org_id: str,
        pr_id: str,
        patch_id: str,
        affected_metrics: list[str] | None = None,
    ) -> dict[str, Any]:
        """Schedule the 4 post-merge window checks.

        STUB: returns the live envelope with the 4-window schedule.
        The real Gate-4b implementation will enqueue 4 cron-like
        tasks via the existing task scheduler.
        """
        metrics = affected_metrics or [
            "success_rate",
            "judge_score_median",
            "latency_p95_ms",
            "cost_per_call_usd",
        ]
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "pr_id": pr_id,
                "patch_id": patch_id,
                "windows": list(POST_MERGE_WINDOWS_HOURS),
                "affected_metrics": metrics,
                "monitor_id": _new_id("pmm"),
                "message": (
                    "Stub schedule — Gate 4b will enqueue 4 "
                    "cron-like tasks via the existing task scheduler."
                ),
            },
        )
