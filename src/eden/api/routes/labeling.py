"""Phase D — labeling queue API routes.

Six routes:

  * ``GET  /orgs/{org}/labeling/items`` — list items + annotation counts
  * ``POST /orgs/{org}/labeling/items`` — seed new items
  * ``POST /orgs/{org}/labeling/traces/{trace_id}/annotate`` — trace score
  * ``GET  /orgs/{org}/labeling/queue/{user}`` — pop the next batch
  * ``POST /orgs/{org}/labeling/annotate`` — submit a label
  * ``POST /orgs/{org}/labeling/skip`` — mark an item skipped
  * ``GET  /orgs/{org}/labeling/agreement`` — inter-annotator agreement
  * ``GET  /orgs/{org}/labeling/export`` — JSONL of approved labels
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from eden.api.deps import (
    get_current_user,
    require_path_org_access,
)
from eden.api.utils.redact import redact_all
from eden.api.utils.safe_error import raise_mapped_db_error
from eden.evaluation.labeling import (
    Annotation,
    LabelingItem,
    LabelingService,
)
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

def _annotation_value_error_status(exc: ValueError) -> int:
    msg = str(exc).lower()
    if "not found" in msg:
        return 404
    return 400

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

class LabelingItemListEntry(BaseModel):
    id: str
    prompt: str
    context: str | None = None
    tags: list[str] = Field(default_factory=list)
    source: str
    created_at: str
    annotations_count: int = 0

class LabelingItemsListResponse(BaseModel):
    items: list[LabelingItemListEntry]
    total: int

class TraceAnnotateRequest(BaseModel):
    score: int = Field(..., ge=0, le=10)
    category: str = Field(..., min_length=1, max_length=100)
    comment: str | None = None

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
    """Default skills lookup. Returns an empty list until a
    dedicated ``user_skills`` table lands; ``LabelingService``
    treats empty as "generalist" so the queue keeps moving."""
    return []

# ── Routes ────────────────────────────────────────────────────────

@router.get(
    "/items",
    response_model=LabelingItemsListResponse,
    summary="List labeling queue items with annotation counts",
)
async def list_items(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(default=100, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> LabelingItemsListResponse:
    pg = await get_postgres_client()
    svc = LabelingService(pg, user_skills=_user_skills)
    items, total = await svc.list_items(org_id=org_id, limit=limit, offset=offset)
    return LabelingItemsListResponse(
        items=[LabelingItemListEntry(**item) for item in items],
        total=total,
    )

@router.post(
    "/items",
    response_model=SeedItemResponse,
    summary="Seed a new item into the labeling queue",
)
async def seed_item(
    body: SeedItemRequest,
    org_id: str = Depends(require_path_org_access),
) -> SeedItemResponse:
    pg = await get_postgres_client()
    svc = LabelingService(pg, user_skills=_user_skills)
    try:
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
    except Exception as exc:
        logger.warning("seed_item failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="labeling seed failed",
            uuid_detail="Invalid organization id",
            fk_detail="Organization not found",
        )
    return SeedItemResponse(item_id=item_id)

@router.post(
    "/traces/{trace_id}/annotate",
    response_model=AnnotationResponse,
    summary="Annotate a trace with a 0-10 score (find-or-seed trace-score item)",
)
async def annotate_trace(
    body: TraceAnnotateRequest,
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> AnnotationResponse:
    user_id = str(user.get("id") or user.get("user_id") or user.get("sub"))
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")
    pg = await get_postgres_client()
    svc = LabelingService(pg, user_skills=_user_skills)
    item_id = await svc.find_or_seed_trace_score_item(org_id=org_id, trace_id=trace_id)
    try:
        ann = await svc.annotate(
            org_id=org_id,
            item_id=item_id,
            annotator_id=user_id,
            label={"score": body.score, "category": body.category},
            confidence=body.score / 10.0,
            notes=body.comment,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=_annotation_value_error_status(exc),
            detail={"error": "invalid_annotation", "detail": str(exc)},
        ) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning("annotate_trace failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="annotation failed",
            uuid_detail="Invalid item or organization id",
        )
    return _annotation_to_response(ann)

@router.get(
    "/queue/{user_id}",
    response_model=QueueResponse,
    summary="Pop the next N items for an annotator",
)
async def pop_queue(
    org_id: str = Depends(require_path_org_access),
    user_id: str = Path(...),
    limit: int = Query(default=5, ge=1, le=50),
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
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
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
            status_code=_annotation_value_error_status(exc),
            detail={"error": "invalid_annotation", "detail": str(exc)},
        ) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning("annotate failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="annotation failed",
            uuid_detail="Invalid item or organization id",
        )
    return _annotation_to_response(ann)

@router.post(
    "/skip",
    summary="Mark an item as skipped (un-labelable)",
)
async def skip(
    body: SkipRequest,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
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
    "/agreement",
    response_model=IIAResponse,
    summary="Compute inter-annotator agreement (Cohen's kappa + Krippendorff's alpha)",
)
async def compute_agreement(
    org_id: str = Depends(require_path_org_access),
    item_ids: list[str] | None = Query(default=None),
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
    org_id: str = Depends(require_path_org_access),
    status: str = Query(default="completed", pattern="^(pending|in_progress|completed|skipped)$"),
    limit: int = Query(default=10_000, ge=1, le=100_000),
) -> str:
    pg = await get_postgres_client()
    svc = LabelingService(pg, user_skills=_user_skills)
    return await svc.export(org_id=org_id, status_filter=status, limit=limit)

# ── F50 annotation queues (kanban) ─────────────────────────────────

class CreateQueueRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: str = Field(default="", max_length=2_000)
    label_schema: dict[str, Any] = Field(default_factory=dict)

class MoveItemRequest(BaseModel):
    item_id: str
    status: str = Field(..., pattern="^(todo|in_progress|done|skipped)$")

class PushDatasetRequest(BaseModel):
    dataset_id: str

@router.get("/queues")
async def list_queues(
    org_id: str = Depends(require_path_org_access),
) -> dict[str, Any]:
    from eden.evaluation.labeling_queues import LabelingQueueService

    queues = await LabelingQueueService().list_queues(org_id)
    return {"queues": [q.to_dict() for q in queues], "total": len(queues)}

@router.post("/queues")
async def create_queue(
    body: CreateQueueRequest,
    org_id: str = Depends(require_path_org_access),
) -> dict[str, Any]:
    from eden.evaluation.labeling_queues import LabelingQueueService

    try:
        q = await LabelingQueueService().create_queue(
            org_id, name=body.name, description=body.description, schema=body.label_schema
        )
    except Exception as exc:
        logger.warning("create_queue failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="labeling queue create failed",
            unique_detail="queue already exists",
            uuid_detail="Invalid organization id",
            fk_detail="Organization not found",
        )
    return {"queue": q.to_dict()}

@router.get("/queues/{queue_id}")
async def get_queue(
    org_id: str = Depends(require_path_org_access),
    queue_id: str = Path(...),
) -> dict[str, Any]:
    from eden.evaluation.labeling_queues import LabelingQueueService

    queues = await LabelingQueueService().list_queues(org_id)
    for q in queues:
        if q.id == queue_id:
            return {"queue": q.to_dict()}
    raise HTTPException(status_code=404, detail="queue not found")

@router.get("/queues/{queue_id}/board")
async def queue_board(
    org_id: str = Depends(require_path_org_access),
    queue_id: str = Path(...),
    limit: int = Query(100, ge=1, le=100),
) -> dict[str, Any]:
    from eden.evaluation.labeling_queues import LabelingQueueService

    board = await LabelingQueueService().kanban_board(org_id, queue_id, limit=limit)
    return {"queue_id": queue_id, "board": board}

@router.get("/queues/{queue_id}/agreement")
async def queue_agreement(
    org_id: str = Depends(require_path_org_access),
    queue_id: str = Path(...),
) -> dict[str, Any]:
    """Inter-annotator agreement for a queue's items.

    Uses the real IAA engine (:meth:`LabelingService.compute_iaa`,
    backed by the ``annotations`` table) rather than reading
    ``label_a``/``annotator_1``/``label_b``/``annotator_2`` keys from
    the kanban item's JSON payload — nothing ever writes those keys,
    so that path always reported zeros.
    """
    from eden.evaluation.labeling_queues import LabelingQueueService

    board = await LabelingQueueService().kanban_board(org_id, queue_id)
    item_ids = [
        str(item["id"])
        for col_items in board.values()
        for item in col_items
        if item.get("id")
    ]
    pg = await get_postgres_client()
    svc = LabelingService(pg, user_skills=_user_skills)
    report = await svc.compute_iaa(org_id=org_id, item_ids=item_ids)
    d = report.to_dict()
    return {
        "queue_id": queue_id,
        "iaa": {
            "kappa": d["kappa"],
            "n": d["annotation_count"],
            "agreement_rate": d["overall_agreement"],
        },
    }

@router.post("/queues/{queue_id}/move")
async def move_queue_item(
    body: MoveItemRequest,
    org_id: str = Depends(require_path_org_access),
    queue_id: str = Path(...),
) -> dict[str, Any]:
    from eden.evaluation.labeling_queues import LabelingQueueService

    svc = LabelingQueueService()
    try:
        ok = await svc.move_item(org_id, queue_id, body.item_id, status=body.status)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"moved": ok, "item_id": body.item_id, "status": body.status}

@router.post("/queues/{queue_id}/push-to-dataset")
async def push_queue_to_dataset(
    body: PushDatasetRequest,
    org_id: str = Depends(require_path_org_access),
    queue_id: str = Path(...),
) -> dict[str, Any]:
    from eden.evaluation.labeling_queues import LabelingQueueService

    try:
        result = await LabelingQueueService().push_to_dataset(
            org_id, queue_id, dataset_id=body.dataset_id
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return result
