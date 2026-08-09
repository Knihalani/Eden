"""F53 versioned dataset hub API."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import (
    get_current_user,
    require_path_org_access,
)
from eden.api.utils.redact import redact_all
from eden.api.utils.safe_error import raise_mapped_db_error
from eden.datasets.hub import DatasetHub
from eden.datasets.spreadsheet import SpreadsheetService
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/datasets",
    tags=["datasets"],
    dependencies=[Depends(require_path_org_access)],
)

class CreateDatasetRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: str = Field(default="", max_length=2_000)
    source_type: str = Field(default="manual")
    source_ref: str | None = None


class PatchDatasetRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2_000)


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


class DatasetItemResponse(BaseModel):
    id: str
    dataset_id: str
    input: str
    expected_output: str
    payload: dict[str, Any] = Field(default_factory=dict)
    origin_trace_id: str | None = None
    split: str | None = None
    created_at: str = ""


class DatasetItemListResponse(BaseModel):
    items: list[DatasetItemResponse]
    total: int


class CreateDatasetItemRequest(BaseModel):
    input: str = Field(..., max_length=100_000)
    expected_output: str = Field(default="", max_length=100_000)
    payload: dict[str, Any] = Field(default_factory=dict)
    origin_trace_id: str | None = None
    split: str | None = Field(default=None, max_length=100)


def _item_to_response(row: dict[str, Any]) -> DatasetItemResponse:
    payload = row.get("payload")
    if isinstance(payload, str):
        import json

        try:
            payload = json.loads(payload)
        except (ValueError, TypeError):
            payload = {}
    created = row.get("created_at")
    return DatasetItemResponse(
        id=str(row["id"]),
        dataset_id=str(row["dataset_id"]),
        input=str(row.get("input") or ""),
        expected_output=str(row.get("expected_output") or ""),
        payload=payload if isinstance(payload, dict) else {},
        origin_trace_id=row.get("origin_trace_id"),
        split=row.get("split"),
        created_at=(
            created.isoformat()
            if isinstance(created, datetime)
            else str(created or "")
        ),
    )

def _to_response(rec: Any) -> DatasetResponse:
    d = rec.to_dict()
    return DatasetResponse(**d)

@router.get("", response_model=DatasetListResponse)
async def list_datasets(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
    limit: int = Query(50, ge=1, le=200),
) -> DatasetListResponse:
    hub = DatasetHub()
    datasets = await hub.list_datasets(org_id, limit=limit)
    return DatasetListResponse(
        datasets=[_to_response(d) for d in datasets],
        total=len(datasets),
    )

@router.post("", response_model=DatasetResponse)
async def create_dataset(
    body: CreateDatasetRequest,
    org_id: str = Depends(require_path_org_access),
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
        raise_mapped_db_error(
            exc,
            fallback="dataset create failed",
            unique_detail="dataset already exists",
            uuid_detail="Invalid organization or dataset id",
            fk_detail="Organization not found",
        )
    return _to_response(rec)


@router.patch("/{dataset_id}", response_model=DatasetResponse)
async def patch_dataset(
    body: PatchDatasetRequest,
    org_id: str = Depends(require_path_org_access),
    dataset_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> DatasetResponse:
    if body.name is None and body.description is None:
        raise HTTPException(status_code=400, detail="name or description required")
    hub = DatasetHub()
    try:
        rec = await hub.update_dataset(
            org_id,
            dataset_id,
            name=body.name,
            description=body.description,
        )
    except Exception as exc:
        logger.warning("patch_dataset failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="dataset update failed",
            unique_detail="dataset name already exists",
            uuid_detail="Invalid dataset id",
            fk_detail="Dataset not found",
        )
    if rec is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    return _to_response(rec)


@router.delete("/{dataset_id}")
async def delete_dataset(
    org_id: str = Depends(require_path_org_access),
    dataset_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, bool]:
    hub = DatasetHub()
    try:
        deleted = await hub.delete_dataset(org_id, dataset_id)
    except Exception as exc:
        logger.warning("delete_dataset failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="dataset delete failed",
            uuid_detail="Invalid dataset id",
            fk_detail="Dataset not found",
        )
    if not deleted:
        raise HTTPException(status_code=404, detail="dataset not found")
    return {"deleted": True}


@router.post("/promote-from-trace")
async def promote_from_trace(
    body: PromoteTraceRequest,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    hub = DatasetHub()
    try:
        result = await hub.promote_trace(
            org_id,
            body.trace_id,
            dataset_id=body.dataset_id,
            dataset_name=body.dataset_name,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning("promote_from_trace failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="trace promote failed",
            uuid_detail="Invalid dataset or organization id",
            fk_detail="Dataset or organization not found",
        )
    return {"status": "ok", "data": result}

@router.get("/{dataset_id}", response_model=DatasetDetailResponse)
async def get_dataset(
    org_id: str = Depends(require_path_org_access),
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
    org_id: str = Depends(require_path_org_access),
    dataset_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    hub = DatasetHub()
    try:
        snap = await hub.create_snapshot(org_id, dataset_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning("create_snapshot failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="snapshot create failed",
            uuid_detail="Invalid dataset id",
            fk_detail="Dataset not found",
        )
    return {"status": "ok", "snapshot": snap.to_dict()}

class ImportRowsRequest(BaseModel):
    rows: list[dict[str, Any]] = Field(default_factory=list, max_length=500)
    column_map: dict[str, str] = Field(default_factory=dict)

@router.post("/{dataset_id}/import")
async def import_dataset_rows(
    body: ImportRowsRequest,
    org_id: str = Depends(require_path_org_access),
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


@router.get("/{dataset_id}/items", response_model=DatasetItemListResponse)
async def list_dataset_items(
    org_id: str = Depends(require_path_org_access),
    dataset_id: str = Path(...),
    split: str | None = Query(default=None, description="Filter by eval subset tag (e.g. smoke, full)."),
    limit: int = Query(default=1000, ge=1, le=10_000),
    offset: int = Query(default=0, ge=0),
    user: dict = Depends(get_current_user),
) -> DatasetItemListResponse:
    hub = DatasetHub()
    rec = await hub.get_dataset(org_id, dataset_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    try:
        items = await hub.list_dataset_items(
            dataset_id,
            limit=limit,
            offset=offset,
            split=split,
        )
    except Exception as exc:
        logger.warning("list_dataset_items failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="dataset items unavailable",
            uuid_detail="Invalid dataset id",
        )
    return DatasetItemListResponse(
        items=[_item_to_response(i) for i in items],
        total=len(items),
    )


@router.post("/{dataset_id}/items", response_model=DatasetItemResponse)
async def create_dataset_item(
    body: CreateDatasetItemRequest,
    org_id: str = Depends(require_path_org_access),
    dataset_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> DatasetItemResponse:
    hub = DatasetHub()
    rec = await hub.get_dataset(org_id, dataset_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    try:
        result = await hub.add_dataset_item(
            dataset_id,
            input_data=body.input,
            expected_output=body.expected_output,
            payload=body.payload,
            origin_trace_id=body.origin_trace_id,
            split=body.split,
        )
    except Exception as exc:
        logger.warning("create_dataset_item failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="dataset item create failed",
            uuid_detail="Invalid dataset id",
            fk_detail="Dataset not found",
        )
    row = await hub.get_dataset_item(dataset_id, result["row_id"])
    if row is None:
        raise HTTPException(status_code=500, detail="item created but not readable")
    return _item_to_response(row)


@router.get("/{dataset_id}/items/{item_id}", response_model=DatasetItemResponse)
async def get_dataset_item(
    org_id: str = Depends(require_path_org_access),
    dataset_id: str = Path(...),
    item_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> DatasetItemResponse:
    hub = DatasetHub()
    rec = await hub.get_dataset(org_id, dataset_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    row = await hub.get_dataset_item(dataset_id, item_id)
    if row is None:
        raise HTTPException(status_code=404, detail="dataset item not found")
    return _item_to_response(row)
