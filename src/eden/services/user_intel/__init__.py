"""User Intelligence services (Cat 9) — real implementations.

This package ships the v0 (8 services) + v2 (7
behavioural-signal services + 1 dashboard) surface for
the 23-category intelligence gap roadmap. The 15 services
cover the user-side of the observability story —
sessions, goals, conversations, explicit feedback,
satisfaction, segmentation, the 7 implicit behavioural
signals, the Bayesian selection-bias correction, and the
cohort dashboard.

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
  :class:`SelectionBiasCorrector` (the v2 Bayesian
  correction per arXiv 2605.12177).
* :mod:`eden.services.user_intel.behavioural` — the 6
  write-path trackers (Regeneration / Edit / Return /
  Abandonment / CopyPaste / Retry) + the
  :class:`BehaviouralDashboard` cohort aggregator.

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
    CopyPasteTracker,
    EditDistanceTracker,
    RegenerationRateTracker,
    RetryRephraseTracker,
    ReturnToFeatureTracker,
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
    # v2 behavioural services
    "RegenerationRateTracker",
    "EditDistanceTracker",
    "ReturnToFeatureTracker",
    "AbandonmentTracker",
    "CopyPasteTracker",
    "RetryRephraseTracker",
    "SelectionBiasCorrector",
    "BehaviouralDashboard",
]
