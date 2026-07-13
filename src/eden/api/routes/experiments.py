"""A/B testing routes (§8.4)."""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from eden.api.deps import require_feature_flag
from eden.experiments import (
    Variant,
    analyse,
    assign_variant,
    recommend_winner,
    record_outcome,
)

logger = logging.getLogger(__name__)
router = APIRouter(
    prefix="/experiments",
    tags=["experiments"],
    dependencies=[Depends(require_feature_flag("experiments_v1"))],
)


class AssignRequest(BaseModel):
    experiment_key: str
    user_id: str
    variants: list[dict[str, Any]] = Field(..., description="List of {name, weight}")


@router.post("/assign")
async def assign(req: AssignRequest) -> dict[str, Any]:
    if not req.variants:
        raise HTTPException(status_code=400, detail="variants must be a non-empty list")
    variants = [Variant(name=v["name"], weight=float(v.get("weight", 1.0))) for v in req.variants]
    chosen = assign_variant(req.experiment_key, req.user_id, variants)
    return {"variant": chosen.name}


class RecordOutcomeRequest(BaseModel):
    experiment_key: str
    user_id: str
    variant: str
    success: bool


@router.post("/record")
async def record(req: RecordOutcomeRequest) -> dict[str, Any]:
    record_outcome(req.experiment_key, req.user_id, req.variant, req.success)
    return {"status": "recorded"}


class AnalyseRequest(BaseModel):
    experiment_key: str
    min_n: int = 100
    control: str | None = Field(
        default=None,
        description=(
            "Name of the control variant. When omitted, the first variant "
            "in the results list (insertion order of recorded outcomes) is "
            "treated as the control. Pass this explicitly if your "
            "record_outcome calls didn't preserve the declared variant order."
        ),
    )


@router.post("/analyse")
async def analyse_endpoint(req: AnalyseRequest) -> dict[str, Any]:
    results = analyse(req.experiment_key)
    return {
        "experiment_key": req.experiment_key,
        "results": [
            {
                "variant": r.variant,
                "n": r.n,
                "successes": r.successes,
                "rate": round(r.rate, 4),
            }
            for r in results
        ],
        "winner": recommend_winner(
            results, min_n=req.min_n, control=req.control
        ),
    }
