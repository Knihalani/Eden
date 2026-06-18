"""Eden API routes for CI/CD Evaluation, Canary Deployment, and Review Gates.

Phase 5.6: Exposes golden datasets, CI pipeline execution, canary deployments,
security scanning, and review gates via REST API.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag, require_org_admin
from eden.evaluation.auto_dataset import AutoDatasetPromoter
from eden.evaluation.canary import (
    CanaryDeployment,
    DeploymentConfig,
    DeploymentStrategy,
    RollbackController,
)
from eden.evaluation.ci_pipeline import CIPipeline, StageName
from eden.evaluation.golden_dataset import (
    DatasetRegistry,
    EnvironmentCategory,
    load_canonical_datasets,
)
from eden.evaluation.review_gate import (
    EnvironmentDiff,
    ReviewGate,
)
from eden.evaluation.security_scanner import SecurityScanner

logger = logging.getLogger(__name__)
router = APIRouter(
    prefix="/evaluation",
    tags=["evaluation"],
    dependencies=[Depends(require_feature_flag("enable_eval_pipeline"))],
)

# ── Shared state ───────────────────────────────────────────────────────────

_dataset_registry: DatasetRegistry | None = None
_ci_pipeline: CIPipeline | None = None
_canary: CanaryDeployment | None = None
_review_gate: ReviewGate | None = None
_security_scanner: SecurityScanner | None = None
_auto_promoter: AutoDatasetPromoter | None = None


def _get_dataset_registry() -> DatasetRegistry:
    global _dataset_registry
    if _dataset_registry is None:
        _dataset_registry = load_canonical_datasets()
    return _dataset_registry


def _get_ci_pipeline() -> CIPipeline:
    global _ci_pipeline
    if _ci_pipeline is None:
        _ci_pipeline = CIPipeline(
            dataset_registry=_get_dataset_registry(),
        )
    return _ci_pipeline


def _get_canary() -> CanaryDeployment:
    global _canary
    if _canary is None:
        _canary = CanaryDeployment()
    return _canary


def _get_review_gate() -> ReviewGate:
    global _review_gate
    if _review_gate is None:
        _review_gate = ReviewGate()
    return _review_gate


def _get_security_scanner() -> SecurityScanner:
    global _security_scanner
    if _security_scanner is None:
        _security_scanner = SecurityScanner()
    return _security_scanner


def _get_auto_promoter() -> AutoDatasetPromoter:
    global _auto_promoter
    if _auto_promoter is None:
        _auto_promoter = AutoDatasetPromoter(
            registry=_get_dataset_registry(),
        )
    return _auto_promoter


# ── Schemas ────────────────────────────────────────────────────────────────

class GoldenDatasetListItem(BaseModel):
    dataset_id: str
    version: str
    frozen_at: str
    description: str
    case_count: int
    categories: list[str]


class GoldenDatasetDetail(BaseModel):
    dataset_id: str
    version: str
    frozen_at: str
    description: str
    cases: list[dict[str, Any]]
    overall_pass_criteria: dict[str, Any]
    baseline_version: str | None = None


class CIPipelineRequest(BaseModel):
    commit_sha: str = Field(..., description="Git commit SHA to evaluate")
    branch: str = Field(..., description="Git branch name")
    changed_files: list[str] = Field(default_factory=list, description="Files changed in PR")
    baseline_commit: str | None = Field(None, description="Baseline commit for regression")
    skip_stages: list[str] = Field(default_factory=list, description="Stage names to skip")


class CIPipelineResponse(BaseModel):
    run_id: str
    commit_sha: str
    branch: str
    overall_status: str
    merge_allowed: bool
    has_regression: bool
    duration_ms: float
    stages: list[dict[str, Any]]
    summary: str
    timestamp: str


class CanaryDeployRequest(BaseModel):
    environment_id: str = Field(..., description="Environment to deploy")
    current_version: str = Field(..., description="Currently serving version")
    candidate_version: str = Field(..., description="New version to deploy")
    strategy: str = Field(default="canary", description="Deployment strategy: shadow, canary, ab_test, blue_green")
    stages: list[dict[str, Any]] | None = Field(None, description="Custom rollout stages")
    rollback: bool = Field(default=True, description="Enable automatic rollback")


class CanaryDeployResponse(BaseModel):
    deployment_id: str
    environment_id: str
    candidate_version: str
    strategy: str
    status: str
    failed_checks: list[str] = Field(default_factory=list)
    action: str
    confidence: float
    metrics: dict[str, Any]
    duration_ms: float
    timestamp: str


class RollbackRequest(BaseModel):
    environment_id: str
    reason: str


class RollbackResponse(BaseModel):
    environment_id: str
    rolled_back_to: str
    reason: str
    timestamp: str
    verified: bool


class ReviewGateRequest(BaseModel):
    environment_id: str = Field(..., description="Environment being changed")
    old_version: str = Field(..., description="Baseline version")
    new_version: str = Field(..., description="Candidate version")
    lines_changed: int = Field(default=0)
    new_dependencies: list[str] = Field(default_factory=list)
    modified_tools: list[str] = Field(default_factory=list)
    changes_auth_logic: bool = Field(default=False)
    changes_payment_logic: bool = Field(default=False)
    adds_network_access: bool = Field(default=False)
    changes_sandbox_config: bool = Field(default=False)
    changes_reward_function: bool = Field(default=False)
    changes_observation_space: bool = Field(default=False)
    test_coverage_delta: float = Field(default=0.0)


class ReviewGateResponse(BaseModel):
    environment_id: str
    risk_level: str
    decision: str
    reason: str
    required_approvals: int
    current_approvals: int
    reviewers: list[str]
    auto_approved: bool


class ReviewActionRequest(BaseModel):
    environment_id: str
    reviewer: str
    notes: str = ""


class SecurityScanRequest(BaseModel):
    code: str = Field(..., description="Python source code to scan")
    requirements: list[str] = Field(default_factory=list, description="Dependency requirements")
    file_path: str = Field(default="<string>", description="Source file path for reporting")


class SecurityScanResponse(BaseModel):
    overall_passed: bool
    blocked_count: int
    warning_count: int
    scans: dict[str, Any]
    all_issues: list[dict[str, Any]]
    duration_ms: float
    timestamp: str


class AutoDatasetRequest(BaseModel):
    traces: list[dict[str, Any]] = Field(..., description="Production traces to evaluate")
    target_dataset_id: str = Field(default="gd_auto_production", description="Target dataset ID")
    category: str | None = Field(None, description="Default category for promoted cases")


class AutoDatasetResponse(BaseModel):
    processed: int
    promoted: int
    rejected: int
    new_cases_added: int
    dataset_id: str
    dataset_version: str
    promotion_threshold: float


# ── Routes: Golden Datasets ────────────────────────────────────────────────

@router.get("/datasets", response_model=list[GoldenDatasetListItem])
async def list_golden_datasets(
    category: str | None = None,
    user: dict = Depends(get_current_user),
):
    """List all golden datasets."""
    registry = _get_dataset_registry()

    cat_enum = EnvironmentCategory(category) if category else None
    datasets = registry.list_datasets(category=cat_enum)

    return [
        GoldenDatasetListItem(
            dataset_id=d.dataset_id,
            version=d.version,
            frozen_at=d.frozen_at,
            description=d.description,
            case_count=len(d.cases),
            categories=list({c.category.value for c in d.cases}),
        )
        for d in datasets
    ]


@router.get("/datasets/{dataset_id}", response_model=GoldenDatasetDetail)
async def get_golden_dataset(
    dataset_id: str,
    version: str | None = None,
    user: dict = Depends(get_current_user),
):
    """Get a specific golden dataset."""
    registry = _get_dataset_registry()
    dataset = registry.get(dataset_id, version=version)

    if not dataset:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found")

    return GoldenDatasetDetail(
        dataset_id=dataset.dataset_id,
        version=dataset.version,
        frozen_at=dataset.frozen_at,
        description=dataset.description,
        cases=[c.to_dict() for c in dataset.cases],
        overall_pass_criteria=dataset.overall_pass_criteria,
        baseline_version=dataset.baseline_version,
    )


# ── Routes: CI Pipeline ────────────────────────────────────────────────────

@router.post("/ci/run", response_model=CIPipelineResponse)
async def run_ci_pipeline(
    request: CIPipelineRequest,
    background_tasks: BackgroundTasks,
    user: dict = Depends(require_org_admin),
):
    """Run the CI evaluation pipeline for a commit."""
    pipeline = _get_ci_pipeline()

    skip_stages = set()
    for name in request.skip_stages:
        try:
            skip_stages.add(StageName(name))
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Unknown stage: {name}")

    report = await pipeline.run(
        commit_sha=request.commit_sha,
        branch=request.branch,
        changed_files=request.changed_files,
        baseline_commit=request.baseline_commit,
        skip_stages=skip_stages,
    )

    return CIPipelineResponse(
        run_id=report.run_id,
        commit_sha=report.commit_sha,
        branch=report.branch,
        overall_status=report.overall_status.value,
        merge_allowed=report.merge_allowed,
        has_regression=report.has_regression,
        duration_ms=report.duration_ms,
        stages=[
            {
                "stage": s.stage.value,
                "status": s.status.value,
                "duration_ms": s.duration_ms,
                "details": s.details,
                "error": s.error,
                "blocks_merge": s.blocks_merge,
            }
            for s in report.stages
        ],
        summary=report.summary,
        timestamp=report.timestamp,
    )


@router.get("/ci/report/{run_id}")
async def get_ci_report(
    run_id: str,
    user: dict = Depends(require_org_admin),
):
    """Get a previously saved CI pipeline report."""
    pipeline = _get_ci_pipeline()
    report = pipeline.load_report(run_id)

    if not report:
        raise HTTPException(status_code=404, detail=f"CI report {run_id} not found")

    return report.to_dict()


# ── Routes: Canary Deployment ────────────────────────────────────────────

@router.post("/canary/deploy", response_model=CanaryDeployResponse)
async def canary_deploy(
    request: CanaryDeployRequest,
    user: dict = Depends(require_org_admin),
):
    """Execute a canary deployment."""
    canary = _get_canary()

    try:
        strategy = DeploymentStrategy(request.strategy)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Unknown strategy: {request.strategy}")

    config = DeploymentConfig(
        strategy=strategy,
        rollback=request.rollback,
    )

    if request.stages:
        from eden.evaluation.canary import RolloutStage
        config.stages = [
            RolloutStage(
                percentage=s["percentage"],
                duration_minutes=s.get("duration_minutes", 10),
                metrics=s.get("metrics", []),
            )
            for s in request.stages
        ]

    result = await canary.deploy(
        environment_id=request.environment_id,
        current_version=request.current_version,
        candidate_version=request.candidate_version,
        config=config,
    )

    deployment_id = f"{request.environment_id}-{request.candidate_version}"

    return CanaryDeployResponse(
        deployment_id=deployment_id,
        environment_id=request.environment_id,
        candidate_version=request.candidate_version,
        strategy=request.strategy,
        status=result.status,
        failed_checks=result.failed_checks,
        action=result.action,
        confidence=result.confidence,
        metrics=result.metrics,
        duration_ms=result.duration_ms,
        timestamp=result.timestamp,
    )


@router.post("/canary/rollback", response_model=RollbackResponse)
async def canary_rollback(
    request: RollbackRequest,
    user: dict = Depends(require_org_admin),
):
    """Execute an emergency rollback."""
    controller = RollbackController(canary=_get_canary())
    result = await controller.emergency_rollback(
        environment_id=request.environment_id,
        reason=request.reason,
    )
    return RollbackResponse(**result)


@router.post("/canary/dry-run")
async def canary_dry_run(
    environment_id: str,
    current_version: str,
    candidate_version: str,
    user: dict = Depends(require_org_admin),
):
    """Validate that rollback is possible before deployment."""
    controller = RollbackController(canary=_get_canary())
    result = await controller.dry_run(
        environment_id=environment_id,
        current_version=current_version,
        candidate_version=candidate_version,
    )
    return result


# ── Routes: Review Gates ───────────────────────────────────────────────────

@router.post("/review/assess", response_model=ReviewGateResponse)
async def assess_review_gate(
    request: ReviewGateRequest,
    user: dict = Depends(require_org_admin),
):
    """Assess an environment change and determine review requirements."""
    gate = _get_review_gate()

    diff = EnvironmentDiff(
        environment_id=request.environment_id,
        old_version=request.old_version,
        new_version=request.new_version,
        lines_changed=request.lines_changed,
        new_dependencies=request.new_dependencies,
        modified_tools=request.modified_tools,
        changes_auth_logic=request.changes_auth_logic,
        changes_payment_logic=request.changes_payment_logic,
        adds_network_access=request.adds_network_access,
        changes_sandbox_config=request.changes_sandbox_config,
        changes_reward_function=request.changes_reward_function,
        changes_observation_space=request.changes_observation_space,
        test_coverage_delta=request.test_coverage_delta,
    )

    decision = gate.assess(diff)

    return ReviewGateResponse(
        environment_id=decision.environment_id,
        risk_level=decision.risk_level.value,
        decision=decision.decision,
        reason=decision.reason,
        required_approvals=decision.required_approvals,
        current_approvals=decision.current_approvals,
        reviewers=decision.reviewers,
        auto_approved=decision.auto_approved,
    )


@router.post("/review/approve")
async def approve_review(
    request: ReviewActionRequest,
    user: dict = Depends(require_org_admin),
):
    """Approve an environment change."""
    gate = _get_review_gate()

    try:
        decision = gate.approve(
            environment_id=request.environment_id,
            reviewer=request.reviewer,
            notes=request.notes,
        )
        return ReviewGateResponse(
            environment_id=decision.environment_id,
            risk_level=decision.risk_level.value,
            decision=decision.decision,
            reason=decision.reason,
            required_approvals=decision.required_approvals,
            current_approvals=decision.current_approvals,
            reviewers=decision.reviewers,
            auto_approved=decision.auto_approved,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/review/reject")
async def reject_review(
    request: ReviewActionRequest,
    user: dict = Depends(require_org_admin),
):
    """Reject an environment change."""
    gate = _get_review_gate()

    try:
        decision = gate.reject(
            environment_id=request.environment_id,
            reviewer=request.reviewer,
            reason=request.notes,
        )
        return ReviewGateResponse(
            environment_id=decision.environment_id,
            risk_level=decision.risk_level.value,
            decision=decision.decision,
            reason=decision.reason,
            required_approvals=decision.required_approvals,
            current_approvals=decision.current_approvals,
            reviewers=decision.reviewers,
            auto_approved=decision.auto_approved,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/review/pending")
async def list_pending_reviews(
    user: dict = Depends(require_org_admin),
):
    """List all pending reviews."""
    gate = _get_review_gate()
    pending = gate.list_pending()

    return [
        {
            "environment_id": d.environment_id,
            "risk_level": d.risk_level.value,
            "decision": d.decision,
            "reason": d.reason,
            "required_approvals": d.required_approvals,
            "current_approvals": d.current_approvals,
            "reviewers": d.reviewers,
        }
        for d in pending
    ]


# ── Routes: Security Scanning ──────────────────────────────────────────────

@router.post("/security/scan", response_model=SecurityScanResponse)
async def run_security_scan(
    request: SecurityScanRequest,
    user: dict = Depends(require_org_admin),
):
    """Run a comprehensive security scan on code and dependencies."""
    scanner = _get_security_scanner()

    result = await scanner.scan_environment(
        code=request.code,
        requirements=request.requirements,
        file_path=request.file_path,
    )

    return SecurityScanResponse(
        overall_passed=result["overall_passed"],
        blocked_count=result["gate_policy"]["blocked_count"],
        warning_count=result["gate_policy"]["warning_count"],
        scans=result["scans"],
        all_issues=result["all_issues"],
        duration_ms=result["duration_ms"],
        timestamp=result["timestamp"],
    )


@router.post("/security/scan-file")
async def scan_file(
    file_path: str,
    requirements: list[str] | None = None,
    user: dict = Depends(require_org_admin),
):
    """Scan a file on disk."""
    scanner = _get_security_scanner()

    # Sanitize and validate path to prevent directory traversal
    normalized = os.path.normpath(file_path)
    if normalized.startswith("..") or "/../" in normalized or normalized.startswith("/"):
        raise HTTPException(status_code=400, detail="Invalid file path: directory traversal not allowed")

    path = Path(file_path).resolve()
    try:
        # Ensure the resolved path is within the project directory
        project_root = Path(".").resolve()
        path.relative_to(project_root)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid file path: must be within project directory")

    if not path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    if not path.is_file():
        raise HTTPException(status_code=400, detail=f"Path is not a file: {file_path}")

    result = await scanner.scan_file(path, requirements or [])
    return result


@router.get("/security/sbom")
async def get_sbom(
    requirements: list[str],
    project_name: str = "eden",
    user: dict = Depends(require_org_admin),
):
    """Generate a Software Bill of Materials (SBOM)."""
    from eden.evaluation.security_scanner import SBOMGenerator
    generator = SBOMGenerator()
    return generator.generate(requirements, project_name)


# ── Routes: Auto Dataset Promotion ─────────────────────────────────────────

@router.post("/datasets/auto-promote", response_model=AutoDatasetResponse)
async def auto_promote_traces(
    request: AutoDatasetRequest,
    user: dict = Depends(require_org_admin),
):
    """Automatically promote high-quality production traces to golden datasets."""
    promoter = _get_auto_promoter()

    cat_enum = EnvironmentCategory(request.category) if request.category else None

    result = await promoter.process_traces(
        traces=request.traces,
        target_dataset_id=request.target_dataset_id,
        category=cat_enum,
    )

    return AutoDatasetResponse(**result)


@router.post("/datasets/{dataset_id}/freeze")
async def freeze_auto_dataset(
    dataset_id: str,
    approved: bool = True,
    user: dict = Depends(require_org_admin),
):
    """Review and freeze an auto-generated dataset."""
    promoter = _get_auto_promoter()
    frozen = await promoter.review_and_freeze(dataset_id, approved=approved)

    if not frozen:
        if not approved:
            return {"status": "rejected", "dataset_id": dataset_id}
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found")

    return {
        "status": "frozen",
        "dataset_id": frozen.dataset_id,
        "version": frozen.version,
        "case_count": len(frozen.cases),
        "frozen_at": frozen.frozen_at,
    }
