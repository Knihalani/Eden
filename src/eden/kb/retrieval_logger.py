"""Retrieval logging service for Retrieval Tuner instrumentation.

Every KB retrieval is logged with agent_id, job_id, query, and retrieved items
so the RetrievalTuner can analyze relevance patterns and adjust strategy.
"""

import hashlib
import logging
from typing import Any
from uuid import uuid4

from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


class RetrievalLogger:
    """Instruments KB retrieval operations.

    Thread-safe context management for tracking which job/agent
    is performing a retrieval operation.
    """

    def __init__(self) -> None:
        self._context: dict = {}

    def set_context(self, job_id: str, agent_id: str) -> None:
        """Set retrieval context for current thread/coroutine."""
        self._context = {"job_id": job_id, "agent_id": agent_id}

    def clear_context(self) -> None:
        """Clear retrieval context."""
        self._context = {}

    def warning(self, msg: str, *args: Any, **kwargs: Any) -> None:
        """Log a warning through the module logger.

        Convenience shim so callers that shadow ``logger`` with
        ``get_retrieval_logger()`` can still emit warnings without
        re-importing logging.
        """
        logger.warning(msg, *args, **kwargs)

    def error(self, msg: str, *args: Any, **kwargs: Any) -> None:
        """Log an error through the module logger (shim)."""
        logger.error(msg, *args, **kwargs)

    def info(self, msg: str, *args: Any, **kwargs: Any) -> None:
        """Log an info through the module logger (shim)."""
        logger.info(msg, *args, **kwargs)

    def _hash_query(self, query: Any) -> str:
        """Create deduplication hash for query."""
        content = str(query).encode() if not isinstance(query, str) else query.encode()
        return hashlib.sha256(content).hexdigest()

    async def log_retrieval(
        self,
        collection: str,
        retrieved_items: list[dict],
        query_vector: list[float] | None = None,
        query_text: str | None = None,
        retrieval_method: str = "vector",
        filter_conditions: dict | None = None,
        score_threshold: float | None = None,
        latency_ms: float | None = None,
    ) -> str | None:
        """Log a retrieval event.

        Returns:
            retrieval_log_id if successful, None otherwise
        """
        job_id = self._context.get("job_id")
        agent_id = self._context.get("agent_id")

        if not job_id or not agent_id:
            logger.warning("Retrieval logged without context set")
            return None

        # Extract item IDs from retrieved items
        item_ids = []
        for item in retrieved_items:
            item_id = item.get("id") or item.get("item_id")
            if item_id:
                item_ids.append(item_id)

        if not item_ids:
            return None

        query_hash = self._hash_query(query_vector or query_text or "")

        client = await get_postgres_client()

        try:
            log_id = str(uuid4())
            await client.execute(
                """
                INSERT INTO retrieval_logs (
                    id, job_id, agent_id, collection, query_hash, query_text,
                    retrieved_item_ids, retrieval_method, filter_conditions,
                    score_threshold, retrieval_latency_ms
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                """,
                log_id,
                job_id,
                agent_id,
                collection,
                query_hash,
                query_text,
                item_ids,
                retrieval_method,
                filter_conditions if filter_conditions else None,
                score_threshold,
                latency_ms,
            )

            return log_id
        except Exception as e:
            logger.error(f"Failed to log retrieval: {e}")
            return None

    async def get_retrieval_for_job(self, job_id: str) -> list[dict]:
        """Get all retrieval logs for a job."""
        client = await get_postgres_client()
        return await client.fetch(
            """
            SELECT * FROM retrieval_logs
            WHERE job_id = $1
            ORDER BY created_at ASC
            """,
            job_id,
        )

    async def get_recent_retrievals(self, days: int = 7, limit: int = 1000) -> list[dict]:
        """Get recent retrieval logs across all jobs."""
        client = await get_postgres_client()
        return await client.fetch(
            """
            SELECT * FROM retrieval_logs
            WHERE created_at > NOW() - INTERVAL '1 day' * $1
            ORDER BY created_at DESC
            LIMIT $2
            """,
            days,
            limit,
        )


# Singleton
_retrieval_logger: RetrievalLogger | None = None


def get_retrieval_logger() -> RetrievalLogger:
    global _retrieval_logger
    if _retrieval_logger is None:
        _retrieval_logger = RetrievalLogger()
    return _retrieval_logger
