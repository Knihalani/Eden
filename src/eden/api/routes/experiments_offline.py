"""F51 offline experiments API."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.api.routes.auth import get_current_user
from eden.experiments.offline_runner import OfflineExperimentRunner

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/experiments/offline",
    tags=["offline-experiments"],
)


class CreateExperimentRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    dataset_id: str
    config: dict[str, Any] = Field(default_factory=dict)
    baseline_experiment_id: str | None = None
    source_issue_id: str | None = None


@router.get("")
async def list_offline_experiments(
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    runner = OfflineExperimentRunner()
    exps = await runner.list_experiments(org_id)
    return {"status": "ok", "experiments": exps, "total": len(exps)}


@router.post("")
async def create_offline_experiment(
    body: CreateExperimentRequest,
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    runner = OfflineExperimentRunner()
    exp = await runner.create(
        org_id,
        name=body.name,
        dataset_id=body.dataset_id,
        config=body.config,
        baseline_experiment_id=body.baseline_experiment_id,
        source_issue_id=body.source_issue_id,
    )
    return {"status": "ok", "experiment": exp.to_dict()}


@router.post("/{experiment_id}/run")
async def run_offline_experiment(
    org_id: str = Path(...),
    experiment_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    runner = OfflineExperimentRunner()
    try:
        result = await runner.run(org_id, experiment_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"status": "ok", "result": result}


@router.get("/{experiment_id}/compare")
async def compare_offline_experiment(
    org_id: str = Path(...),
    experiment_id: str = Path(...),
    baseline_id: str | None = Query(None),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    runner = OfflineExperimentRunner()
    try:
        result = await runner.compare(org_id, experiment_id, baseline_id=baseline_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"status": "ok", "compare": result}
