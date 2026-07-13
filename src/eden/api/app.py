"""FastAPI application for Eden job submission and retrieval."""

import logging
import os
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from eden.api.middleware.internal_only import InternalOnlyMiddleware
from eden.api.middleware.quota_enforcement import QuotaEnforcementMiddleware
from eden.api.middleware.security_headers import (
    SecurityHeadersMiddleware,
    apply_security_headers,
)
from eden.api.middleware.tenant_rate_limit import TenantRateLimitMiddleware
from eden.api.routes import (
    agent_issues,
    agent_sessions,
    agent_pr_suggestions,
    agents,
    ai_agent,
    ai_insights,
    alerts,
    analytics,
    analytics_v2,
    api_keys,
    app_events,
    audit,
    auth,
    autonomy,
    billing,
    budgets,
    chain,
    change_impact,
    clerk_webhooks,
    compliance,
    compliance_pack,
    cost,
    cost_overrides,
    data_platform,
    datasets_spreadsheet,
    debugger,
    experiments,
    export,
    export_destinations,
    feature_flags,
    fleet,
    ingestion,
    improve,
    insights,
    learn,
    integrations_helicone,
    integrations_langfuse,
    integrations_langsmith,
    integrations_runloop,
    integrations_wandb,
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
    internal_health,
    judges,
    kb,
    labeling,
    llmops,
    media,
    model_compare,
    notifications,
    observability,
    observability_a2a,
    observability_computer_use,
    observability_fine_tune,
    observability_mcp,
    observability_provider_routing,
    observability_stream,
    observability_voice,
    onboarding,
    optimization,
    orgs,
    patterns,
    pii_policy,
    presigned_feedback,
    prompt_canary,
    prompts,
    prompts_v2,
    production_eval,
    qa_generator,
    rbac,
    redteam,
    references,
    region,
    replay,
    scim,
    sessions,
    sharing,
    sidebar_prefs,
    signals,
    search_signals,
    tool_call_labels,
    sql_query,
    sso,
    streaming_tokens,
    support,
    trace_quality,
    webhooks,
    websocket,
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
    quality_worker_running: bool = False


# ============================================================================
# Lifespan
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    import asyncio

    logger.info("Starting Eden API...")

    # Schema must lead code on every API deploy. Workers set
    # SKIP_MIGRATIONS=1; the API owns the upgrade.
    try:
        from eden.db_migrations.runner import run_alembic_upgrade_head

        await asyncio.to_thread(run_alembic_upgrade_head)
    except Exception as exc:
        logger.error("Alembic upgrade failed at startup: %s", exc)

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

    # Phase 7.1b follow-up — start the Insights detector loop.
    # Best-effort: a failure to start the loop must never block
    # app startup.  The loop reads the ``judge_scores`` table on a
    # 60s cadence (configurable via ``insights_loop_interval_seconds``)
    # and writes ``Insight`` objects to Postgres + the KB.
    insights_loop = None
    anomaly_loop = None
    evolution_loop = None
    if getattr(settings, "insights_loop_enabled", True):
        try:
            from eden.insights.detector_loop import start_insights_detector_loop

            await start_insights_detector_loop()
            insights_loop = True
        except Exception as e:
            logger.warning(f"Insights detector loop startup skipped: {e}")

    if getattr(settings, "anomaly_loop_enabled", True):
        try:
            from eden.data_platform.anomaly_detector_loop import (
                start_anomaly_detector_loop,
            )

            await start_anomaly_detector_loop()
            anomaly_loop = True
        except Exception as e:
            logger.warning(f"Anomaly detector loop startup skipped: {e}")

    if getattr(settings, "evolution_loop_enabled", True):
        try:
            from eden.agents.evolution.loop import start_evolution_loop

            await start_evolution_loop()
            evolution_loop = True
            logger.info("Evolution loop started (evolver + promotion)")
        except Exception as e:
            logger.warning(f"Evolution loop startup skipped: {e}")

    # Audit 2026-06-22 B1.36 — register all closed-loop promotion hooks
    # so on_judge_regression / on_drift_alert / etc. actually fire.
    try:
        from eden.llmops.promotion_hooks import register_all_hooks

        register_all_hooks()
        logger.info("Promotion hooks registered")
    except Exception as e:
        logger.warning(f"Promotion hook registration skipped: {e}")

    # N14 — production platform activation. Install the trace-quality
    # wirings (Cat 15/17/22 + StatGate gating on closed-loop apply) and
    # start the quality-pipeline sidecar worker. ``install_all()`` is
    # idempotent (safe to call once per process); the worker self-gates
    # on ``trace_quality_enabled`` / ``trace_quality_compute_async`` /
    # ``trace_quality_worker_enabled``.
    try:
        from eden.observability.trace_quality.wiring import install_all

        install_all()
        logger.info("trace_quality: install_all complete")
    except Exception as e:
        logger.warning(f"trace_quality install_all skipped: {e}")

    # WS2 — F39/F40/N15 learn-in-production gateway filters.
    try:
        from eden.llmops.learn_wiring import install_learn_filters

        install_learn_filters()
        logger.info("learn_wiring: gateway filters installed")
    except Exception as e:
        logger.warning(f"learn_wiring install skipped: {e}")

    try:
        from eden.observability.quality_pipeline.worker import start_worker

        await start_worker()
    except Exception as e:
        logger.warning(f"quality_pipeline worker startup skipped: {e}")

    # N14 — optional judge Redis tailer (gated by judges_async_tailer_enabled).
    try:
        from eden.llmops.judges.redis_tailer import start_judge_tailer

        await start_judge_tailer(settings)
    except Exception as e:
        logger.warning(f"judge tailer startup skipped: {e}")

    # F20 — start the trace.finalized consumer so finalized traces are
    # auto-scanned into stumbles/issues without operator configuration.
    try:
        from eden.workers.trace_finalized_consumer import start_consumer

        await start_consumer()
    except Exception as e:
        logger.warning(f"trace_finalized consumer startup skipped: {e}")

    # F46 — start the closed-loop event consumer (group eden-closed-loop)
    # so issue_created → triage → remediate → verify events are processed.
    try:
        from eden.closed_loop.event_bus import start_consumer as start_loop

        await start_loop()
    except Exception as e:
        logger.warning(f"closed-loop consumer startup skipped: {e}")

    # F46 (Wave 6) — start the verify worker that resolves/regresses
    # issues once a remediation's quiet window elapses.
    try:
        from eden.closed_loop.verify import start_verify_worker

        await start_verify_worker()
    except Exception as e:
        logger.warning(f"closed-loop verify worker startup skipped: {e}")

    # Phase 3a (2026-06-23) — surface a loud startup warning when neither
    # a GitHub App nor the legacy PR-provider env vars are configured.
    # Without this, the agent silently falls back to ``LocalPRProvider``
    # (writes ``.eden/prs/<n>.json`` to the local FS), so the user's
    # "open a PR" button looks like it worked but no real GitHub PR
    # was created. The warning makes the misconfiguration visible at
    # deploy time, not at incident time.
    github_app_ok = all(
        getattr(settings, attr, "").strip()
        for attr in (
            "github_app_id",
            "github_app_client_id",
            "github_app_client_secret",
            "github_app_private_key",
        )
    )
    github_pr_ok = bool(
        os.environ.get("EDEN_GITHUB_TOKEN", "").strip()
        and os.environ.get("EDEN_GITHUB_REPO", "").strip()
    )
    if not github_app_ok and not github_pr_ok:
        logger.warning(
            "PR provider is in LOCAL mode — 'Open PR' actions from the "
            "agent will write JSONL files to the local FS instead of "
            "creating real GitHub PRs. Configure ONE of:\n"
            "  • GitHub App: GITHUB_APP_ID + GITHUB_APP_CLIENT_ID + "
            "GITHUB_APP_CLIENT_SECRET + GITHUB_APP_PRIVATE_KEY\n"
            "  • Legacy PAT: EDEN_GITHUB_TOKEN + EDEN_GITHUB_REPO\n"
            "To force local mode intentionally, set EDEN_PR_PROVIDER=local."
        )
    else:
        logger.info("PR provider: GitHub configured (PRs will open remotely)")

    yield

    # F59 — orderly shutdown. The order matters: drain the
    # background tasks that own live Postgres rows first (so
    # the final flush completes against a live pool), then
    # close the sink clients that don't depend on the
    # Postgres pool, then close Postgres last. Pre-F59
    # ``close_redis_client`` / ``close_otel_dual_exporter``
    # / ``shutdown_trace_quality`` / ``close_telemetry_collector``
    # were never called from the lifespan, so the process
    # leaked their aiohttp / asyncio transports across
    # every pod restart (F57 already closed the httpx
    # pool; this closes the rest).

    # ── 1. background-task drainers (use Postgres) ──
    if insights_loop:
        try:
            from eden.insights.detector_loop import stop_insights_detector_loop

            await stop_insights_detector_loop()
        except Exception as e:  # pragma: no cover - defensive
            logger.warning(f"Insights detector loop stop failed: {e}")

    if anomaly_loop:
        try:
            from eden.data_platform.anomaly_detector_loop import (
                stop_anomaly_detector_loop,
            )

            await stop_anomaly_detector_loop()
        except Exception as e:  # pragma: no cover - defensive
            logger.warning(f"Anomaly detector loop stop failed: {e}")

    if evolution_loop:
        try:
            from eden.agents.evolution.loop import stop_evolution_loop

            await stop_evolution_loop()
        except Exception as e:  # pragma: no cover - defensive
            logger.warning(f"Evolution loop stop failed: {e}")

    try:
        from eden.closed_loop.verify import stop_verify_worker

        await stop_verify_worker()
    except Exception as e:  # pragma: no cover - defensive
        logger.warning(f"closed-loop verify worker stop failed: {e}")

    try:
        from eden.closed_loop.event_bus import stop_consumer as stop_loop

        await stop_loop()
    except Exception as e:  # pragma: no cover - defensive
        logger.warning(f"closed-loop consumer stop failed: {e}")

    try:
        from eden.workers.trace_finalized_consumer import stop_consumer

        await stop_consumer()
    except Exception as e:  # pragma: no cover - defensive
        logger.warning(f"trace_finalized consumer stop failed: {e}")

    try:
        from eden.observability.quality_pipeline.worker import stop_worker

        await stop_worker()
    except Exception as e:  # pragma: no cover - defensive
        logger.warning(f"quality_pipeline worker stop failed: {e}")

    try:
        from eden.llmops.judges.redis_tailer import stop_judge_tailer

        await stop_judge_tailer()
    except Exception as e:  # pragma: no cover - defensive
        logger.warning(f"judge tailer stop failed: {e}")

    try:
        from eden.observability.trace_quality.hooks import (
            shutdown_trace_quality,
        )

        await shutdown_trace_quality()
    except Exception as e:  # pragma: no cover - defensive
        logger.warning(f"trace_quality shutdown failed: {e}")

    # ── 2. sink clients (independent of Postgres) ──
    try:
        from eden.observability.otel_exporter import (
            close_otel_dual_exporter,
        )

        await close_otel_dual_exporter()
    except Exception as e:  # pragma: no cover - defensive
        logger.warning(f"otel_exporter shutdown failed: {e}")

    try:
        from eden.storage.redis import close_redis_client

        await close_redis_client()
    except Exception as e:  # pragma: no cover - defensive
        logger.warning(f"redis shutdown failed: {e}")

    try:
        from eden.observability.telemetry_collector import (
            close_telemetry_collector,
        )

        await close_telemetry_collector()
    except Exception as e:  # pragma: no cover - defensive
        logger.warning(f"telemetry_collector shutdown failed: {e}")

    # ── 3. httpx pools ──
    # B-6 follow-up — release the shared ``httpx.AsyncClient``
    # used by ``clerk_auth._fetch_jwks`` so the underlying SSL
    # transport pool is closed cleanly.
    try:
        from eden.api.utils.clerk_auth import shutdown_clerk_auth

        await shutdown_clerk_auth()
    except Exception as e:
        logger.warning(f"clerk_auth shutdown failed: {e}")

    # F57 — release the ``WebhookDeliveryService`` singleton's
    # keep-alive HTTP pool.
    try:
        from eden.services.webhook_delivery import (
            get_webhook_delivery_service,
        )

        await get_webhook_delivery_service().aclose()
    except Exception as e:
        logger.warning(
            f"webhook_delivery shutdown failed: {e}"
        )

    # ── 4. Postgres pool, last ──
    try:
        from eden.storage.postgres import close_postgres_client

        await close_postgres_client()
    except Exception as e:
        logger.warning(f"postgres shutdown failed: {e}")

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

# Per-org resource budget enforcement (§6.3 cost guardrails).
# Registered BEFORE TenantRateLimitMiddleware so quota (per-org resource
# budget) fires first, rate-limit (per-second burst) fires second. Disable
# in dev with QUOTA_ENFORCEMENT_ENABLED=false.
if getattr(settings, "quota_enforcement_enabled", True):
    app.add_middleware(QuotaEnforcementMiddleware)

# Internal-only middleware gates the ``/v1/internal/*`` namespace to
# the IP allow-list (default: loopback). Operators set
# ``INTERNAL_ALLOWED_IPS`` to a comma-separated list when deploying
# behind Northflank + Vercel.
app.add_middleware(InternalOnlyMiddleware)

# Default-deny auth middleware (security 26). Every request must
# carry an auth context (cookie, bearer, or org-specific header)
# unless the path is on the explicit public-prefix allow-list.
# Catches the case where a new route ships without
# ``Depends(get_current_user)`` — the route would be open under
# the old opt-in posture; here it fails CLOSED with 401.
from eden.api.middleware.default_deny import DefaultDenyAuthMiddleware

if getattr(settings, "default_deny_enabled", True):
    app.add_middleware(DefaultDenyAuthMiddleware)

# RLS GUC middleware (B-1 fix, now actually wired in). Sets the
# ``app.current_org_id`` Postgres session var for every request that
# resolves an org, so the migration-015 RLS policies actually filter
# rows on the observability / retention / audit tables. Without this
# the policies read NULL from ``current_setting`` and return empty
# row sets — the "org not picked up" symptom. Registered AFTER
# DefaultDeny (so the auth context is in place) and BEFORE
# TenantRateLimit (so the per-org key is correct). Fail-soft: a DB
# blip on the ``set_config`` logs a warning but does not block the
# request (a missing GUC → empty RLS rows → safe default).
try:
    from eden.api.middleware.rls_org_context import RLSOrgContextMiddleware

    if getattr(settings, "rls_org_context_enabled", True):
        app.add_middleware(RLSOrgContextMiddleware)
except ImportError:  # pragma: no cover — defensive
    logger.warning(
        "RLSOrgContextMiddleware could not be imported; org-scoped "
        "queries will return empty row sets until the import is fixed."
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

# ponytail: GZipMiddleware for transit compression when the reverse
# proxy doesn't do it itself. Production deployments behind Vercel
# or Northflank usually already gzip, in which case this middleware
# sees the request with Content-Encoding set and skips; harmless.
# minimum_size=500 skips compressing tiny JSON like {"ok": true}.
app.add_middleware(GZipMiddleware, minimum_size=500)

# Audit 2026-07-06 — pre-existing bug fix. Both middlewares were
# implemented and unit-tested but never registered on the app.
# Wire them now so:
#   - LatencyMiddleware populates the §11.4 latency histogram that
#     /metrics + the alerts engine read from
#   - CorrelationIdMiddleware sets the request contextvar that
#     api_version / bronze_sink read for log correlation
#   - Both are no-op for cost (contextvar + perf_counter per
#     request, ~µs each on the hot path)
from eden.api.middleware.api_version import APIVersionMiddleware
from eden.api.middleware.correlation_id import CorrelationIdMiddleware
from eden.api.middleware.latency import LatencyMiddleware

# Registered first so the histogram and correlation_id are
# populated for the entire downstream chain (including the
# 401 path of DefaultDenyAuthMiddleware below).
app.add_middleware(LatencyMiddleware)
app.add_middleware(CorrelationIdMiddleware)

# Pre-existing bug #4 — APIVersionMiddleware was implemented and
# the ``envelope.py`` schemas reference ``api_version``, but the
# middleware was never ``add_middleware``'d. As a result the
# ``X-API-Version`` header was never echoed on responses, and the
# version-validation 400 was never returned for clients that
# passed an unknown ``X-API-Version``. Wiring it here activates
# both behaviours for every ``/v1/*`` request.
app.add_middleware(APIVersionMiddleware)

# F67 — security headers (OWASP Secure Headers Project).
# Pure-ASGI middleware registered LAST in the chain so it
# becomes the OUTERMOST user middleware (FastAPI's
# ``add_middleware`` does ``insert(0, ...)``; the last
# registered is at index 0 → wrapped LAST in Starlette's
# ``reversed()`` build loop → outermost). Every response —
# CORS preflight, 401 from DefaultDenyAuth, 503 from
# health-probe, 429 from rate-limit, and the route's own
# 200/4xx — goes through this middleware on the way out.
# The ``ServerErrorMiddleware`` outside us still handles
# uncaught exceptions (500 envelope) so the global
# ``@app.exception_handler(Exception)`` applies the same
# headers via ``apply_security_headers()`` (helper in
# ``eden.api.middleware.security_headers``).
app.add_middleware(SecurityHeadersMiddleware)


# ============================================================================
# Global exception handlers (Site-wide fix — July 2026)
# ============================================================================
# Before this: an uncaught exception in any route became a bare
# Starlette 500 with body ``Internal Server Error`` and no JSON. The
# portal's ``proxyError`` couldn't pretty-print it, support had no
# ``request_id`` to correlate, and 404s from middleware raised
# StarletteHTTPException with the default ``{"detail": "Not Found"}``
# body — which the portal's lib/proxy.ts couldn't destructure
# consistently. Now every 5xx and 4xx middleware raise gets the same
# envelope shape the rest of the project uses: {error, detail, request_id}.
def _request_id(request: Request) -> str:
    return (
        request.headers.get("x-request-id")
        or request.headers.get("x-correlation-id")
        or str(uuid.uuid4())
    )


@app.exception_handler(Exception)
async def _unhandled_exception(request: Request, exc: Exception):
    rid = _request_id(request)
    # Log the full traceback once, on the server, with the request id
    # the user (or our own error envelope) will surface. ``exc_info``
    # captures the traceback in the log without re-raising.
    logger.exception(
        "unhandled exception [request_id=%s] %s %s",
        rid, request.method, request.url.path,
    )
    # F67 — apply OWASP security headers to the 500 envelope.
    # ``ServerErrorMiddleware`` is the outermost wrapper, so our
    # SecurityHeadersMiddleware doesn't see this response. The
    # exception handler is the right place to set them.
    return JSONResponse(
        status_code=500,
        content={
            "error": "internal_error",
            "detail": "An unexpected error occurred",
            "request_id": rid,
        },
        headers=apply_security_headers(),
    )


@app.exception_handler(StarletteHTTPException)
async def _http_exception(request: Request, exc: StarletteHTTPException):
    rid = _request_id(request)
    status = exc.status_code
    # Map the most common middleware raises to a stable, frontend-
    # friendly envelope. Anything outside the map falls through to a
    # generic shape; the upstream ``exc.detail`` is preserved as
    # ``detail`` when it's a plain string.
    #
    # Preserve the original detail when the handler that raised
    # passed an explicit message (e.g. ``HTTPException(
    # status_code=403, detail="Destination belongs to a different
    # org")``). Overwriting with a generic "You don't have access
    # to this resource" stripped actionable info — the test
    # suite lost the ability to distinguish cross-tenant
    # attempts from generic permission denials.
    upstream_detail = exc.detail if isinstance(exc.detail, (str, dict)) else None
    if status == 404:
        err, detail = "not_found", upstream_detail or "The requested resource was not found"
    elif status == 401:
        err, detail = "unauthorized", upstream_detail or "Authentication required"
    elif status == 403:
        err, detail = "forbidden", upstream_detail or "You don't have access to this resource"
    elif status == 429:
        err, detail = "rate_limited", upstream_detail or "Too many requests — slow down"
    elif status == 503:
        # Audit 2026-07-02 — surface the *missing config* reason in
        # the detail so on-call can grep logs for the cause
        # ("CLERK_WEBHOOK_SIGNING_SECRET unset", "DB unavailable", etc.)
        # without needing to read the upstream detail field. The
        # per-route 503 handlers still set their own HTTPException
        # detail — we only see them here when the exception bubbles
        # through unhandled.
        err, detail = "service_unavailable", exc.detail if isinstance(exc.detail, str) else "service temporarily unavailable"
    else:
        err = "http_error"
        detail = exc.detail if isinstance(exc.detail, (str, dict)) else "Request failed"
    # F67 — apply OWASP security headers to the 4xx/5xx envelope.
    # Preserves the upstream ``exc.headers`` (set by raise-for-status
    # flows that pass Retry-After, Allow, etc.) and merges our
    # security headers on top.
    return JSONResponse(
        status_code=status,
        content={"error": err, "detail": detail, "request_id": rid},
        headers=apply_security_headers(exc.headers or {}),
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
app.include_router(budgets.router)  # /orgs/{org_id}/budget + /budget/ticker + /budget/actions (D.10 cost guardrails)
app.include_router(cost.router)  # /orgs/{org_id}/cost/comparison (Cat 23 audit)
app.include_router(analytics.router)  # /orgs/{org_id}/analytics
app.include_router(export.router)  # /orgs/{org_id}/export
app.include_router(export_destinations.router)  # /orgs/{org_id}/export/{destinations,schedules,run-now}
app.include_router(ingestion.router)  # /orgs/{org_id}/ingest (multi-format observability ingestion)
app.include_router(observability.router)  # /orgs/{org_id}/observability/{traces,summary,spans/search,...}
app.include_router(agents.router)  # /orgs/{org_id}/agents (Phase 2 surface — list + register + get)
app.include_router(llmops.router)  # /orgs/{org_id}/llmops/{artifacts,prompts,ab-tests,experiments,gateway,monitoring,cache}
app.include_router(trace_quality.router)  # /v1/traces/{trace_id}/{loops,quality,intervention,...} (Cat 22 trace quality)
app.include_router(observability_mcp.router)  # /v1/traces/{id}/mcp + /v1/mcp/{org}/auth_failures (D.12.1)
app.include_router(observability_a2a.router)  # /v1/traces/{id}/a2a + /v1/a2a/{org}/links + invocation graph (D.12.2)
app.include_router(observability_computer_use.router)  # /v1/traces/{id}/computer_use + step + screenshot tombstone (D.12.3)
app.include_router(observability_voice.router)  # /v1/voice_sessions/* + /v1/traces/{id}/voice_sessions + barge_in spike (D.12.4)
app.include_router(observability_fine_tune.router)  # /v1/fine_tuning_runs/* + /v1/webhooks/openai/fine_tuning (D.12.5)
app.include_router(observability_provider_routing.router)  # /v1/provider_routing/* + /v1/traces/{id}/provider_routing (D.12.6)
app.include_router(internal_health.router)  # /v1/internal/health/* — ops dashboard (Phase 4 B3 §9.6)
app.include_router(optimization.router)  # /orgs/{org_id}/optimization/{overview,costs,savings,cache,budget,}
app.include_router(alerts.router)  # /alerts (global alert feed + per-rule ack)
app.include_router(app_events.router)  # /orgs/{org_id}/ingest/app (Phase A1 app/site events)
app.include_router(scim.router)  # /orgs/{org_id}/scim/v2
app.include_router(sso.router)  # /sso
app.include_router(chain.router)  # /chain
app.include_router(ai_insights.router)  # /orgs/{org_id}/ai-insights
app.include_router(sidebar_prefs.router)  # /orgs/{org_id}/sidebar-prefs (per-user UI prefs)
app.include_router(ai_agent.router)  # /orgs/{org_id}/ai (Phase C unified agent)
app.include_router(sharing.sharing_router)  # /orgs/{org_id}/traces/{trace_id}/share + saved-searches (Phase N)
app.include_router(sharing.public_router)  # /public/traces/{token} (no auth, token-gated)
# Phase A1: session lifecycle + presigned feedback tokens
app.include_router(sessions.router)  # /orgs/{org_id}/intelligence/user/sessions/...
app.include_router(presigned_feedback.auth_router)  # /orgs/{org_id}/intelligence/user/feedback/presigned-token
app.include_router(presigned_feedback.public_router)  # /api/v1/feedback/tokens/{token_id} (no auth, token-gated)
app.include_router(onboarding.router)  # /v1/internal/onboarding/{org_id}/* (D.14 cold-start UX)
app.include_router(sql_query.router)  # /orgs/{org_id}/sql (Phase M read-only SQL executor)
app.include_router(compliance.router)  # /api/v1/me/* + /api/v1/dsar + /subprocessors (GDPR + CCPA)
app.include_router(qa_generator.router)  # /orgs/{org_id}/synthetic (Phase J synthetic Q/A generator)
app.include_router(redteam.router)  # /orgs/{org_id}/redteam (Phase L red-team probes)
app.include_router(labeling.router)  # /orgs/{org_id}/labeling (Phase D labeling queue)
app.include_router(signals.router)  # /orgs/{org_id}/signals (Phase Q plain-English signals)
app.include_router(debugger.router)  # /orgs/{org_id}/debugger (Phase P agent debugger)
app.include_router(datasets_spreadsheet.router)  # /orgs/{org_id}/datasets/{dataset_id} (Phase S spreadsheet)
app.include_router(prompts.router)  # /orgs/{org_id}/prompts (Phase I prompt management + playground)
app.include_router(prompts_v2.router)  # /orgs/{org_id}/prompts/* (D.9 versioning: /{name}/versions + /eval-runs)
app.include_router(pii_policy.router)  # /orgs/{org_id}/pii-policy
app.include_router(cost_overrides.router)  # /orgs/{org_id}/cost-overrides (per-tenant contract rates)  # /orgs/{org_id}/retention-policy
app.include_router(region.router)  # /orgs/{org_id}/region
app.include_router(experiments.router)  # /experiments (gated)
app.include_router(notifications.router)  # /notifications (user-scoped feed; June 2026 Cat 5 mount fix)
app.include_router(model_compare.router)  # /orgs/{org_id}/models/{compare,recommend,project} (Phase 7.6)
app.include_router(integrations_helicone.router)  # /integrations/helicone (gated)
app.include_router(intelligence_code_change.router)  # /orgs/{org_id}/intelligence/code-change (Cat 23, gated by intelligence_gap_v0)
# Intelligence gap surface — Cat 4/5/6/8/9/10/11/12/13/14/18/19/20/22
# All self-gate on `intelligence_gap_v0` via the per-router `dependencies=`
# list; this just makes them reachable when the flag is on.
app.include_router(agent_issues.router)  # /orgs/{org_id}/agent-issues (F28/F29, gated by agent_issues_v0)
app.include_router(fleet.router)  # /orgs/{org_id}/fleet (N05/D9, gated by fleet_health_v1)
app.include_router(agent_sessions.router)  # /orgs/{org_id}/agent-sessions (F23, gated by agent_sessions_v1)
app.include_router(change_impact.router)  # /orgs/{org_id}/change-impact (N04)
app.include_router(improve.router)  # /orgs/{org_id}/improve (N17 cockpit + F04 autofix)
app.include_router(learn.router)  # /orgs/{org_id}/{nudges,promotions,book,drift,...} (WS2)
app.include_router(production_eval.router)  # /orgs/{org_id}/production-eval/* (N03, gated)
app.include_router(compliance_pack.router)  # /orgs/{org_id}/compliance/* (N06, gated)
app.include_router(search_signals.router)  # /orgs/{org_id}/search/to-signal (N10)
app.include_router(tool_call_labels.router)  # /orgs/{org_id}/tool-calls/{span_id}/label (F21)
app.include_router(autonomy.router)  # /orgs/{org_id}/settings/autonomy (N22, gated by closed_loop_orchestrator_v1)
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

# ── Phase 2 audit (2026-06-23) — 18 routers that were defined but
# never mounted. Co-mounting them in a single block keeps the diff
# legible. Each module is self-gating (returns 503/404 when its
# feature flag is off) so this is safe in any environment.
#
# RBAC (custom roles + permissions) — fixes the /settings?tab=roles
# "RBAC migration may not be applied" error in the portal.
app.include_router(rbac.router)  # /orgs/{org_id}/roles
app.include_router(rbac.permissions_router)  # /orgs/{org_id}/permissions
# WebSocket — /ws/jobs/{job_id}/trace + /ws/jobs/{job_id}/logs
app.include_router(websocket.router)
# SSE live-tail (Phase 7.2) — /orgs/{org_id}/observability/sse/stream
# (prefix renamed in Phase 2 to avoid collision with observability.router)
app.include_router(observability_stream.router)
# Insights API (Phase 6.3) — /orgs/{org_id}/insights/...
app.include_router(insights.router)
# Judges (Phase 7.1b) — /orgs/{org_id}/observability/judges/...
app.include_router(judges.router)
# Alert replay/ack — /alerts/... (mounted at root, not under /orgs)
app.include_router(replay.router)
# Media blob storage (Phase 7.2a) — /orgs/{org_id}/media/{blob_id}
app.include_router(media.router)
# Data platform (Phase 5) — /orgs/{org_id}/data-platform/...
app.include_router(data_platform.router)
# Analytics v2 (Phase 8.2) — /orgs/{org_id}/analytics/{cohorts,funnel}
app.include_router(analytics_v2.router)
# Prompt canary management (Phase 7.2c/d) — /orgs/{org_id}/prompts/{agent}/canary
app.include_router(prompt_canary.router)
# Patterns (Phase 7.2 C5) — /orgs/{org_id}/observability/patterns/...
app.include_router(patterns.router)
# Support tickets + Discord webhook test — /support/tickets, /integrations/discord/test
app.include_router(support.router)
# 3rd-party observability integrations
app.include_router(integrations_langfuse.router)  # /integrations/langfuse
app.include_router(integrations_langsmith.router)  # /integrations/langsmith
app.include_router(integrations_wandb.router)  # /integrations/wandb
app.include_router(integrations_runloop.router)  # /integrations/runloop

# Onboarding wizard (June 2026) — GitHub App OAuth + per-org
# wizard state + integration PR runs. Two routers:
#   public: /integrations/github/{configured,authorize,callback,webhook}
#   org:    /orgs/{org_id}/{github,onboarding}/...
# Both gracefully degrade when GITHUB_APP_* env vars are unset
# (the wizard's "Connect GitHub" step renders a "Skip" fallback).
app.include_router(github_routes.public_router)
app.include_router(github_routes.org_router)

# Outbound webhooks (customer-facing CRUD + delivery + replay). Prefix
# /orgs/{org_id}/webhooks — no collision with the inbound clerk_webhooks
# router mounted above at /webhooks/clerk.
app.include_router(webhooks.router)  # /orgs/{org_id}/webhooks
# D.8 streaming tokens (per upgradespec §C.1)
app.include_router(streaming_tokens.router)  # /orgs/{org_id}/traces/{trace_id}/tokens
# Cat 23 agent PR suggestions — UI surface for in-portal code-change
# review. Prefix /orgs/{org_id}/agent/pr-suggestions — unique.
app.include_router(agent_pr_suggestions.router)  # /orgs/{org_id}/agent/pr-suggestions

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
    """Check system health.

    Phase 2 audit (2026-06-23) — return HTTP 503 when degraded so
    Northflank's ``httpHealthCheck`` actually restarts the container.
    The previous version always returned 200, which meant a broken
    Postgres connection (Neon project deleted, bad pool, etc.) would
    only be surfaced via the body, not the status code — Northflank
    keeps traffic pointed at a half-dead container. The
    ``HEALTH_PROBE_MODE`` setting lets operators force a 200 response
    (e.g. local dev with an in-memory db).
    """
    from fastapi.responses import JSONResponse

    kb_health = await kb_health_check()

    overall = "healthy" if (
        kb_health.get("postgres") == "connected" and
        kb_health.get("qdrant") == "connected"
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

    try:
        from eden.observability.quality_pipeline.worker import (
            is_worker_running,
        )

        worker_running = is_worker_running()
    except Exception:
        worker_running = False

    body = HealthResponse(
        status=overall,
        version=settings.app_version,
        postgres=pg,
        qdrant=kb_health.get("qdrant", "unknown"),
        quality_worker_running=worker_running,
    )

    # HEALH_PROBE_MODE controls the status code:
    #   "auto"  — 200 if healthy, 503 if degraded (production default)
    #   "200"   — always 200 (local dev / debug; lets you probe the body
    #             without tripping Northflank's restart loop)
    #   "503"   — always 503 (manual chaos testing)
    mode = getattr(settings, "health_probe_mode", "auto")
    if mode == "200":
        return body
    if mode == "503":
        return JSONResponse(status_code=503, content=body.model_dump())
    if overall == "healthy":
        return body
    return JSONResponse(status_code=503, content=body.model_dump())


def _get_sandbox_health() -> str:
    """Removed 2026-07-04 — sandbox subsystem retired."""
    return "removed"


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port)
