"""FastAPI application for Eden job submission and retrieval."""

import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from eden.config import get_settings
from eden.kb import initialize_kb, health_check as kb_health_check
from eden.pipeline.graph import compile_eden_graph
from eden.storage.checkpointer import create_postgres_checkpointer
from eden.api.routes import jobs, kb, auth, orgs, references, api_keys, audit, analytics, export, export_destinations, scim, billing, sso, benchmark, chain, ai_insights, pii_policy, retention_policy, region
from eden.api.routes import (
    feature_flags,
    specs,
    sandbox,
    experiments,
    evaluation,
    multi_agent,
    marketplace,
    integrations_helicone,
)
from eden.api.routes.jobs import set_eden_graph

logger = logging.getLogger(__name__)
settings = get_settings()

# Pipeline graph (compiled on startup)
eden_graph = None


# ============================================================================
# Pydantic Schemas (kept for backwards compatibility and imports)
# ============================================================================

class JobRequest(BaseModel):
    """Request schema for job submission.

    The description is the primary input — tags are optional hints that help
    the Planner understand the domain. The Planner is free to infer additional
    tags from the description.
    """

    description: str = Field(..., description="Natural language description of the environment")
    tags: list[str] = Field(
        default_factory=list,
        description="Optional tags to guide the Planner (e.g., rl, continuous, gymnasium, multi-agent). The Planner may infer additional tags from the description."
    )
    framework: str = Field(default="gymnasium", description="Target framework")
    framework_version: str = Field(default="0.29", description="Framework version")
    difficulty_parameters: dict = Field(default_factory=dict)
    output_mode: str = Field(default="gymnasium_mode")


class JobResponse(BaseModel):
    """Response schema for job submission."""

    job_id: str
    status: str
    message: str


class JobStatusResponse(BaseModel):
    """Response schema for job status."""

    job_id: str
    status: str
    current_stage: str
    outcome_tier: Optional[str] = None
    created_at: str
    updated_at: str
    stage_history: list[dict] = Field(default_factory=list)


class JobResultResponse(BaseModel):
    """Response schema for job result."""

    job_id: str
    status: str
    outcome_tier: Optional[str] = None
    environment_code: Optional[str] = None
    test_results: Optional[dict] = None
    quality_report: Optional[dict] = None
    archivist_summary: Optional[dict] = None


class HealthResponse(BaseModel):
    """Response schema for health check."""

    status: str
    version: str
    postgres: str
    qdrant: str
    sandbox: str


# ============================================================================
# Lifespan
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    global eden_graph
    logger.info("Starting Eden API...")

    # Initialize Knowledge Base
    try:
        await initialize_kb()
        logger.info("Knowledge Base initialized")
    except Exception as e:
        logger.warning(f"KB initialization warning: {e}")

    # Initialize sandbox runner
    try:
        from eden.sandbox.runner import get_sandbox_runner
        # Initialize async sandbox runner
        await get_sandbox_runner()
        logger.info("Sandbox runner initialized")
    except Exception as e:
        logger.warning(f"Sandbox initialization warning: {e}")

    # Compile pipeline graph with checkpointer
    # Gated on the enable_eval_pipeline feature flag: when off, the legacy
    # multi-stage pipeline is not used and we skip compilation entirely.
    if settings.enable_eval_pipeline:
        try:
            checkpointer = None
            if settings.checkpoint_enabled:
                checkpointer = await create_postgres_checkpointer()

            eden_graph = compile_eden_graph(checkpointer=checkpointer)
            set_eden_graph(eden_graph)
            logger.info("Pipeline graph compiled")
        except Exception as e:
            logger.warning(f"Graph compilation warning (expected in dev): {e}")
            eden_graph = None
            set_eden_graph(None)
    else:
        logger.info("enable_eval_pipeline=false: skipping pipeline graph compilation")
        eden_graph = None
        set_eden_graph(None)

    # Phase 7.1b follow-up — start the Insights detector loop.
    # Best-effort: a failure to start the loop must never block
    # app startup.  The loop reads the ``judge_scores`` table on a
    # 60s cadence (configurable via ``insights_loop_interval_seconds``)
    # and writes ``Insight`` objects to Postgres + the KB.
    insights_loop = None
    if getattr(settings, "insights_loop_enabled", True):
        try:
            from eden.insights.detector_loop import start_insights_detector_loop

            await start_insights_detector_loop()
            insights_loop = True
        except Exception as e:
            logger.warning(f"Insights detector loop startup skipped: {e}")

    yield

    # Cleanup
    if insights_loop:
        try:
            from eden.insights.detector_loop import stop_insights_detector_loop

            await stop_insights_detector_loop()
        except Exception as e:
            logger.warning(f"Insights detector loop stop failed: {e}")

    from eden.storage.postgres import close_postgres_client
    from eden.sandbox.runner import close_sandbox_runner

    await close_sandbox_runner()
    await close_postgres_client()
    logger.info("Shutting down Eden API...")


# ============================================================================
# FastAPI App
# ============================================================================

app = FastAPI(
    title="Eden",
    description="AI-native environment generation system",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include route modules
app.include_router(jobs.router)
app.include_router(kb.router)
app.include_router(auth.router)
app.include_router(audit.router)  # /orgs/{org_id}/audit-log
app.include_router(orgs.router)
app.include_router(references.router)
app.include_router(api_keys.router)
app.include_router(billing.router)  # /orgs/{org_id}/billing
app.include_router(analytics.router)  # /orgs/{org_id}/analytics
app.include_router(export.router)  # /orgs/{org_id}/export
app.include_router(export_destinations.router)  # /orgs/{org_id}/export/{destinations,schedules,run-now}
app.include_router(scim.router)  # /orgs/{org_id}/scim/v2
app.include_router(sso.router)  # /sso
app.include_router(benchmark.router)  # /benchmark
app.include_router(chain.router)  # /chain
app.include_router(ai_insights.router)  # /orgs/{org_id}/ai-insights
app.include_router(pii_policy.router)  # /orgs/{org_id}/pii-policy
app.include_router(retention_policy.router)  # /orgs/{org_id}/retention-policy
app.include_router(region.router)  # /orgs/{org_id}/region
app.include_router(specs.router)  # /specs (gated)
app.include_router(sandbox.router)  # /sandbox (gated)
app.include_router(experiments.router)  # /experiments (gated)
app.include_router(evaluation.router)  # /evaluation (gated)
app.include_router(multi_agent.router)  # /orgs/{org_id}/multi-agent (gated)
app.include_router(marketplace.router)  # /marketplace (gated)
app.include_router(integrations_helicone.router)  # /integrations/helicone (gated)
app.include_router(feature_flags.router)  # /feature-flags (public)

# A2 — Per-org AI Gateway model registry. CRUD over the
# org_gateway_models table; the gateway in A1 calls /resolve to
# look up the upstream provider, model id, and (decrypted) API
# key for a given logical model name. The router is always
# mounted; the routes themselves enforce org membership + admin.
from eden.api.routes import gateway_models
app.include_router(gateway_models.router)


# ============================================================================
# Health Check
# ============================================================================

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Check system health."""
    kb_health = await kb_health_check()
    sandbox_status = _get_sandbox_health()

    overall = "healthy" if (
        kb_health.get("postgres") == "connected" and
        kb_health.get("qdrant") == "connected" and
        sandbox_status in ("ready", "null_sandbox", "healthy")
    ) else "degraded"

    return HealthResponse(
        status=overall,
        version=settings.app_version,
        postgres=kb_health.get("postgres", "unknown"),
        qdrant=kb_health.get("qdrant", "unknown"),
        sandbox=sandbox_status,
    )


def _get_sandbox_health() -> str:
    """Get sandbox health status."""
    try:
        from eden.sandbox.runner import _sandbox_runner, NullSandboxRunner
        if _sandbox_runner is None:
            return "uninitialized"
        if isinstance(_sandbox_runner, NullSandboxRunner):
            return "null_sandbox"
        return "ready"
    except Exception:
        return "unknown"


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port)