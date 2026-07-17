"""F34 — signal classifier train / status / promote / shadow-report."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_org_member
from eden.signals.classifier_pipeline import ClassifierTrainingPipeline
from eden.signals.shadow_compare import ShadowComparator

router = APIRouter(
    prefix="/orgs/{org_id}/signals/{signal_id}/classifier",
    tags=["signal-classifiers"],
    dependencies=[Depends(get_current_user), Depends(require_org_member)],
)
_pipeline = ClassifierTrainingPipeline()
_shadow = ShadowComparator()


class TrainBody(BaseModel):
    trace_ids: list[str] | None = None


class PromoteBody(BaseModel):
    min_agreement: float = Field(default=0.8, ge=0.0, le=1.0)


@router.post("/train")
async def train_classifier(
    org_id: str = Path(...),
    signal_id: str = Path(...),
    body: TrainBody | None = None,
) -> dict[str, Any]:
    result = await _pipeline.train(
        org_id,
        signal_id,
        trace_ids=(body.trace_ids if body else None),
    )
    return {
        "status": "ok" if result.trained else "incomplete",
        "feature": "f34_signal_classifiers",
        "data": {
            "classifier_id": result.classifier_id,
            "signal_id": result.signal_id,
            "sample_count": result.sample_count,
            "metrics": result.metrics,
            "trained": result.trained,
        },
    }


@router.get("")
async def get_classifier(
    org_id: str = Path(...),
    signal_id: str = Path(...),
) -> dict[str, Any]:
    data = await _pipeline.get_status(org_id, signal_id)
    return {"status": data.get("status", "ok"), "feature": "f34", "data": data}


@router.post("/promote")
async def promote_classifier(
    org_id: str = Path(...),
    signal_id: str = Path(...),
    body: PromoteBody | None = None,
) -> dict[str, Any]:
    min_a = body.min_agreement if body else 0.8
    data = await _pipeline.promote(org_id, signal_id, min_agreement=min_a)
    return {"status": data.get("status", "ok"), "feature": "f34", "data": data}


@router.post("/shadow-report")
async def shadow_report(
    org_id: str = Path(...),
    signal_id: str = Path(...),
) -> dict[str, Any]:
    data = await _shadow.report(org_id, signal_id)
    return {"status": data.get("status", "ok"), "feature": "f34", "data": data}
