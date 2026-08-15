"""Outcome / ROI Intelligence (Cat 11) — real implementations.

Three services live in :mod:`eden.analytics.outcomes.tracker`:

* :class:`~eden.analytics.outcomes.tracker.OutcomeTracker` —
  attach a business outcome to a trace. Persists to
  ``outcomes``.
* :class:`~eden.analytics.outcomes.tracker.OutcomeRollup` —
  per-department ROI rollup. Reads ``outcomes`` +
  ``usage_events`` (cost) and persists to
  ``outcome_department_rollups``. Fires
  :func:`eden.llmops.promotion_hooks.get_promotion_hook().on_drift_alert`
  for low-ROI departments.
* :class:`~eden.analytics.outcomes.tracker.DepartmentAnalytics` —
  top-level summary + drift z-score. Read-only.

See ``docs/observability-gap/11-outcome-roi-intelligence.md``.
"""

from __future__ import annotations

from .tracker import (
    DepartmentAnalytics,
    OutcomeRollup,
    OutcomeTracker,
)

__all__ = [
    "DepartmentAnalytics",
    "OutcomeRollup",
    "OutcomeTracker",
]
