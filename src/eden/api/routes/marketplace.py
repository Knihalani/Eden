"""Marketplace HTTP surface.

Exposes the §5 endpoints:
  - GET  /marketplace/cards                  — list + search
  - GET  /marketplace/cards/featured         — featured row
  - GET  /marketplace/cards/{card_id}        — detail
  - POST /marketplace/cards                  — create draft
  - PATCH /marketplace/cards/{card_id}       — update
  - POST /marketplace/cards/{card_id}/submit — submit for review
  - POST /marketplace/cards/{card_id}/publish — publish (admin)
  - POST /marketplace/cards/{card_id}/retire  — retire
  - POST /marketplace/cards/{card_id}/fork    — fork into a new draft
  - GET  /marketplace/cards/{card_id}/reviews — list reviews
  - POST /marketplace/cards/{card_id}/reviews — submit a review
  - POST /marketplace/reviews/{review_id}/flag   — flag for moderation
  - POST /marketplace/reviews/{review_id}/moderate — approve / hide
  - GET  /marketplace/moderation/queue       — moderation queue (§5.5)
"""
from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag
from eden.marketplace import (
    EnvCardSummary,
    ForkRequest,
    QualityBand,
    Review,
    SubmitRequest,
    create_card,
    flag_review,
    fork_card,
    get_card,
    list_featured,
    list_published,
    list_reviews,
    moderate_review,
    moderation_queue,
    publish_card,
    retire_card,
    search_cards,
    submit_card,
    submit_review,
    update_card,
)
from eden.marketplace.models import EnvCard

logger = logging.getLogger(__name__)
router = APIRouter(
    prefix="/marketplace",
    tags=["marketplace"],
    dependencies=[Depends(require_feature_flag("enable_eval_pipeline"))],
)


class _PatchRequest(BaseModel):
    title: str | None = None
    summary: str | None = None
    description: str | None = None
    category: str | None = None
    tags: list[str] | None = None
    license: str | None = None
    homepage_url: str | None = None
    repository_url: str | None = None


@router.get("/cards", response_model=list[EnvCardSummary])
async def list_cards(
    q: str | None = Query(default=None, description="Full-text search query"),
    category: str | None = Query(default=None),
    tag: str | None = Query(default=None),
    quality: QualityBand | None = Query(default=None),
    limit: int = Query(default=24, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> list[EnvCardSummary]:
    if q or quality:
        return await search_cards(
            q=q, category=category, tag=tag, quality_band=quality, limit=limit, offset=offset
        )
    return await list_published(
        category=category, tag=tag, quality_band=quality, limit=limit, offset=offset
    )


@router.get("/cards/featured", response_model=list[EnvCardSummary])
async def featured_cards(limit: int = Query(default=6, ge=1, le=20)) -> list[EnvCardSummary]:
    return await list_featured(limit=limit)


@router.get("/cards/{card_id}", response_model=EnvCard)
async def get_card_detail(card_id: UUID) -> EnvCard:
    card = await get_card(card_id)
    if not card:
        raise HTTPException(status_code=404, detail="Env card not found")
    return card


@router.post("/cards", response_model=EnvCard, status_code=status.HTTP_201_CREATED)
async def create_card_route(
    req: SubmitRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> EnvCard:
    org_id = user.get("active_org_id") or user.get("org_id")
    if not org_id:
        raise HTTPException(status_code=400, detail="No active organization on user")
    return await create_card(
        org_id=UUID(org_id),
        author_id=UUID(user["user_id"]),
        req=req,
    )


@router.patch("/cards/{card_id}", response_model=EnvCard)
async def update_card_route(card_id: UUID, patch: _PatchRequest) -> EnvCard:
    data = patch.model_dump(exclude_unset=True)
    updated = await update_card(card_id, patch=data)
    if not updated:
        raise HTTPException(
            status_code=409,
            detail="Card not found or not in an editable state (must be draft or archived)",
        )
    return updated


@router.post("/cards/{card_id}/submit", response_model=EnvCard)
async def submit_card_route(card_id: UUID) -> EnvCard:
    card = await submit_card(card_id)
    if not card:
        raise HTTPException(
            status_code=409,
            detail="Card is not in draft state or does not exist",
        )
    return card


@router.post("/cards/{card_id}/publish", response_model=EnvCard)
async def publish_card_route(card_id: UUID) -> EnvCard:
    card = await publish_card(card_id)
    if not card:
        raise HTTPException(
            status_code=409,
            detail="Card is not in a publishable state (must be submitted or in_review)",
        )
    return card


@router.post("/cards/{card_id}/retire", response_model=EnvCard)
async def retire_card_route(card_id: UUID) -> EnvCard:
    card = await retire_card(card_id)
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")
    return card


@router.post("/cards/{card_id}/fork", response_model=EnvCard, status_code=status.HTTP_201_CREATED)
async def fork_card_route(
    card_id: UUID,
    req: ForkRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> EnvCard:
    org_id = user.get("active_org_id") or user.get("org_id")
    if not org_id:
        raise HTTPException(status_code=400, detail="No active organization on user")
    forked = await fork_card(
        parent_card_id=card_id,
        new_org_id=UUID(org_id),
        new_author_id=UUID(user["user_id"]),
        req=req,
    )
    if not forked:
        raise HTTPException(
            status_code=404,
            detail="Parent card not found or not in published state",
        )
    return forked


# ────────────────────────────────────────────────────────────────────────
# Reviews (§5.6)
# ────────────────────────────────────────────────────────────────────────


class _ReviewRequest(BaseModel):
    rating: int = Field(ge=1, le=5)
    title: str | None = Field(default=None, max_length=120)
    body: str = Field(min_length=4, max_length=4000)


@router.get("/cards/{card_id}/reviews")
async def list_card_reviews(
    card_id: UUID,
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    items = await list_reviews(card_id, limit=limit, offset=offset)
    return {"items": items, "count": len(items)}


@router.post("/cards/{card_id}/reviews", status_code=status.HTTP_201_CREATED)
async def submit_card_review(
    card_id: UUID,
    req: _ReviewRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    review = await submit_review(
        card_id=card_id,
        user_id=UUID(user["user_id"]),
        rating=req.rating,
        title=req.title,
        body=req.body,
    )
    if review is None:
        raise HTTPException(status_code=400, detail="Invalid review payload")
    return {
        "id": str(review.id),
        "rating": review.rating,
        "flagged": review.flagged,
        "created_at": review.created_at,
    }


class _FlagRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=400)


@router.post("/reviews/{review_id}/flag", status_code=status.HTTP_200_OK)
async def flag_review_route(
    review_id: UUID,
    req: _FlagRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    ok = await flag_review(review_id=review_id, reason=req.reason)
    if not ok:
        raise HTTPException(status_code=404, detail="Review not found")
    return {"status": "flagged"}


class _ModerateRequest(BaseModel):
    approve: bool


@router.post("/reviews/{review_id}/moderate", status_code=status.HTTP_200_OK)
async def moderate_review_route(
    review_id: UUID,
    req: _ModerateRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    ok = await moderate_review(
        review_id=review_id,
        moderator_id=UUID(user["user_id"]),
        approve=req.approve,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Review not found")
    return {"status": "approved" if req.approve else "hidden"}


@router.get("/moderation/queue")
async def moderation_queue_route(
    limit: int = Query(default=50, ge=1, le=200),
) -> dict[str, Any]:
    items = await moderation_queue(limit=limit)
    return {"items": items, "count": len(items)}
