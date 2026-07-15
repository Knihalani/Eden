"""Eden configuration.

Audit 2026-07-06 v3 — ``Settings`` is lazy-loaded via PEP 562.

Prior: importing ``eden.config`` eagerly loaded ``pydantic``
(~50ms) and ``pydantic_settings`` (~114ms). With 67 modules
doing ``from eden.config import get_settings`` at module load,
the ~114ms ``pydantic_settings`` cost was paid on every
``from eden.api.app import app`` cold import and every test
setup.

Post-fix:
  * Module-level imports only ``logging``, ``lru_cache``, and
    ``pathlib`` from stdlib. Pydantic is deferred.
  * The ``Settings`` class is built on first ``get_settings()``
    call (or first ``from eden.config import Settings``).
  * ``from eden.config import get_settings`` still resolves
    (PEP 562).
  * Same ``@lru_cache`` memoisation.
"""

import logging
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)

# Module-level cache for the lazily-built Settings class.
_settings_class = None


def _build_settings_class():
    """Build and return the Settings class (lazy, PEP 562).

    Pydantic + pydantic_settings are imported inside this function
    so the ~114ms cold-import cost is paid only on first access.
    Caches the built class in module globals.
    """
    global _settings_class
    if _settings_class is not None:
        return _settings_class
    from pydantic import AliasChoices, Field, field_validator  # noqa: F401
    from pydantic_settings import BaseSettings, SettingsConfigDict

    class Settings(BaseSettings):
        """Eden environment configuration."""

        model_config = SettingsConfigDict(
            env_file=".env",
            env_file_encoding="utf-8",
            case_sensitive=False,
            extra="ignore",  # don't blow up on unrelated env vars from other tools
        )

        # Application
        app_name: str = "Eden"
        app_version: str = "0.1.0"
        debug: bool = False

        # Production readiness (Phase 1 backend foundation)
        # ``eden_production`` enables fail-closed startup checks and
        # stricter KB init. ``run_background_workers`` gates whether the
        # API process hosts in-process background loops (off when a
        # dedicated ``eden-worker`` job is deployed).
        eden_production: bool = False
        run_background_workers: bool = True
        strict_startup_checks: bool = False
        eden_upload_dir: str = "/tmp/eden-uploads"
        avatar_storage_backend: str = "local"  # "local" | "s3"
        avatar_s3_bucket: str = ""
        avatar_public_base_url: str = ""

        # Server
        host: str = "0.0.0.0"
        port: int = 8000

        # CORS — read by ``api/app.py::_cors_origins_list`` (Phase 2 audit).
        # Phase 1 left the field undeclared on Settings; the app fell back to
        # ``getattr(settings, "cors_origins_raw", "")`` which silently produced
        # an empty allow-list in prod. Set ``CORS_ORIGINS_RAW`` to a CSV
        # list of allowed portal origins (e.g. ``https://edenobservability.com``)
        # in the Northflank env block.
        cors_origins_raw: str = ""

        # /health probe override — when set, /health returns this status code
        # (200 healthy / 503 degraded). Defaults to "auto" which derives the
        # code from the postgres + qdrant + sandbox probes. Set to "200" in
        # environments where Northflank restarts aren't safe (e.g. local dev).
        health_probe_mode: str = "auto"

        # PostgreSQL
        postgres_host: str = "localhost"
        postgres_port: int = 5432
        postgres_db: str = "eden"
        postgres_user: str = "eden"
        postgres_password: str = ""
        # Quota enforcement (DL-14 Fail-closed) gates mutating routes. The
        # middleware reads this flag at request time; False bypasses the
        # snapshot fetch and defers to the route handler. Tests set this to
        # False because seeding org_resource_limits across every fixture is
        # impractical; production keeps it True.
        quota_enabled: bool = True
        # Defaults are deliberately conservative (20/5 = ~80 conns across
        # the API + 2 jobs + worker). The Northflank manifest overrides
        # down to 10/2 per container; PostgresClient honours these.
        postgres_pool_size: int = 20
        # Audit 2026-07-02 — default to 0 so the pool starts empty and
        # Neon's auto-suspend can fire during idle periods. Operators who
        # need a warm pool (e.g. to absorb a burst at startup) override
        # via ``POSTGRES_MIN_POOL_SIZE`` in the Northflank manifest. The
        # 5-connection default from earlier shipped 5 warm sockets
        # forever, which kept Neon running 24/7.
        postgres_min_pool_size: int = 0
        # Server-side ``statement_timeout`` cap, applied to every pooled
        # connection via ``SET statement_timeout`` in the pool's init
        # callback. 30 s matches the previous hardcoded value; override
        # with ``POSTGRES_STATEMENT_TIMEOUT_MS`` in the deployment manifest
        # (useful for tightening on dev or relaxing for heavy ETL).
        postgres_statement_timeout_ms: int = 30_000
        # ``idle_in_transaction_session_timeout`` — auto-kills connections
        # that have been sitting in a transaction without running a query
        # for longer than this. The default (60 s) catches the "developer
        # opened a tx in psql and went to lunch" + the "app crashed mid-tx
        # and the connection sits open holding locks" failure modes, both
        # of which silently burn Neon CU until the connection times out
        # at the TCP layer (potentially hours). 60 s is aggressive enough
        # to keep Neon cheap without breaking long ETL jobs that
        # legitimately hold a tx open — those run on a dedicated
        # connection with a custom ``statement_timeout``.
        postgres_idle_in_transaction_timeout_ms: int = 60_000

        # Qdrant
        qdrant_host: str = "localhost"
        qdrant_port: int = 6333
        qdrant_collection_prefix: str = "eden_"
        # Qdrant Cloud (or any TLS-terminated upstream) needs HTTPS + API key.
        # ``qdrant_api_key`` maps to env var ``QDRANT_API_KEY`` (the qdrant-client
        # Python lib also reads ``QDRANT_API_KEY`` natively, but we plumb it
        # through Settings so the rest of the app can read the same value).
        qdrant_https: bool = False
        qdrant_api_key: str = ""

        @field_validator("qdrant_host", mode="before")
        @classmethod
        def _normalize_qdrant_host(cls, v: object) -> object:
            """Strip accidental https:// prefix from QDRANT_HOST."""
            if isinstance(v, str):
                for prefix in ("https://", "http://"):
                    if v.startswith(prefix):
                        v = v[len(prefix) :]
                return v.rstrip("/")
            return v

        # Typesense — full-text search across spans (Phase B).
        # TYPESENSE_API_KEY is required and must match docker-compose.yml.
        # If the host is unreachable at startup the search layer falls back
        # to a no-op stub so the rest of the app keeps working.
        typesense_host: str = "localhost"
        typesense_port: int = 8108
        typesense_api_key: str = ""
        typesense_protocol: str = "http"
        typesense_collection: str = "eden_spans"
        typesense_enabled: bool = True
        typesense_search_v1: bool = True

        # Feature flags — gates the per-Cat intelligence surface.
        # The Cat 1-23 wiring tests flip these via monkeypatch; see
        # ``tests/intelligence/test_intelligence_gap_stubs.py``.
        #
        # Both default to **True** so the Cat 23 + Cat 14 surfaces are
        # accessible out-of-the-box. Users are informed during
        # /onboarding that these features are active and can opt
        # out per-org via the Settings page (or per-deploy by
        # setting the env var to "false" in the Northflank env).
        intelligence_gap_v0: bool = True
        # Cat 14 (autonomous) destructive-action flag. The
        # ``/heal``, ``/heal/{id}/approve``, ``/heal/{id}/deny`` routes
        # require this + the per-action two-stage opt-in. Default
        # true so the recommendations + SelfHealer queue are
        # reachable; the human-approval gate is what actually
        # blocks the side-effect.
        autonomous_actions_v0: bool = True
        experiments_v1: bool = False

        # F03 — checkpoint ingest + prefix cache.
        # ``debugger_checkpoint_ingest_v1``: default True so new orgs
        # populate debugger_llm_cache automatically. Set to false to
        # disable the prefix-cache upsert path without touching the
        # CheckpointStore audit trail (which is always written).
        # ``debugger_checkpoint_backfill_v1``: default False — gates the
        # scripts/backfill_checkpoints.py one-shot script. Enable
        # explicitly before running the backfill job.
        debugger_checkpoint_ingest_v1: bool = True
        debugger_checkpoint_backfill_v1: bool = False

        # Cat 23 Code-Change two-stage opt-in (see eden/code_change/approvals).
        # ``code_change_enabled`` is the master switch — the patch propose
        # route refuses every request when this is false. ``auto_pr_enabled``
        # and ``auto_revert_enabled`` are the second stage; both are required
        # for any auto side-effect (PR creation, revert). All three default
        # to ``False`` so a fresh deployment cannot accidentally mutate code.
        code_change_enabled: bool = False
        auto_pr_enabled: bool = False
        auto_revert_enabled: bool = False

        # N23 — recurring improvement agent (replaces Cat 23 inbox).
        improvement_agent_v1: bool = False
        improvement_schedule_enabled: bool = False

        # ── Cat 23 Phase 3b: quality gates (scheduler, critic, cost cap) ─
        # These knobs are read by ``eden.patches.patch_generator.PatchGenerator``
        # (critic loop + size validation) and the N23 improvement sweep.
        # The per-org overrides live on
        # ``organizations.features->'code_change_policy'``; these env-level
        # values are the global defaults that the policy service falls back
        # to when an org hasn't set its own. Defaults are conservative
        # — a fresh deploy should not be able to fan out 1000 patches in a
        # flood even if every other gate is open.
        #
        # ``max_cost_per_user_per_day`` — hard cap on total LLM spend the
        # autonomous PR pipeline can rack up per org per day. The scheduler
        # circuit-breaks when the SUM(cost_usd) of generated proposed_patches
        # in the last 24h exceeds this. $50/day covers ~150 T2 patches at
        # $0.30 each (per the Phase 3b cost table in the plan).
        max_cost_per_user_per_day: float = 50.0
        # Minimum number of traces that must cluster together on the same
        # RCA signature before the scheduler will generate a patch. Prevents
        # one-off flukes from triggering an autonomous PR. ``IncidentClusterer``
        # already defaults to 3; this knob just exposes it to env-level config.
        patch_cluster_min_size: int = 3
        # Soft + hard caps on lines changed per diff. 200 lines is the
        # soft cap — patches this size generate normally. 500 lines is the
        # hard cap — anything bigger returns an "investigation" envelope and
        # never writes a proposed_patches row. The hard cap prevents the
        # agent from auto-opening architectural-scale PRs.
        patch_max_diff_lines_soft: int = 200
        patch_max_diff_lines_hard: int = 500
        # ``patch_quality_floor`` — minimum overall quality_score (0-1)
        # required for a generated patch to be queued for human review.
        # Patches below this threshold are inserted into proposed_patches
        # with status='low_quality' so a human can still see them, but
        # the inbox does not notify the on-call.
        patch_quality_floor: float = 0.8
        # Daily + weekly ceilings on the total number of proposed_patches
        # rows generated per org. The scheduler returns early when either
        # is hit. Distinct from the auto-approval rate limiter (which is
        # post-generation); these caps stop generation itself.
        patch_max_per_day: int = 10
        patch_max_per_week: int = 30
        # ``patch_similarity_threshold`` (0.0-1.0) — when a freshly-generated
        # diff has ``difflib.SequenceMatcher.ratio() > threshold`` against
        # any proposed_patches row from the last 14 days, the new patch is
        # dropped as a duplicate. 0.85 catches structural duplicates
        # (same fix) while allowing evolved variants (different fix).
        patch_similarity_threshold: float = 0.85
        # Lookback windows (overridable per-deploy; the default 14d is
        # what the dedup check uses).
        patch_similarity_lookback_days: int = 14
        patch_rejection_memory_wontfix_days: int = 30
        patch_rejection_memory_user_fixed_days: int = 90
        # Cron scheduler cadence — the eden-cron Northflank job ticks
        # every 5 min but the heavy Cat 23 evaluator runs at this cadence.
        # Default 15 min matches the Phase 3b plan ("15-min cron tick").
        scheduler_tick_seconds: int = 900

        # Phase C — unified AI agent (Cat 14 real + global panel).
        # The agent uses the ModelRouter T3 tier (x-ai/grok-4.5 primary).
        # Override via AI_AGENT_T3_MODEL when set. ``max_turns`` caps the
        # ReAct loop so a runaway query can't burn an unlimited number of
        # LLM calls. The retention window controls how long persisted
        # conversations live before a separate retention job prunes them.
        ai_agent_enabled: bool = True
        ai_agent_max_turns: int = 10
        ai_agent_t3_model: str = ""  # blank → use ModelTier.T3 default
        ai_agent_stream_chunk_ms: int = 50  # SSE chunk flush cadence
        ai_agent_retention_days: int = 90
        # DL-15: when True, the ChatService uses the OpenRouter
        # ``usage.cost`` field for budget tracking instead of the
        # per-token estimate. Off by default per C-5 rollout guidance.
        ai_agent_real_cost: bool = False
        # DL-10: hard cap on the ChatService gateway's request
        # ``max_tokens`` parameter. The OpenRouter upstream caps at
        # 4096 by default; set to 0 to disable the cap. The test
        # suite asserts the default is 4096 (Phase C-7 rollback
        # preserves the original OpenRouter limit).
        gateway_max_tokens_cap: int = 4096

        # Phase R — stdlib ``logging`` shim (Logfire-style 5-min
        # time-to-first-log). When the user calls ``eden.install()`` (or
        # ``eden.install_logging()``) the EdenLoggingHandler is attached
        # to the root logger and every ``logging.info("...")`` call from
        # the user's app + any 3rd-party library becomes a
        # ``TelemetryEvent(event_type="log")`` in the pipeline.
        # ``eden_log_level`` sets the minimum level captured. Default
        # INFO so WARNING/ERROR/CRITICAL are always captured.
        eden_log_level: str = "INFO"
        eden_log_project: str = "default"
        eden_log_agent_id: str = ""  # optional cross-ref to an agent
        eden_log_realm: str = "production"  # "production" | "environment"

        # OpenRouter
        openrouter_api_key: str = ""
        openrouter_base_url: str = "https://openrouter.ai/api/v1"

        # MiniMax — alternate upstream (Eden's primary model provider in v1+).
        # Routes check ``use_minimax`` first and fall back to ``openrouter_api_key``
        # when the MiniMax key is missing/disabled.
        use_minimax: bool = False
        minimax_api_key: str = ""
        minimax_base_url: str = "https://api.minimax.io/v1"
        minimax_model: str = "MiniMax-M3"

        # Token budgets per agent
        max_tokens_planner: int = 50000
        max_tokens_critic: int = 30000
        max_tokens_refiner: int = 25000
        max_tokens_fact_checker: int = 25000
        max_tokens_executor: int = 15000
        max_tokens_optimizer: int = 15000
        max_tokens_code_quality: int = 10000
        max_tokens_verifier: int = 10000
        max_tokens_tester: int = 10000
        max_tokens_adversarial_tester: int = 15000
        max_tokens_archivist: int = 60000

        # Max turns per agent
        max_turns_planner: int = 8
        max_turns_critic: int = 6
        max_turns_refiner: int = 5
        max_turns_fact_checker: int = 4
        max_turns_executor: int = 6
        max_turns_optimizer: int = 4
        max_turns_code_quality: int = 4
        max_turns_verifier: int = 3
        max_turns_tester: int = 5
        max_turns_adversarial_tester: int = 5
        max_turns_archivist: int = 20

        # Retry configuration
        max_retries: int = 3
        retry_min_wait: int = 1
        retry_max_wait: int = 60
        circuit_breaker_threshold: int = 5
        circuit_breaker_timeout: int = 60

        # LangGraph
        checkpoint_enabled: bool = True
        interrupt_before_archivist: bool = True
        interrupt_before_human_review: bool = True

        # JWT Authentication
        jwt_secret: str = "change-me-in-production"
        # Optional secondary key accepted during a rotation window. When
        # set, ``decode_access_token`` will accept tokens signed with
        # either the primary or this previous key. Tokens issued with
        # the old key remain valid until natural expiry; new tokens are
        # always signed with the primary. Clear this after the rotation
        # window to fully cut over.
        jwt_secret_previous: str = ""
        # 24h absolute lifetime — serves as the absolute session timeout
        # regardless of activity. Idle timeout is enforced at
        # ``get_current_user`` via a sliding last_seen_at window
        # (see migration 079). 24h is short enough that a leaked cookie
        # is useful for at most a day; long enough that an active user
        # never sees an unexpected logout.
        jwt_exp_days: int = 1
        # Optional JWT aud / iss claim support (opt-in). The auth helpers
        # check for non-empty strings before adding them to the token;
        # leaving them empty preserves the original behaviour. See
        # ``src/eden/api/utils/auth.py``.
        jwt_audience: str = ""
        jwt_issuer: str = ""

        # Clerk (portal auth provider, June 2026 cutover)
        # When ``clerk_secret_key`` is set, the API accepts Clerk session
        # JWTs in the ``Authorization: Bearer`` header. When empty, Clerk
        # verification is skipped and only Eden-issued cookie JWTs are
        # accepted (legacy behaviour for the CLI / SDK / service-to-service).
        # The JWKS URL is auto-derived from the publishable key when the
        # secret is set; override via ``clerk_jwks_url`` for non-default
        # Clerk deployments (EU region, custom domain).
        #
        # ``AliasChoices`` accepts both the canonical uppercase-underscore
        # env var (``CLERK_SECRET_KEY``) and the hyphenated name
        # Northflank uses for the existing secret (``CLERK-SECRET-KEY``).
        # pydantic-settings is case-insensitive but does NOT auto-convert
        # hyphens to underscores, so we have to declare both explicitly.
        clerk_secret_key: str = Field(
            default="",
            validation_alias=AliasChoices(
                "clerk_secret_key",
                "CLERK-SECRET-KEY",
                "clerk-secret-key",
            ),
        )
        clerk_jwt_key: str = ""  # asymmetric public key fallback (PEM)
        clerk_jwks_url: str = ""
        # Publishable key — only used server-side to auto-derive the
        # JWKS URL when ``clerk_jwks_url`` isn't set. Safe to keep here:
        # publishable keys are intentionally public; we just don't want
        # to expose them via ``NEXT_PUBLIC_*`` because we don't need
        # them in the browser bundle.
        clerk_publishable_key: str = ""
        # Svix signing secret used to verify Clerk webhook deliveries.
        # When empty, ``POST /webhooks/clerk`` rejects every request with
        # 503. Set this in Vercel / Northflank as ``CLERK_WEBHOOK_SIGNING_SECRET``
        # (canonical uppercase-underscore) or, in the existing Northflank
        # deployment, as the hyphenated ``clerk-webhook-signing-secret``
        # that was used at creation time. ``AliasChoices`` accepts both
        # so a stale ``clerk-webhook-signing-secret`` secret still works
        # without forcing an NF rename.
        clerk_webhook_signing_secret: str = Field(
            default="",
            validation_alias=AliasChoices(
                "clerk_webhook_signing_secret",
                "CLERK_WEBHOOK_SIGNING_SECRET",
                "clerk-webhook-signing-secret",
                "CLERK_WEBHOOK-SIGNING-SECRET",
            ),
        )

        # Encryption (Fernet key for sensitive at-rest fields).
        # If empty, falls back to deriving a key from JWT_SECRET.
        encryption_key: str = ""

        # Stripe
        stripe_secret_key: str = ""
        stripe_webhook_secret: str = ""

        # Email (SendGrid)
        sendgrid_api_key: str = ""
        sendgrid_from_email: str = "noreply@eden.ai"
        sendgrid_from_name: str = "Eden"

        # Postgres (Neon) — SSL config for the cutover
        # When ``postgres_sslmode`` is empty (the dev default), the
        # connection builder in ``db_migrations/env.py`` falls back to a
        # plain ``postgresql://`` DSN. Set to ``require`` (or ``verify-full``)
        # for managed providers (Neon, RDS, Aurora, Cloud SQL) which all
        # require SSL. ``postgres_channel_binding`` is Neon-specific;
        # asyncpg's scram-sha-256 SSL handshake is the equivalent — the
        # field is kept for libpq-style connections.
        # ``database_url`` is a full-URL override. When non-empty, it
        # takes precedence over the individual ``POSTGRES_*`` vars — useful
        # for PgBouncer pools, Neon endpoints with non-standard SSL, etc.
        database_url: str = ""
        postgres_sslmode: str = ""
        postgres_channel_binding: str = ""
        postgres_endpoint_id: str = ""

        # Portal
        portal_base_url: str = "https://portal.example.com"
        app_url: str = "https://portal.example.com"

        # Chain configuration
        chain_enabled_experts: list[str] = []  # Environment: EDEN_CHAIN_ENABLED_EXPERTS
        chain_disabled_optional: list[str] = []  # Environment: EDEN_CHAIN_DISABLED_OPTIONAL

        # ── Phase 7.0 multi-format ingestion layer ─────────────────────────
        # Master switch for the /orgs/{org_id}/ingest/{format} POST endpoints
        # plus per-tenant rate limit, body cap, and the PII pre-mask gate.
        ingestion_layer_enabled: bool = True
        ingestion_pii_pre_mask: bool = True
        ingestion_max_body_bytes: int = 5 * 1024 * 1024  # 5 MiB
        ingestion_per_tenant_rpm: int = 600
        ingestion_per_api_key_rpm: int = 300
        ingestion_allowed_formats: list[str] = [
            "otel", "helicone", "langfuse", "openai", "anthropic",
            "bedrock", "gemini", "framework", "webhook",
        ]
        ingestion_chunks_max_per_request: int = 1000
        # OTLP gRPC sidecar (off by default — HTTP-JSON via the POST routes
        # is the canonical path).
        ingestion_otlp_enabled: bool = False
        ingestion_otlp_grpc_host: str = "0.0.0.0"
        ingestion_otlp_grpc_port: int = 4317

        # Evolution Engine
        # When the prompt evolver generates a variant, automatically
        # promote it to a canary at this traffic percentage.
        # 0 disables auto-canary creation (variants stay inactive).
        evolver_auto_canary_pct: int = 5

        # ── Object storage (Phase B1, 2026-06-19) ─────────────────────────
        # Single-bucket object storage for the data platform
        # (bronze/silver/datasets/cold archives, NDJSON exports, raw
        # event archives). Phase B1 added Impossible Cloud as the
        # default backend (€7.99/TB/mo flat, zero egress, EU-only).
        #
        # ``bronze_s3_bucket`` is the bucket name; the access key /
        # secret / endpoint come from the EDEN_STORAGE_* trio below.
        # Backwards-compat: if ``EDEN_STORAGE_BACKEND`` is unset or
        # empty, the platform falls back to AWS S3 (legacy) using the
        # AWS_* env vars.
        bronze_s3_bucket: str = ""
        eden_storage_backend: str = ""  # "" = AWS S3, "impossible_cloud" = Impossible Cloud
        eden_storage_endpoint: str = ""  # S3 endpoint URL (empty for AWS)
        eden_storage_access_key: str = ""
        eden_storage_secret_key: str = ""
        # When True, the production monitor's hallucination judge uses
        # the ModelRouter T3 tier primary model as a tiebreaker when
        # the heuristic is inconclusive. Off by default — the
        # heuristic + judge_scores table is the primary signal.
        production_monitor_use_llm_judge: bool = False
        # Maximum number of variants the evolver may generate per run.
        # When more agents are degraded than this, the most-degraded
        # (agent, judge) pairs win the slots.
        evolver_max_variants_per_run: int = 3
        # Minimum number of judge-score samples before the evolver will
        # generate a variant for an (agent, judge) pair. Guards against
        # noisy decisions on tiny windows.
        evolver_min_samples: int = 20
        # Judge-score threshold below which an (agent, judge) is
        # considered degraded. Pairs below this mean over the lookback
        # window are eligible for prompt variants.
        evolver_degradation_threshold: float = 0.7

        # ── Promotion loop (Phase 7.1b follow-up) ───────────────────────
        evolution_loop_enabled: bool = True
        evolution_loop_interval_seconds: int = 300
        promotion_loop_enabled: bool = True
        # Used by ``eden.llmops.promotion.PromotionLoop`` to decide
        # whether the canary's stats are significant enough to
        # promote, keep, or roll back.
        promotion_min_calls: int = 30
        promotion_min_success_rate_lift: float = 0.05
        promotion_max_latency_ratio: float = 1.10
        promotion_max_judge_regression: float = 0.05
        promotion_confidence_band: float = 0.02
        promotion_lookback_minutes: int = 60

        # ── Insights detector loop (Phase 7.1b follow-up) ──────────────
        # The detector registry ships six real detectors, but nothing
        # periodically read new ``judge_scores`` rows and fanned them
        # through ``InsightsService`` to write ``insights`` /
        # ``kb_insight_writes`` rows.  The loop in
        # ``src/eden/insights/detector_loop.py`` does that, started
        # from the FastAPI lifespan.
        insights_loop_enabled: bool = True
        insights_loop_interval_seconds: float = 60.0
        insights_loop_batch_size: int = 200
        insights_loop_max_runtime_seconds: float = 50.0

        # Anomaly detection background loop (data platform).
        anomaly_loop_enabled: bool = True
        anomaly_loop_interval_seconds: float = 900.0

        # Judge Redis tailer — off by default to limit LLM cost.
        judges_async_tailer_enabled: bool = False
        judges_async_tailer_max_keys: int = 50

        # Feature flags
        # Default OFF: legacy experiments / eval-harness routes (chain, experiments,
        # Helicone integration). Set EXPERIMENTS_V1=true to enable.
        experiments_v1: bool = False  # Environment: EXPERIMENTS_V1

        # Paths
        project_root: Path = Path(__file__).parent.parent.parent
        seed_data_dir: Path = Path("./seed")
        migrations_dir: Path = Path("./migrations")

        # ── AI Insights chat sidebar (Phase 8 / Batch B4) ─────────────────
        # Direct Anthropic SDK call (not OpenRouter). The chat endpoint
        # requires ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in the env to
        # actually invoke the model — ``ai_insights_enabled`` only gates
        # the route's master switch.
        ai_insights_enabled: bool = True
        ai_insights_model: str = "claude-sonnet-4-6"

        # ── Rate limiting ─────────────────────────────────────────────────
        # Per-tenant sliding-window rate limiter. Defaults to 60 requests
        # per 60s window. Backed by Redis (REDIS_URL) when available; falls
        # back to in-memory TokenBucket for single-node dev. The middleware
        # also sets standard X-RateLimit-* headers on every response.
        rate_limit_enabled: bool = True
        # Default-deny auth middleware (security 26). Every request must
        # carry an auth context; the middleware short-circuits to 401
        # before the route runs unless the path is on the public allow-
        # list. Disable only for debugging — production must be on.
        default_deny_enabled: bool = True
        # Gate the per-tenant rate-limit middleware. The local-bucket
        # fallback fills up within milliseconds of back-to-back test
        # requests and the suite returns 429 from every mutating test.
        # Tests set this to False (paired with quota_enabled); production
        # keeps it True.
        rate_limit_enabled: bool = True
        rate_limit_default_per_window: int = 60
        rate_limit_window_seconds: int = 60

        # ClickHouse — used by data_platform.clickhouse_sink + the columnar
        # engine (Cat 18). HTTP interface only; see
        # docs/architecture/clickhouse-transport.md for why.
        clickhouse_url: str = "http://localhost:8123"
        clickhouse_database: str = "eden"
        clickhouse_user: str = "default"
        clickhouse_password: str = ""
        clickhouse_timeout: int = 30

        # Prometheus /metrics scrape auth. When set, scrapers must present
        # ``Authorization: Bearer <token>`` to read /metrics. When empty,
        # /metrics returns 503 — the endpoint is never publicly exposed.
        # Set this on the Prometheus side and as METRICS_BEARER_TOKEN on
        # the Eden backend (Northflank project secret).
        metrics_bearer_token: str = ""

        # Redis — used by TenantRateLimitMiddleware, IdempotencyMiddleware,
        # OptimizationCache, and the RedisTailer judge pipeline. Empty
        # string disables Redis (in-memory fallback for all middlewares).
        redis_url: str = "redis://localhost:6379/0"

        # ── GitHub App (onboarding wizard) ────────────────────────────────
        # The onboarding wizard uses a GitHub App (not an OAuth App) so we
        # get fine-grained, per-repo permissions and short-lived
        # installation tokens. All four fields are optional — when any are
        # missing, the wizard's "Connect GitHub" step gracefully degrades
        # to a "Skip — integrate manually" path.
        #
        # ``github_app_slug`` is the URL-friendly name in
        # ``https://github.com/apps/<slug>/installations/new``. It is NOT
        # the OAuth client id (``Iv23…``) — confusing those two produces
        # a GitHub 404. Eden cloud default: ``eden-observability``.
        github_app_id: str = ""
        github_app_client_id: str = ""
        github_app_client_secret: str = ""
        github_app_private_key: str = ""  # PEM-encoded; multi-line OK in .env
        github_app_webhook_secret: str = ""
        github_app_slug: str = ""  # e.g. eden-observability
        github_app_callback_url: str = ""  # e.g. https://edenobservability.com/onboarding/connect

        # ── Trace-quality / quality-pipeline activation (N14) ───────────
        # These gate the trace-quality wiring (``install_all()``) and the
        # quality-pipeline sidecar worker started from ``api/app.py``
        # lifespan. Source of truth: ``prompts/06_settings.md``. Prior to
        # N14 these attributes were absent, so ``quality_pipeline.worker``
        # no-oped even when started. Env-driven via ``EDEN_*``.
        trace_quality_enabled: bool = True
        trace_quality_compute_async: bool = True
        # N14 — explicit worker / hot-path toggles (default on; worker
        # still also requires ``trace_quality_enabled`` + compute_async).
        trace_quality_worker_enabled: bool = True
        trace_quality_hot_path_enabled: bool = True
        traceloop_auto_apply: bool = False  # per-action kill-switch default
        stat_gate_min_n: int = 30
        stat_gate_min_effect: float = 0.2
        detector_keep_rate_loop: float = 1.0
        detector_keep_rate_error: float = 1.0

        # ── N16 intelligence-aware tail sampling ───────────────────────
        # Master switch + profile for the in-process policy
        # (``eden.observability.sampling.policy``). OTel edge sampling is
        # configured separately in ``deploy/otel-collector-config.yaml``.
        # ``sampling_enabled=False`` or ``sampling_profile=full`` keeps
        # 100% of traces (safe rollback). ``probabilistic_sample_rate``
        # overrides the profile fallback when set below 1.0; default 1.0
        # means "use profile rate" (not "keep everything").
        sampling_enabled: bool = True
        sampling_profile: str = "balanced"  # full | balanced | aggressive
        probabilistic_sample_rate: float = 1.0
        sampling_slow_threshold_ms: float = 5_000.0

        # ── N09 content-addressed / message dedupe ─────────────────────
        # Gates ``message_store`` upserts on ingest and ``BlobStore``
        # intern. When False, payloads stay fully inline (N09 rollback).
        # Trace-scoped message dedupe is always the primary path; org
        # blob store is additive for large system/tool payloads.
        content_dedupe_enabled: bool = True

        quality_pipeline_workers: int = 2
        quality_pipeline_watermark_poll_ms: int = 1000
        quality_pipeline_batch_size: int = 100

        # Per-action kill-switch defaults mirrored into
        # ``tenant_guardrail_action_config`` (read-only True, mutating
        # False). Distinct from ``_KILL_SWITCH_DEFAULT`` (private) so it is
        # env-serialisable as JSON.
        default_action_applied_flag: dict[str, bool] = {
            "record_to_table": True,
            "emit_audit_event": True,
            "emit_drift_alert": True,
            "rewrite_response": True,
            "coalesce_step": True,
            "truncate_context": False,
            "block_user": False,
            "escalate_to_admin": False,
            "revoke_api_key": False,
            "apply_policy_change": False,
        }

        # Enhancement-tracking bounds (no-drop invariant + compute budget).
        enhancements_per_component_max: int = 5
        enhancements_compute_budget_seconds: int = 14400  # 4 CPU-hours
        enhancements_no_drop_invariant_enforced: bool = True

        # ── Closed-loop error diagnosis feature flags ───────────────────
        # The issues surface (F28/F29 stumbles+issues + routes) is on by
        # default to honour the zero-config product promise; auto
        # detection (F20) and the orchestrator (F46) are gated so they
        # can be rolled out per deployment.
        agent_issues_v0: bool = True
        auto_issue_detection_v1: bool = True
        per_trace_signals_v1: bool = True
        tool_call_label_learning_v1: bool = True
        signal_classifiers_v1: bool = True
        closed_loop_orchestrator_v1: bool = True
        # WS3 fix/prove surface (F22, N04, F23)
        issue_fix_chat_v1: bool = True
        issue_fix_auto_verify_v1: bool = True
        change_impact_preview_v1: bool = True
        agent_sessions_v1: bool = True
        # Triage budget (F30) — optional max LLM spend per org per day.
        # ``<=0`` / unset = unlimited; orgs may override via
        # ``code_change_policy.max_triage_cost_usd_per_day``.
        max_triage_cost_usd_per_day: float = 0.0

        # ── Autonomy policy engine (N22) ────────────────────────────────
        # Org-level defaults for the autonomous-maintenance safety
        # envelope. When an org (or agent) has no ``autonomy_policies`` row
        # these seed the resolved policy, so the effective posture is
        # derived from the existing scattered flags
        # (``autonomous_actions_v0`` → runtime heal, ``code_change_enabled``
        # → patch PR, ``auto_pr_enabled`` → auto-merge). ``assisted`` is
        # the safe default: runtime heals auto-execute, code patches need a
        # human. ``daily_maintenance_budget_usd`` caps triage+patch LLM
        # spend per org per day; on breach the loop downgrades to
        # suggest-only. ``hipaa`` forces ``observe`` regardless.
        default_maintenance_mode: str = "assisted"
        default_compliance_profile: str = "standard"
        daily_maintenance_budget_usd: float = 25.0
        max_auto_rollbacks_per_day: int = 3

        # ── Closed-loop verify loop (F46 Wave 6) ────────────────────────
        # After a remediation the orchestrator schedules a verify row;
        # the verify worker waits ``verify_delay_seconds`` then confirms
        # the fix held (no new stumbles for the issue fingerprint in the
        # trailing ``verify_quiet_window_minutes`` AND StatGate P0
        # cleared). Pass → issue ``resolved``; fail → ``regressed`` +
        # human escalation. The worker polls every
        # ``verify_poll_interval_seconds``.
        verify_delay_seconds: int = 1800
        verify_quiet_window_minutes: int = 30
        verify_poll_interval_seconds: int = 60
        verify_max_attempts: int = 3

        # ── WS4 enterprise feature flags ────────────────────────────────
        production_eval_sampling_v1: bool = True
        fleet_health_v1: bool = True
        compliance_pack_export_v1: bool = True
        issue_experiments_v1: bool = True

        # ── Issue alerting (F47 Wave 7) ─────────────────────────────────
        # Slack Block Kit alerts for P0/P1 issue creation, verify
        # failures, and human escalations. Global fallback webhook (a
        # per-org ``org_integrations`` row overrides it when present).
        # Storm caps stop an incident flood from paging on-call 200x: an
        # identical fingerprint alert is deduped for
        # ``issue_alert_dedup_minutes`` and an org is capped at
        # ``issue_alert_max_per_hour`` alerts/hour.
        slack_webhook_url: str = ""
        issue_alerts_enabled: bool = True
        issue_alert_dedup_minutes: int = 15
        issue_alert_max_per_hour: int = 30

        # ── Kill-switch defaults (v2.7 hot-path) ────────────────────────
        # Mutating actions default OFF per audit/permission policy.
        # Read-only actions default ON. Override per-tenant via
        # ``tenant_guardrail_action_config`` (Cat 15/17/22 wiring shim).
        # Audit 2026-07-02 — see spec §04 #9.
        _KILL_SWITCH_DEFAULT: dict[str, bool] = {
            # mutating — must default OFF
            "block_user": False,
            "revoke_api_key": False,
            "escalate_to_admin": False,
            "truncate_context": False,
            "apply_policy_change": False,
            # read-only — default ON
            "record_to_table": True,
            "emit_audit_event": True,
            "emit_drift_alert": True,
            "rewrite_response": True,
            "coalesce_step": True,
        }

        def get_action_default(self, action_class: str) -> bool:  # ponytail: instance helper — sets are instance-scoped (Pydantic model_config doesn't allow dict defaults at class level on BaseSettings)
            """Return the default kill-switch state for ``action_class``.

            Audit 2026-07-02 — mutating classes default False;
            read-only default True; unknown classes default True
            (fail-open so observability never silently breaks).
            """
            return self._KILL_SWITCH_DEFAULT.get(action_class, True)



    _settings_class = Settings
    return _settings_class



__all__ = ["Settings", "get_settings"]  # noqa: F822


def __getattr__(name):
    """PEP 562 — lazy module attribute access for Settings."""
    if name == "Settings":
        cls = _build_settings_class()
        globals()["Settings"] = cls
        return cls
    if name in __all__:
        raise AttributeError(name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


@lru_cache
def get_settings() -> "Settings":  # noqa: F821
    """Get cached settings instance.

    Cat 23 audit (2026-06-21): refuse to boot when ``jwt_secret`` is
    still the placeholder default in any non-test environment. Tests
    set ``EDEN_TESTING=1`` (or similar) so unit suites can keep using
    a fixture secret.
    """
    import os

    settings = _build_settings_class()()
    # Phase 1: production mode implies strict startup unless overridden.
    if settings.eden_production and not settings.strict_startup_checks:
        settings = settings.model_copy(update={"strict_startup_checks": True})
    placeholder = "change-me-in-production"
    if settings.jwt_secret == placeholder:
        testing = os.environ.get("EDEN_TESTING", "").lower() in (
            "1", "true", "yes",
        ) or os.environ.get("PYTEST_CURRENT_TEST")
        if testing:
            logger.debug("jwt_secret using placeholder (test mode)")
        else:
            raise RuntimeError(
                "jwt_secret is still set to the placeholder default "
                "'change-me-in-production'. Set EDEN_JWT_SECRET (or "
                "JWT_SECRET) to a real secret before booting in any "
                "non-test environment."
            )
    # Minimum length check. 32 bytes (256 bits) is the floor for
    # HS256 — anything shorter weakens the signature against brute
    # force. We skip the check in test mode because fixtures use a
    # short placeholder.
    if not os.environ.get("PYTEST_CURRENT_TEST") and len(
        settings.jwt_secret
    ) < 32:
        raise RuntimeError(
            "jwt_secret must be at least 32 characters. Generate one "
            "with: python -c 'import secrets; print(secrets.token_urlsafe(32))'"
        )
    return settings
