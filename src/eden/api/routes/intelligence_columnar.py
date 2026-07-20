"""Intelligence Gap — Columnar Engine (Cat 18, v1.3) routes.

Real implementations (2026-06-11):

* ``POST /partitions/ensure``  — materialise a per-org
  ClickHouse partition and return its metadata
* ``POST /rollups/precompute`` — compute a rollup for
  the (org, source_table, granularity, window) tuple
  and persist it to ``columnar_rollups``
* ``POST /compact``            — run a single
  ``OPTIMIZE TABLE ... FINAL`` cycle for a partition;
  fires :class:`ColumnarHook.on_compaction_drift` on
  the SLA-breach path
* ``POST /query``              — execute a read-only
  SQL query against the columnar engine (ClickHouse
  happy path with Postgres fallback)

Gates:
* ``intelligence_gap_v0`` umbrella flag
* Org scoping via ``{org_id}`` path param
* ``get_current_user`` for auth

See ``docs/observability-gap/18-query-performance.md``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, Path
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag, require_path_org_access

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/columnar",
    tags=["intelligence-columnar"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)


# ─── Schemas ───────────────────────────────────────────────────────


class EnsurePartitionRequest(BaseModel):
    granularity: str = Field(
        "day", description="hour | day | week"
    )
    source_table: str = Field(
        "telemetry_events",
        description="telemetry_events | usage_events | judge_scores",
    )


class PrecomputeRollupsRequest(BaseModel):
    table: str = Field(..., description="telemetry_events | usage_events | judge_scores")
    granularity: str = Field(..., description="hour | day | week")
    window_start: datetime = Field(...)
    window_end: datetime = Field(...)


class CompactRequest(BaseModel):
    partition_id: str = Field(
        ..., description="The ClickHouse partition name (e.g. 'eden.org_abc.2026_06')"
    )


class QueryRequest(BaseModel):
    query: str = Field(..., description="The read-only SQL to execute")
    engine: str = Field(
        "auto",
        description="clickhouse | postgres | auto (default)",
    )


# ─── Routes ────────────────────────────────────────────────────────


@router.post("/partitions/ensure")
async def ensure_partition(
    org_id: str = Depends(require_path_org_access),
    body: EnsurePartitionRequest = Body(...),
) -> dict[str, Any]:
    """Materialise the org's ClickHouse partition and return its metadata.

    Idempotent: repeated calls update the
    ``rows_total`` + ``bytes_total`` estimate in place.
    """
    from eden.columnar import ColumnarPartitionManager

    return await ColumnarPartitionManager().ensure(
        org_id,
        granularity=body.granularity,
        source_table=body.source_table,
    )


@router.post("/rollups/precompute")
async def precompute_rollups(
    org_id: str = Depends(require_path_org_access),
    body: PrecomputeRollupsRequest = Body(...),
) -> dict[str, Any]:
    """Compute the rollup for the given window.

    Persists to ``columnar_rollups`` with the
    per-bucket aggregates. The query engine reads from
    here on the Postgres fallback path.
    """
    from eden.columnar import ColumnarAggregator

    return await ColumnarAggregator().precompute_rollups(
        org_id,
        table=body.table,
        granularity=body.granularity,
        window_start=body.window_start,
        window_end=body.window_end,
    )


@router.post("/compact")
async def compact(
    org_id: str = Depends(require_path_org_access),
    body: CompactRequest = Body(...),
) -> dict[str, Any]:
    """Run one compaction cycle for the given partition.

    Fires :func:`ColumnarHook.on_compaction_drift` on
    the SLA-breach path (compaction took > 4h) or on
    the ``status='failed'`` path (ClickHouse
    ``OPTIMIZE TABLE ... FINAL`` raised).
    """
    from eden.columnar import ColumnarCompactor

    return await ColumnarCompactor().compact_segments(
        org_id,
        partition_id=body.partition_id,
    )


@router.post("/query")
async def query(
    org_id: str = Depends(require_path_org_access),
    body: QueryRequest = Body(...),
) -> dict[str, Any]:
    """Execute a read-only SQL query against the columnar engine.

    The query must include an ``org_id`` filter — the
    query engine does not auto-inject in v1.3. The
    read-only allowlist rejects any non-SELECT/WITH
    leading keyword or disallowed identifier.
    """
    from eden.columnar import ColumnarQueryEngine

    return await ColumnarQueryEngine().execute(
        org_id,
        query=body.query,
        engine=body.engine,
    )
