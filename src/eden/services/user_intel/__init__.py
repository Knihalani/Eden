"""User Intelligence services (Cat 9) — real implementations.

ponytail: per upgradespec §D.2 (Phase 1 cut), the 6
behavioural trackers were reduced to 3 (Regeneration,
Edit, Abandonment). The 3 dropped (Return / CopyPaste /
Retry) were re-runnable from derived metrics.

This package ships the v0 (8 services) + v2 (3
behavioural-signal services + 1 dashboard) surface for
the 23-category intelligence gap roadmap. The 11 services
cover the user-side of the observability story —
sessions, goals, conversations, explicit feedback,
satisfaction, segmentation, the 3 implicit behavioural
signals, the Flat Bayesian selection-bias correction, and
the cohort dashboard.

Service modules
----------------

* :mod:`eden.services.user_intel.sessions` —
  :class:`SessionAnalytics` + :class:`GoalTracker`.
* :mod:`eden.services.user_intel.conversations` —
  :class:`ConversationService`.
* :mod:`eden.services.user_intel.feedback` —
  :class:`UserFeedbackService`.
* :mod:`eden.services.user_intel.segments` —
  :class:`UserSegmentationService`.
* :mod:`eden.services.user_intel.satisfaction` —
  :class:`SatisfactionSignalService` +
  :class:`SelectionBiasCorrector` (the v2 Flat Bayesian
  correction; hierarchical was removed per §D.2).
* :mod:`eden.services.user_intel.behavioural` — the 3
  write-path trackers (Regeneration / Edit /
  Abandonment) + the :class:`BehaviouralDashboard`
  cohort aggregator.

The package degrades gracefully — every fetcher and
persistence helper is best-effort, so an empty
``user_sessions`` / ``user_feedback`` /
``user_behavioural_signals`` table returns a clean
"no data" envelope rather than 500ing.

See ``docs/observability-gap/09-user-intelligence.md``.
"""

from __future__ import annotations

from .behavioural import (
    AbandonmentTracker,
    BehaviouralDashboard,
    EditDistanceTracker,
    RegenerationRateTracker,
)
from .conversations import ConversationService
from .feedback import UserFeedbackService
from .satisfaction import (
    SatisfactionSignalService,
    SelectionBiasCorrector,
)
from .segments import UserSegmentationService
from .sessions import GoalTracker, SessionAnalytics

__all__ = [
    # v0 services
    "SessionAnalytics",
    "GoalTracker",
    "SatisfactionSignalService",
    "ConversationService",
    "UserFeedbackService",
    "UserSegmentationService",
    # v2 behavioural services (kept per §D.2)
    "RegenerationRateTracker",
    "EditDistanceTracker",
    "AbandonmentTracker",
    "SelectionBiasCorrector",
    "BehaviouralDashboard",
]