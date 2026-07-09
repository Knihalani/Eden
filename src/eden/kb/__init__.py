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


def _get_postgres_client():
    """Lazy import + return the Postgres client factory."""
    from eden.storage.postgres import get_postgres_client
    return get_postgres_client


def _get_qdrant_client():
    """Lazy import + return the Qdrant client factory."""
    from eden.storage.qdrant import get_qdrant_client
    return get_qdrant_client


logger = logging.getLogger(__name__)


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

    get_postgres_client = _get_postgres_client()
    client = await get_postgres_client()

    migrations_dir = os.environ.get(
        "EDEN_MIGRATIONS_DIR",
        "/Users/kaiavnihalani/Downloads/Eden/migrations"
    )

    schema_file = f"{migrations_dir}/001_kb_schema.sql"

    if not os.path.exists(schema_file):
        logger.warning(f"Migration file not found: {schema_file}")
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
    """Initialize Qdrant collections."""
    get_qdrant_client = _get_qdrant_client()
    client = get_qdrant_client()

    try:
        client.initialize_collections()
        logger.info("Qdrant collections initialized")
    except Exception as e:
        logger.error(f"Failed to initialize Qdrant collections: {e}")
        raise


async def health_check() -> dict:
    """Check Knowledge Base health.

    Returns:
        Dict with health status of each KB layer
    """
    health = {
        "postgres": "unknown",
        "qdrant": "unknown",
    }

    # Lazy-resolve clients (audit 2026-07-06).
    get_postgres_client = _get_postgres_client()
    get_qdrant_client = _get_qdrant_client()

    # Check PostgreSQL
    try:
        client = await get_postgres_client()
        result = await client.fetchval("SELECT 1")
        health["postgres"] = "connected" if result == 1 else "error"
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

    return health
