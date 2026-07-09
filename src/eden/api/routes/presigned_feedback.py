"""Presigned feedback token routes (Phase A1, 2026-06-19).

Endpoints:

- ``POST /orgs/{org_id}/intelligence/user/feedback/presigned-token``
  — issue a LangSmith-style unauthenticated feedback token. Auth
  required (server-side).

- ``POST /api/v1/feedback/tokens/{token_id}`` — public endpoint,
  NO auth required. The token_id IS the credential. Accepts
  ``{value, comment?}`` and persists the feedback to
  ``user_feedback`` (same table the Cat 9 explicit feedback
  service writes to, so the Bayesian satisfaction service picks
  it up automatically).

This is the single most differentiated feature in Phase A1 —
LangSmith is the only LLM observability vendor with it as of
2026-06-19, and Eden will be the first to ship it cross-domain
without the Braintrust browser-SDK CORS limitation.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user
from eden.services.app_intel import DEFAULT_TTL_SECONDS, PresignedFeedbackService

logger = logging.getLogger(__name__)


# Org-scoped router (requires auth) — issues tokens
auth_router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/user/feedback",
    tags=["presigned-feedback"],
    dependencies=[Depends(get_current_user)],
)


# Public router (no auth) — consumes tokens. Mounted at /api/v1.
public_router = APIRouter(
    prefix="/api/v1/feedback/tokens",
    tags=["presigned-feedback-public"],
)


# ── Request / response models ──────────────────────────────────────────


class IssueTokenRequest(BaseModel):
    trace_id: str = Field(..., min_length=1, max_length=128)
    feedback_key: str = Field(default="user_score", min_length=1, max_length=64)
    expires_in_seconds: int | None = Field(
        default=None, ge=60, le=24 * 60 * 60
    )


class IssueTokenResponse(BaseModel):
    token_id: str
    url: str
    expires_at: str


class SubmitFeedbackRequest(BaseModel):
    value: str = Field(
        ...,
        description=(
            "One of 'up'/'down' (or 'thumbs_up'/'thumbs_down'/"
            "'positive'/'negative'/'+1'/'-1') or a 1-5 star rating"
        ),
    )
    comment: str | None = Field(default=None, max_length=2048)


class SubmitFeedbackResponse(BaseModel):
    status: str = "ok"
    trace_id: str
    feedback_key: str
    consumed: bool = True


# ── Auth-required: issue a token ───────────────────────────────────────


@auth_router.post(
    "/presigned-token",
    response_model=IssueTokenResponse,
)
async def issue_presigned_token(
    org_id: str = Path(...),
    body: IssueTokenRequest = ...,
) -> IssueTokenResponse:
    svc = PresignedFeedbackService()
    result = await svc.issue(
        org_id,
        trace_id=body.trace_id,
        feedback_key=body.feedback_key,
        ttl_seconds=body.expires_in_seconds or DEFAULT_TTL_SECONDS,
    )
    if not result["token_id"]:
        raise HTTPException(status_code=503, detail="token store unavailable")
    # Strip the HMAC tag from the API response.
    return IssueTokenResponse(
        token_id=result["token_id"],
        url=result["url"],
        expires_at=result["expires_at"],
    )


# ── Public: submit feedback (no auth) ─────────────────────────────────


@public_router.post(
    "/{token_id}",
    response_model=SubmitFeedbackResponse,
)
async def submit_presigned_feedback(
    token_id: str = Path(..., min_length=1, max_length=128),
    body: SubmitFeedbackRequest = ...,
) -> SubmitFeedbackResponse:
    svc = PresignedFeedbackService()
    record = await svc.consume(token_id, body.value, body.comment)
    if record is None:
        # Either token not found, expired, or already consumed by
        # a different submit. Either way, return 401 — we do not
        # leak which case it is.
        raise HTTPException(
            status_code=401,
            detail="invalid or expired feedback token",
        )
    return SubmitFeedbackResponse(
        trace_id=record["trace_id"],
        feedback_key=record["feedback_key"],
        consumed=True,
    )
