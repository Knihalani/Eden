"""Phase S — Dataset-as-spreadsheet API routes.

Five routes:

  * ``GET    /orgs/{org}/datasets/{id}/rows`` — list rows
  * ``POST   /orgs/{org}/datasets/{id}/rows`` — add a row
  * ``PATCH  /orgs/{org}/datasets/{id}/rows/{row_id}`` — update
  * ``DELETE /orgs/{org}/datasets/{id}/rows/{row_id}`` — delete
  * ``POST   /orgs/{org}/datasets/{id}/columns`` — add column
  * ``GET    /orgs/{org}/datasets/{id}/columns`` — list columns
  * ``POST   /orgs/{org}/datasets/{id}/columns/{col_id}/generate`` — AI fill
  * ``GET    /orgs/{org}/datasets/{id}/export`` — JSONL export
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field, model_validator

from eden.api.deps import (
    _try_resolve_token_payload,
    get_current_user,
    resolve_path_org_access,
)
from eden.api.utils.redact import redact_all
from eden.api.utils.safe_error import raise_mapped_db_error
from eden.datasets.hub import DatasetHub
from eden.datasets.spreadsheet import (
    SpreadsheetColumn,
    SpreadsheetRow,
    SpreadsheetService,
    generate_column,
)
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


async def _require_path_org(
    org_id: str = Path(..., description="Organization ID"),
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> str:
    _, eden_org = await resolve_path_org_access(org_id, user, payload)
    return eden_org


async def _assert_dataset_org(org_id: str, dataset_id: str) -> None:
    """Reject cross-org dataset access (IDOR)."""
    try:
        rec = await DatasetHub().get_dataset(org_id, dataset_id)
    except Exception as exc:
        logger.warning("assert_dataset_org failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="dataset lookup failed",
            uuid_detail="Invalid dataset id",
        )
    if rec is None:
        raise HTTPException(status_code=404, detail="dataset not found")


async def _spreadsheet_svc() -> SpreadsheetService:
    pg = await get_postgres_client()
    if pg is None:
        raise HTTPException(status_code=503, detail="database unavailable")
    return SpreadsheetService(pg)


router = APIRouter(
    prefix="/orgs/{org_id}/datasets/{dataset_id}",
    tags=["datasets-spreadsheet"],
    dependencies=[Depends(_require_path_org)],
)


# ─- Schemas ──────────────────────────────────────────────────────


class ColumnResponse(BaseModel):
    id: str
    name: str
    type: str
    source: str
    description: str
    created_at: str


class ColumnListResponse(BaseModel):
    columns: list[ColumnResponse]


class AddColumnRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    type: str = Field(default="text", pattern="^(text|number|json)$")
    source: str = Field(default="user", pattern="^(user|ai)$")
    description: str = Field(default="", max_length=2_000)


class RowResponse(BaseModel):
    id: str
    dataset_id: str
    input: str
    expected_output: str
    values: dict[str, Any]
    created_at: str
    updated_at: str


class RowListResponse(BaseModel):
    rows: list[RowResponse]
    total_count: int


class AddRowRequest(BaseModel):
    # Portal historically POSTed ``{values}`` only; accept that and
    # derive ``input`` from values.input / prompt / first column.
    input: str = Field(default="", max_length=100_000)
    expected_output: str = Field(default="", max_length=100_000)
    values: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _derive_input_from_values(self) -> AddRowRequest:
        if self.input:
            return self
        vals = self.values or {}
        for key in ("input", "prompt", "value"):
            if key in vals and vals[key] is not None and str(vals[key]):
                self.input = str(vals[key])
                return self
        if vals:
            first = next(iter(vals.values()), None)
            if first is not None:
                self.input = str(first)
        return self


class UpdateRowRequest(BaseModel):
    input: str | None = None
    expected_output: str | None = None
    values: dict[str, Any] | None = None


class FilterSpec(BaseModel):
    column: str
    op: str = Field(default="==", pattern="^(==|!=|>|>=|<|<=|contains|starts_with)$")
    value: str = ""


class SortSpec(BaseModel):
    column: str
    direction: str = Field(default="asc", pattern="^(asc|desc)$")


class ListRowsQuery(BaseModel):
    filter: list[FilterSpec] | None = None
    sort: list[SortSpec] | None = None
    limit: int = Field(default=200, ge=1, le=10_000)
    offset: int = Field(default=0, ge=0)


class GenerateRequest(BaseModel):
    # The default stub handler is used unless the caller
    # supplies a real one via the app.state.llm_client.
    # For the v1 surface we always use the stub.
    handler: str | None = Field(default=None)


# ─- Helpers ──────────────────────────────────────────────────────


def _column_to_response(c: SpreadsheetColumn) -> ColumnResponse:
    return ColumnResponse(
        id=c.id, name=c.name, type=c.type, source=c.source,
        description=c.description, created_at=c.created_at,
    )


def _row_to_response(r: SpreadsheetRow) -> RowResponse:
    return RowResponse(
        id=r.id, dataset_id=r.dataset_id,
        input=r.input, expected_output=r.expected_output,
        values=r.values,
        created_at=r.created_at, updated_at=r.updated_at,
    )


# ─- Routes ────────────────────────────────────────────────────────


@router.get(
    "/columns",
    response_model=ColumnListResponse,
    summary="List columns for a dataset",
)
async def list_columns_route(
    org_id: str = Depends(_require_path_org),
    dataset_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> ColumnListResponse:
    await _assert_dataset_org(org_id, dataset_id)
    svc = await _spreadsheet_svc()
    try:
        cols = await svc.list_columns(dataset_id)
    except Exception as exc:
        logger.warning("list_columns failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="columns unavailable",
            uuid_detail="Invalid dataset id",
        )
    return ColumnListResponse(
        columns=[_column_to_response(c) for c in cols],
    )


@router.post(
    "/columns",
    response_model=ColumnResponse,
    summary="Add a new column to the dataset",
)
async def add_column_route(
    body: AddColumnRequest,
    org_id: str = Depends(_require_path_org),
    dataset_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> ColumnResponse:
    await _assert_dataset_org(org_id, dataset_id)
    svc = await _spreadsheet_svc()
    try:
        col = await svc.add_column(
            dataset_id=dataset_id,
            name=body.name,
            type=body.type,
            source=body.source,
            description=body.description,
        )
    except Exception as exc:
        logger.warning("add_column failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="column create failed",
            unique_detail="column already exists",
            uuid_detail="Invalid dataset id",
            fk_detail="Dataset not found",
        )
    return _column_to_response(col)


@router.post(
    "/columns/{col_id}/generate",
    response_model=RowListResponse,
    summary="AI-generate values for a column across all rows",
)
async def generate_column_route(
    body: GenerateRequest,
    org_id: str = Depends(_require_path_org),
    dataset_id: str = Path(...),
    col_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> RowListResponse:
    """Run the AI handler over every row to fill the column.

    The handler is the stub (returns a placeholder) in v1;
    production wires a real LLM via the route layer.
    """
    await _assert_dataset_org(org_id, dataset_id)
    svc = await _spreadsheet_svc()
    try:
        cols = await svc.list_columns(dataset_id)
        col = next((c for c in cols if c.id == col_id), None)
        if col is None:
            raise HTTPException(status_code=404, detail="column not found")
        rows = await svc.list_rows(dataset_id, limit=10_000)
        # Generate values.
        generated = await generate_column(col, rows)
        # Persist the values back into each row.
        for row in rows:
            if row.id in generated:
                new_values = dict(row.values)
                new_values[col_id] = generated[row.id]
                await svc.update_row(row_id=row.id, values=new_values)
        # Re-fetch the rows.
        updated_rows = await svc.list_rows(dataset_id, limit=10_000)
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("generate_column failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="column generate failed",
            uuid_detail="Invalid column or dataset id",
        )
    return RowListResponse(
        rows=[_row_to_response(r) for r in updated_rows],
        total_count=len(updated_rows),
    )


@router.get(
    "/rows",
    response_model=RowListResponse,
    summary="List rows for a dataset, with optional filter + sort",
)
async def list_rows_route(
    org_id: str = Depends(_require_path_org),
    dataset_id: str = Path(...),
    filter: str | None = Query(default=None, description="JSON-encoded list of filter specs."),
    sort: str | None = Query(default=None, description="JSON-encoded list of sort specs."),
    limit: int = Query(default=200, ge=1, le=10_000),
    offset: int = Query(default=0, ge=0),
    user: dict = Depends(get_current_user),
) -> RowListResponse:
    await _assert_dataset_org(org_id, dataset_id)
    import json
    try:
        filter_spec = json.loads(filter) if filter else None
        sort_spec = json.loads(sort) if sort else None
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid filter or sort JSON") from exc
    svc = await _spreadsheet_svc()
    try:
        rows = await svc.list_rows(
            dataset_id,
            filter_spec=filter_spec,
            sort_spec=sort_spec,
            limit=limit, offset=offset,
        )
    except Exception as exc:
        logger.warning("list_rows failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="rows unavailable",
            uuid_detail="Invalid dataset id",
        )
    return RowListResponse(
        rows=[_row_to_response(r) for r in rows],
        total_count=len(rows),
    )


@router.post(
    "/rows",
    response_model=RowResponse,
    summary="Add a new row to the dataset",
)
async def add_row_route(
    body: AddRowRequest,
    org_id: str = Depends(_require_path_org),
    dataset_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> RowResponse:
    await _assert_dataset_org(org_id, dataset_id)
    svc = await _spreadsheet_svc()
    try:
        row = await svc.add_row(
            dataset_id=dataset_id,
            input=body.input,
            expected_output=body.expected_output,
            values=body.values,
        )
    except Exception as exc:
        logger.warning("add_row failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="row create failed",
            uuid_detail="Invalid dataset id",
            fk_detail="Dataset not found",
        )
    return _row_to_response(row)


@router.patch(
    "/rows/{row_id}",
    response_model=RowResponse,
    summary="Update a row's values + optional input/output",
)
async def update_row_route(
    body: UpdateRowRequest,
    org_id: str = Depends(_require_path_org),
    dataset_id: str = Path(...),
    row_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> RowResponse:
    await _assert_dataset_org(org_id, dataset_id)
    svc = await _spreadsheet_svc()
    try:
        await svc.update_row(
            row_id=row_id,
            values=body.values or {},
            input=body.input,
            expected_output=body.expected_output,
        )
        row = await svc.get_row(row_id)
    except Exception as exc:
        logger.warning("update_row failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="row update failed",
            uuid_detail="Invalid row id",
            fk_detail="Row not found",
        )
    if row is None:
        raise HTTPException(status_code=404, detail="row not found after update")
    if row.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="row not found")
    return _row_to_response(row)


@router.delete(
    "/rows/{row_id}",
    summary="Delete a row",
)
async def delete_row_route(
    org_id: str = Depends(_require_path_org),
    dataset_id: str = Path(...),
    row_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, bool]:
    await _assert_dataset_org(org_id, dataset_id)
    svc = await _spreadsheet_svc()
    try:
        existing = await svc.get_row(row_id)
    except Exception as exc:
        logger.warning("delete_row lookup failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="row delete failed",
            uuid_detail="Invalid row id",
        )
    if existing is None or existing.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="row not found")
    try:
        await svc.delete_row(row_id)
    except Exception as exc:
        logger.warning("delete_row failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="row delete failed",
            uuid_detail="Invalid row id",
        )
    return {"deleted": True}


@router.get(
    "/export",
    response_class=PlainTextResponse,
    summary="Export rows as JSONL",
)
async def export_route(
    org_id: str = Depends(_require_path_org),
    dataset_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> str:
    await _assert_dataset_org(org_id, dataset_id)
    svc = await _spreadsheet_svc()
    try:
        return await svc.export_rows(dataset_id)
    except Exception as exc:
        logger.warning("export_rows failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="export failed",
            uuid_detail="Invalid dataset id",
        )
