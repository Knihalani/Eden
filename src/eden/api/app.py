"""FastAPI application for Eden API.

Phase 2: the legacy environment-generation pipeline (Planner→Critic→Refiner→…
→Archivist) has been retired. Job submission / job management routes
(`/jobs`, `/specs`, `/v1/jobs`, `/v1/benchmarks`) are removed;
`/v1/environments` is stubbed to 410 Gone.
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Intelligence gap routers (Phase 9 — see
# docs/eden-observability-gap-roadmap.md). All gated by the
# ``intelligence_gap_v0`` umbrella feature flag.
from eden.api.routes import (
    agent_pr_suggestions,
    agent_runs,
    agents,
    ai_insights,
    analytics,
    api_keys,
    audit,
    auth,
    billing,
    builder_graphs,
    chain,
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
    marketplace,
    multi_agent,
    orgs,
    pii_policy,
    references,
    region,
    retention_policy,
    sandbox,
    scim,
    sso,
)
from eden.config import get_settings
from eden.kb import health_check as kb_health_check
from eden.kb import initialize_kb

logger = logging.getLogger(__name__)
settings = get_settings()


# ============================================================================
# Pydantic Schemas
# ============================================================================

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
async def lifespan(app: FastAPI) -> None:
    """Application lifespan handler."""
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

    # Start the RedisTailer background worker. It polls
    # ``telemetry:<tenant>:<trace>:events`` Redis Streams and runs
    # the registered judges on every event. Without this, judges
    # only ever fire on direct ``run_judges`` calls — the
    # continuous tailing pipeline is the default-on surface.
    # Best-effort: the tailer needs Redis; in test envs that
    # don't configure Redis the helper returns None and the
    # start is a no-op.
    try:
        from eden.llmops.judges.redis_tailer import redis_tailer

        await redis_tailer.start()
        logger.info("RedisTailer started")
    except Exception as e:
        logger.warning(f"RedisTailer startup skipped: {e}")

    # Phase 9 — register the 7 new intelligence judges (Cat 3 +
    # Galileo Luna-2) and wire the closed-loop hooks. Best-effort:
    # a failure here must not block app startup.
    try:
        from eden.llmops.judges.builtin_v9 import register_intelligence_judges
        from eden.llmops.promotion_hooks import register_all_hooks

        register_intelligence_judges()
        register_all_hooks()
    except Exception as e:
        logger.warning(f"Intelligence gap wiring skipped: {e}")

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
    from eden.storage.redis import close_redis_client
    # Close the LLM client's async httpx connection pool. Without
    # this, ``AsyncOpenAI`` keeps the underlying ``AsyncClient``
    # alive past process shutdown, leaking sockets on reload.
    try:
        from eden.llm.client import _get_llm_client
        await _get_llm_client().close_async()
    except Exception as e:
        logger.warning(f"LLM client close_async skipped: {e}")

    # Best-effort: a missing Redis singleton (Redis not configured
    # in this env) should not block shutdown. The ``close_redis_client``
    # helper itself is a no-op when no client was ever opened.
    try:
        await close_redis_client()
    except Exception as e:
        logger.warning(f"Redis client close skipped: {e}")

    # Stop the RedisTailer (it depends on Redis; if the close
    # above raised, the tailer's own close is a no-op). The
    # tailer's stop cancels the polling task and lets any
    # in-flight event finish its judge run before returning.
    try:
        from eden.llmops.judges.redis_tailer import redis_tailer

        await redis_tailer.stop()
    except Exception as e:
        logger.warning(f"RedisTailer stop skipped: {e}")

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

# CORS — explicit allowlist, never wildcard with credentials.
# Browsers reject ``allow_origins=["*"]`` + ``allow_credentials=True``,
# and (when they don't) any site can make credentialed requests on
# behalf of logged-in users. Settings.cors_allowed_origins is a
# comma-separated list; when empty we fall back to the portal's
# own origin so the same-origin frontend still works.
_settings = get_settings()
_cors_origins_raw = _settings.cors_allowed_origins.strip()
if _cors_origins_raw:
    _cors_origins = [o.strip() for o in _cors_origins_raw.split(",") if o.strip()]
else:
    _cors_origins = list({
        _settings.portal_base_url.rstrip("/"),
        _settings.app_url.rstrip("/"),
    })
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Org-Id", "X-Org-Api-Key"],
    expose_headers=["X-Region-Hint"],
)

# Include route modules
# Phase 2: jobs, specs, benchmark routers removed (env-gen pipeline retired).
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
app.include_router(ingestion.router)  # /orgs/{org_id}/ingest/{format} (Phase 7.0 multi-format)
app.include_router(scim.router)  # /orgs/{org_id}/scim/v2
app.include_router(sso.router)  # /sso
app.include_router(chain.router)  # /chain
# Batch A1 — register the OpenAI-compatible HTTP gateway
app.include_router(_gateway_routes.router)  # /gateway/v1/...
app.include_router(ai_insights.router)  # /orgs/{org_id}/ai-insights
app.include_router(pii_policy.router)  # /orgs/{org_id}/pii-policy
app.include_router(retention_policy.router)  # /orgs/{org_id}/retention-policy
app.include_router(region.router)  # /orgs/{org_id}/region
app.include_router(sandbox.router)  # /sandbox (gated)
app.include_router(experiments.router)  # /experiments (gated)
app.include_router(evaluation.router)  # /evaluation (gated)
app.include_router(multi_agent.router)  # /orgs/{org_id}/multi-agent (gated; was env-gen)
app.include_router(marketplace.router)  # /marketplace (gated)
app.include_router(integrations_helicone.router)  # /integrations/helicone (gated)
app.include_router(agents.router)  # /orgs/{org_id}/agents (Phase 2: agent registry)
app.include_router(agent_runs.router)  # /orgs/{org_id}/agents/{agent_id}/{uploads,sim/runs,test/runs}
app.include_router(builder_graphs.router)  # /orgs/{org_id}/builder/graphs (Phase 1.7 visual builder save/load)
app.include_router(feature_flags.router)  # /feature-flags (public)

# Custom RBAC (§6.3) — /orgs/{org_id}/roles + /orgs/{org_id}/permissions.
# Was defined but not mounted; mounting it now so the portal's
# role-management pages have a real backend.
from eden.api.routes import rbac

app.include_router(rbac.router)  # /orgs/{org_id}/roles/*
app.include_router(rbac.permissions_router)  # /orgs/{org_id}/permissions

# A1 — OpenAI-compatible AI Gateway (POST /gateway/v1/chat/completions,
# /gateway/v1/completions, /gateway/v1/embeddings, GET /gateway/v1/models).
# This is the customer-facing wire-protocol surface that proxies the
# customer app to per-org upstream providers. Was defined but not
# mounted in app — fixing now so POST /gateway/v1/chat/completions
# returns 401/403 (auth) instead of 404 when called without creds.
from eden.api.routes import gateway

app.include_router(gateway.router)

# A2 — Per-org AI Gateway model registry. CRUD over the
# org_gateway_models table; the gateway in A1 calls /resolve to
# look up the upstream provider, model id, and (decrypted) API
# key for a given logical model name. The router is always
# mounted; the routes themselves enforce org membership + admin.
from eden.api.routes import gateway_models

app.include_router(gateway_models.router)

# Phase 9 — Intelligence gap routers (gated by ``intelligence_gap_v0``).
# 15 new routers covering the 16-category surface; each route
# returns the ``IntelligenceStubResponse`` envelope until the
# underlying feature is built. See
# ``docs/eden-observability-gap-roadmap.md``.
app.include_router(intelligence_replay.router)        # Cat 1 + Cat 16 (decision)
app.include_router(intelligence_rca.router)            # Cat 2
app.include_router(intelligence_eval.router)           # Cat 3
app.include_router(intelligence_retrieval.router)      # Cat 4
app.include_router(intelligence_memory.router)         # Cat 5
app.include_router(intelligence_agents.router)         # Cat 6
app.include_router(intelligence_tools.router)          # Cat 7
app.include_router(intelligence_cost.router)           # Cat 8
app.include_router(intelligence_user.router)           # Cat 9
app.include_router(intelligence_governance.router)     # Cat 10
app.include_router(intelligence_outcomes.router)       # Cat 11
app.include_router(intelligence_experiments.router)    # Cat 12 (+ Simulation)
app.include_router(intelligence_predictive.router)     # Cat 13 (+ Drift)
app.include_router(intelligence_autonomous.router)     # Cat 14 (+ NL Interface)
app.include_router(intelligence_guardrails.router)     # Cat 15 (Runtime Protection)
app.include_router(intelligence_closed_loop.router)    # Cat 17 (Closed-Loop Wiring)
app.include_router(intelligence_apm_depth.router)      # Cat 22 (APM Depth, v1.4)
app.include_router(intelligence_metric_studio.router)  # Cat 21 (Custom-Metric Studio)
app.include_router(intelligence_columnar.router)      # Cat 18 (Columnar Engine)
app.include_router(intelligence_dsl.router)           # Cat 19 (Trace Query DSL)
app.include_router(intelligence_time_travel.router)   # Cat 20 (Time-Travel Debugging)
app.include_router(intelligence_code_change.router)   # Cat 23 (Autonomous Code Modification, v1.6 STUB)
app.include_router(agent_pr_suggestions.router)        # Agent PR-suggestion flow (observability-driven)


# ============================================================================
# Health Check
# ============================================================================

@app.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
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
