"""Backwards-compat re-export shim for the v0 stub.

The v0 stub at this path was a flat module with all 6
v0 service classes returning ``not_implemented`` envelopes.
The v1 (this PR) replaces those stubs with real
implementations in the sub-modules under
``eden.services.user_intel.*`` (sessions, conversations,
feedback, segments, satisfaction). This shim re-exports
the classes so old imports keep working.

The behaviour of the classes is now *real* — the methods
are async, read from Postgres, and return live envelopes.
Any code that still does ``from eden.services.user_intel.analytics
import SessionAnalytics`` and calls ``.aggregate(...)`` will
get the real implementation (and needs to ``await`` it).

See :mod:`eden.services.user_intel` for the full surface.
"""

from __future__ import annotations

from .conversations import ConversationService
from .feedback import UserFeedbackService
from .satisfaction import SatisfactionSignalService
from .segments import UserSegmentationService
from .sessions import GoalTracker, SessionAnalytics

__all__ = [
    "SessionAnalytics",
    "GoalTracker",
    "SatisfactionSignalService",
    "ConversationService",
    "UserFeedbackService",
    "UserSegmentationService",
]
