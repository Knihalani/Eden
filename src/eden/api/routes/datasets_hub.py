"""F53 versioned dataset hub API."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field

from eden.api.routes.auth import get_current_user
from eden.datasets.hub import DatasetHub
from eden.datasets.spreadsheet import SpreadsheetService
from eden.storage.postgres import get_postgres_client

from eden.api.utils.redact import redact_all

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/datasets",
    tags=["datasets"],
)


class CreateDatasetRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: str = Field(default="", max_length=2_000)
    source_type: str = Field(default="manual")
    source_ref: str | None = None


class PromoteTraceRequest(BaseModel):
    trace_id: str = Field(..., min_length=1)
    dataset_id: str | None = None
    dataset_name: str | None = None


class DatasetResponse(BaseModel):
    id: str
    name: str
    description: str
    source_type: str
    source_ref: str | None
    version: int
    row_count: int
    column_count: int
    created_at: str
    updated_at: str


class DatasetListResponse(BaseModel):
    datasets: list[DatasetResponse]
    total: int


class DatasetDetailResponse(DatasetResponse):
    columns: list[dict[str, Any]] = Field(default_factory=list)
    rows: list[dict[str, Any]] = Field(default_factory=list)
    snapshots: list[dict[str, Any]] = Field(default_factory=list)


def _to_response(rec: Any) -> DatasetResponse:
    d = rec.to_dict()
    return DatasetResponse(**d)


@router.get("", response_model=DatasetListResponse)
async def list_datasets(
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> DatasetListResponse:
    hub = DatasetHub()
    datasets = await hub.list_datasets(org_id)
    return DatasetListResponse(
        datasets=[_to_response(d) for d in datasets],
        total=len(datasets),
    )


@router.post("", response_model=DatasetResponse)
async def create_dataset(
    body: CreateDatasetRequest,
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> DatasetResponse:
    hub = DatasetHub()
    try:
        rec = await hub.create_dataset(
            org_id,
            name=body.name,
            description=body.description,
            source_type=body.source_type,
            source_ref=body.source_ref,
        )
    except Exception as exc:
        logger.warning("create_dataset failed: %s", redact_all(str(exc)))
        raise HTTPException(status_code=400, detail="dataset create failed") from exc
    return _to_response(rec)


@router.post("/promote-from-trace")
async def promote_from_trace(
    body: PromoteTraceRequest,
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    hub = DatasetHub()
    result = await hub.promote_trace(
        org_id,
        body.trace_id,
        dataset_id=body.dataset_id,
        dataset_name=body.dataset_name,
    )
    return {"status": "ok", "data": result}


@router.get("/{dataset_id}", response_model=DatasetDetailResponse)
async def get_dataset(
    org_id: str = Path(...),
    dataset_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> DatasetDetailResponse:
    hub = DatasetHub()
    rec = await hub.get_dataset(org_id, dataset_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    pg = await get_postgres_client()
    columns: list[dict[str, Any]] = []
    rows: list[dict[str, Any]] = []
    if pg is not None:
        svc = SpreadsheetService(pg)
        columns = [c.to_dict() for c in await svc.list_columns(dataset_id)]
        rows = [r.to_dict() for r in await svc.list_rows(dataset_id, limit=200)]
    snapshots = [s.to_dict() for s in await hub.list_snapshots(org_id, dataset_id)]
    base = _to_response(rec)
    return DatasetDetailResponse(
        **base.model_dump(),
        columns=columns,
        rows=rows,
        snapshots=snapshots,
    )


@router.post("/{dataset_id}/snapshots")
async def create_snapshot(
    org_id: str = Path(...),
    dataset_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    hub = DatasetHub()
    try:
        snap = await hub.create_snapshot(org_id, dataset_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"status": "ok", "snapshot": snap.to_dict()}


class ImportRowsRequest(BaseModel):
    rows: list[dict[str, Any]] = Field(default_factory=list, max_length=500)
    column_map: dict[str, str] = Field(default_factory=dict)


@router.post("/{dataset_id}/import")
async def import_dataset_rows(
    body: ImportRowsRequest,
    org_id: str = Path(...),
    dataset_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    """Bulk import rows (CSV/JSONL wizard posts mapped objects)."""
    hub = DatasetHub()
    rec = await hub.get_dataset(org_id, dataset_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    pg = await get_postgres_client()
    if pg is None:
        raise HTTPException(status_code=503, detail="database unavailable")
    svc = SpreadsheetService(pg)
    inserted = 0
    for raw in body.rows[:500]:
        values: dict[str, Any] = {}
        if body.column_map:
            for src, dest in body.column_map.items():
                if src in raw:
                    values[dest] = raw[src]
        else:
            values = dict(raw)
        input_text = str(values.pop("input", values.pop("prompt", "")) or "")
        expected = str(values.pop("expected_output", values.pop("expected", "")) or "")
        await svc.add_row(
            dataset_id=dataset_id,
            input=input_text,
            expected_output=expected,
            values=values,
        )
        inserted += 1
    return {"status": "ok", "inserted": inserted, "dataset_id": dataset_id}
