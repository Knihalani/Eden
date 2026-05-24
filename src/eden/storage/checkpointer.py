"""LangGraph PostgreSQL checkpointer factory."""

import logging
from typing import Optional

from langgraph.checkpoint.postgres import PostgresCheckpointSaver

from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


async def create_postgres_checkpointer() -> Optional[PostgresCheckpointSaver]:
    """Create a PostgresCheckpointSaver backed by Eden's PostgreSQL pool.

    Returns None if PostgreSQL is not available.
    """
    try:
        client = await get_postgres_client()
        return PostgresCheckpointSaver(pool=client._pool)
    except Exception as e:
        logger.warning(f"Could not create PostgresCheckpointSaver: {e}")
        return None