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
from eden.api.openapi_public import build_public_openapi_spec


def _init_sentry() -> None:
    """Initialize Sentry when a usable DSN is configured.

    Never crash the process on a bad/empty DSN. Northflank's
    ``eden-required`` secret group often has ``SENTRY_DSN`` set to an
    empty string or a placeholder without a scheme; sentry-sdk then
    raises ``BadDsn: Unsupported scheme ''`` at import time and the
    container exit-loops with ``no healthy upstream`` on the ingress
    (July 2026 production outage).
    """
    log = logging.getLogger(__name__)
    dsn = os.environ.get("SENTRY_DSN", "").strip()
    if not dsn:
        try:
            from eden.config import get_settings

            dsn = (get_settings().sentry_dsn or "").strip()
        except Exception:  # noqa: BLE001
            return
    if not dsn:
        return
    # Reject DSNs that cannot possibly work (empty scheme, missing
    # scheme, placeholder values). sentry-sdk's Dsn() parser raises
    # BadDsn for these; we short-circuit first so boot stays green.
    lowered = dsn.lower()
    if lowered in {"none", "null", "undefined", "your_sentry_dsn_here"}:
        log.warning("SENTRY_DSN looks like a placeholder (%r) — skipping Sentry init", dsn)
        return
    if "://" not in dsn:
        log.warning(
            "SENTRY_DSN missing scheme (got %r) — skipping Sentry init. "
            "Set a full https://…@….ingest.sentry.io/… DSN or leave the secret empty.",
            dsn[:48],
        )
        return
    scheme = dsn.split("://", 1)[0].strip()
    if not scheme:
        # Matches the production crash: BadDsn Unsupported scheme ''.
        # Northflank secret was set to a value like ``://…`` or otherwise
        # scheme-less after the separator.
        log.warning(
            "SENTRY_DSN has empty scheme (%r) — skipping Sentry init",
            dsn[:48],
        )
        return
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
        from sentry_sdk.utils import BadDsn
    except ImportError:
        log.warning("SENTRY_DSN set but sentry-sdk is not installed")
        return
    try:
        sentry_sdk.init(
            dsn=dsn,
            environment=os.environ.get("SENTRY_ENVIRONMENT", "development"),
            traces_sample_rate=float(
                os.environ.get("SENTRY_TRACES_SAMPLE_RATE", "0") or 0
            ),
            integrations=[
                StarletteIntegration(transaction_style="endpoint"),
                FastApiIntegration(transaction_style="endpoint"),
            ],
            send_default_pii=False,
        )
    except BadDsn as exc:
        log.error(
            "SENTRY_DSN is invalid (%s) — skipping Sentry init so the API can boot. "
            "Fix or clear the SENTRY_DSN secret in Northflank.",
            exc,
        )
    except Exception as exc:  # noqa: BLE001
        log.error("Sentry init failed (%s) — continuing without Sentry", exc)



_init_sentry()

from eden.api.routes import (
    admin_status,
    agent_issues,
    agent_sessions,
    agent_pr_suggestions,
    agents,
    ai_insights,
    analytics,
    analytics_v2,
    api_keys,
    app_events,
    audit,
    auth,
    autonomy,
    billing,
    browser_sessions,
    budgets,
    change_impact,
    clerk_webhooks,
    compliance,
    compliance_pack,
    cost,
    cost_overrides,
    data_platform,
    datasets_hub,
    datasets_spreadsheet,
    experiments_offline,
    debugger,
    export,
    export_destinations,
    feature_flags,
    finops,
    fleet,
    ingestion,
    ingest_agent_sessions,
    improve,
    insights,
    learn,
    integrations_langfuse,
    integrations_langsmith,
    integrations_runloop,
    integrations_status,
    integrations_wandb,
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
    playgrounds,
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
    signal_investigator,
    signal_classifiers,
    slack_interactive,
    topics,
    tool_call_labels,
    observability_live,
    mcp_keys,
    agentic_metrics,
    sql_query,
    wave6_online,
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
from eden.alerts import routes as nl_alerts_routes
from eden.config import get_settings
from eden.kb import health_check as kb_health_check
from eden.kb import initialize_kb
from eden.observability.metrics_endpoint import router as metrics_endpoint_router

logger = logging.getLogger(__name__)
settings = get_settings()

# B26 — intelligence_* routers are feature-flag gated and numpy-heavy.
# Defer import+include until lifespan (or explicit ``mount_deferred_routers``)
# so cold ``import eden.api.app`` does not pay for them. OpenAPI is complete
# once lifespan has run (uvicorn always does before accepting traffic).
_DEFERRED_INTELLIGENCE_ROUTERS: tuple[str, ...] = (
    "intelligence_agents",
    "intelligence_apm_depth",
    "intelligence_autonomous",
    "intelligence_closed_loop",
    "intelligence_columnar",
    "intelligence_cost",
    "intelligence_dsl",
    "intelligence_eval",
    "intelligence_experiments",
    "intelligence_governance",
    "intelligence_guardrails",
    "intelligence_memory",
    "intelligence_metric_studio",
    "intelligence_outcomes",
    "intelligence_predictive",
    "intelligence_rca",
    "intelligence_replay",
    "intelligence_retrieval",
    "intelligence_time_travel",
    "intelligence_tools",
    "intelligence_user",
)


def mount_deferred_routers(application: FastAPI | None = None) -> int:
    """Import and include B26 deferred intelligence routers. Idempotent.

    Returns the number of routers newly mounted (0 if already mounted).
    """
    import importlib

    target = application if application is not None else app
    if getattr(target.state, "_b26_deferred_mounted", False):
        return 0
    mounted = 0
    for name in _DEFERRED_INTELLIGENCE_ROUTERS:
        mod = importlib.import_module(f"eden.api.routes.{name}")
        target.include_router(mod.router)
        mounted += 1
    target.state._b26_deferred_mounted = True
    # Invalidate any cached OpenAPI so deferred paths appear.
    target.openapi_schema = None
    return mounted


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
    statgate_installed: bool = False
    evolution_loop_running: bool = False
    # False on API when workers run on ``eden-worker``; then
    # ``quality_worker_running`` / ``evolution_loop_running`` being
    # false is expected for this process, not a crash signal.
    background_workers_expected: bool = False


# ============================================================================
# Lifespan
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    import asyncio

    logger.info("Starting Eden API...")

    # B26 — mount deferred intelligence routers before accepting traffic
    # so OpenAPI and route tables are complete for the first request.
    try:
        n = mount_deferred_routers(app)
        if n:
            logger.info("B26: mounted %s deferred intelligence routers", n)
    except Exception as exc:  # noqa: BLE001
        logger.error("B26: deferred router mount failed: %s", exc)
        if settings.eden_production or settings.strict_startup_checks:
            raise

    # Schema must lead code on every deploy. Production uses the
    # dedicated ``eden-migrate`` init job (SKIP_MIGRATIONS=1 on API).
    try:
        from eden.db_migrations.runner import run_alembic_upgrade_head

        await asyncio.to_thread(run_alembic_upgrade_head)
    except Exception as exc:
        logger.error("Alembic upgrade failed at startup: %s", exc)
        if settings.eden_production or settings.strict_startup_checks:
            raise

    # Phase 1 — fail-closed dependency probes (Postgres, Redis, Qdrant,
    # OpenRouter). Results are stored on app.state for /ready.
    from eden.api.startup_checks import StartupCheckError, run_startup_checks

    try:
        from eden.api.startup_checks import is_ready

        app.state.startup_checks = await run_startup_checks(settings=settings)
        # Ready when required deps (Postgres) are up — soft failures
        # (Redis / Qdrant / OpenRouter) must not black-hole the LB.
        app.state.ready = is_ready(app.state.startup_checks)
    except StartupCheckError:
        app.state.startup_checks = {}
        app.state.ready = False
        if settings.strict_startup_checks:
            raise

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
        if settings.eden_production or settings.strict_startup_checks:
            raise
        logger.warning(f"KB initialization warning: {e}")

    # N14 — StatGate / Cat 15/17/22 wiring on every API pod (idempotent).
    # Worker start remains leader-gated in background workers below.
    try:
        from eden.observability.trace_quality.wiring import install_all

        install_all()
        logger.info("N14: trace_quality install_all completed")
    except Exception as e:
        logger.warning("N14: trace_quality install_all skipped: %s", e)

    # Phase 1 — background loops are gated by EDEN_RUN_BACKGROUND_WORKERS.
    # When enabled, a Redis leader lock ensures only one API replica runs
    # the singleton tasks (insights, anomaly, evolution, consumers, etc.).
    background_workers = False
    if getattr(settings, "run_background_workers", False):
        try:
            from eden.workers.background import start_background_workers

            await start_background_workers(settings)
            background_workers = True
            logger.info("Background workers started (leader-gated)")
        except Exception as e:
            logger.warning(f"Background workers startup skipped: {e}")

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
    if background_workers:
        try:
            from eden.workers.background import stop_background_workers

            await stop_background_workers()
        except Exception as e:  # pragma: no cover - defensive
            logger.warning(f"Background workers stop failed: {e}")

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
        "X-Org-Id",
        "X-Org-Api-Key",
        "Idempotency-Key",
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

# IdempotencyMiddleware — optional ``Idempotency-Key`` dedupe for
# mutating ``/v1/*`` requests. Mounted behind
# ``idempotency_middleware_enabled`` (default True). Requests without
# the header pass through; with the header, Redis + Postgres cache
# the first successful response for 24h.
if getattr(settings, "idempotency_middleware_enabled", True):
    from eden.api.middleware.idempotency import IdempotencyMiddleware

    app.add_middleware(IdempotencyMiddleware)

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
app.include_router(admin_status.router)  # F84 /orgs/{org_id}/admin/eden-status
app.include_router(kb.router)
app.include_router(auth.router)
app.include_router(clerk_webhooks.router)  # /webhooks/clerk
app.include_router(audit.router)  # /orgs/{org_id}/audit-log
app.include_router(orgs.router)
app.include_router(references.router)
app.include_router(api_keys.router)
app.include_router(billing.router)  # /orgs/{org_id}/billing
app.include_router(budgets.router)  # /orgs/{org_id}/budget + /budget/ticker + /budget/actions (D.10 cost guardrails)
app.include_router(finops.router)  # /orgs/{org_id}/finops/{explorer,export,kill-switches} (SOTA W8)
app.include_router(cost.router)  # /orgs/{org_id}/cost/comparison (Cat 23 audit)
app.include_router(analytics.router)  # /orgs/{org_id}/analytics
app.include_router(export.router)  # /orgs/{org_id}/export
app.include_router(export_destinations.router)  # /orgs/{org_id}/export/{destinations,schedules,run-now}
app.include_router(ingestion.router)  # /orgs/{org_id}/ingest (multi-format observability ingestion)
app.include_router(ingest_agent_sessions.router)  # /orgs/{org_id}/ingest/agent-sessions (F23 SDK, X-Org-Api-Key)
app.include_router(observability.ingest_router)  # /orgs/{org_id}/observability/telemetry/ingest* (API key)
app.include_router(observability.router)  # /orgs/{org_id}/observability/{traces,summary,spans/search,...}
app.include_router(agents.router)  # /orgs/{org_id}/agents (Phase 2 surface — list + register + get)
app.include_router(llmops.router)  # /orgs/{org_id}/llmops/{artifacts,prompts,ab-tests,experiments,gateway,monitoring,cache}
app.include_router(trace_quality.router)  # /v1/traces/{trace_id}/{loops,quality,intervention,...} (Cat 22 trace quality)
app.include_router(observability_mcp.router)  # /v1/traces/{id}/mcp + /v1/mcp/{org}/auth_failures (D.12.1)
from eden.mcp_server.http_transport import router as mcp_http_router

app.include_router(mcp_http_router)  # W28 Streamable HTTP MCP at /v1/mcp
app.include_router(observability_a2a.router)  # /v1/traces/{id}/a2a + /v1/a2a/{org}/links + invocation graph (D.12.2)
app.include_router(observability_computer_use.router)  # /v1/traces/{id}/computer_use + /v1/computer_use/{org}/steps (D.12.3)
app.include_router(observability_voice.router)  # /v1/voice_sessions + /v1/traces/{id}/voice_sessions (D.12.4)
app.include_router(observability_fine_tune.router)  # /v1/fine_tuning_runs + lineage (D.12.5)
app.include_router(observability_fine_tune.webhook_router)  # /v1/webhooks/openai/fine_tuning (D.12.5, R-12)
app.include_router(observability_provider_routing.router)  # /v1/provider_routing/{org}/{attempts,failure_rate} (D.12.6)
app.include_router(internal_health.router)  # /v1/internal/health/* — ops dashboard (Phase 4 B3 §9.6)
app.include_router(optimization.router)  # /orgs/{org_id}/optimization/{overview,costs,savings,cache,budget,}
app.include_router(app_events.router)  # /orgs/{org_id}/ingest/app (Phase A1 app/site events)
app.include_router(scim.router)  # /orgs/{org_id}/scim/v2
app.include_router(sso.router)  # /sso
app.include_router(ai_insights.router)  # /orgs/{org_id}/ai-insights
app.include_router(sidebar_prefs.router)  # /orgs/{org_id}/sidebar-prefs (per-user UI prefs)
# W20: Phase-C dual ``/ai`` surface unmounted — ChatSidebar + ai-insights only.
# ai_agent module kept for ``_sse_format`` / unit helpers; do not remount.
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
app.include_router(nl_alerts_routes.router)  # F81 NL alerts compile + rules
app.include_router(debugger.router)  # /orgs/{org_id}/debugger (Phase P agent debugger)
app.include_router(browser_sessions.router)  # F09 browser recording
app.include_router(datasets_hub.router)  # /orgs/{org_id}/datasets (F53 hub list/create)
app.include_router(datasets_spreadsheet.router)  # /orgs/{org_id}/datasets/{dataset_id} (Phase S spreadsheet)
app.include_router(experiments_offline.router)  # /orgs/{org_id}/experiments/offline (F51)
app.include_router(playgrounds.router)  # /orgs/{org_id}/playgrounds (W18 U03/F49)
# prompts_v2 first: FastAPI first-match wins. D.9 owns GET/POST "" and
# GET /{name}; Phase I keeps PATCH, playground, rollback, etc.
app.include_router(prompts_v2.router)  # /orgs/{org_id}/prompts (D.9 list/create/get + versions)
app.include_router(prompts.router)  # /orgs/{org_id}/prompts (Phase I playground/rollback; shadowed list/create/get)
app.include_router(pii_policy.router)  # /orgs/{org_id}/pii-policy
app.include_router(cost_overrides.router)  # /orgs/{org_id}/cost-overrides (per-tenant contract rates)  # /orgs/{org_id}/retention-policy
app.include_router(region.router)  # /orgs/{org_id}/region
app.include_router(notifications.router)  # /notifications (user-scoped feed; June 2026 Cat 5 mount fix)
app.include_router(model_compare.router)  # /orgs/{org_id}/models/{compare,recommend,project} (Phase 7.6)
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
app.include_router(wave6_online.router)  # Phase 5 Wave 6: F52-F79, F54-F68, F76, N15
app.include_router(compliance_pack.router)  # /orgs/{org_id}/compliance/* (N06, gated)
app.include_router(search_signals.router)  # /orgs/{org_id}/search/to-signal (N10)
app.include_router(signal_investigator.router)  # F06 clusters + backfill
app.include_router(signal_classifiers.router)  # F34 classifiers
app.include_router(topics.router)  # F65 topics
app.include_router(slack_interactive.router)  # F71 Slack bot
app.include_router(tool_call_labels.router)  # /orgs/{org_id}/tool-calls/{span_id}/label (F21)
app.include_router(observability_live.router)  # /orgs/{org_id}/stream/traces/* (N11 live)
app.include_router(mcp_keys.router)  # /orgs/{org_id}/mcp/keys (W28)
app.include_router(agentic_metrics.router)  # F64 agentic metrics pack
app.include_router(autonomy.router)  # /orgs/{org_id}/settings/autonomy (N22, gated by closed_loop_orchestrator_v1)
# B26: intelligence_* routers mounted via mount_deferred_routers() in lifespan
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
# Alert replay/ack — /orgs/{org_id}/alerts/... (path-scoped, auth via resolve_path_org_access)
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
app.include_router(integrations_status.router)  # /orgs/{org_id}/integrations/status

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
# Retired Cat 23 routes (N23 replacement)
# ============================================================================

_CODE_CHANGE_GONE_DETAIL = (
    "Cat 23 `/orgs/{org_id}/intelligence/code-change/*` retired 2026-07-15; "
    "use `/orgs/{org_id}/improve/plans` (N23 recurring improvement agent)."
)


@app.api_route(
    "/orgs/{org_id}/intelligence/code-change",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    include_in_schema=False,
)
@app.api_route(
    "/orgs/{org_id}/intelligence/code-change/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    include_in_schema=False,
)
async def intelligence_code_change_gone(org_id: str, path: str = "") -> JSONResponse:
    """Return 410 Gone for removed Cat 23 intelligence/code-change surface."""
    return JSONResponse(
        status_code=410,
        content={"detail": _CODE_CHANGE_GONE_DETAIL.format(org_id=org_id)},
    )


# ============================================================================
# Public OpenAPI (customer contract)
# ============================================================================


@app.get("/openapi/v1/public.json", include_in_schema=False)
async def public_openapi_spec() -> dict:
    """Customer-facing OpenAPI document (no auth required)."""
    return build_public_openapi_spec(app.openapi())


# ============================================================================
# Health Check
# ============================================================================

@app.get("/live")
async def liveness_probe():
    """Kubernetes liveness probe — process is up."""
    return {"status": "alive", "version": settings.app_version}


@app.get("/ready")
async def readiness_probe(request: Request):
    """Load-balancer readiness probe — required deps are reachable.

    July 2026: readiness is gated on Postgres only (see
    ``REQUIRED_FOR_READY``). Soft deps (Redis / Qdrant / OpenRouter)
    still appear under ``checks`` so operators can see degradation,
    but a Redis blip must not pull the pod out of the Northflank
    pool — that previously surfaced as portal 503s with
    ``detail: no healthy upstream`` on every ``/auth/me`` call.
    """
    from fastapi.responses import JSONResponse

    from eden.api.startup_checks import is_ready, run_startup_checks

    checks = getattr(request.app.state, "startup_checks", None)
    if checks is None:
        checks = await run_startup_checks(settings=settings, strict=False)
        request.app.state.startup_checks = checks
        request.app.state.ready = is_ready(checks)

    ready = bool(getattr(request.app.state, "ready", False)) or is_ready(checks)

    body = {
        "status": "ready" if ready else "not_ready",
        "version": settings.app_version,
        "checks": checks,
    }
    if ready:
        return body
    return JSONResponse(status_code=503, content=body)


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Detailed system health for monitors and the portal badge.

    Soft deps (Qdrant, quality worker) mark the body ``degraded`` and,
    in ``auto`` mode, return HTTP 503 so monitors can alert. This is
    intentional and is **not** the ingress readiness probe — use
    ``/ready`` for that (Postgres-only). ``HEALTH_PROBE_MODE=200``
    forces a 200 so local/dev probes can read the body without
    tripping restart loops.
    """
    from fastapi.responses import JSONResponse

    from eden.api.startup_checks import health_probe_http_status

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

    try:
        from eden.observability.platform_activation import is_statgate_installed

        statgate_installed = is_statgate_installed()
    except Exception:
        statgate_installed = False

    evolution_loop_running = False
    try:
        from eden.agents.evolution.loop import is_evolution_loop_running

        evolution_loop_running = is_evolution_loop_running()
    except Exception:
        pass

    # Degrade /health when the quality worker is expected on this process
    # (trace_quality_worker_enabled=true AND we are the background leader)
    # but the worker task has died or never started. Non-leader replicas skip
    # this check — they never own the worker so is_worker_running() is always
    # False for them, which is correct.
    if overall == "healthy":
        try:
            from eden.workers.background import background_workers_running
            if (
                getattr(settings, "trace_quality_worker_enabled", True)
                and background_workers_running()
                and not worker_running
            ):
                overall = "degraded"
        except Exception:
            pass

    body = HealthResponse(
        status=overall,
        version=settings.app_version,
        postgres=pg,
        qdrant=kb_health.get("qdrant", "unknown"),
        quality_worker_running=worker_running,
        statgate_installed=statgate_installed,
        evolution_loop_running=evolution_loop_running,
        background_workers_expected=bool(
            getattr(settings, "run_background_workers", False)
        ),
    )

    mode = getattr(settings, "health_probe_mode", "auto")
    status_code = health_probe_http_status(overall, mode)
    if status_code == 200:
        return body
    return JSONResponse(status_code=status_code, content=body.model_dump())


def _get_sandbox_health() -> str:
    """Removed 2026-07-04 — sandbox subsystem retired."""
    return "removed"


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port)
