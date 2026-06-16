"""Eden configuration."""

from functools import lru_cache
from pathlib import Path

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

    # Server
    host: str = "0.0.0.0"
    port: int = 8000

    # PostgreSQL
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_db: str = "eden"
    postgres_user: str = "eden"
    postgres_password: str = ""
    postgres_pool_size: int = 20
    postgres_min_pool_size: int = 5

    # Qdrant
    qdrant_host: str = "localhost"
    qdrant_port: int = 6333
    qdrant_collection_prefix: str = "eden_"

    # OpenRouter
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"

    # Model configuration
    model_reasoning: str = "anthropic/claude-sonnet-4.6"
    model_code: str = "qwen/qwen3-coder:free"
    model_fast: str = "deepseek/deepseek-v4-flash:free"
    model_fallback: str = "meta-llama/llama-3.3-70b-instruct"

    # Sandboxing
    firecracker_jailer_path: str = "/usr/local/bin/jailer"
    firecracker_kernel_path: str = "./vmlinux"
    firecracker_rootfs_path: str = "./rootfs.ext4"
    sandbox_memory_mb: int = 512
    sandbox_cpu_count: int = 2
    sandbox_snapshot_pool_size: int = 10
    sandbox_max_concurrent: int = 100

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
    jwt_exp_days: int = 7

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
    # require SSL. ``postgres_channel_binding`` is Neon-specific; safe
    # to leave empty elsewhere.
    # ``database_url`` is a full-URL override. When non-empty, it
    # takes precedence over the individual ``POSTGRES_*`` vars — useful
    # for PgBouncer pools, Neon endpoints with non-standard SSL, etc.
    database_url: str = ""
    postgres_sslmode: str = ""
    postgres_channel_binding: str = ""
    postgres_endpoint_id: str = ""

    # Backblaze B2 cold tier (Phase 6 of the Postgres + Compression
    # plan). All four must be set for ``ParquetColdExporter`` to write
    # Parquet+zstd-7 archives; otherwise it's a no-op. B2 is S3-
    # compatible, so we use boto3 with a custom endpoint_url. Cheapest
    # hot US storage with free egress via Cloudflare bandwidth alliance.
    b2_endpoint_url: str = ""            # e.g. https://s3.us-west-001.backblazeb2.com
    b2_cold_bucket: str = ""             # e.g. eden-cold
    b2_access_key_id: str = ""
    b2_secret_access_key: str = ""

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

    # ── Promotion loop (Phase 7.1b follow-up) ───────────────────────
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

    # Feature flags
    # Default OFF: the legacy multi-stage environment-generation pipeline
    # (Planner→Critic→Refiner→Fact-checker→Executor→Code-quality→Verifier→Tester→Archivist)
    # is being hard-cut. Set ENABLE_EVAL_PIPELINE=true to re-enable.
    enable_eval_pipeline: bool = False  # Environment: ENABLE_EVAL_PIPELINE

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
    github_app_id: str = ""
    github_app_client_id: str = ""
    github_app_client_secret: str = ""
    github_app_private_key: str = ""  # PEM-encoded; multi-line OK in .env
    github_app_webhook_secret: str = ""
    github_app_callback_url: str = ""  # e.g. https://portal.example.com/onboarding/connect


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
