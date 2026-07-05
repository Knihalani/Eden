"""App/site-layer integration services (Phase A1, 2026-06-19).

Service layer for the new ``/orgs/{org_id}/ingest/app`` and
``/orgs/{org_id}/intelligence/user/sessions/*`` and
``/intelligence/user/feedback/presigned-token`` routes.

Subpackages
-----------
- :mod:`.events` — :class:`AppEventsService` (app_events writes)
- :mod:`.sessions` — :class:`SessionIdentityService` (session lifecycle)
- :mod:`.presigned` — :class:`PresignedFeedbackService` (LangSmith-style tokens)
"""
from __future__ import annotations

from .events import MAX_BATCH, AppEventsService
from .presigned import DEFAULT_TTL_SECONDS, PresignedFeedbackService
from .sessions import DEFAULT_TTL_HOURS, SessionIdentityService

__all__ = [
    "AppEventsService",
    "MAX_BATCH",
    "SessionIdentityService",
    "DEFAULT_TTL_HOURS",
    "PresignedFeedbackService",
    "DEFAULT_TTL_SECONDS",
]
