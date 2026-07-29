"""Insights API routes — Phase 6.3.

Endpoints for trace ingestion, detector results, dataset management,
and comparative analysis (environment vs production disparity).
"""

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import OrgMember, get_current_org_member, require_path_org_access
from eden.insights import (
    DetectorRegistry,
    InsightsService,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}", tags=["insights"], dependencies=[Depends(require_path_org_access)])

# Global singletons (production: dependency-injected)
_insights_service: InsightsService | None = None
_detector_registry: DetectorRegistry | None = None


def _get_service() -> InsightsService:
    global _insights_service
    if _insights_service is None:
        _insights_service = InsightsService()
    return _insights_service


def _get_detector_registry() -> DetectorRegistry:
    global _detector_registry
    if _detector_registry is None:
        _detector_registry = DetectorRegistry()
    return _detector_registry


# ============================================================================
# Pydantic Schemas
# ============================================================================

class TraceIngestRequest(BaseModel):
    realm: str = Field(..., description="environment | production | comparative")
    raw_trace: dict[str, Any] = Field(..., description="Raw trace data from the source")
    env_trace_id: str | None = Field(None, description="For comparative realm: environment trace ID")
    prod_trace_id: str | None = Field(None, description="For comparative realm: production trace ID")
    metrics: dict[str, Any] | None = Field(None, description="For comparative realm: disparity metrics")


class InsightResponse(BaseModel):
    insight_id: str
    detector: str
    severity: str
    confidence: float
    summary: str
    affected_trace_ids: list[str]
    pattern: dict[str, Any]
    recommended_action: str
    auto_created_dataset: str | None
    metadata: dict[str, Any]


class DatasetResponse(BaseModel):
    dataset_id: str
    name: str
    dataset_type: str
    version: str
    tenant_id: str
    project_id: str
    created_at: str
    updated_at: str
    entry_count: int
    tags: list[str]
    metadata: dict[str, Any]


class DatasetEntryResponse(BaseModel):
    entry_id: str
    source_trace_id: str
    source_realm: str
    extracted_at: str
    extract_rule: str
    dataset_id: str
    input: dict[str, Any]
    expected: dict[str, Any]
    metadata: dict[str, Any]
    lineage: list[str]


class DisparityDimensionResponse(BaseModel):
    name: str
    env_value: float
    prod_value: float
    gap: float
    severity: str
    explanation: str


class DisparityReportResponse(BaseModel):
    report_id: str
    tenant_id: str
    env_trace_id: str
    prod_trace_id: str
    generated_at: str
    overall_score: float
    dimensions: list[DisparityDimensionResponse]
    recommendations: list[str]
    metadata: dict[str, Any]


class OverviewResponse(BaseModel):
    summary: dict[str, Any]
    traces: dict[str, Any]
    insights: dict[str, Any]
    disparity: dict[str, Any]
    datasets: dict[str, Any]


class TrendsResponse(BaseModel):
    period_days: int
    daily_traces: dict[str, int]
    daily_insights: dict[str, int]
    outcome_by_day: dict[str, dict[str, int]]


class DetectorsResponse(BaseModel):
    detectors: list[dict[str, Any]]


class RunDetectorsRequest(BaseModel):
    detector_names: list[str] | None = Field(None, description="Specific detectors to run; null = all")
    realm: str | None = Field(None, description="Filter traces by realm")


class CompareRequest(BaseModel):
    env_trace_id: str
    prod_trace_id: str


class BatchCompareRequest(BaseModel):
    trace_pairs: list[tuple[str, str]]


class ExportDatasetRequest(BaseModel):
    format_type: str = Field("jsonl", description="jsonl | json | csv | openai-eval")
    split_ratio: tuple[float, float] | None = Field(None, description="Train/test split ratio")


# ============================================================================
# Routes
# ============================================================================

@router.post("/insights/traces/ingest", response_model=dict[str, Any])
async def ingest_trace(
    org_id: str = Depends(require_path_org_access),
    req: TraceIngestRequest = Body(...),
    member: OrgMember = Depends(get_current_org_member),
) -> dict[str, Any]:
    """Ingest a raw trace into the Insights Engine."""
    service = _get_service()
    tenant_id = member.org_id

    try:
        if req.realm == "environment":
            trace = service.ingest_environment_trace(tenant_id, req.raw_trace)
        elif req.realm == "production":
            trace = service.ingest_production_trace(tenant_id, req.raw_trace)
        elif req.realm == "comparative":
            if not req.env_trace_id or not req.prod_trace_id or not req.metrics:
                raise HTTPException(status_code=400, detail="comparative realm requires env_trace_id, prod_trace_id, and metrics")
            trace = service.ingest_comparative_trace(tenant_id, req.env_trace_id, req.prod_trace_id, req.metrics)
        else:
            raise HTTPException(status_code=400, detail=f"Unknown realm: {req.realm}")
    except (KeyError, TypeError, ValueError) as e:
        logger.warning(f"Trace ingestion failed for org {org_id}: {e}")
        raise HTTPException(status_code=422, detail=f"Malformed trace data: {e}") from e

    # Auto-process for datasets
    service.generate_datasets(tenant_id, [trace.trace_id])

    return {
        "trace_id": trace.trace_id,
        "realm": trace.realm.value,
        "fingerprint": trace.fingerprint(),
        "content_hash": trace.content_hash(),
        "insight_count": len(trace.insights),
    }


@router.get("/insights/traces", response_model=list[dict[str, Any]])
async def list_traces(
    org_id: str = Depends(require_path_org_access),
    realm: str | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    member: OrgMember = Depends(get_current_org_member),
) -> list[dict[str, Any]]:
    """List ingested traces for the organization."""
    service = _get_service()
    from eden.insights.unified_trace_model import Realm
    try:
        realm_enum = Realm(realm) if realm else None
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Invalid realm: {realm}") from None
    traces = service.list_traces(member.org_id, realm=realm_enum, limit=limit, offset=offset)
    return [t.to_dict() for t in traces]


@router.get("/insights/traces/{trace_id}", response_model=dict[str, Any])
async def get_trace(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
    member: OrgMember = Depends(get_current_org_member),
) -> dict[str, Any]:
    """Get a single trace by ID."""
    service = _get_service()
    # member.org_id, matching every other scoped call in this module — the
    # in-memory store is keyed by it. Without the tenant argument this
    # returned any tenant's trace to any caller holding the id.
    trace = service.get_trace(member.org_id, trace_id)
    if not trace:
        raise HTTPException(status_code=404, detail="Trace not found")
    return trace.to_dict()


# ──────────────────────────────────────────────────────────────────────────
# Insights / Detectors
# ──────────────────────────────────────────────────────────────────────────

@router.get("/insights/overview", response_model=OverviewResponse)
async def get_insights_overview(
    org_id: str = Depends(require_path_org_access),
    member: OrgMember = Depends(get_current_org_member),
) -> OverviewResponse:
    """Get the insights dashboard overview.

    Prefer Postgres-backed overview (detector_loop writes). Fall back to
    the in-memory store when Postgres is unavailable.
    """
    service = _get_service()
    overview = await service.get_overview_from_postgres(member.org_id)
    if overview is None:
        overview = service.get_overview(member.org_id)
    return OverviewResponse(**overview)


@router.get("/insights/trends", response_model=TrendsResponse)
async def get_insights_trends(
    org_id: str = Depends(require_path_org_access),
    days: int = Query(30, ge=1, le=365),
    member: OrgMember = Depends(get_current_org_member),
) -> TrendsResponse:
    """Get trend data for insights charts."""
    service = _get_service()
    trends = service.get_trends(member.org_id, days=days)
    return TrendsResponse(**trends)


@router.post("/insights/detectors/run", response_model=list[InsightResponse])
async def run_detectors(
    org_id: str = Depends(require_path_org_access),
    req: RunDetectorsRequest = Body(...),
    member: OrgMember = Depends(get_current_org_member),
) -> list[InsightResponse]:
    """Run detectors on traces and return insights."""
    service = _get_service()
    from eden.insights.unified_trace_model import Realm
    try:
        realm_enum = Realm(req.realm) if req.realm else None
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Invalid realm: {req.realm}") from None
    insights = service.run_detectors(
        member.org_id,
        detector_names=req.detector_names,
        realm=realm_enum,
    )
    return [InsightResponse(**i.to_dict()) for i in insights]


@router.get("/insights/detectors", response_model=DetectorsResponse)
async def list_detectors(
    org_id: str = Depends(require_path_org_access),
    member: OrgMember = Depends(get_current_org_member),
) -> DetectorsResponse:
    """List available detectors."""
    registry = _get_detector_registry()
    detectors = []
    for name, detector in registry._detectors.items():
        detectors.append({
            "name": name,
            "description": detector.__class__.__doc__ or "",
            "min_confidence": detector.min_confidence,
        })
    return DetectorsResponse(detectors=detectors)


@router.get("/insights", response_model=list[InsightResponse])
async def list_insights(
    org_id: str = Depends(require_path_org_access),
    detector: str | None = Query(None),
    severity: str | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
    member: OrgMember = Depends(get_current_org_member),
) -> list[InsightResponse]:
    """List detected insights for the organization."""
    service = _get_service()
    insights = service.get_insights(
        member.org_id,
        detector=detector,
        severity=severity,
        limit=limit,
    )
    return [InsightResponse(**i.to_dict()) for i in insights]


@router.get("/insights/{insight_id}", response_model=InsightResponse)
async def get_insight(
    org_id: str = Depends(require_path_org_access),
    insight_id: str = Path(...),
    member: OrgMember = Depends(get_current_org_member),
) -> InsightResponse:
    """Get a single insight by ID."""
    service = _get_service()
    insight = service.get_insight_by_id(member.org_id, insight_id)
    if not insight:
        raise HTTPException(status_code=404, detail="Insight not found")
    return InsightResponse(**insight.to_dict())


# ──────────────────────────────────────────────────────────────────────────
# Datasets
# ──────────────────────────────────────────────────────────────────────────

@router.post("/insights/datasets/generate", response_model=dict[str, Any])
async def generate_datasets(
    org_id: str = Depends(require_path_org_access),
    trace_ids: list[str] | None = Body(None),
    member: OrgMember = Depends(get_current_org_member),
) -> dict[str, Any]:
    """Generate datasets from traces using configured rules."""
    service = _get_service()
    results = service.generate_datasets(member.org_id, trace_ids)
    return {
        "datasets_created": len(results),
        "entries_by_dataset": {
            ds_id: len(entries) for ds_id, entries in results.items()
        },
    }


@router.get("/insights/datasets", response_model=list[DatasetResponse])
async def list_datasets(
    org_id: str = Depends(require_path_org_access),
    member: OrgMember = Depends(get_current_org_member),
) -> list[DatasetResponse]:
    """List all datasets for the organization."""
    service = _get_service()
    datasets = service.list_datasets(member.org_id)
    return [DatasetResponse(**d) for d in datasets]


@router.get("/insights/datasets/{dataset_id}", response_model=DatasetResponse)
async def get_dataset(
    org_id: str = Depends(require_path_org_access),
    dataset_id: str = Path(...),
    member: OrgMember = Depends(get_current_org_member),
) -> DatasetResponse:
    """Get a single dataset by ID."""
    service = _get_service()
    dataset = service.get_dataset(dataset_id)
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    return DatasetResponse(**dataset)


@router.get("/insights/datasets/{dataset_id}/entries", response_model=list[DatasetEntryResponse])
async def get_dataset_entries(
    org_id: str = Depends(require_path_org_access),
    dataset_id: str = Path(...),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    member: OrgMember = Depends(get_current_org_member),
) -> list[DatasetEntryResponse]:
    """Get entries for a dataset."""
    service = _get_service()
    entries = service.get_dataset_entries(dataset_id, limit, offset)
    return [DatasetEntryResponse(**e) for e in entries]


@router.post("/insights/datasets/{dataset_id}/export", response_model=dict[str, Any])
async def export_dataset(
    org_id: str = Depends(require_path_org_access),
    dataset_id: str = Path(...),
    req: ExportDatasetRequest = Body(...),
    member: OrgMember = Depends(get_current_org_member),
) -> dict[str, Any]:
    """Export a dataset to a portable format."""
    if req.split_ratio and (req.split_ratio[0] + req.split_ratio[1]) <= 0:
        raise HTTPException(status_code=400, detail="split_ratio components must sum to a positive value")
    service = _get_service()
    try:
        return service.export_dataset(
            dataset_id,
            format_type=req.format_type,
            split_ratio=req.split_ratio,
        )
    except (KeyError, ValueError) as e:
        raise HTTPException(status_code=404, detail=str(e) or "Dataset not found") from e


@router.get("/insights/datasets/stats", response_model=dict[str, Any])
async def get_dataset_stats(
    org_id: str = Depends(require_path_org_access),
    member: OrgMember = Depends(get_current_org_member),
) -> dict[str, Any]:
    """Get dataset engine statistics."""
    service = _get_service()
    return service.get_dataset_stats()


# ──────────────────────────────────────────────────────────────────────────
# Comparative Analysis / Disparity
# ──────────────────────────────────────────────────────────────────────────

@router.post("/insights/disparity/compare", response_model=DisparityReportResponse)
async def compare_traces(
    org_id: str = Depends(require_path_org_access),
    req: CompareRequest = Body(...),
    member: OrgMember = Depends(get_current_org_member),
) -> DisparityReportResponse:
    """Compare an environment trace against a production trace."""
    service = _get_service()
    try:
        report = service.compare_env_vs_prod(member.org_id, req.env_trace_id, req.prod_trace_id)
        return DisparityReportResponse(**report.to_dict())
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@router.post("/insights/disparity/batch-compare", response_model=list[DisparityReportResponse])
async def batch_compare_traces(
    org_id: str = Depends(require_path_org_access),
    req: BatchCompareRequest = Body(...),
    member: OrgMember = Depends(get_current_org_member),
) -> list[DisparityReportResponse]:
    """Batch compare multiple trace pairs."""
    service = _get_service()
    reports = service.batch_compare(member.org_id, req.trace_pairs)
    return [DisparityReportResponse(**r.to_dict()) for r in reports]


@router.get("/insights/disparity/reports", response_model=list[DisparityReportResponse])
async def list_disparity_reports(
    org_id: str = Depends(require_path_org_access),
    min_score: float | None = Query(None, ge=0.0, le=1.0),
    limit: int = Query(100, ge=1, le=500),
    member: OrgMember = Depends(get_current_org_member),
) -> list[DisparityReportResponse]:
    """List disparity reports for the organization."""
    service = _get_service()
    reports = service.get_disparity_reports(member.org_id, min_score=min_score, limit=limit)
    return [DisparityReportResponse(**r.to_dict()) for r in reports]


@router.get("/insights/disparity/reports/{report_id}", response_model=DisparityReportResponse)
async def get_disparity_report(
    org_id: str = Depends(require_path_org_access),
    report_id: str = Path(...),
    member: OrgMember = Depends(get_current_org_member),
) -> DisparityReportResponse:
    """Get a single disparity report by ID."""
    service = _get_service()
    report = service.get_disparity_report(member.org_id, report_id)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    return DisparityReportResponse(**report.to_dict())


# ============================================================================
# §3.2 Closed-loop correlation (Insights → KB → env quality)
# ============================================================================

class CorrelationWeekBucket(BaseModel):
    week_start: str
    insights_written: int
    kb_writes: int
    jobs_in_post_window: int
    gold_tier_in_post_window: int
    gold_tier_rate: float | None = None


class CorrelationReportResponse(BaseModel):
    organization_id: str | None = None
    lookback_days: int
    weeks: list[CorrelationWeekBucket] = []
    aggregate_post_jobs: int = 0
    aggregate_post_gold: int = 0
    aggregate_post_rate: float | None = None
    target_slo: float
    target_slo_met: bool
    generated_at: str


@router.get("/insights/correlation", response_model=CorrelationReportResponse)
async def get_insights_correlation(
    org_id: str = Depends(require_path_org_access),
    days: int = Query(30, ge=7, le=180, description='Lookback window in days'),
    member: OrgMember = Depends(get_current_org_member),
) -> CorrelationReportResponse:
    """Closed-loop correlation report (Insights → KB → env quality).

    Returns weekly buckets of: insights written, KB writes, jobs in the
    post-write window, and gold-tier jobs in that window. The aggregate
    gold-tier rate is compared against the §3.2 SLO target (5%).

    Returns an empty report (target_slo_met=False) if the
    ``insights`` / ``kb_insight_writes`` tables (migration 019) have
    not been applied yet.
    """
    from eden.insights.correlation import correlation_report

    report = await correlation_report(
        organization_id=member.org_id,
        lookback_days=days,
    )
    return CorrelationReportResponse(
        organization_id=report.organization_id,
        lookback_days=report.lookback_days,
        weeks=[CorrelationWeekBucket(**{
            "week_start": w.week_start,
            "insights_written": w.insights_written,
            "kb_writes": w.kb_writes,
            "jobs_in_post_window": w.jobs_in_post_window,
            "gold_tier_in_post_window": w.gold_tier_in_post_window,
            "gold_tier_rate": w.gold_tier_rate,
        }) for w in report.weeks],
        aggregate_post_jobs=report.aggregate_post_jobs,
        aggregate_post_gold=report.aggregate_post_gold,
        aggregate_post_rate=report.aggregate_post_rate,
        target_slo=report.target_slo,
        target_slo_met=report.target_slo_met,
        generated_at=report.generated_at,
    )
