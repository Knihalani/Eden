"""Knowledge Base initialization and management."""

import logging
from typing import Optional

# Audit 2026-07-06 - lazy-load Qdrant and Postgres clients. The
# Qdrant client in particular pulls ~570ms of import time (grpc
# protobufs + numpy). Previously the eager imports here meant
# every ``from eden.kb.episodic.client import ...`` paid the cost,
# even though the episodic client only uses Postgres. Lazy
# import keeps the KB subpackage import time in the sub-100ms
# range so KB unit tests don't pay the Qdrant import cost.


def classify_postgres_health(select_result: object, read_only_guc: object) -> str:
    """Map a liveness probe + the read-only GUC to a health string.

    ``SELECT 1`` alone is not a sufficient health signal. On 2026-07-30
    the Neon endpoint went read-only for roughly two minutes: every
    INSERT failed with ReadOnlySQLTransactionError, so ingest, signup
    and onboarding were all down — while ``/health`` reported
    ``postgres: connected`` the entire time, because a read-only
    database answers ``SELECT 1`` perfectly.

    For a product whose job is accepting writes, "reachable" and
    "usable" are different claims and the health endpoint has to be able
    to distinguish them.

    ``read_only_guc`` of ``None`` means the GUC could not be read; that
    is reported as connected rather than inventing an outage from a
    failed probe.
    """
    if select_result != 1:
        return "error"
    if read_only_guc is None:
        return "connected"
    return (
        "read_only"
        if str(read_only_guc).strip().lower() in ("on", "true", "yes", "1")
        else "connected"
    )


def _get_postgres_client():
    """Lazy import + return the Postgres client factory."""
    from eden.storage.postgres import get_postgres_client

    return get_postgres_client


def _get_qdrant_client():
    """Lazy import + return the Qdrant client factory."""
    from eden.storage.qdrant import get_qdrant_client

    return get_qdrant_client


logger = logging.getLogger(__name__)

# Cache /health Postgres+Qdrant probes so LB/monitor chatter doesn't
# keep Neon warm with SELECT 1 every few seconds. /ready has its own
# cache path; this mirrors that for the detailed health surface.
# TTL must exceed typical probe cadence (Northflank /ready is 30s;
# external /health monitors are often 30–60s) so idle fleets can
# reach Neon's suspend_timeout (~300s).
_HEALTH_CACHE: dict[str, object] = {"at": 0.0, "value": None}
_HEALTH_CACHE_TTL_S = 90.0


async def initialize_kb() -> None:
    """Initialize the Knowledge Base storage layer.

    Creates PostgreSQL schema and Qdrant collections if they don't exist.
    Should be called on application startup.
    """
    # Lazy-resolve the client factories (audit 2026-07-06).
    # The assignments are intentional side-effects to force the
    # Qdrant / Postgres SDK modules into ``sys.modules`` so the
    # downstream initialisers can use them; we don't need the
    # returned factory objects here.
    _ = _get_postgres_client()  # noqa: F841
    _ = _get_qdrant_client()  # noqa: F841

    # Initialize PostgreSQL schema
    await _initialize_postgres_schema()

    # Initialize Qdrant collections
    _initialize_qdrant_collections()

    # Seed initial prompts if none exist
    await _seed_initial_prompts()

    logger.info("Knowledge Base initialized successfully")


async def _seed_initial_prompts() -> None:
    """Seed initial prompts for all agents if not already present."""
    try:
        from eden.kb.prompt_versions.seed import seed_initial_prompts

        results = await seed_initial_prompts()
        seeded = sum(1 for r in results.values() if r.get("status") == "success")
        if seeded > 0:
            logger.info(f"Seeded initial prompts for {seeded} agents")
    except Exception as e:
        logger.warning(f"Could not seed initial prompts: {e}")


async def _initialize_postgres_schema() -> None:
    """Initialize PostgreSQL schema from migration file."""
    import os
    from pathlib import Path

    from eden.config import get_settings

    get_postgres_client = _get_postgres_client()
    client = await get_postgres_client()

    settings = get_settings()
    migrations_dir = os.environ.get(
        "EDEN_MIGRATIONS_DIR",
        str(settings.migrations_dir),
    )
    if not Path(migrations_dir).is_absolute():
        migrations_dir = str(settings.project_root / migrations_dir)

    schema_file = Path(migrations_dir) / "001_kb_schema.sql"

    if not schema_file.is_file():
        msg = f"Migration file not found: {schema_file}"
        if settings.eden_production or settings.strict_startup_checks:
            logger.error(msg)
            raise FileNotFoundError(msg)
        logger.warning(msg)
        return

    with open(schema_file) as f:
        schema_sql = f.read()

    # Execute schema
    try:
        await client.execute(schema_sql)
        logger.info("PostgreSQL schema initialized")
    except Exception as e:
        logger.error(f"Failed to initialize PostgreSQL schema: {e}")
        raise


def _initialize_qdrant_collections() -> None:
    """Initialize Qdrant collections.

    Soft on failure: Qdrant is not required for non-vector portal paths
    (auth, traces list via Postgres, etc.). Raising here under
    ``EDEN_PRODUCTION=1`` previously risked taking the whole API down
    for an Errno-99 Cloud misconfig while Postgres was healthy.
    """
    get_qdrant_client = _get_qdrant_client()
    client = get_qdrant_client()

    try:
        client.initialize_collections()
        logger.info("Qdrant collections initialized")
    except Exception as e:
        logger.error(
            "Failed to initialize Qdrant collections (soft — API continues): %s",
            e,
        )


async def health_check() -> dict:
    """Check Knowledge Base health.

    Returns:
        Dict with health status of each KB layer
    """
    import time

    now = time.monotonic()
    cached_at = float(_HEALTH_CACHE.get("at") or 0.0)
    cached_val = _HEALTH_CACHE.get("value")
    if cached_val is not None and (now - cached_at) < _HEALTH_CACHE_TTL_S:
        return dict(cached_val)  # type: ignore[arg-type]

    health = {
        "postgres": "unknown",
        "qdrant": "unknown",
    }

    # Lazy-resolve clients (audit 2026-07-06).
    get_postgres_client = _get_postgres_client()
    get_qdrant_client = _get_qdrant_client()

    # Check PostgreSQL.
    #
    # SELECT 1 alone is not enough. On 2026-07-30 the Neon endpoint went
    # read-only for roughly two minutes — every INSERT failed with
    # ReadOnlySQLTransactionError, so ingest, signup and onboarding were
    # all down — while this check happily reported "connected" the whole
    # time, because a read-only database answers SELECT 1 perfectly.
    #
    # A database you cannot write to is an outage for this product, and
    # the health endpoint has to be able to say so. transaction_read_only
    # is a cheap session GUC read; no write is attempted.
    try:
        client = await get_postgres_client()
        result = await client.fetchval("SELECT 1")
        try:
            read_only_guc = await client.fetchval("SHOW transaction_read_only")
        except Exception:  # noqa: BLE001 — GUC unavailable; treat as writable
            read_only_guc = None
        health["postgres"] = classify_postgres_health(result, read_only_guc)
    except Exception as e:
        health["postgres"] = f"error: {str(e)[:100]}"

    # Check Qdrant
    try:
        client = get_qdrant_client()
        # Simple health check - try to list collections
        client._get_client().get_collections()
        health["qdrant"] = "connected"
    except Exception as e:
        health["qdrant"] = f"error: {str(e)[:100]}"

    _HEALTH_CACHE["at"] = now
    _HEALTH_CACHE["value"] = dict(health)
    return health
