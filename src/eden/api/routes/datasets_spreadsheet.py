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
from pydantic import BaseModel, Field

from eden.datasets.spreadsheet import (
    SpreadsheetColumn,
    SpreadsheetRow,
    SpreadsheetService,
    generate_column,
)
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


router = APIRouter(
    prefix="/orgs/{org_id}/datasets/{dataset_id}",
    tags=["datasets-spreadsheet"],
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
    input: str = Field(..., min_length=0, max_length=100_000)
    expected_output: str = Field(default="", max_length=100_000)
    values: dict[str, Any] = Field(default_factory=dict)


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


def _get_user():
    from eden.api.routes.auth import get_current_user
    return get_current_user


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
    org_id: str = Path(...),
    dataset_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> ColumnListResponse:
    pg = await get_postgres_client()
    svc = SpreadsheetService(pg)
    cols = await svc.list_columns(dataset_id)
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
    org_id: str = Path(...),
    dataset_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> ColumnResponse:
    pg = await get_postgres_client()
    svc = SpreadsheetService(pg)
    col = await svc.add_column(
        dataset_id=dataset_id,
        name=body.name,
        type=body.type,
        source=body.source,
        description=body.description,
    )
    return _column_to_response(col)


@router.post(
    "/columns/{col_id}/generate",
    response_model=RowListResponse,
    summary="AI-generate values for a column across all rows",
)
async def generate_column_route(
    body: GenerateRequest,
    org_id: str = Path(...),
    dataset_id: str = Path(...),
    col_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> RowListResponse:
    """Run the AI handler over every row to fill the column.

    The handler is the stub (returns a placeholder) in v1;
    production wires a real LLM via the route layer.
    """
    pg = await get_postgres_client()
    svc = SpreadsheetService(pg)
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
    org_id: str = Path(...),
    dataset_id: str = Path(...),
    filter: str | None = Query(default=None, description="JSON-encoded list of filter specs."),
    sort: str | None = Query(default=None, description="JSON-encoded list of sort specs."),
    limit: int = Query(default=200, ge=1, le=10_000),
    offset: int = Query(default=0, ge=0),
    user: dict = Depends(_get_user()),
) -> RowListResponse:
    import json
    filter_spec = json.loads(filter) if filter else None
    sort_spec = json.loads(sort) if sort else None
    pg = await get_postgres_client()
    svc = SpreadsheetService(pg)
    rows = await svc.list_rows(
        dataset_id,
        filter_spec=filter_spec,
        sort_spec=sort_spec,
        limit=limit, offset=offset,
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
    org_id: str = Path(...),
    dataset_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> RowResponse:
    pg = await get_postgres_client()
    svc = SpreadsheetService(pg)
    row = await svc.add_row(
        dataset_id=dataset_id,
        input=body.input,
        expected_output=body.expected_output,
        values=body.values,
    )
    return _row_to_response(row)


@router.patch(
    "/rows/{row_id}",
    response_model=RowResponse,
    summary="Update a row's values + optional input/output",
)
async def update_row_route(
    body: UpdateRowRequest,
    org_id: str = Path(...),
    dataset_id: str = Path(...),
    row_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> RowResponse:
    pg = await get_postgres_client()
    svc = SpreadsheetService(pg)
    await svc.update_row(
        row_id=row_id,
        values=body.values or {},
        input=body.input,
        expected_output=body.expected_output,
    )
    row = await svc.get_row(row_id)
    if row is None:
        raise HTTPException(status_code=404, detail="row not found after update")
    return _row_to_response(row)


@router.delete(
    "/rows/{row_id}",
    summary="Delete a row",
)
async def delete_row_route(
    org_id: str = Path(...),
    dataset_id: str = Path(...),
    row_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> dict[str, bool]:
    pg = await get_postgres_client()
    svc = SpreadsheetService(pg)
    await svc.delete_row(row_id)
    return {"deleted": True}


@router.get(
    "/export",
    response_class=PlainTextResponse,
    summary="Export rows as JSONL",
)
async def export_route(
    org_id: str = Path(...),
    dataset_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> str:
    pg = await get_postgres_client()
    svc = SpreadsheetService(pg)
    return await svc.export_rows(dataset_id)
