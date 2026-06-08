"""LangGraph PostgreSQL checkpointer factory."""

import logging
from typing import Optional

from langgraph.checkpoint.postgres import PostgresSaver  # was: PostgresCheckpointSaver

from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


async def create_postgres_checkpointer() -> Optional[PostgresSaver]:
    """Create a PostgresSaver backed by Eden's PostgreSQL pool.

    Returns None if PostgreSQL is not available.
    """
    try:
        client = await get_postgres_client()
        return PostgresSaver(pool=client._pool)
    except Exception as e:
        logger.warning(f"Could not create PostgresSaver: {e}")
        return None