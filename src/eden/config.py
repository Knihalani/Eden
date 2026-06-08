"""Eden configuration."""

from pathlib import Path
from functools import lru_cache
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Eden environment configuration."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
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

    # Stripe
    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""

    # Email (SendGrid)
    sendgrid_api_key: str = ""
    sendgrid_from_email: str = "noreply@eden.ai"
    sendgrid_from_name: str = "Eden"

    # Portal
    portal_base_url: str = "https://portal.example.com"
    app_url: str = "https://portal.example.com"

    # Chain configuration
    chain_enabled_experts: list[str] = []  # Environment: EDEN_CHAIN_ENABLED_EXPERTS
    chain_disabled_optional: list[str] = []  # Environment: EDEN_CHAIN_DISABLED_OPTIONAL

    # Evolution Engine
    # When the prompt evolver generates a variant, automatically
    # promote it to a canary at this traffic percentage.
    # 0 disables auto-canary creation (variants stay inactive).
    evolver_auto_canary_pct: int = 5

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

    # Paths
    project_root: Path = Path(__file__).parent.parent.parent
    seed_data_dir: Path = Path("./seed")
    migrations_dir: Path = Path("./migrations")


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
