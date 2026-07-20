"""Data platform API routes for Eden.

Exposes endpoints for:
- Silver ETL pipeline execution
- Quarantine event management
- Data quality reports
- Data lineage queries
- Data retention / GDPR operations
- Storage lifecycle management
"""

import json
import logging
from datetime import datetime
from typing import Any, NoReturn

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_org_admin, require_path_org_access
from eden.api.utils.redact import redact_all
from eden.api.utils.safe_error import raise_mapped_db_error
from eden.data_platform.lineage import get_lineage_tracker
from eden.data_platform.quality import DataQualityValidator
from eden.data_platform.retention import DataRetentionManager
from eden.data_platform.silver_etl import SilverETLPipeline
from eden.data_platform.storage_lifecycle import StorageLifecycleManager
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


async def _require_pg():
    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="database unavailable")
    return client


def _reraise_dp(exc: Exception, *, fallback: str) -> NoReturn:
    logger.warning("data_platform failed: %s", redact_all(str(exc)))
    raise_mapped_db_error(
        exc,
        fallback=fallback,
        uuid_detail="Invalid id",
        fk_detail="Referenced resource not found",
    )

router = APIRouter(prefix="/orgs/{org_id}/data-platform", tags=["data-platform"], dependencies=[Depends(require_path_org_access)])


# ============================================================================
# Pydantic Schemas
# ============================================================================

class ETLLaunchRequest(BaseModel):
    """Request to trigger a Silver ETL run."""

    limit: int = Field(default=10000, ge=1, le=50000, description="Max Bronze events to process")
    since: str | None = Field(default=None, description="ISO datetime — only process events after this time")


class ETLRunResponse(BaseModel):
    """Response from a Silver ETL run."""

    processed: int
    deduplicated: int
    quarantined: int
    pii_scrubbed: int
    silver_inserted: int
    quality_violations: int
    duration_ms: float
    errors: list[str]


class QuarantineListResponse(BaseModel):
    """Response for quarantine event listing."""

    events: list[dict[str, Any]]
    total: int
    limit: int
    offset: int


class QuarantineReviewRequest(BaseModel):
    """Request to review/reprocess quarantined events."""

    quarantine_ids: list[str]
    resolution: str = Field(default="reprocessed", pattern="^(reprocessed|discarded|false_positive)$")


class QualityReportResponse(BaseModel):
    """Response for data quality report."""

    table_name: str
    timestamp: str
    total_rows: int
    passed_count: int
    error_count: int
    warning_count: int
    quality_score: float
    results: list[dict[str, Any]]


class RetentionRunRequest(BaseModel):
    """Request to run a retention policy."""

    dry_run: bool = Field(default=True, description="If true, only log what would be done")
    policy_name: str | None = Field(default=None, description="Run a specific policy by name; omit for all")


class RetentionRunResponse(BaseModel):
    """Response from a retention run."""

    pii_redacted_rows: int
    archived_rows: int
    deleted_rows: int
    deleted_s3_objects: int
    deleted_clickhouse_rows: int
    errors: list[str]
    duration_ms: float


class GDPRExportResponse(BaseModel):
    """Response for GDPR data export."""

    tenant_id: str
    exported_at: str
    tables: dict[str, Any]
    download_url: str | None = None


class LineageQueryResponse(BaseModel):
    """Response for lineage query."""

    dataset: str
    upstream: list[dict[str, Any]]
    downstream: list[dict[str, Any]]


class StorageSummaryResponse(BaseModel):
    """Response for storage usage summary."""

    timestamp: str
    hot: dict[str, Any]
    warm: dict[str, Any]
    cold: dict[str, Any]


# ============================================================================
# ETL Endpoints
# ============================================================================

@router.post("/etl/run", response_model=ETLRunResponse)
async def run_etl(
    org_id: str = Depends(require_path_org_access),
    request: ETLLaunchRequest = Body(...),
    user: dict = Depends(require_org_admin),
):
    """Trigger a Silver ETL run for unprocessed Bronze events.

    Processes raw usage_events into the silver_events table.
    Requires admin role.
    """
    since_dt = None
    if request.since:
        try:
            since_dt = datetime.fromisoformat(request.since.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid since datetime format") from None

    etl = SilverETLPipeline()
    try:
        report = await etl.run_from_bronze(since=since_dt, limit=request.limit)
    except Exception as exc:
        _reraise_dp(exc, fallback="ETL run failed")

    return ETLRunResponse(
        processed=report.processed,
        deduplicated=report.deduplicated,
        quarantined=report.quarantined,
        pii_scrubbed=report.pii_scrubbed,
        silver_inserted=report.silver_inserted,
        quality_violations=report.quality_violations,
        duration_ms=report.duration_ms,
        errors=report.errors,
    )


@router.get("/etl/report/latest")
async def get_latest_etl_report(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
):
    """Get the most recent ETL processing statistics from the retention log."""
    client = await _require_pg()
    try:
        row = await client.fetchrow(
            """
            SELECT * FROM data_retention_log
            WHERE org_id = $1
              AND policy_name = 'silver_etl_batch'
            ORDER BY completed_at DESC
            LIMIT 1
            """,
            org_id,
        )
    except Exception as exc:
        _reraise_dp(exc, fallback="ETL report unavailable")
    if not row:
        return {"message": "No ETL reports found"}
    return dict(row)


# ============================================================================
# Quarantine Endpoints
# ============================================================================

@router.get("/quarantine", response_model=QuarantineListResponse)
async def list_quarantine(
    org_id: str = Depends(require_path_org_access),
    resolution: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user: dict = Depends(get_current_user),
):
    """List quarantined events for review."""
    client = await _require_pg()

    conditions = ["org_id = $1"]
    params = [org_id]
    param_idx = 2

    if resolution:
        conditions.append(f"resolution = ${param_idx}")
        params.append(resolution)
        param_idx += 1

    where_clause = " AND ".join(conditions)

    count_query = f"SELECT COUNT(*) FROM quarantine_events WHERE {where_clause}"
    try:
        total = await client.fetchval(count_query, *params) or 0

        query = f"""
            SELECT quarantine_id, org_id, event_type, quarantine_reason,
                   raw_payload, quarantined_at, resolution
            FROM quarantine_events
            WHERE {where_clause}
            ORDER BY quarantined_at DESC
            LIMIT ${param_idx} OFFSET ${param_idx + 1}
        """
        params.extend([limit, offset])
        rows = await client.fetch(query, *params)
    except Exception as exc:
        _reraise_dp(exc, fallback="quarantine list unavailable")

    return QuarantineListResponse(
        events=[dict(r) for r in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post("/quarantine/reprocess")
async def reprocess_quarantine(
    org_id: str = Depends(require_path_org_access),
    request: QuarantineReviewRequest = Body(...),
    user: dict = Depends(require_org_admin),
):
    """Reprocess selected quarantined events.

    Removes successfully reprocessed events from quarantine.
    """
    if not request.quarantine_ids:
        raise HTTPException(status_code=400, detail="quarantine_ids must be non-empty")
    etl = SilverETLPipeline()
    try:
        report = await etl.reprocess_quarantine(request.quarantine_ids)
    except Exception as exc:
        _reraise_dp(exc, fallback="quarantine reprocess failed")

    # Update resolution status for all requested IDs
    client = await _require_pg()
    placeholders = ", ".join(f"${i + 2}" for i in range(len(request.quarantine_ids)))
    try:
        await client.execute(
            f"""
            UPDATE quarantine_events
            SET resolution = $1, reviewed_at = NOW(), reviewed_by = $2
            WHERE quarantine_id IN ({placeholders})
            """,
            request.resolution,
            user["user_id"],
            *request.quarantine_ids,
        )
    except Exception as exc:
        _reraise_dp(exc, fallback="quarantine update failed")

    return {
        "reprocessed": report.silver_inserted,
        "quarantined": report.quarantined,
        "errors": report.errors,
    }


# ============================================================================
# Data Quality Endpoints
# ============================================================================

@router.get("/quality/{table_name}", response_model=QualityReportResponse)
async def get_quality_report(
    org_id: str = Depends(require_path_org_access),
    table_name: str = Path(...),
    user: dict = Depends(get_current_user),
):
    """Run quality validation on a table and return the report."""
    validator = DataQualityValidator()

    # For silver_events, use the built-in expectation suite
    if table_name == "silver_events":
        from eden.data_platform.quality import SILVER_EVENT_EXPECTATIONS
        report = await validator.validate_table(table_name, SILVER_EVENT_EXPECTATIONS)
    elif table_name == "usage_events":
        from eden.data_platform.quality import USAGE_EVENT_EXPECTATIONS
        report = await validator.validate_table(table_name, USAGE_EVENT_EXPECTATIONS)
    else:
        raise HTTPException(status_code=400, detail=f"No expectation suite for table: {table_name}")

    # Persist report
    client = await _require_pg()
    try:
        await client.execute(
            """
            INSERT INTO data_quality_reports (
                table_name, total_rows, passed_count, error_count, warning_count,
                quality_score, results_json, duration_ms
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            """,
            table_name,
            report.total_rows,
            report.passed_count,
            report.error_count,
            report.warning_count,
            report.quality_score,
            json.dumps([{
                "name": r.expectation.name,
                "success": r.success,
                "observed": r.observed_value,
                "message": r.message,
            } for r in report.results]),
            report.duration_ms,
        )
    except Exception as exc:
        _reraise_dp(exc, fallback="quality report persist failed")

    return QualityReportResponse(
        table_name=report.table_name,
        timestamp=report.timestamp,
        total_rows=report.total_rows,
        passed_count=report.passed_count,
        error_count=report.error_count,
        warning_count=report.warning_count,
        quality_score=report.quality_score,
        results=[{
            "name": r.expectation.name,
            "success": r.success,
            "observed": r.observed_value,
            "message": r.message,
        } for r in report.results],
    )


@router.get("/quality/reports/history")
async def get_quality_history(
    org_id: str = Depends(require_path_org_access),
    table_name: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user: dict = Depends(get_current_user),
):
    """Get historical quality reports."""
    client = await get_postgres_client()

    conditions = []
    params = []
    param_idx = 1

    if table_name:
        conditions.append(f"table_name = ${param_idx}")
        params.append(table_name)
        param_idx += 1

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    query = f"""
        SELECT table_name, timestamp, total_rows, passed_count,
               error_count, warning_count, quality_score
        FROM data_quality_reports
        {where_clause}
        ORDER BY timestamp DESC
        LIMIT ${param_idx} OFFSET ${param_idx + 1}
    """
    params.extend([limit, offset])
    rows = await client.fetch(query, *params)

    return {
        "reports": [dict(r) for r in rows],
        "total": len(rows),
        "limit": limit,
        "offset": offset,
    }


# ============================================================================
# Data Lineage Endpoints
# ============================================================================

@router.get("/lineage/dataset/{dataset_name}", response_model=LineageQueryResponse)
async def get_dataset_lineage(
    org_id: str = Depends(require_path_org_access),
    dataset_name: str = Path(...),
    user: dict = Depends(get_current_user),
):
    """Get upstream and downstream lineage for a dataset."""
    tracker = await get_lineage_tracker()

    upstream = await tracker.get_upstream(dataset_name)
    downstream = await tracker.get_downstream(dataset_name)

    return LineageQueryResponse(
        dataset=dataset_name,
        upstream=upstream,
        downstream=downstream,
    )


@router.get("/lineage/job/{job_id}")
async def get_job_lineage(
    org_id: str = Depends(require_path_org_access),
    job_id: str = Path(...),
    user: dict = Depends(get_current_user),
):
    """Get full lineage history for a specific Eden pipeline job."""
    tracker = await get_lineage_tracker()
    runs = await tracker.get_lineage_for_job(job_id)
    return {
        "job_id": job_id,
        "runs": runs,
        "total": len(runs),
    }


@router.get("/lineage/export")
async def export_lineage(
    org_id: str = Depends(require_path_org_access),
    since: str | None = Query(None),
    limit: int = Query(1000, ge=1, le=10000),
    user: dict = Depends(get_current_user),
):
    """Export lineage events as OpenLineage-compatible JSON."""
    tracker = await get_lineage_tracker()

    since_dt = None
    if since:
        try:
            since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid since datetime format") from None

    events = await tracker.export_openlineage(since=since_dt, limit=limit)
    return {
        "events": events,
        "total": len(events),
        "format": "openlineage",
    }


# ============================================================================
# Data Retention / GDPR Endpoints
# ============================================================================

@router.post("/retention/run", response_model=RetentionRunResponse)
async def run_retention(
    org_id: str = Depends(require_path_org_access),
    request: RetentionRunRequest = Body(...),
    user: dict = Depends(require_org_admin),
):
    """Run data retention policies.

    Requires admin role. Dry-run by default.
    """
    manager = DataRetentionManager(dry_run=request.dry_run)

    if request.policy_name:
        # Run a single policy
        policies = [p for p in manager.policies if p.data_type == request.policy_name]
        if not policies:
            raise HTTPException(status_code=404, detail=f"Policy not found: {request.policy_name}")
        reports = {p.data_type: await manager.run_retention_policy(p) for p in policies}
    else:
        reports = await manager.run_all_policies()

    # Aggregate results
    total = RetentionRunResponse(
        pii_redacted_rows=sum(r.pii_redacted_rows for r in reports.values()),
        archived_rows=sum(r.archived_rows for r in reports.values()),
        deleted_rows=sum(r.deleted_rows for r in reports.values()),
        deleted_s3_objects=sum(r.deleted_s3_objects for r in reports.values()),
        deleted_clickhouse_rows=sum(r.deleted_clickhouse_rows for r in reports.values()),
        errors=[e for r in reports.values() for e in r.errors],
        duration_ms=sum(r.duration_ms for r in reports.values()),
    )

    return total


@router.delete("/gdpr/tenant")
async def delete_tenant_data(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(require_org_admin),
):
    """GDPR right-to-be-forgotten: delete all data for the tenant.

    Requires admin role. This is irreversible.
    """
    manager = DataRetentionManager(dry_run=False)
    report = await manager.delete_user_data(org_id)

    return {
        "tenant_id": org_id,
        "deleted_rows": report.deleted_rows,
        "deleted_s3_objects": report.deleted_s3_objects,
        "deleted_clickhouse_rows": report.deleted_clickhouse_rows,
        "errors": report.errors,
    }


@router.get("/gdpr/export", response_model=GDPRExportResponse)
async def export_tenant_data(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(require_org_admin),
):
    """GDPR data portability: export all tenant data as JSON.

    Requires admin role.
    """
    manager = DataRetentionManager()
    export = await manager.export_user_data(org_id)

    return GDPRExportResponse(
        tenant_id=export["tenant_id"],
        exported_at=export["exported_at"],
        tables=export["tables"],
    )


# ============================================================================
# Storage Lifecycle Endpoints
# ============================================================================

@router.get("/storage/summary", response_model=StorageSummaryResponse)
async def get_storage_summary(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
):
    """Get storage usage summary across hot/warm/cold tiers."""
    manager = StorageLifecycleManager()
    summary = await manager.get_storage_summary()
    return StorageSummaryResponse(**summary)


@router.post("/storage/apply-lifecycle-rules")
async def apply_lifecycle_rules(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(require_org_admin),
):
    """Apply S3 bucket lifecycle rules for automated tiering.

    Requires admin role. Run once at infrastructure setup time.
    """
    manager = StorageLifecycleManager()
    ok = await manager.apply_s3_lifecycle_rules()
    return {"applied": ok}


@router.post("/storage/transition")
async def transition_storage(
    org_id: str = Depends(require_path_org_access),
    table: str = Query(..., description='Table to transition (e.g., silver_events)'),
    before_days: int = Query(7, ge=1, description='Move rows older than N days'),
    user: dict = Depends(require_org_admin),
):
    """Move PostgreSQL rows older than N days to S3 warm storage.

    Requires admin role.
    """
    manager = StorageLifecycleManager()
    moved = await manager.transition_to_warm(table, before_days)
    return {"table": table, "rows_moved": moved, "before_days": before_days}
