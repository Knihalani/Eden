"""Intelligence Gap — User Intelligence (Cat 9) routes.

7 routes backed by real implementations in
:mod:`eden.services.user_intel`:

* ``POST /orgs/{org_id}/intelligence/user/sessions/aggregate``
  — session metrics (active / dormant / returned / abandon
  rate / regen rate / median length).
* ``POST /orgs/{org_id}/intelligence/user/goals`` — track a
  multi-turn inferred intent.
* ``PATCH /orgs/{org_id}/intelligence/user/goals/{goal_id}``
  — mark a goal as ``achieved`` or ``abandoned``.
* ``GET /orgs/{org_id}/intelligence/user/conversation/{session_id}``
  — read a session's message history.
* ``POST /orgs/{org_id}/intelligence/user/conversation/message``
  — append a message (idempotent on role + content hash).
* ``POST /orgs/{org_id}/intelligence/user/feedback`` — submit
  thumbs-up/down.
* ``GET /orgs/{org_id}/intelligence/user/feedback/{trace_id}``
  — read the explicit feedback for a trace.
* ``GET /orgs/{org_id}/intelligence/user/satisfaction/{trace_id}``
  — full satisfaction envelope (explicit + implicit +
  corrected + coverage-weighted).
* ``GET /orgs/{org_id}/intelligence/user/segment?user_id=...``
  — cohort assignment.
* ``GET /orgs/{org_id}/intelligence/user/dashboard/cohort``
  — cohort-level aggregate of the 7 implicit signals.

Plus the 6 v2 behavioural write paths:

* ``POST /orgs/{org_id}/intelligence/user/signals/regeneration``
* ``POST /orgs/{org_id}/intelligence/user/signals/edit-distance``
* ``POST /orgs/{org_id}/intelligence/user/signals/return``
* ``POST /orgs/{org_id}/intelligence/user/signals/abandonment``
* ``POST /orgs/{org_id}/intelligence/user/signals/copy-paste``
* ``POST /orgs/{org_id}/intelligence/user/signals/retry``

Total: 13 routes, gated by the umbrella
``intelligence_gap_v0`` feature flag.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag
from eden.services.user_intel import (
    AbandonmentTracker,
    BehaviouralDashboard,
    ConversationService,
    EditDistanceTracker,
    GoalTracker,
    RegenerationRateTracker,
    SatisfactionSignalService,
    SelectionBiasCorrector,
    SessionAnalytics,
    UserFeedbackService,
    UserSegmentationService,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/user",
    tags=["intelligence-user"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
    ],
)

# Module-level singletons — stateless services. The
# methods are async so the singleton is safe to share
# across concurrent requests.
_sessions = SessionAnalytics()
_goals = GoalTracker()
_satisfaction = SatisfactionSignalService()
_corrector = SelectionBiasCorrector()
_conversations = ConversationService()
_feedback = UserFeedbackService()
_segments = UserSegmentationService()
_dashboard = BehaviouralDashboard()

_regen = RegenerationRateTracker()
_edit = EditDistanceTracker()
# ponytail: ReturnToFeatureTracker / CopyPasteTracker /
# RetryRephraseTracker removed per upgradespec §D.2
# (Phase 1 cut). Routes that previously called them now
# return 501 via _deferred().
_abandon = AbandonmentTracker()


# ── v0 request bodies ────────────────────────────────────────────────


class GoalRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    goal: str = Field(..., min_length=1, max_length=1024)
    session_id: str | None = Field(default=None, max_length=128)


class GoalStatusRequest(BaseModel):
    status: str = Field(..., pattern="^(achieved|abandoned)$")


class ConversationMessageRequest(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=128)
    role: str = Field(..., min_length=1, max_length=16)
    content: str = Field(..., min_length=1, max_length=16384)


class FeedbackRequest(BaseModel):
    trace_id: str = Field(..., min_length=1, max_length=128)
    thumbs: str = Field(..., min_length=1, max_length=16)
    user_id: str | None = Field(default=None, max_length=128)
    comment: str | None = Field(default=None, max_length=2048)
    rating: int | None = Field(default=None, ge=1, le=5)


# ── v2 behavioural-signal request bodies ─────────────────────────────


class RegenerationRequest(BaseModel):
    trace_id: str = Field(..., min_length=1, max_length=128)
    user_id: str = Field(..., min_length=1, max_length=128)
    regenerated: bool = True


class EditDistanceRequest(BaseModel):
    trace_id: str = Field(..., min_length=1, max_length=128)
    user_id: str = Field(..., min_length=1, max_length=128)
    model_response: str = Field(..., min_length=0, max_length=16384)
    final_text: str = Field(..., min_length=0, max_length=16384)


class ReturnRequest(BaseModel):
    trace_id: str = Field(..., min_length=1, max_length=128)
    user_id: str = Field(..., min_length=1, max_length=128)
    returned: bool | None = None


class AbandonmentRequest(BaseModel):
    trace_id: str = Field(..., min_length=1, max_length=128)
    user_id: str = Field(..., min_length=1, max_length=128)
    abandoned: bool = True


class CopyPasteRequest(BaseModel):
    trace_id: str = Field(..., min_length=1, max_length=128)
    user_id: str = Field(..., min_length=1, max_length=128)
    copied: bool = True
    redacted_snippet: str | None = Field(
        default=None, max_length=200
    )


class RetryRequest(BaseModel):
    trace_id: str = Field(..., min_length=1, max_length=128)
    user_id: str = Field(..., min_length=1, max_length=128)
    retried: bool = True
    similarity: float | None = Field(default=None, ge=0.0, le=1.0)


# ── v0 routes ────────────────────────────────────────────────────────


@router.post("/sessions/aggregate")
async def sessions_aggregate(
    org_id: str = Path(...),
    window: str = Query(
        "7d",
        description=(
            "Time window for the aggregate. Accepts "
            "Nh/Nd/Nm/Ns. Default '7d'."
        ),
    ),
    user_segment_id: str | None = Query(
        None,
        max_length=64,
        description=(
            "Optional user-segment filter. When set, only "
            "users in that segment are aggregated. "
            "Default: all users."
        ),
    ),
) -> dict[str, Any]:
    return await _sessions.aggregate(
        org_id, window=window, user_segment_id=user_segment_id
    )


@router.post("/goals")
async def track_goal(
    org_id: str = Path(...),
    body: GoalRequest = Body(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    # Audit 2026-06-22 B1.33 — derive user_id from session, ignore body value
    # to prevent any-user-to-any-user writes.
    return await _goals.track(
        org_id,
        user_id=user["user_id"],
        goal=body.goal,
        session_id=body.session_id,
    )


@router.patch("/goals/{goal_id}")
async def update_goal_status(
    org_id: str = Path(...),
    goal_id: str = Path(..., min_length=1, max_length=64),
    body: GoalStatusRequest = Body(...),
) -> dict[str, Any]:
    if body.status == "achieved":
        return await _goals.mark_achieved(
            org_id, goal_id=goal_id
        )
    return await _goals.mark_abandoned(org_id, goal_id=goal_id)


@router.get("/goals")
async def list_user_goals(
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    # Audit 2026-06-22 B1.33 — derive user_id from session; self-only.
    return await _goals.list_for_user(org_id, user_id=user["user_id"])


@router.get("/conversation/{session_id}")
async def conversation_history(
    org_id: str = Path(...),
    session_id: str = Path(..., min_length=1, max_length=128),
    limit: int = Query(100, ge=1, le=1000),
) -> dict[str, Any]:
    return await _conversations.get_history(
        org_id, session_id=session_id, limit=limit
    )


@router.post("/conversation/message")
async def add_conversation_message(
    org_id: str = Path(...),
    body: ConversationMessageRequest = Body(...),
) -> dict[str, Any]:
    return await _conversations.add_message(
        org_id,
        session_id=body.session_id,
        role=body.role,
        content=body.content,
    )


@router.post("/feedback")
async def submit_feedback(
    org_id: str = Path(...),
    body: FeedbackRequest = Body(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    # Audit 2026-06-22 B1.33 — derive user_id from session.
    return await _feedback.submit_thumbs(
        org_id,
        trace_id=body.trace_id,
        thumbs=body.thumbs,
        user_id=user["user_id"],
        comment=body.comment,
        rating=body.rating,
    )


@router.get("/feedback/{trace_id}")
async def get_feedback_for_trace(
    org_id: str = Path(...),
    trace_id: str = Path(..., min_length=1, max_length=128),
) -> dict[str, Any]:
    return await _feedback.get_feedback_for_trace(
        org_id, trace_id=trace_id
    )


@router.get("/satisfaction/{trace_id}")
async def satisfaction(
    org_id: str = Path(...),
    trace_id: str = Path(..., min_length=1, max_length=128),
    user_id: str | None = Query(
        None,
        max_length=128,
        description=(
            "Optional user id — when set, the correction "
            "is persisted under (org, user, trace) so the "
            "audit log can group per user."
        ),
    ),
) -> dict[str, Any]:
    return await _satisfaction.compute(
        org_id, trace_id=trace_id, user_id=user_id
    )


@router.get("/segment")
async def segment(
    org_id: str = Path(...),
    user_id: str = Query(..., min_length=1, max_length=128),
) -> dict[str, Any]:
    return await _segments.segment(org_id, user_id=user_id)


# ── v2 behavioural-signal routes (write paths) ───────────────────────


@router.post("/signals/regeneration")
async def signal_regeneration(
    org_id: str = Path(...),
    body: RegenerationRequest = Body(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    # Audit 2026-06-22 B1.33 — derive user_id from session.
    return await _regen.track(
        org_id,
        trace_id=body.trace_id,
        user_id=user["user_id"],
        regenerated=body.regenerated,
    )


@router.post("/signals/edit-distance")
async def signal_edit_distance(
    org_id: str = Path(...),
    body: EditDistanceRequest = Body(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    return await _edit.compute(
        org_id,
        trace_id=body.trace_id,
        user_id=user["user_id"],
        model_response=body.model_response,
        final_text=body.final_text,
    )


@router.post("/signals/return")
async def signal_return(
    org_id: str = Path(...),
    body: ReturnRequest = Body(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    # ponytail: ReturnToFeatureTracker removed per upgradespec §D.2
    return {
        "status": "not_implemented",
        "feature": "user_signal_return",
        "live": False,
        "message": "ReturnToFeatureTracker removed per upgradespec §D.2.",
    }


@router.post("/signals/abandonment")
async def signal_abandonment(
    org_id: str = Path(...),
    body: AbandonmentRequest = Body(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    return await _abandon.detect(
        org_id,
        trace_id=body.trace_id,
        user_id=user["user_id"],
        abandoned=body.abandoned,
    )


@router.post("/signals/copy-paste")
async def signal_copy_paste(
    org_id: str = Path(...),
    body: CopyPasteRequest = Body(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    # ponytail: CopyPasteTracker removed per upgradespec §D.2
    return {
        "status": "not_implemented",
        "feature": "user_signal_copy_paste",
        "live": False,
        "message": "CopyPasteTracker removed per upgradespec §D.2.",
    }


@router.post("/signals/retry")
async def signal_retry(
    org_id: str = Path(...),
    body: RetryRequest = Body(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    # ponytail: RetryRephraseTracker removed per upgradespec §D.2
    return {
        "status": "not_implemented",
        "feature": "user_signal_retry",
        "live": False,
        "message": "RetryRephraseTracker removed per upgradespec §D.2.",
    }


# ── v2 dashboard / corrector routes (read paths) ─────────────────────


@router.get("/dashboard/cohort")
async def cohort_dashboard(
    org_id: str = Path(...),
    cohort: str | None = Query(
        None,
        max_length=64,
        description=(
            "Optional cohort name (e.g. 'power_users'). "
            "The dashboard aggregates the 7 implicit "
            "signals + the explicit feedback aggregate "
            "for the cohort. Default: all users."
        ),
    ),
    window: str = Query(
        "30d",
        description=(
            "Time window for the cohort dashboard. "
            "Accepts Nh/Nd/Nm/Ns. Default '30d'."
        ),
    ),
) -> dict[str, Any]:
    return await _dashboard.cohort(
        org_id, cohort=cohort, window=window
    )


@router.get("/correction/{trace_id}")
async def bias_correction(
    org_id: str = Path(...),
    trace_id: str = Path(..., min_length=1, max_length=128),
    user_id: str | None = Query(None, max_length=128),
) -> dict[str, Any]:
    """The standalone selection-bias-correction endpoint.

    Equivalent to the ``posterior`` field of the
    satisfaction endpoint, but exposed on its own so the
    front-end can call it without the rest of the
    satisfaction envelope.
    """
    return await _corrector.correct(
        org_id, trace_id=trace_id, user_id=user_id
    )
