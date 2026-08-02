"""F51 offline experiments API."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import (
    get_current_user,
    require_path_org_access,
)
from eden.api.utils.redact import redact_all
from eden.api.utils.safe_error import raise_mapped_db_error
from eden.experiments.offline_runner import OfflineExperimentRunner

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/experiments/offline",
    tags=["offline-experiments"],
    dependencies=[Depends(require_path_org_access)],
)

class CreateExperimentRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    dataset_id: str
    config: dict[str, Any] = Field(default_factory=dict)
    baseline_experiment_id: str | None = None
    source_issue_id: str | None = None

@router.get("")
async def list_offline_experiments(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    runner = OfflineExperimentRunner()
    try:
        exps = await runner.list_experiments(org_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"status": "ok", "experiments": exps, "total": len(exps)}

@router.post("")
async def create_offline_experiment(
    body: CreateExperimentRequest,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    runner = OfflineExperimentRunner()
    try:
        exp = await runner.create(
            org_id,
            name=body.name,
            dataset_id=body.dataset_id,
            config=body.config,
            baseline_experiment_id=body.baseline_experiment_id,
            source_issue_id=body.source_issue_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning("create_offline_experiment failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="offline experiment create failed",
            unique_detail="experiment already exists",
            uuid_detail="Invalid experiment or dataset id",
            fk_detail="Dataset or organization not found",
        )
    return {"status": "ok", "experiment": exp.to_dict()}

@router.post("/{experiment_id}/run")
async def run_offline_experiment(
    org_id: str = Depends(require_path_org_access),
    experiment_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    runner = OfflineExperimentRunner()
    try:
        result = await runner.run(org_id, experiment_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning("run_offline_experiment failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="offline experiment run failed",
            uuid_detail="Invalid experiment id",
            fk_detail="Experiment not found",
        )
    return {"status": "ok", "result": result}

@router.get("/{experiment_id}/compare")
async def compare_offline_experiment(
    org_id: str = Depends(require_path_org_access),
    experiment_id: str = Path(...),
    baseline_id: str | None = Query(None),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    runner = OfflineExperimentRunner()
    try:
        result = await runner.compare(org_id, experiment_id, baseline_id=baseline_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning("compare_offline_experiment failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="offline experiment compare failed",
            uuid_detail="Invalid experiment id",
            fk_detail="Experiment not found",
        )
    return {"status": "ok", "compare": result}
