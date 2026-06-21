"""Phase D — labeling queue API routes.

Six routes:

  * ``POST /orgs/{org}/labeling/items`` — seed new items
  * ``GET  /orgs/{org}/labeling/queue/{user}`` — pop the next batch
  * ``POST /orgs/{org}/labeling/annotate`` — submit a label
  * ``POST /orgs/{org}/labeling/skip`` — mark an item skipped
  * ``GET  /orgs/{org}/labeling/iia`` — inter-annotator agreement
  * ``GET  /orgs/{org}/labeling/export`` — JSONL of approved labels
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from eden.evaluation.labeling import (
    Annotation,
    LabelingItem,
    LabelingService,
)
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


router = APIRouter(
    prefix="/orgs/{org_id}/labeling",
    tags=["labeling"],
)


# ── Schemas ───────────────────────────────────────────────────────


class SeedItemRequest(BaseModel):
    payload: dict[str, Any] = Field(default_factory=dict)
    label_schema: dict[str, Any] = Field(default_factory=dict)
    prompt: str | None = None
    tags: list[str] = Field(default_factory=list)
    required_skills: list[str] = Field(default_factory=list)
    annotations_required: int = Field(default=1, ge=1, le=10)
    source_trace_id: str | None = None
    source_span_id: str | None = None
    source_dataset_id: str | None = None
    source_synthetic_qa_id: str | None = None


class SeedItemResponse(BaseModel):
    item_id: str


class ItemResponse(BaseModel):
    id: str
    org_id: str
    payload: dict[str, Any]
    label_schema: dict[str, Any]
    prompt: str | None
    status: str
    tags: list[str]
    annotations_required: int
    required_skills: list[str]
    source_trace_id: str | None = None
    source_span_id: str | None = None
    source_dataset_id: str | None = None
    source_synthetic_qa_id: str | None = None
    assigned_to: str | None = None


class QueueResponse(BaseModel):
    items: list[ItemResponse]


class AnnotateRequest(BaseModel):
    item_id: str
    label: Any  # scalar or dict
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    notes: str | None = None
    time_spent_ms: int | None = None
    skills_exercised: list[str] = Field(default_factory=list)


class AnnotationResponse(BaseModel):
    id: str
    org_id: str
    item_id: str
    annotator_id: str
    label: Any
    confidence: float
    notes: str | None
    time_spent_ms: int | None
    skills_exercised: list[str]
    created_at: str
    updated_at: str


class IIAResponse(BaseModel):
    kappa: float
    alpha: float
    overall_agreement: float
    item_count: int
    annotation_count: int
    per_item: dict[str, dict[str, float]] = Field(default_factory=dict)
    per_pair: dict[str, dict[str, float]] = Field(default_factory=dict)


class SkipRequest(BaseModel):
    item_id: str
    reason: str | None = None


# ── Helpers ───────────────────────────────────────────────────────


def _get_user():
    from eden.api.routes.auth import get_current_user
    return get_current_user


def _item_to_response(item: LabelingItem) -> ItemResponse:
    return ItemResponse(
        id=item.id, org_id=item.org_id,
        payload=item.payload, label_schema=item.label_schema,
        prompt=item.prompt, status=item.status,
        tags=item.tags,
        annotations_required=item.annotations_required,
        required_skills=item.required_skills,
        source_trace_id=item.source_trace_id,
        source_span_id=item.source_span_id,
        source_dataset_id=item.source_dataset_id,
        source_synthetic_qa_id=item.source_synthetic_qa_id,
        assigned_to=item.assigned_to,
    )


def _annotation_to_response(ann: Annotation) -> AnnotationResponse:
    return AnnotationResponse(
        id=ann.id, org_id=ann.org_id,
        item_id=ann.item_id, annotator_id=ann.annotator_id,
        label=ann.label, confidence=ann.confidence,
        notes=ann.notes, time_spent_ms=ann.time_spent_ms,
        skills_exercised=ann.skills_exercised,
        created_at=ann.created_at,
        updated_at=ann.updated_at,
    )


def _user_skills(uid: str) -> list[str]:
    """Default skills lookup. Reads from the org_members table
    when a dedicated skills table is added; for now raises so
    callers see a real 501 instead of a silent empty list
    (which used to make every annotator look like a generalist)."""
    raise NotImplementedError(
        "skill lookup not yet implemented — pending skills table migration"
    )


# ── Routes ────────────────────────────────────────────────────────


@router.post(
    "/items",
    response_model=SeedItemResponse,
    summary="Seed a new item into the labeling queue",
)
async def seed_item(
    body: SeedItemRequest,
    org_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> SeedItemResponse:
    pg = await get_postgres_client()
    svc = LabelingService(pg, user_skills=_user_skills)
    item_id = await svc.seed(
        org_id=org_id,
        payload=body.payload,
        label_schema=body.label_schema,
        prompt=body.prompt,
        tags=body.tags,
        required_skills=body.required_skills,
        annotations_required=body.annotations_required,
        source_trace_id=body.source_trace_id,
        source_span_id=body.source_span_id,
        source_dataset_id=body.source_dataset_id,
        source_synthetic_qa_id=body.source_synthetic_qa_id,
    )
    return SeedItemResponse(item_id=item_id)


@router.get(
    "/queue/{user_id}",
    response_model=QueueResponse,
    summary="Pop the next N items for an annotator",
)
async def pop_queue(
    org_id: str = Path(...),
    user_id: str = Path(...),
    limit: int = Query(default=5, ge=1, le=50),
    user: dict = Depends(_get_user()),
) -> QueueResponse:
    pg = await get_postgres_client()
    svc = LabelingService(pg, user_skills=_user_skills)
    items = await svc.pop(
        org_id=org_id, annotator_id=user_id, limit=limit,
    )
    return QueueResponse(items=[_item_to_response(i) for i in items])


@router.post(
    "/annotate",
    response_model=AnnotationResponse,
    summary="Submit (or revise) an annotation",
)
async def annotate(
    body: AnnotateRequest,
    org_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> AnnotationResponse:
    user_id = str(user.get("id") or user.get("user_id") or user.get("sub"))
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")
    pg = await get_postgres_client()
    svc = LabelingService(pg, user_skills=_user_skills)
    try:
        ann = await svc.annotate(
            org_id=org_id,
            item_id=body.item_id,
            annotator_id=user_id,
            label=body.label,
            confidence=body.confidence,
            notes=body.notes,
            time_spent_ms=body.time_spent_ms,
            skills_exercised=body.skills_exercised,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid_annotation", "detail": str(exc)},
        )
    return _annotation_to_response(ann)


@router.post(
    "/skip",
    summary="Mark an item as skipped (un-labelable)",
)
async def skip(
    body: SkipRequest,
    org_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> dict[str, bool]:
    user_id = str(user.get("id") or user.get("user_id") or user.get("sub"))
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")
    pg = await get_postgres_client()
    svc = LabelingService(pg, user_skills=_user_skills)
    await svc.skip(
        org_id=org_id, item_id=body.item_id,
        annotator_id=user_id, reason=body.reason,
    )
    return {"skipped": True}


@router.get(
    "/iia",
    response_model=IIAResponse,
    summary="Compute inter-annotator agreement (Cohen's kappa + Krippendorff's alpha)",
)
async def compute_iia(
    org_id: str = Path(...),
    item_ids: list[str] | None = Query(default=None),
    user: dict = Depends(_get_user()),
) -> IIAResponse:
    pg = await get_postgres_client()
    svc = LabelingService(pg, user_skills=_user_skills)
    report = await svc.compute_iaa(org_id=org_id, item_ids=item_ids)
    d = report.to_dict()
    return IIAResponse(**d)


@router.get(
    "/export",
    response_class=PlainTextResponse,
    summary="Export approved annotations as JSONL",
)
async def export(
    org_id: str = Path(...),
    status: str = Query(default="completed", pattern="^(pending|in_progress|completed|skipped)$"),
    limit: int = Query(default=10_000, ge=1, le=100_000),
    user: dict = Depends(_get_user()),
) -> str:
    pg = await get_postgres_client()
    svc = LabelingService(pg, user_skills=_user_skills)
    return await svc.export(org_id=org_id, status_filter=status, limit=limit)
