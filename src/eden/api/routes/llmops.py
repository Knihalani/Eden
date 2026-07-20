"""Eden API — LLMOps & Experiment Tracking Routes (Phase 6.7).

Exposes model registry, prompt registry, experiment tracking, AI gateway,
production monitoring, and semantic cache endpoints.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_path_org_access
from eden.llmops import (
    AIGateway,
    ArtifactEvaluation,
    ArtifactType,
    Experiment,
    ExperimentRun,
    ExperimentTracker,
    ModelArtifact,
    ModelArtifactRegistry,
    ModelHealthSnapshot,
    ProductionMonitor,
    PromptABTest,
    PromptRegistry,
    PromptTemplate,
    SemanticCache,
)

router = APIRouter(prefix="/orgs/{org_id}/llmops", tags=["llmops"], dependencies=[Depends(require_path_org_access)])

# ──────────────────────────────────────────────────────────────────────────
# Shared registries (in-memory; production would use DB-backed services)
# ──────────────────────────────────────────────────────────────────────────
_model_registry = ModelArtifactRegistry()
_prompt_registry = PromptRegistry()
_experiment_tracker = ExperimentTracker()
_ai_gateway = AIGateway()
_production_monitor = ProductionMonitor()
_semantic_cache = SemanticCache()

# Seed some demo data
_model_registry.register(ModelArtifact(
    artifact_id="art_claude_sonnet_4",
    artifact_type=ArtifactType.BASE_MODEL,
    model_family="claude",
    model_version="claude-sonnet-4-20250514",
    provider="openrouter",
    storage_uri="s3://eden-artifacts/models/claude-sonnet-4",
    config_hash="abc123",
    training_config={},
    metadata={"description": "Claude 3.5 Sonnet — creative tasks"},
))
_model_registry.register(ModelArtifact(
    artifact_id="art_gpt4o",
    artifact_type=ArtifactType.BASE_MODEL,
    model_family="gpt",
    model_version="gpt-4o-20250513",
    provider="openrouter",
    storage_uri="s3://eden-artifacts/models/gpt-4o",
    config_hash="def456",
    training_config={},
    metadata={"description": "GPT-4o — balanced quality/speed"},
))
_model_registry.add_evaluation(ArtifactEvaluation(
    evaluation_id="eval_001",
    artifact_id="art_claude_sonnet_4",
    benchmark_suite_id="suite_v1",
    pass_rate=0.94,
    avg_latency_ms=800,
    cost_per_1k_tokens=0.003,
    hallucination_rate=0.02,
))
_model_registry.add_evaluation(ArtifactEvaluation(
    evaluation_id="eval_002",
    artifact_id="art_gpt4o",
    benchmark_suite_id="suite_v1",
    pass_rate=0.92,
    avg_latency_ms=600,
    cost_per_1k_tokens=0.0025,
    hallucination_rate=0.03,
))

# Seed prompt templates
for scope in ["spec_generator", "designer", "implementer", "reviewer", "archivist"]:
    _prompt_registry.register(PromptTemplate(
        prompt_id=f"prompt_{scope}_v1",
        prompt_name=f"{scope}_default",
        agent_scope=scope,
        version=1,
        template_text=f"You are the {scope.replace('_', ' ').title()} agent...",
        template_hash="seed",
        is_default=True,
        metadata={"description": f"Default prompt for {scope}"},
    ))

# Seed experiment
_experiment_tracker.create_experiment(Experiment(
    experiment_id="exp_prompt_v2",
    experiment_name="spec_generator_prompt_v2",
    experiment_type="prompt_ab",
    pipeline_version="v2.3.1",
    git_commit="a1b2c3d",
    config_snapshot={"spec_generator": {"model": "claude-sonnet-4", "temperature": 0.7}},
    prompt_ids=["prompt_spec_generator_v1"],
    status="completed",
    completed_at=datetime.now(UTC),
))
_experiment_tracker.add_run(ExperimentRun(
    run_id="run_001",
    experiment_id="exp_prompt_v2",
    job_id="job_001",
    metrics={"env_pass_rate": 0.88, "generation_time_sec": 142, "total_tokens": 45231},
    outputs={"environment_id": "env_001", "lines_of_code": 1247, "review_score": 8.3},
))

# Seed health snapshot
_production_monitor.record_snapshot(ModelHealthSnapshot(
    model_family="claude",
    model_version="claude-sonnet-4-20250514",
    timestamp=datetime.now(UTC),
    output_drift_kl=0.03,
    hallucination_rate=0.02,
    token_efficiency=1.0,
    latency_p95_ms=750,
    cost_per_env_usd=0.85,
    pass_rate=0.94,
    overall_score=0.92,
))


# ============================================================================
# Ownership helper
# ============================================================================

def _check_org_access(org_id: str, user: dict) -> None:
    """Verify user belongs to the org. Production would check DB."""
    user_orgs = user.get("organizations", [])
    if not any(o.get("id") == org_id or o.get("slug") == org_id for o in user_orgs):
        raise HTTPException(status_code=403, detail="Access denied to this organization")


# ============================================================================
# Pydantic Schemas
# ============================================================================

class ModelArtifactCreate(BaseModel):
    artifact_type: str
    model_family: str
    model_version: str
    provider: str
    storage_uri: str
    training_config: dict[str, Any] = Field(default_factory=dict)
    parent_artifact_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ArtifactEvaluationCreate(BaseModel):
    benchmark_suite_id: str
    pass_rate: float
    avg_latency_ms: int
    cost_per_1k_tokens: float
    hallucination_rate: float


class PromptTemplateCreate(BaseModel):
    prompt_name: str
    agent_scope: str
    version: int
    template_text: str
    variables: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


class PromptABTestCreate(BaseModel):
    prompt_name: str
    variant_a_id: str
    variant_b_id: str
    traffic_split: float = 0.50
    success_metric: str = "env_pass_rate"


class ExperimentCreate(BaseModel):
    experiment_name: str
    experiment_type: str
    pipeline_version: str
    git_commit: str
    config_snapshot: dict[str, Any]
    model_artifact_ids: list[str] = Field(default_factory=list)
    prompt_ids: list[str] = Field(default_factory=list)
    baseline_experiment_id: str | None = None


class ExperimentRunCreate(BaseModel):
    experiment_id: str
    job_id: str | None = None
    run_params: dict[str, Any] = Field(default_factory=dict)
    metrics: dict[str, Any] = Field(default_factory=dict)
    outputs: dict[str, Any] = Field(default_factory=dict)


class GatewayRequest(BaseModel):
    model_family: str
    model_version: str
    prompt: str
    temperature: float = 0.7
    max_tokens: int = 2048


class HealthSnapshotCreate(BaseModel):
    model_family: str
    model_version: str
    output_drift_kl: float
    hallucination_rate: float
    token_efficiency: float
    latency_p95_ms: float
    cost_per_env_usd: float
    pass_rate: float
    overall_score: float


class CacheSetRequest(BaseModel):
    query: str
    response: str
    model_version: str
    ttl_seconds: int = 3600


# ============================================================================
# Model Artifact Registry Routes
# ============================================================================

@router.post("/artifacts", response_model=dict[str, Any])
async def create_artifact(
    org_id: str = Depends(require_path_org_access),
    body: ModelArtifactCreate = Body(...),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    artifact = ModelArtifact(
        artifact_id=f"art_{uuid.uuid4().hex[:12]}",
        artifact_type=ArtifactType(body.artifact_type),
        model_family=body.model_family,
        model_version=body.model_version,
        provider=body.provider,
        storage_uri=body.storage_uri,
        config_hash=_model_registry.compute_config_hash(body.training_config),
        training_config=body.training_config,
        parent_artifact_id=body.parent_artifact_id,
        metadata={**body.metadata, "org_id": org_id},
    )
    _model_registry.register(artifact)
    return {"artifact": artifact.to_dict()}


@router.get("/artifacts", response_model=dict[str, Any])
async def list_artifacts(
    org_id: str = Depends(require_path_org_access),
    model_family: str | None = None,
    artifact_type: str | None = None,
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    atype = ArtifactType(artifact_type) if artifact_type else None
    if model_family:
        artifacts = _model_registry.list_by_family(model_family)
    else:
        artifacts = _model_registry.list_all(atype)
    return {
        "artifacts": [a.to_dict() for a in artifacts],
        "total": len(artifacts),
    }


@router.get("/artifacts/{artifact_id}", response_model=dict[str, Any])
async def get_artifact(
    org_id: str = Depends(require_path_org_access),
    artifact_id: str = Path(...),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    artifact = _model_registry.get(artifact_id)
    if not artifact:
        raise HTTPException(status_code=404, detail="Artifact not found")
    evaluations = _model_registry.get_evaluations(artifact_id)
    return {
        "artifact": artifact.to_dict(),
        "evaluations": [e.to_dict() for e in evaluations],
    }


@router.post("/artifacts/{artifact_id}/evaluations", response_model=dict[str, Any])
async def add_evaluation(
    org_id: str = Depends(require_path_org_access),
    artifact_id: str = Path(...),
    body: ArtifactEvaluationCreate = Body(...),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    artifact = _model_registry.get(artifact_id)
    if not artifact:
        raise HTTPException(status_code=404, detail="Artifact not found")
    evaluation = ArtifactEvaluation(
        evaluation_id=f"eval_{uuid.uuid4().hex[:12]}",
        artifact_id=artifact_id,
        benchmark_suite_id=body.benchmark_suite_id,
        pass_rate=body.pass_rate,
        avg_latency_ms=body.avg_latency_ms,
        cost_per_1k_tokens=body.cost_per_1k_tokens,
        hallucination_rate=body.hallucination_rate,
    )
    _model_registry.add_evaluation(evaluation)
    return {"evaluation": evaluation.to_dict()}


@router.get("/artifacts/best", response_model=dict[str, Any])
async def get_best_artifact(
    org_id: str = Depends(require_path_org_access),
    model_family: str = Query(...),
    metric: str = 'pass_rate',
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    best = _model_registry.get_best_by_metric(model_family, metric)
    if not best:
        raise HTTPException(status_code=404, detail="No artifacts found")
    return {"artifact": best.to_dict()}


# ============================================================================
# Prompt Registry Routes
# ============================================================================

@router.post("/prompts", response_model=dict[str, Any])
async def create_prompt(
    org_id: str = Depends(require_path_org_access),
    body: PromptTemplateCreate = Body(...),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    template = PromptTemplate(
        prompt_id=f"prompt_{uuid.uuid4().hex[:12]}",
        prompt_name=body.prompt_name,
        agent_scope=body.agent_scope,
        version=body.version,
        template_text=body.template_text,
        template_hash="",
        variables=body.variables,
        created_by=user.get("user_id"),
        metadata={**body.metadata, "org_id": org_id},
    )
    _prompt_registry.register(template)
    return {"prompt": template.to_dict()}


@router.get("/prompts", response_model=dict[str, Any])
async def list_prompts(
    org_id: str = Depends(require_path_org_access),
    agent_scope: str | None = None,
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    prompts = _prompt_registry.list_all(agent_scope)
    return {
        "prompts": [p.to_dict() for p in prompts],
        "total": len(prompts),
    }


@router.get("/prompts/{prompt_id}", response_model=dict[str, Any])
async def get_prompt(
    org_id: str = Depends(require_path_org_access),
    prompt_id: str = Path(...),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    prompt = _prompt_registry.get(prompt_id)
    if not prompt:
        raise HTTPException(status_code=404, detail="Prompt not found")
    return {"prompt": prompt.to_dict()}


@router.post("/prompts/{prompt_name}/default", response_model=dict[str, Any])
async def set_default_prompt(
    org_id: str = Depends(require_path_org_access),
    prompt_name: str = Path(...),
    version: int = Query(...),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    template = _prompt_registry.set_default(prompt_name, version)
    if not template:
        raise HTTPException(status_code=404, detail="Prompt not found")
    return {"prompt": template.to_dict()}


@router.post("/prompts/{prompt_id}/render", response_model=dict[str, Any])
async def render_prompt(
    org_id: str = Depends(require_path_org_access),
    prompt_id: str = Path(...),
    variables: dict[str, Any] = Body(...),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    prompt = _prompt_registry.get(prompt_id)
    if not prompt:
        raise HTTPException(status_code=404, detail="Prompt not found")
    try:
        rendered = _prompt_registry.render(prompt.prompt_name, variables, override_version=prompt.version)
        return {"rendered": rendered, "prompt_id": prompt_id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# ============================================================================
# A/B Testing Routes
# ============================================================================

@router.post("/ab-tests", response_model=dict[str, Any])
async def create_ab_test(
    org_id: str = Depends(require_path_org_access),
    body: PromptABTestCreate = Body(...),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    test = PromptABTest(
        test_id=f"abt_{uuid.uuid4().hex[:12]}",
        prompt_name=body.prompt_name,
        variant_a_id=body.variant_a_id,
        variant_b_id=body.variant_b_id,
        traffic_split=body.traffic_split,
        success_metric=body.success_metric,
        start_date=datetime.now(UTC),
    )
    _prompt_registry.create_ab_test(test)
    return {"test": test.to_dict()}


@router.get("/ab-tests", response_model=dict[str, Any])
async def list_ab_tests(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    tests = list(_prompt_registry._ab_tests.values())
    return {"tests": [t.to_dict() for t in tests], "total": len(tests)}


@router.post("/ab-tests/{test_id}/promote", response_model=dict[str, Any])
async def promote_ab_winner(
    org_id: str = Depends(require_path_org_access),
    test_id: str = Path(...),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    winner = _prompt_registry.promote_ab_winner(test_id)
    if not winner:
        raise HTTPException(status_code=400, detail="No winner set for this test")
    return {"winner": winner.to_dict()}


# ============================================================================
# Experiment Tracking Routes
# ============================================================================

@router.post("/experiments", response_model=dict[str, Any])
async def create_experiment(
    org_id: str = Depends(require_path_org_access),
    body: ExperimentCreate = Body(...),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    experiment = Experiment(
        experiment_id=f"exp_{uuid.uuid4().hex[:12]}",
        experiment_name=body.experiment_name,
        experiment_type=body.experiment_type,
        pipeline_version=body.pipeline_version,
        git_commit=body.git_commit,
        config_snapshot=body.config_snapshot,
        model_artifact_ids=body.model_artifact_ids,
        prompt_ids=body.prompt_ids,
        baseline_experiment_id=body.baseline_experiment_id,
        created_by=user.get("user_id"),
    )
    _experiment_tracker.create_experiment(experiment)
    return {"experiment": experiment.to_dict()}


@router.get("/experiments", response_model=dict[str, Any])
async def list_experiments(
    org_id: str = Depends(require_path_org_access),
    experiment_type: str | None = None,
    status: str | None = None,
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    experiments = _experiment_tracker.list_experiments(experiment_type, status)
    return {
        "experiments": [e.to_dict() for e in experiments],
        "total": len(experiments),
    }


@router.get("/experiments/{experiment_id}", response_model=dict[str, Any])
async def get_experiment(
    org_id: str = Depends(require_path_org_access),
    experiment_id: str = Path(...),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    experiment = _experiment_tracker.get_experiment(experiment_id)
    if not experiment:
        raise HTTPException(status_code=404, detail="Experiment not found")
    runs = _experiment_tracker.get_runs(experiment_id)
    comparison = _experiment_tracker.compare_to_baseline(experiment_id)
    return {
        "experiment": experiment.to_dict(),
        "runs": [r.to_dict() for r in runs],
        "comparison": comparison,
    }


@router.post("/experiments/{experiment_id}/runs", response_model=dict[str, Any])
async def add_experiment_run(
    org_id: str = Depends(require_path_org_access),
    experiment_id: str = Path(...),
    body: ExperimentRunCreate = Body(...),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    experiment = _experiment_tracker.get_experiment(experiment_id)
    if not experiment:
        raise HTTPException(status_code=404, detail="Experiment not found")
    run = ExperimentRun(
        run_id=f"run_{uuid.uuid4().hex[:12]}",
        experiment_id=experiment_id,
        job_id=body.job_id,
        run_params=body.run_params,
        metrics=body.metrics,
        outputs=body.outputs,
    )
    _experiment_tracker.add_run(run)
    return {"run": run.to_dict()}


@router.post("/experiments/{experiment_id}/complete", response_model=dict[str, Any])
async def complete_experiment(
    org_id: str = Depends(require_path_org_access),
    experiment_id: str = Path(...),
    status: str = 'completed',
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    experiment = _experiment_tracker.complete_experiment(experiment_id, status)
    if not experiment:
        raise HTTPException(status_code=404, detail="Experiment not found")
    return {"experiment": experiment.to_dict()}


@router.get("/experiments/{experiment_id}/regression", response_model=dict[str, Any])
async def check_regression(
    org_id: str = Depends(require_path_org_access),
    experiment_id: str = Path(...),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    regression = _experiment_tracker.check_regression(experiment_id)
    recommendation = _experiment_tracker.auto_rollback_recommendation(experiment_id)
    return {
        "regression": regression,
        "recommendation": recommendation,
    }


# ============================================================================
# AI Gateway Routes
# ============================================================================

@router.post("/gateway/complete", response_model=dict[str, Any])
async def gateway_complete(
    org_id: str = Depends(require_path_org_access),
    body: GatewayRequest = Body(...),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    # Audit 2026-07-04 — the previous implementation returned a
    # hardcoded mock response with fabricated cost / latency /
    # provider values. That silently shipped fabricated metrics into
    # the LLMOps dashboard and the judge-eval pipeline. The real
    # provider call lives in ``eden.api.routes.gateway`` (mounted
    # under ``/gateway/v1``). Surface a 501 so callers route there.
    raise HTTPException(
        status_code=410,
        detail=(
            "Legacy /llmops/gateway/complete stub retired 2026-07-04; "
            "use /gateway/v1/chat/completions instead."
        ),
    )


@router.get("/gateway/metrics", response_model=dict[str, Any])
async def gateway_metrics(
    org_id: str = Depends(require_path_org_access),
    limit: int = 100,
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    metrics = _ai_gateway.get_metrics(tenant_id=org_id, limit=limit)
    return {"metrics": metrics, "total": len(metrics)}


@router.get("/gateway/health", response_model=dict[str, Any])
async def gateway_health(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    health = _ai_gateway.get_provider_health()
    return {"providers": [h.to_dict() if hasattr(h, "to_dict") else {"provider": str(h.provider), "healthy": h.healthy, "avg_latency_ms": h.avg_latency_ms} for h in health]}


# ============================================================================
# Production Monitoring Routes
# ============================================================================

@router.post("/monitoring/snapshots", response_model=dict[str, Any])
async def record_health_snapshot(
    org_id: str = Depends(require_path_org_access),
    body: HealthSnapshotCreate = Body(...),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    snapshot = ModelHealthSnapshot(
        model_family=body.model_family,
        model_version=body.model_version,
        timestamp=datetime.now(UTC),
        output_drift_kl=body.output_drift_kl,
        hallucination_rate=body.hallucination_rate,
        token_efficiency=body.token_efficiency,
        latency_p95_ms=body.latency_p95_ms,
        cost_per_env_usd=body.cost_per_env_usd,
        pass_rate=body.pass_rate,
        overall_score=body.overall_score,
    )
    alerts = _production_monitor.record_snapshot(snapshot)
    return {
        "snapshot": snapshot.to_dict(),
        "alerts_triggered": [a.to_dict() for a in alerts],
        "alert_count": len(alerts),
    }


@router.get("/monitoring/health", response_model=dict[str, Any])
async def get_overall_health(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    return _production_monitor.get_overall_health()


@router.get("/monitoring/models/{model_family}", response_model=dict[str, Any])
async def get_model_health(
    org_id: str = Depends(require_path_org_access),
    model_family: str = Path(...),
    hours: int = 24,
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    history = _production_monitor.get_health_history(model_family, hours)
    latest = _production_monitor.get_latest_health(model_family)
    return {
        "model_family": model_family,
        "latest": latest.to_dict() if latest else None,
        "history": [h.to_dict() for h in history],
    }


@router.get("/monitoring/alerts", response_model=dict[str, Any])
async def list_alerts(
    org_id: str = Depends(require_path_org_access),
    model_family: str | None = None,
    severity: str | None = None,
    acknowledged: bool | None = None,
    limit: int = 100,
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    from eden.llmops.production_monitor import AlertSeverity
    sev = AlertSeverity(severity) if severity else None
    alerts = _production_monitor.get_alerts(model_family, sev, acknowledged, limit)
    return {
        "alerts": [a.to_dict() for a in alerts],
        "total": len(alerts),
    }


@router.post("/monitoring/alerts/{alert_id}/acknowledge", response_model=dict[str, Any])
async def acknowledge_alert(
    org_id: str = Depends(require_path_org_access),
    alert_id: str = Path(...),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    alert = _production_monitor.acknowledge_alert(alert_id)
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    return {"alert": alert.to_dict()}


# ============================================================================
# Semantic Cache Routes
# ============================================================================

@router.post("/cache/get", response_model=dict[str, Any])
async def cache_get(
    org_id: str = Depends(require_path_org_access),
    query: str = Query(...),
    model_version: str = Query(...),
    threshold: float = 0.95,
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    cached = await _semantic_cache.get(query, model_version, threshold)
    return {"hit": cached is not None, "response": cached}


@router.post("/cache/set", response_model=dict[str, Any])
async def cache_set(
    org_id: str = Depends(require_path_org_access),
    body: CacheSetRequest = Body(...),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    await _semantic_cache.set(
        body.query,
        body.response,
        body.model_version,
        body.ttl_seconds,
    )
    return {"status": "cached"}


@router.get("/cache/stats", response_model=dict[str, Any])
async def cache_stats(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    return _semantic_cache.get_stats()


@router.post("/cache/invalidate", response_model=dict[str, Any])
async def cache_invalidate(
    org_id: str = Depends(require_path_org_access),
    pattern: str = '*',
    user: dict = Depends(get_current_user),
):
    _check_org_access(org_id, user)
    removed = _semantic_cache.invalidate(pattern)
    return {"invalidated_count": removed}
