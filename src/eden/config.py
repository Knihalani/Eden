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

# One-time deprecation flag for the ``verify_poll_interval_seconds``
# read-through alias (M3, D7).
_VERIFY_POLL_ALIAS_WARNED = False


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
        # dedicated ``eden-worker`` job is deployed). Default False so
        # API pods do not host loops unless explicitly enabled.
        eden_production: bool = False
        # Northflank/Helm set ``EDEN_RUN_BACKGROUND_WORKERS`` (see
        # northflank.yml + helm/eden/templates/*-deployment.yaml), not
        # ``RUN_BACKGROUND_WORKERS`` — the field's default env-var form
        # sans ``env_prefix``/an alias. Without ``AliasChoices`` here the
        # deployed env var was silently ignored and this always fell
        # back to the ``False`` default regardless of what infra set.
        run_background_workers: bool = Field(
            default=False,
            validation_alias=AliasChoices(
                "run_background_workers",
                "RUN_BACKGROUND_WORKERS",
                "EDEN_RUN_BACKGROUND_WORKERS",
            ),
        )
        # Cap for fire-and-forget ``bounded_create_task`` hot sites.
        background_task_concurrency: int = 64
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

        # /health probe override. "auto" → 200 when healthy, 503 when
        # degraded (soft deps included — monitors page on HTTP status).
        # Ingress MUST use /ready, not /health. Set "200" for local/dev
        # so soft-dep degradation does not trip restart loops.
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
        # Max-size default is deliberately conservative (20 = ~80 conns
        # across the API + 2 jobs + worker, one pool each). The Northflank
        # manifest overrides down to 10 per container; PostgresClient
        # honours ``POSTGRES_POOL_SIZE``. See ``postgres_min_pool_size``
        # below for the min-size default (0, not 5 — updated 2026-07-02).
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
        # asyncpg recycles pooled connections that have been idle longer
        # than this (seconds). Keep well under Neon's suspend window
        # (``suspend_timeout_seconds`` ≈ 300) so idle sockets are gone
        # long before autosuspend evaluates quiet TCP. Previous 60s was
        # safe with min_size=0 but still held sockets through short gaps
        # between worker ticks.
        postgres_max_inactive_connection_lifetime: float = 30.0
        # asyncpg's client-side prepared-statement cache (default size
        # 100, keyed per physical ``Connection``) is incompatible with
        # PgBouncer *transaction*-mode pooling, which this module targets
        # (see ``PostgresClient`` docstring): PgBouncer can hand the next
        # statement on the same logical session to a *different* backend
        # connection than the one that prepared it, producing intermittent
        # "prepared statement does not exist" / "prepared statement
        # already exists" errors under load. Default to 0 (cache
        # disabled) — the standard fix. Override via
        # ``POSTGRES_STATEMENT_CACHE_SIZE`` only for a deployment that is
        # known to run *session*-mode pooling (or no pooler at all).
        postgres_statement_cache_size: int = 0

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
        typesense_bulk_index_enabled: bool = True

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
        # Cat 20 — best-effort TraceRecorder hooks on the AI gateway
        # hot path. When True, ``AIGateway.complete`` +
        # ``/gateway/v1/*`` record cacheability metadata for
        # fork-and-replay. Failures never break the LLM response.
        time_travel_recording_enabled: bool = True
        # Cat 20 — the /time-travel/replay endpoint. TURNED OFF
        # 2026-07-30 because it does not do what it reports doing, and
        # a feature that lies is worse than one that is absent.
        #
        # The recorder never stores prompt content: both call sites
        # (llmops/ai_gateway.py and api/routes/gateway.py) pass a request
        # dict of model/temperature metadata only. The replayer looks for
        # payload["messages"], then payload["prompt"], finds neither,
        # and short-circuits — returning the RECORDED response hash and
        # reporting re_executed=True without ever reaching the gateway.
        # A second, independent bug guarantees the same outcome even if
        # the payload were fixed: _apply_edits_to_step writes edits onto
        # the step dict while _re_execute_step reads from step["payload"],
        # so user edits never reach the prompt.
        #
        # Net effect: a user changes a prompt, gets an identical response
        # hash back, and concludes their edit had no effect on the model.
        # The tokens_saved / cost_saved_usd figures are fiction.
        #
        # Recording stays ON. Replay is ON after the 2026-07-31 evidence-
        # plane fix: call sites persist prompt/messages, edits land in
        # payload, and empty prompts report cannot_replay (not fake
        # re_executed). Flip off with TIME_TRAVEL_REPLAY_ENABLED=0 if needed.
        # See docs/ops/disabled-features.md.
        time_travel_replay_enabled: bool = True
        # SSO routes. ON after 2026-08-02: handlers query live tables
        # ``org_sso_settings`` + ``sso_configurations``; SCIM token
        # write/read both use ``org_scim_config``. Kill-switch via
        # ``SSO_ENABLED=0``. See docs/ops/disabled-features.md.
        sso_enabled: bool = True
        # D.14 onboarding-v2 API surface (services/onboarding/ +
        # api/routes/onboarding.py). ON after migration
        # ``128_onboarding_state_v2_columns`` adds the state-machine
        # columns alongside the wizard columns from
        # ``029_onboarding_wizard``. Alembic 056's ``CREATE TABLE IF
        # NOT EXISTS`` had no-op'd against the wizard table; ``_persist``
        # no longer swallows write failures. Flip off with
        # ``ONBOARDING_STATE_MACHINE_V2_ENABLED=0`` if needed.
        # Portal wizard ``/orgs/{org}/onboarding/state`` is separate.
        # See docs/ops/known-issues.md #9.
        onboarding_state_machine_v2_enabled: bool = True
        # Email verification on password signup. Shipped 2026-08-02 as
        # one unit: the ``email_verification_tokens`` table (migration
        # ``133_email_verification_tokens``),
        # ``email_service.send_verification_email``, and the
        # ``/auth/verify-email`` route — the register's re-enable
        # condition (docs/ops/disabled-features.md §1c). login() still
        # does not gate on ``email_verified``: verification records
        # trust, it does not block sign-in. Kill-switch:
        # ``EMAIL_VERIFICATION_ENABLED=0``.
        email_verification_enabled: bool = True
        # Cat 14 (autonomous) destructive-action flag. The
        # ``/heal``, ``/heal/{id}/approve``, ``/heal/{id}/deny`` routes
        # require this + the per-action two-stage opt-in. OFF by
        # default — enable explicitly; the human-approval gate still
        # blocks side-effects when the flag is on.
        autonomous_actions_v0: bool = False
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
        # Default ON for GA / new deploys (matches GA-COMPLETION-CHECKLIST N23).
        # Kill via IMPROVEMENT_AGENT_V1=false or per-org features if needed.
        improvement_agent_v1: bool = True
        improvement_schedule_enabled: bool = True
        # F62 — SLM-as-judge tier for online scoring (fast slot / Haiku-class).
        online_scoring_slm_v1: bool = True

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
        # Minimum fingerprint / stumble count before N20 enqueues an
        # improvement_plan. Spec floor is 5×; env may raise but not lower.
        patch_cluster_min_size: int = 5
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
        # Rank-then-generate sweep caps (N23). Max PatchGenerator invokes
        # per sweep is stricter than the inbox code_patch lane (also 3).
        patch_max_generates_per_sweep: int = 3
        # Hard stop on LLM calls inside one sweep (gen+critic+margin).
        patch_max_llm_calls_per_sweep: int = 8
        # COST: the same hard stop for patch generation reached OUTSIDE a
        # sweep (closed-loop ``propose_patch`` actions, promotion hooks).
        # Those paths never armed the sweep budget, so ``try_consume_llm_call``
        # was unlimited there -- one runaway action could fan out unbounded
        # gen+critic pairs. Smaller than the sweep budget because a single
        # action proposes a single patch (2 attempts x gen+critic = 4).
        patch_max_llm_calls_per_run: int = 4
        # Triage confidence floor before PatchGenerator runs.
        patch_min_triage_confidence: float = 0.65
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
        # The agent uses the internal chat SSOT (all ModelRouter tiers
        # resolve to eden.llm.models.INTERNAL_CHAT_MODEL — DeepSeek).
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
        # W20 / F70 — in-product ChatSidebar copilot (features.f70).
        # OFF by default; set FEATURES_F70=true to enable.
        features_f70: bool = False
        # DL-10: hard cap on the ChatService gateway's request
        # ``max_tokens`` parameter. The OpenRouter upstream caps at
        # 4096 by default; set to 0 to disable the cap. The test
        # suite asserts the default is 4096 (Phase C-7 rollback
        # preserves the original OpenRouter limit).
        gateway_max_tokens_cap: int = 4096

        # Semantic prompt cache (eden.optimization.cache.SemanticCache).
        # COST: every cache-miss used to embed the prompt TWICE -- once in
        # ``.get`` to search, once again in ``.set`` to store the identical
        # normalized text. The embedding is now computed once and reused,
        # but this flag stays so the embedding spend can be killed without
        # a redeploy.
        semantic_cache_v1: bool = True
        # Embedding model id was hardcoded at the call site, so the
        # cheapest-model choice could not be changed without a code change.
        semantic_cache_embed_model: str = "openai/text-embedding-3-small"

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

        # JWT Authentication — accept JWT_SECRET and EDEN_JWT_SECRET
        # (docs/boot error mention both; without AliasChoices only the
        # pydantic field name / JWT_SECRET env form worked).
        jwt_secret: str = Field(
            default="change-me-in-production",
            validation_alias=AliasChoices(
                "jwt_secret",
                "JWT_SECRET",
                "EDEN_JWT_SECRET",
            ),
        )
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
        # Required when eden_production=True. Dev may leave empty
        # (falls back to deriving a key from JWT_SECRET).
        encryption_key: str = ""

        # Sentry error tracking (optional — no-op when DSN empty).
        sentry_dsn: str = ""
        sentry_environment: str = "development"
        sentry_traces_sample_rate: float = 0.0

        # Stripe
        stripe_secret_key: str = ""
        stripe_webhook_secret: str = ""

        # Email (SendKit) — API key via SENDKIT_API_KEY / sendkit_api_key.
        # Alerts from alerts@; invites/exports from info@.
        sendkit_api_key: str = ""
        email_from_alerts: str = "alerts@edenobservability.com"
        email_from_info: str = "info@edenobservability.com"
        email_from_name: str = "Eden"

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
            "otel",
            "helicone",
            "langfuse",
            "openai",
            "anthropic",
            "bedrock",
            "gemini",
            "framework",
            "webhook",
        ]
        ingestion_chunks_max_per_request: int = 1000
        # W9 — load shed when in-process buffer / lag pressure is high.
        ingestion_shed_enabled: bool = True
        ingestion_shed_max_depth: int = 5000
        ingestion_shed_retry_after_seconds: int = 5
        # W9 — late-span watermark (reject beyond max age).
        late_span_policy_enabled: bool = True
        late_span_max_age_seconds: float = 86400.0  # 24h
        late_span_soft_age_seconds: float = 3600.0  # stamp late_span attr after 1h
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
        evolution_loop_enabled: bool = False
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
        # 1200s = 2x the 600s shared idle grid period, so this loop
        # coalesces with the other leader loops instead of waking Neon on
        # its own phase. Was 180.0 (off-grid, ~4x the Redis cost).
        insights_loop_interval_seconds: float = 1200.0
        insights_loop_batch_size: int = 200
        insights_loop_max_runtime_seconds: float = 50.0

        # Anomaly detection background loop (data platform).
        anomaly_loop_enabled: bool = True
        # 1200s = 2x the 600s shared idle grid. Was 900.0, which is not a
        # grid multiple and so re-fragmented the DB-quiet window.
        anomaly_loop_interval_seconds: float = 1200.0

        # Judge Redis tailer — off by default to limit LLM cost.
        judges_async_tailer_enabled: bool = False
        judges_async_tailer_max_keys: int = 50
        # UnifiedJudge LLM — OFF by default. Layer A owns production
        # float scores; flip on only for shadow calibration / HIL.
        judges_llm_v1: bool = False
        # T1 ModelRouter annotator — runs after Layer A.
        # Writes eval:llm:* search tags only (never Issues).
        trace_annotator_v1: bool = True
        # COST: fraction of finalized traces that get an LLM annotation.
        # This used to be 100% coverage with no sampling and no budget, so
        # annotator spend scaled linearly with ingest volume and nothing
        # capped it. The sample is taken deterministically off the trace id
        # so the finalized-trace consumer's retry ladder cannot re-roll it.
        # 0.1 keeps the eval:llm:* tag corpus statistically useful at ~1/10
        # the cost. Set TRACE_ANNOTATOR_SAMPLE_RATE=1.0 to restore old
        # behaviour, 0.0 to disable sampling-based annotation entirely.
        trace_annotator_sample_rate: float = 0.1

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
        # Internal chat SSOT (eden.llm.models.INTERNAL_CHAT_MODEL).
        # Was "claude-sonnet-4-6" — misleading: insights actually route
        # through OpenRouter tiers, all of which are DeepSeek now.
        ai_insights_model: str = "deepseek/deepseek-v4-flash-0731"

        # ── Rate limiting ─────────────────────────────────────────────────
        # Per-tenant sliding-window rate limiter. Defaults to 60 requests
        # per 60s window. Backed by Redis (REDIS_URL) when available; falls
        # back to in-memory TokenBucket for single-node dev. The middleware
        # also sets standard X-RateLimit-* headers on every response.
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
        # Anonymous / IP + fallback when no org tier row exists.
        rate_limit_default_per_window: int = 60
        rate_limit_window_seconds: int = 60
        # Authenticated portal (Clerk/JWT, no API key) fan-out: a single
        # hub mount can fire 8–15 React Query GETs. Free-tier 60 rpm made
        # normal navigation throw "Too many requests" pageErrors. Portal
        # traffic uses max(tier_rpm, this value); API-key traffic stays
        # on the tighter tier/default bucket.
        rate_limit_portal_per_window: int = 300
        # When False (default), rate limits use in-process token buckets /
        # sliding windows and do NOT touch Redis. Upstash Free tier is
        # 500k commands/month; per-request Redis Lua (3–5 cmds each) was
        # exhausting that quota. Set RATE_LIMIT_DISTRIBUTED=true only when
        # running multiple API replicas that must share counters.
        rate_limit_distributed: bool = False
        # IdempotencyMiddleware — when enabled, mutating ``/v1/*``
        # requests that carry an ``Idempotency-Key`` header are
        # deduped (Redis + Postgres). Requests without the header
        # pass through unchanged. Disable with
        # ``IDEMPOTENCY_MIDDLEWARE_ENABLED=false``.
        idempotency_middleware_enabled: bool = True

        # ClickHouse — used by data_platform.clickhouse_sink + the columnar
        # engine (Cat 18). HTTP interface only; see
        # docs/architecture/clickhouse-transport.md for why.
        # Production points CLICKHOUSE_URL at Tinybird
        # (https://api.us-east.tinybird.co); the sink auto-detects that
        # host and switches to Tinybird Events API + /v0/sql.
        clickhouse_url: str = "http://localhost:8123"
        clickhouse_database: str = "eden"
        clickhouse_user: str = "default"
        clickhouse_password: str = ""
        clickhouse_timeout: int = 30
        # Tinybird workspace tokens (Events API + pipe/SQL reads).
        # Prefer TINYBIRD_ADMIN_TOKEN for ingest; branch token is fine
        # for read-only pipe queries in staging.
        tinybird_api_host: str = ""
        tinybird_admin_token: str = ""
        tinybird_branch_token: str = ""

        # Prometheus /metrics scrape auth. When set, scrapers must present
        # ``Authorization: Bearer <token>`` to read /metrics. When empty,
        # /metrics returns 503 — the endpoint is never publicly exposed.
        # Set this on the Prometheus side and as METRICS_BEARER_TOKEN on
        # the Eden backend (Northflank project secret).
        metrics_bearer_token: str = ""

        # Redis — used by IdempotencyMiddleware, OptimizationCache,
        # leader election, and the RedisTailer judge pipeline. Empty
        # string disables Redis (in-memory fallback for middlewares).
        # Upstash Free = 500k cmds/month — keep health checks off and
        # rate_limit_distributed=False unless you upgrade the plan.
        redis_url: str = "redis://localhost:6379/0"
        # redis-py PING cadence. 0 disables (recommended on Upstash Free).
        redis_health_check_interval: int = 0
        # Cap per-command Redis wait so a hung Upstash socket cannot
        # stall an ASGI worker (rate-limit / idempotency / locks).
        # Stream consumers use a separate client with a longer timeout
        # (see redis_stream_block_ms) — do not raise this for the API.
        redis_socket_timeout: float = 2.0
        # Bound the asyncio connection pool — redis-py's default is
        # effectively unbounded and can open sockets under load.
        redis_max_connections: int = 32
        # XREADGROUP block for closed-loop + trace.finalized consumers.
        # Upstash bills each blocked read. 300s → ~9k cmds/mo per
        # consumer idle; 30s was ~86k; 2s was ~1.3M. Must stay below
        # the stream client's socket timeout (auto-derived).
        redis_stream_block_ms: int = 300_000
        # How often to XAUTOCLAIM idle PEL entries (not every read cycle).
        redis_stream_autoclaim_interval_s: int = 300
        # Leader-lock extend / retry cadence for worker loops (seconds).
        # Lower = more Redis SET/EXPIRE traffic on Upstash Free.
        redis_leader_tick_seconds: int = 120
        # Per-span ``telemetry:{org}:{trace}:events`` XADD — only needed
        # when the async judge RedisTailer is on. Default off with the
        # tailer; Postgres remains the durable ingest store.
        redis_telemetry_stream_enabled: bool = False
        # Write SSE replay ZSET even when NUMSUB=0 (Last-Event-ID buffer).
        # Default false: no live listeners → 0 Redis cmds on ingest;
        # portal falls back to REST. Set true to keep quiet-window resume.
        redis_sse_write_when_idle: bool = False
        # NUMSUB cache TTL when nobody is listening (seconds).
        redis_sse_numsub_idle_ttl_s: float = 30.0
        # NUMSUB cache TTL while at least one subscriber is connected.
        redis_sse_numsub_active_ttl_s: float = 2.0
        # Live-trace publisher: buffer/publish when NUMSUB=0. Default
        # false — SDK publish with no open live UI costs ~0 Redis cmds.
        redis_live_write_when_idle: bool = False

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
        github_app_callback_url: str = ""  # e.g. https://edenobservability.com/agents/connect

        # ── Slack App (Soft Autonomy alerts) ─────────────────────────────
        # Full Slack Bot (OAuth + chat.postMessage + Block Kit) for
        # issue / PR / needs-approval alerts with per-agent channel
        # routing. Mirrors the GitHub App pattern: org-level install
        # (``org_slack_installs``) + per-agent channel binding
        # (``agent_slack_channels``). All fields optional — when unset,
        # the portal "Connect Slack" button degrades to hidden and the
        # dispatcher no-ops.
        #
        # ``slack_bot_token`` (xoxb-) is the single-workspace fallback for
        # early development / self-hosted single-tenant deploys; the
        # multi-tenant path stores per-org bot tokens (encrypted) from
        # the OAuth exchange and never reads this var.
        slack_client_id: str = ""
        slack_client_secret: str = ""
        slack_signing_secret: str = ""
        slack_callback_url: str = ""  # e.g. https://api.eden…/integrations/slack/callback
        slack_bot_token: str = ""  # xoxb- dev/single-tenant fallback only
        # Alert storm control, mirrors issue_alert_* for email.
        slack_alerts_enabled: bool = True
        slack_alert_dedup_minutes: int = 15
        slack_alert_max_per_hour: int = 30

        # ── Soft Autonomy Phase 7: nightly soft-issue novelty review ──
        # L1 rank (hot orgs by fresh issues) → L3 DeepSeek novelty scout
        # over a compact digest of ≤ ``soft_issue_review_traces_per_org``
        # traces → L4 compile_signal shadow detectors. Hard caps live in
        # eden.services.soft_issue_review; these are the operator knobs.
        soft_issue_review_enabled: bool = True
        soft_issue_review_traces_per_org: int = 50

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
        # (``eden.observability.sampling.policy``), applied on ingest via
        # ``eden.observability.sampling.apply.should_route_event``.
        # OTel edge sampling is configured separately in
        # ``deploy/otel-collector-config.yaml``.
        #
        # Soft-launch / Wave-1 default is ``full`` (100% keep) so new
        # installs match SDK ``EDEN_SAMPLING_PROFILE`` default. For cost
        # reduction after soft-launch, set ``EDEN_SAMPLING_PROFILE=balanced``
        # (~15% non-signal keep; errors/loops/stumbles always kept) or
        # ``aggressive`` (~5%). ``sampling_enabled=False`` also keeps 100%.
        # ``probabilistic_sample_rate`` overrides the profile fallback when
        # set below 1.0; default 1.0 means "use profile rate".
        sampling_enabled: bool = Field(
            default=True,
            validation_alias=AliasChoices(
                "sampling_enabled",
                "SAMPLING_ENABLED",
                "EDEN_SAMPLING_ENABLED",
            ),
        )
        sampling_profile: str = Field(
            default="full",  # full | balanced | aggressive
            validation_alias=AliasChoices(
                "sampling_profile",
                "SAMPLING_PROFILE",
                "EDEN_SAMPLING_PROFILE",
            ),
        )
        probabilistic_sample_rate: float = Field(
            default=1.0,
            validation_alias=AliasChoices(
                "probabilistic_sample_rate",
                "PROBABILISTIC_SAMPLE_RATE",
                "EDEN_PROBABILISTIC_SAMPLE_RATE",
            ),
        )
        sampling_slow_threshold_ms: float = 5_000.0
        # ── N09 content-addressed / message dedupe ─────────────────────
        # Gates ``message_store`` upserts on ingest and ``BlobStore``
        # intern. When False, payloads stay fully inline (N09 rollback).
        # Trace-scoped message dedupe is always the primary path; org
        # blob store is additive for large system/tool payloads.
        content_dedupe_enabled: bool = True

        quality_pipeline_workers: int = 8
        quality_pipeline_watermark_poll_ms: int = 1000
        quality_pipeline_batch_size: int = 100
        # ── Idle-poll cadences (Neon scale-to-zero) ────────────────────
        # These MUST share one value. ``eden.storage.empty_cooldown``
        # quantises every deadline onto a wall-clock grid of the
        # configured period, so loops on a common period wake on the same
        # boundaries and leave one long shared quiet window. Loops given
        # different periods land on different grids and re-fragment the
        # window -- which is what kept Neon awake even after each
        # individual cooldown was raised. Change them together.
        #
        # 600s: comfortably above Neon's ~300s suspend_timeout, leaving
        # roughly 10 idle minutes per cycle minus the work itself.
        idle_poll_period_seconds: float = 600.0
        # Empty-poll backoff ceiling for the quality sidecar. Must exceed
        # Neon's suspend_timeout (~300s) so an idle fleet can actually
        # autosuspend; the previous hard-coded 30s kept compute warm
        # forever. Override via ``QUALITY_PIPELINE_EMPTY_BACKOFF_MAX_S``.
        quality_pipeline_empty_backoff_max_s: float = 600.0
        # Self-obs probe cadence (worker leader loop). Raised 600 -> 3600
        # on 2026-07-30 after measuring the write mix on production:
        #
        #   eden_synthetic_runs        10,327 inserts
        #   eden_component_heartbeats   7,892 inserts
        #   eden_leader_leases          1,236 inserts / 1,955 updates
        #   ---------------------------------------------------------
        #   19,576 of 20,553 total inserts = 95.2%
        #
        # Everything else in the database combined was 977 rows. At zero
        # users, essentially the entire write load was Eden watching
        # itself — 8,321 rows/day, and one of the loops forcing Neon
        # awake. At 1h this drops to ~1,387 rows/day.
        #
        # The cost is that a degraded/failing component pages up to an
        # hour later. At launch scale you notice from the portal long
        # before the probe does, so this is the right trade; revisit once
        # real traffic makes self-obs a minority of writes again.
        self_obs_probe_interval_seconds: float = 3600.0
        # Webhook outbox drain floor. Empty polls skip PG for this many
        # seconds after a zero-row claim (see webhook_delivery). Real work
        # is not delayed by this: enqueue paths publish a Redis signal that
        # short-circuits the cooldown on the draining process.
        webhook_drain_empty_cooldown_seconds: float = 600.0
        # Closed-loop verify + insights + EQL empty-poll cooldowns.
        verify_empty_cooldown_seconds: float = 600.0
        insights_empty_cooldown_seconds: float = 600.0
        eql_empty_cooldown_seconds: float = 600.0

        # ── Idle-cost budget: Upstash Redis free tier = 10k commands/day ──
        # Everything below exists to keep a *zero-traffic* deployment far
        # under that ceiling, and to keep Neon's ~300s autosuspend window
        # reachable. Intervals are deliberately multiples of
        # ``idle_poll_period_seconds`` (600s) so every loop lands on the
        # same shared wall-clock grid (see eden.storage.empty_cooldown) —
        # raising one interval in isolation does not help.

        # Sidecar guard lock. The holder renews forever, even uncontended,
        # and each renew is one Lua EVAL = 1 Upstash command. At the old
        # TTL=60s/renew=20s that was 4,320 commands/day on its own — 43% of
        # the entire free tier, burned by a lock nobody contends. TTL 600s
        # with a 200s renew costs 432/day. Renew must stay < TTL/2 so a
        # slow tick cannot let the lock lapse; the cost is that a
        # hard-crashed holder blocks sidecar failover for up to one TTL.
        sidecar_guard_ttl_seconds: int = 600
        sidecar_guard_renew_seconds: float = 200.0

        # Leader-gated loop cadences. Each tick costs 2 Redis commands
        # (SET NX acquire + Lua EVAL release) plus renews while work runs.
        # All are grid multiples so they coalesce onto the same boundaries
        # instead of each carving its own hole in the DB-quiet window.
        # 1200s = 2 grid periods => 72 ticks/day => 144 commands/day each.
        # (``insights_loop_interval_seconds`` itself is declared above with
        # the other insights settings; its default is now 1200.0.)
        eql_watchdog_interval_seconds: float = 1200.0
        # Demotion is a 7-day nudge sweep; hourly was far more often than
        # the semantics need. 6 grid periods = 3600s, now grid-aligned.
        artifact_demotion_interval_seconds: float = 3600.0
        # Webhook drain is the one loop with a real latency SLA. It stays
        # on the grid but at a single period (600s) rather than 120s;
        # enqueue paths publish a Redis signal that short-circuits the
        # empty cooldown, so real deliveries do not wait for the tick.
        webhook_drain_interval_seconds: float = 600.0
        # Closed-loop verify: the file previously carried three different
        # defaults for this one interval (180/60/180). One grid-aligned
        # value, used everywhere.
        verify_loop_interval_seconds: float = 600.0

        # Anomaly detector: ran every 900s, which is not a multiple of the
        # 600s grid, so it re-fragmented the quiet window every cycle, and
        # it hit Postgres unconditionally (6 gathered queries + persist)
        # with no empty-result cooldown. 1200s = 2 grid periods.
        # (``anomaly_loop_interval_seconds`` is declared above with the
        # other anomaly settings; its default is now 1200.0.)
        anomaly_empty_cooldown_seconds: float = 600.0

        # Self-obs probes: telemetry about ourselves, not user-facing. The
        # tick used to walk up to 500 orgs *serially* at >=3 PG writes
        # each — >=1,500 round trips per tick, long enough that Postgres
        # never went idle no matter how the loop was phased. Probe a small
        # rotating subset per tick instead, concurrently, with the
        # heartbeats batched into one multi-row INSERT. At 25 orgs/tick and
        # a 600s grid the full fleet is still covered every ~2h for 500
        # orgs, which is ample for a liveness signal.
        self_obs_probe_org_budget: int = 25
        self_obs_probe_concurrency: int = 8

        # Bounded in-memory caches. The gateway mints a unique trace_id per
        # request, so these dicts previously grew by one entry per request
        # and were never evicted — an unbounded leak in a long-lived API
        # process. 4096 mirrors ``_numsub_cache`` in
        # api/routes/observability_stream.py.
        checkpoint_expire_cache_max: int = 4096

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
        tool_call_inference_v1: bool = False
        tool_call_min_labels: int = 5
        # N11 live in-flight trace streaming (Redis pub/sub). Defaults on
        # for Wave 27 so portal/SDK/MCP surfaces are exercisable; flip off
        # via env for rollback.
        live_trace_streaming_v1: bool = True
        live_mcp_tail_v1: bool = True
        live_max_sessions_per_org: int = 100
        signal_classifiers_v1: bool = True
        agentic_metrics_v1: bool = True
        closed_loop_orchestrator_v1: bool = True
        # WS3 prove surface (N04, F23) — portal fix-chat DELETED @ W26
        # OFF by default; set CHANGE_IMPACT_PREVIEW_V1=true to enable.
        change_impact_preview_v1: bool = False
        agent_sessions_v1: bool = True
        debug_sessions_v1: bool = True
        browser_recording_v1: bool = True
        # RTBF cross-store fanout. OFF until every store has a genuinely
        # per-user erasure path. Today Typesense filters on a field absent
        # from its schema, Redis scans a key pattern nothing matches, and
        # Qdrant/ClickHouse have no delete-by-user at all — so a "completed"
        # erasure erases almost nothing. Set RTBF_FANOUT_V1=true only once
        # those are real. See services/governance_intel/rtbf_fanout.py.
        rtbf_fanout_v1: bool = False
        # MCP Streamable-HTTP transport at /v1/mcp. OFF by default: until the
        # 2026-07 remediation it accepted any non-empty bearer string as full
        # mcp:read+debug+fix against any org named in X-Org-Id, and several
        # tools fell through to local Postgres fallbacks that bypass the API's
        # authorization entirely. Enable only after reviewing which API keys
        # carry MCP scopes. Cursor/stdio is unaffected by this flag.
        mcp_http_transport_v1: bool = False
        # Triage budget (F30) — optional max LLM spend per org per day.
        # Positive default enforces a daily cap; orgs may override via
        # ``code_change_policy.max_triage_cost_usd_per_day`` (incl. 0 = unlimited).
        max_triage_cost_usd_per_day: float = 5.0

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
        # ``verify_loop_interval_seconds`` (declared above with the other
        # leader-gated loop cadences — the SSOT for this interval).
        verify_delay_seconds: int = 1800
        verify_quiet_window_minutes: int = 30
        verify_max_attempts: int = 3
        # M3 (D3) janitor: issues stuck in ``fix_pending`` longer than
        # this are returned to ``triaged`` (+ audit row + cockpit
        # "stuck" badge) by the verify worker's ``fix_pending_janitor``
        # idle chore.
        fix_pending_max_age_minutes: int = 120

        @property
        def verify_poll_interval_seconds(self) -> float:
            """Deprecated alias (M3, D7) — this used to be a dead field
            that disagreed with the interval the worker actually reads.
            It now reads through to ``verify_loop_interval_seconds``."""
            global _VERIFY_POLL_ALIAS_WARNED
            if not _VERIFY_POLL_ALIAS_WARNED:
                _VERIFY_POLL_ALIAS_WARNED = True
                logger.warning(
                    "config: verify_poll_interval_seconds is deprecated; "
                    "reading through to verify_loop_interval_seconds"
                )
            return self.verify_loop_interval_seconds

        # ── Artifacts + Ledger (GA — default on; org features can kill) ─
        artifacts_v1: bool = True
        ledger_v1: bool = True
        artifacts_inrun_v1: bool = False
        improvement_loop_preview: bool = False
        zero_label_onboarding_v1: bool = False
        inject_budget_soft_tokens: int = 800
        inject_budget_hard_tokens: int = 1200
        max_promoted_artifacts: int = 8
        max_evolution_ops_usd_per_org_day: float = 2.0
        min_lift_per_100_tokens: float = 0.5

        # ── WS4 enterprise feature flags ────────────────────────────────
        # Sampling reuses Layer A judge_scores when present ($0 path).
        production_eval_sampling_v1: bool = True
        # Signal investigator LLM path removed — StatGate/heuristics only
        signal_investigator_llm_v1: bool = False
        fleet_health_v1: bool = True
        compliance_pack_export_v1: bool = True
        issue_experiments_v1: bool = True
        # In-process code evaluators use exec() without a real sandbox —
        # keep OFF until subprocess/container isolation ships.
        code_evaluators_exec_enabled: bool = Field(
            default=False,
            validation_alias=AliasChoices(
                "code_evaluators_exec_enabled",
                "CODE_EVALUATORS_EXEC_ENABLED",
                "EDEN_CODE_EVALUATORS_EXEC_ENABLED",
            ),
        )

        # ── Issue alerting (F47 Wave 7) ─────────────────────────────────
        # SendKit email alert storm control (Slack removed 2026-07-23).
        # Each fingerprint is deduped for ``issue_alert_dedup_minutes``
        # and an org is capped at ``issue_alert_max_per_hour`` alerts/hour.
        issue_alerts_enabled: bool = True
        issue_alert_dedup_minutes: int = 15
        issue_alert_max_per_hour: int = 30

        # ── Phase 7 Wave 8 (F06/F65/N10) ───────────────────────────────
        signal_clusters_v1: bool = True
        signal_backfill_v1: bool = True
        deep_search_to_signal_v1: bool = True
        f65_topics_v1: bool = True

        # ── Settings the code reads but this class never declared ───────
        #
        # Every field below was already being read somewhere in src/eden
        # and was NOT defined here. ``model_config`` sets
        # ``extra="ignore"``, so each was permanently absent: the
        # ``getattr(settings, "x", default)`` call sites silently took
        # their fallback, and no environment variable could change it.
        # They read like live knobs in review and were not.
        #
        # Each default below is the EXACT fallback its call site was
        # already using, extracted mechanically by
        # ``scripts/settings_drift_defaults.py`` rather than chosen — so
        # declaring them changes no behaviour. The fix is that they
        # become settable. Verified no name was read with two different
        # defaults, which would have meant no single safe value existed.
        #
        # ``scripts/settings_drift_check.py`` guards against the class
        # drifting from its readers again.

        # Per-step timeouts for the quality pipeline, milliseconds.
        # These five were read as bare attributes
        # (``s.quality_step_timeout_tas_ms``), so the AttributeError was
        # caught by ``_get_timeout``'s ``except Exception`` and every
        # step silently fell back to a uniform 30s — the whole mapping
        # was unreachable. 30000 preserves that effective behaviour.
        quality_step_timeout_tas_ms: int = 30000
        quality_step_timeout_loop_ms: int = 30000
        quality_step_timeout_quality_ms: int = 30000
        quality_step_timeout_reasoning_ms: int = 30000
        quality_step_timeout_detection_ms: int = 30000

        # Middleware kill switches. Both already defaulted to True via
        # getattr, so the middleware ran — but neither could be turned
        # OFF by configuration, which is what northflank.yml's
        # QUOTA_ENFORCEMENT_ENABLED comment implies you can do.
        quota_enforcement_enabled: bool = True
        rls_org_context_enabled: bool = True

        # Feature flags whose branches were unreachable.
        # ``online_scoring_llm_fallback_v1`` gates the production-eval
        # LLM fallback in evaluation/online/scorer_cascade.py.
        online_scoring_llm_fallback_v1: bool = False
        otel_dual_emit_enabled: bool = False
        otel_dual_emit_include_content: bool = False
        otel_exporter_otlp_endpoint: str = ""
        patterns_clusterer_enabled: bool = True
        patterns_clusterer_lookback_days: int = 7
        patterns_clusterer_min_cluster_size: int = 20
        nl_alerts_paging_enabled: bool = True
        optimization_cache_emit_metrics: bool = True
        gateway_enabled: bool = True

        # Third-party integration credentials. Without these fields the
        # corresponding integrations could never be configured at all —
        # the status routes always saw an empty key.
        wandb_api_key: str = ""
        wandb_project: str = "eden"
        helicone_api_key: str = ""
        langfuse_public_key: str = ""
        langfuse_secret_key: str = ""
        langfuse_host: str = "https://cloud.langfuse.com"
        langsmith_api_key: str = ""
        langsmith_endpoint: str = "https://api.smith.langchain.com"
        runloop_api_key: str = ""
        runloop_sdk_module: str = "runloop"
        kafka_bootstrap_servers: str = "localhost:9092"

        # Outbound webhooks.
        alert_webhook_url: str | None = None
        support_webhook_url: str = ""
        eden_support_webhook_url: str = ""

        # Bronze-layer sink tuning. northflank.yml sets
        # BRONZE_BATCH_SIZE / BRONZE_FLUSH_INTERVAL_SECONDS on the
        # service, and until now neither reached the code.
        bronze_batch_size: int = 100
        bronze_flush_interval_seconds: float = 5.0
        bronze_s3_prefix: str = "bronze/events"

        # Media store.
        media_backend: str = "local"
        media_s3_bucket: str = "eden-media"
        media_storage_path: str = "/var/lib/eden/media"

        # Misc.
        app_ingest_per_tenant_rpm: int = 5000
        api_public_url: str | None = None
        eden_api_url: str | None = None
        eden_log_tenant: str | None = None

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

        def get_action_default(
            self, action_class: str
        ) -> bool:  # ponytail: instance helper — sets are instance-scoped (Pydantic model_config doesn't allow dict defaults at class level on BaseSettings)
            """Return the default kill-switch state for ``action_class``.

            Audit 2026-07-02 — mutating classes default False;
            read-only default True. Unknown classes default **False**
            (fail-closed) so new action types cannot auto-apply until
            explicitly allow-listed.
            """
            return self._KILL_SWITCH_DEFAULT.get(action_class, False)

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
            "1",
            "true",
            "yes",
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
    if not os.environ.get("PYTEST_CURRENT_TEST") and len(settings.jwt_secret) < 32:
        raise RuntimeError(
            "jwt_secret must be at least 32 characters. Generate one "
            "with: python -c 'import secrets; print(secrets.token_urlsafe(32))'"
        )
    # Production must use a dedicated ENCRYPTION_KEY — never the
    # JWT_SECRET-derived fallback (rotation of either secret would
    # break the other).
    if settings.eden_production and not (settings.encryption_key or "").strip():
        raise RuntimeError(
            "encryption_key is required when eden_production=True. "
            "Set ENCRYPTION_KEY to a Fernet key "
            "(python -c 'from cryptography.fernet import Fernet; "
            "print(Fernet.generate_key().decode())')."
        )
    return settings
