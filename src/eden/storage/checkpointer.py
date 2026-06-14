"""LangGraph PostgreSQL checkpointer factory."""

import logging

try:
    from langgraph.checkpoint.postgres import PostgresSaver
except ImportError:  # older langgraph versions
    from langgraph.checkpoint.postgres import PostgresCheckpointSaver as PostgresSaver  # type: ignore

from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


async def create_postgres_checkpointer() -> PostgresCheckpointSaver | None:
    """Create a PostgresCheckpointSaver backed by Eden's PostgreSQL pool.

    Returns None if PostgreSQL is not available.
    """
    try:
        client = await get_postgres_client()
        return PostgresSaver(pool=client._pool)
    except Exception as e:
        logger.warning(f"Could not create PostgresCheckpointSaver: {e}")
        return None
