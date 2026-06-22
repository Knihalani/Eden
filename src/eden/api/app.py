"""FastAPI application for Eden job submission and retrieval."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from eden.api.middleware.tenant_rate_limit import TenantRateLimitMiddleware
from eden.api.routes import (
    ai_agent,
    ai_insights,
    analytics,
    api_keys,
    app_events,
    audit,
    auth,
    billing,
    chain,
    clerk_webhooks,
    cost,
    datasets_spreadsheet,
    debugger,
    evaluation,
    experiments,
    export,
    export_destinations,
    feature_flags,
    ingestion,
    integrations_helicone,
    intelligence_agents,
    intelligence_apm_depth,
    intelligence_autonomous,
    intelligence_closed_loop,
    intelligence_code_change,
    intelligence_columnar,
    intelligence_cost,
    intelligence_dsl,
    intelligence_eval,
    intelligence_experiments,
    intelligence_governance,
    intelligence_guardrails,
    intelligence_memory,
    intelligence_metric_studio,
    intelligence_outcomes,
    intelligence_predictive,
    intelligence_rca,
    intelligence_replay,
    intelligence_retrieval,
    intelligence_time_travel,
    intelligence_tools,
    intelligence_user,
    kb,
    labeling,
    marketplace,
    multi_agent,
    notifications,
    orgs,
    pii_policy,
    presigned_feedback,
    prompts,
    qa_generator,
    redteam,
    references,
    region,
    retention_policy,
    sandbox,
    scim,
    sessions,
    sharing,
    signals,
    sql_query,
    sso,
)
from eden.api.routes import (
    github as github_routes,
)
from eden.config import get_settings
from eden.kb import health_check as kb_health_check
from eden.kb import initialize_kb
from eden.observability.metrics_endpoint import router as metrics_endpoint_router

logger = logging.getLogger(__name__)
settings = get_settings()


def _cors_origins_list() -> list[str]:
    """Resolve the CORS allow-list from ``CORS_ORIGINS_RAW`` (CSV).

    ``*`` is not allowed when ``allow_credentials=True`` (browsers
    reject the response). We split on comma, trim, and drop the
    ``*`` token explicitly so a misconfiguration in prod surfaces
    as a startup warning rather than a silent block.

    Local dev defaults to ``http://localhost:3000`` and
    ``http://127.0.0.1:3000`` (the Vercel portal's dev port).
    """
    raw = getattr(settings, "cors_origins_raw", "") or ""
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if "*" in parts:
        logger.warning(
            "CORS_ORIGINS_RAW contains '*' which is incompatible with "
            "allow_credentials=True. The '*' token is dropped — set an "
            "explicit allow-list (e.g. https://your-portal.example.com)."
        )
        parts = [p for p in parts if p != "*"]
    if not parts:
        # Dev defaults — the portal at localhost:3000 (Vercel) and
        # the Vite dev server at 5173.
        parts = [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ]
    return parts


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
    outcome_tier: str | None = None
    created_at: str
    updated_at: str
    stage_history: list[dict] = Field(default_factory=list)


class JobResultResponse(BaseModel):
    """Response schema for job result."""

    job_id: str
    status: str
    outcome_tier: str | None = None
    environment_code: str | None = None
    test_results: dict | None = None
    quality_report: dict | None = None
    archivist_summary: dict | None = None


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
    logger.info("Starting Eden API...")

    # Audit (June 21 2026) — surface missing Clerk webhook secret at
    # startup. Downgraded ERROR → WARNING so a fresh dev environment
    # (where webhooks aren't wired up) doesn't trip alerting. The
    # runtime webhook handler at src/eden/api/routes/clerk_webhooks.py
    # still rejects unsigned webhooks with 503. Set the secret via
    # the Clerk dashboard (Webhooks → click your endpoint → reveal
    # the "Signing Secret"), then store in NF:
    #   northflank patch secret --secretId CLERK_WEBHOOK_SIGNING_SECRET \
    #     --projectId eden-staging-us-central --input '<json with the whsec_... value>'
    # To silence this warning entirely in local dev, set
    # CLERK_WEBHOOK_SIGNING_SECRET=whsec_dev_placeholder in .env
    # — the runtime handler will still reject real webhooks until a
    # valid signing secret is configured.
    clerk_secret = getattr(settings, "clerk_webhook_signing_secret", "") or ""
    if not clerk_secret:
        logger.warning(
            "CLERK_WEBHOOK_SIGNING_SECRET is not set — Clerk webhooks "
            "(user.created, organizationMembership.*, etc.) will be "
            "rejected with 503 at runtime. Get the signing secret from "
            "Clerk Dashboard → Webhooks → click your endpoint → reveal "
            "'Signing Secret'."
        )
    else:
        logger.info("CLERK_WEBHOOK_SIGNING_SECRET is set")

    # Initialize Knowledge Base
    try:
        await initialize_kb()
        logger.info("Knowledge Base initialized")
    except Exception as e:
        logger.warning(f"KB initialization warning: {e}")

    # Audit (June 21 2026) — non-fatal Qdrant startup probe. The audit
    # flagged "Qdrant / Typesense startup check" as cosmetic-only since
    # ``/health`` already covers liveness.  This surfaces the probe in
    # the startup log so a misconfigured QDRANT_HOST is loud at deploy
    # time, not silent until the next ``/health`` scrape.
    try:
        kb_health = await kb_health_check()
        if kb_health.get("qdrant") == "connected":
            logger.info("Qdrant probe: connected")
        else:
            logger.warning(
                f"Qdrant probe: {kb_health.get('qdrant', 'unknown')} — "
                "check QDRANT_HOST / QDRANT_PORT"
            )
        if kb_health.get("postgres") == "connected":
            logger.info("Postgres probe: connected")
        else:
            logger.warning(f"Postgres probe: {kb_health.get('postgres', 'unknown')}")
    except Exception as e:
        logger.warning(f"KB startup probe warning: {e}")

    # Initialize sandbox runner
    try:
        from eden.sandbox.runner import get_sandbox_runner
        # Initialize async sandbox runner
        await get_sandbox_runner()
        logger.info("Sandbox runner initialized")
    except Exception as e:
        logger.warning(f"Sandbox initialization warning: {e}")

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

    # Audit 2026-06-22 B1.36 — register all closed-loop promotion hooks
    # so on_judge_regression / on_drift_alert / etc. actually fire.
    try:
        from eden.llmops.promotion_hooks import register_all_hooks

        register_all_hooks()
        logger.info("Promotion hooks registered")
    except Exception as e:
        logger.warning(f"Promotion hook registration skipped: {e}")

    yield

    # Cleanup
    if insights_loop:
        try:
            from eden.insights.detector_loop import stop_insights_detector_loop

            await stop_insights_detector_loop()
        except Exception as e:
            logger.warning(f"Insights detector loop stop failed: {e}")

    from eden.sandbox.runner import close_sandbox_runner
    from eden.storage.postgres import close_postgres_client

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
    # Explicit origin list. ``allow_origins=["*"]`` + ``allow_credentials=True``
    # is forbidden by the CORS spec (browsers reject it), and was the
    # original state — so any credentialed request from the portal
    # would silently fail. Allowed origins are read from the
    # ``CORS_ORIGINS_RAW`` env var (comma-separated) and default to a
    # localhost dev set.
    allow_origins=_cors_origins_list(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Accept",
        "Accept-Language",
        "Authorization",
        "Content-Type",
        "If-Match",
        "If-None-Match",
        "X-CSRF-Token",
        "X-Requested-With",
    ],
    # The session cookie is set with ``samesite="lax"`` by the auth
    # routes, so we don't need to expose it here. We do expose ETag
    # so the portal's optimistic-update flow works.
    expose_headers=["ETag", "X-Request-ID"],
    # Browser cache preflight results for 10 minutes — the auth +
    # org headers rarely change.
    max_age=600,
)

# Per-tenant sliding-window rate limiter. Registered AFTER CORS so
# preflight OPTIONS requests are never rate-limited. Falls back to
# in-memory TokenBucket when REDIS_URL is unset. Disable in dev with
# RATE_LIMIT_ENABLED=false. Defaults: 60 req / 60s window.
if getattr(settings, "rate_limit_enabled", True):
    app.add_middleware(
        TenantRateLimitMiddleware,
        default_limit=getattr(settings, "rate_limit_default_per_window", 60),
        default_window=getattr(settings, "rate_limit_window_seconds", 60),
    )

# Include route modules
app.include_router(kb.router)
app.include_router(auth.router)
app.include_router(clerk_webhooks.router)  # /webhooks/clerk
app.include_router(audit.router)  # /orgs/{org_id}/audit-log
app.include_router(orgs.router)
app.include_router(references.router)
app.include_router(api_keys.router)
app.include_router(billing.router)  # /orgs/{org_id}/billing
app.include_router(cost.router)  # /orgs/{org_id}/cost/comparison (Cat 23 audit)
app.include_router(analytics.router)  # /orgs/{org_id}/analytics
app.include_router(export.router)  # /orgs/{org_id}/export
app.include_router(export_destinations.router)  # /orgs/{org_id}/export/{destinations,schedules,run-now}
app.include_router(ingestion.router)  # /orgs/{org_id}/ingest (multi-format observability ingestion)
app.include_router(app_events.router)  # /orgs/{org_id}/ingest/app (Phase A1 app/site events)
app.include_router(scim.router)  # /orgs/{org_id}/scim/v2
app.include_router(sso.router)  # /sso
app.include_router(chain.router)  # /chain
app.include_router(ai_insights.router)  # /orgs/{org_id}/ai-insights
app.include_router(ai_agent.router)  # /orgs/{org_id}/ai (Phase C unified agent)
app.include_router(sharing.sharing_router)  # /orgs/{org_id}/traces/{trace_id}/share + saved-searches (Phase N)
app.include_router(sharing.public_router)  # /public/traces/{token} (no auth, token-gated)
# Phase A1: session lifecycle + presigned feedback tokens
app.include_router(sessions.router)  # /orgs/{org_id}/intelligence/user/sessions/...
app.include_router(presigned_feedback.auth_router)  # /orgs/{org_id}/intelligence/user/feedback/presigned-token
app.include_router(presigned_feedback.public_router)  # /api/v1/feedback/tokens/{token_id} (no auth, token-gated)
app.include_router(sql_query.router)  # /orgs/{org_id}/sql (Phase M read-only SQL executor)
app.include_router(qa_generator.router)  # /orgs/{org_id}/synthetic (Phase J synthetic Q/A generator)
app.include_router(redteam.router)  # /orgs/{org_id}/redteam (Phase L red-team probes)
app.include_router(labeling.router)  # /orgs/{org_id}/labeling (Phase D labeling queue)
app.include_router(signals.router)  # /orgs/{org_id}/signals (Phase Q plain-English signals)
app.include_router(debugger.router)  # /orgs/{org_id}/debugger (Phase P agent debugger)
app.include_router(datasets_spreadsheet.router)  # /orgs/{org_id}/datasets/{dataset_id} (Phase S spreadsheet)
app.include_router(prompts.router)  # /orgs/{org_id}/prompts (Phase I prompt management + playground)
app.include_router(pii_policy.router)  # /orgs/{org_id}/pii-policy
app.include_router(retention_policy.router)  # /orgs/{org_id}/retention-policy
app.include_router(region.router)  # /orgs/{org_id}/region
app.include_router(sandbox.router)  # /sandbox (gated)
app.include_router(experiments.router)  # /experiments (gated)
app.include_router(evaluation.router)  # /evaluation (gated)
app.include_router(multi_agent.router)  # /orgs/{org_id}/multi-agent (gated)
app.include_router(notifications.router)  # /notifications (user-scoped feed; June 2026 Cat 5 mount fix)
app.include_router(marketplace.router)  # /marketplace (gated)
app.include_router(integrations_helicone.router)  # /integrations/helicone (gated)
app.include_router(intelligence_code_change.router)  # /orgs/{org_id}/intelligence/code-change (Cat 23, gated by intelligence_gap_v0)
# Intelligence gap surface — Cat 4/5/6/8/9/10/11/12/13/14/18/19/20/22
# All self-gate on `intelligence_gap_v0` via the per-router `dependencies=`
# list; this just makes them reachable when the flag is on.
app.include_router(intelligence_agents.router)
app.include_router(intelligence_apm_depth.router)
app.include_router(intelligence_autonomous.router)
app.include_router(intelligence_closed_loop.router)
app.include_router(intelligence_columnar.router)
app.include_router(intelligence_cost.router)
app.include_router(intelligence_dsl.router)
app.include_router(intelligence_eval.router)
app.include_router(intelligence_experiments.router)
app.include_router(intelligence_governance.router)
app.include_router(intelligence_guardrails.router)
app.include_router(intelligence_memory.router)
app.include_router(intelligence_metric_studio.router)
app.include_router(intelligence_outcomes.router)
app.include_router(intelligence_predictive.router)
app.include_router(intelligence_rca.router)
app.include_router(intelligence_replay.router)
app.include_router(intelligence_retrieval.router)
app.include_router(intelligence_time_travel.router)
app.include_router(intelligence_tools.router)
app.include_router(intelligence_user.router)
app.include_router(metrics_endpoint_router)  # /metrics (Prometheus, bearer-token auth)
app.include_router(feature_flags.router)  # /feature-flags (public)

# Onboarding wizard (June 2026) — GitHub App OAuth + per-org
# wizard state + integration PR runs. Two routers:
#   public: /integrations/github/{configured,authorize,callback,webhook}
#   org:    /orgs/{org_id}/{github,onboarding}/...
# Both gracefully degrade when GITHUB_APP_* env vars are unset
# (the wizard's "Connect GitHub" step renders a "Skip" fallback).
app.include_router(github_routes.public_router)
app.include_router(github_routes.org_router)

# A2 — Per-org AI Gateway model registry. CRUD over the
# org_gateway_models table; the gateway in A1 calls /resolve to
# look up the upstream provider, model id, and (decrypted) API
# key for a given logical model name. The router is always
# mounted; the routes themselves enforce org membership + admin.
from eden.api.routes import gateway, gateway_models

app.include_router(gateway.router)  # /gateway/v1 (OpenAI-compatible surface)
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

    # Surface the DB target the runtime is actually using so deploy
    # misconfigurations are diagnosable from the public endpoint alone
    # (no shell-in needed). Host/port/db only — credentials are NEVER
    # logged. The ``postgres`` field below is overridden with a more
    # informative message when the connection is failing, but only on
    # the first failing health check after startup (to avoid spamming).
    pg = kb_health.get("postgres", "unknown")
    if pg != "connected" and not getattr(health_check, "_shown_target", False):
        try:
            from urllib.parse import urlsplit

            from eden.storage.dsn import build_dsn

            dsn = build_dsn(settings).replace("postgresql+asyncpg", "postgresql")
            parts = urlsplit(dsn)
            pg = (
                f"{pg} | target=scheme:{parts.scheme} "
                f"host:{parts.hostname} port:{parts.port or 'default'} "
                f"db:{parts.path.lstrip('/') or settings.postgres_db} "
                f"sslmode:{settings.postgres_sslmode or 'off'} "
                f"database_url_set:{bool(settings.database_url)}"
            )
            health_check._shown_target = True
        except Exception:
            pass

    return HealthResponse(
        status=overall,
        version=settings.app_version,
        postgres=pg,
        qdrant=kb_health.get("qdrant", "unknown"),
        sandbox=sandbox_status,
    )


def _get_sandbox_health() -> str:
    """Get sandbox health status."""
    try:
        from eden.sandbox.runner import NullSandboxRunner, _sandbox_runner
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
