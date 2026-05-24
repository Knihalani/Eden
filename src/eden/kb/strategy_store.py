"""Retrieval strategy state management for Retrieval Tuner.

Manages per-collection retrieval strategy parameters that the RetrievalTuner
adjusts based on relevance analysis.
"""

import logging
from datetime import datetime
from typing import Optional

from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


class RetrievalStrategyStore:
    """Manages per-collection retrieval strategy parameters."""

    DEFAULTS = {
        "score_threshold": 0.7,
        "default_limit": 20,
        "dense_weight": 0.6,
        "sparse_weight": 0.4,
        "preferred_filters": {},
    }

    async def get_strategy(self, collection: str) -> dict:
        """Get strategy for a collection, creating if not exists."""
        client = await get_postgres_client()

        row = await client.fetchrow(
            """
            SELECT * FROM retrieval_strategy_state WHERE collection = $1
            """,
            collection,
        )

        if not row:
            await client.execute(
                """
                INSERT INTO retrieval_strategy_state (collection, created_at, updated_at)
                VALUES ($1, NOW(), NOW())
                ON CONFLICT (collection) DO NOTHING
                """,
                collection,
            )
            return self.DEFAULTS.copy()

        return dict(row)

    async def update_strategy(self, collection: str, updates: dict) -> bool:
        """Update strategy parameters for a collection."""
        client = await get_postgres_client()

        set_clauses = ["updated_at = NOW()"]
        params = []
        idx = 1

        for key, value in updates.items():
            set_clauses.append(f"{key} = ${idx}")
            params.append(value)
            idx += 1

        params.append(collection)

        try:
            await client.execute(
                f"""
                UPDATE retrieval_strategy_state
                SET {', '.join(set_clauses)}
                WHERE collection = ${idx}
                """,
                *params,
            )
            return True
        except Exception as e:
            logger.error(f"Failed to update strategy for {collection}: {e}")
            return False

    async def record_relevance(self, collection: str, is_relevant: bool) -> None:
        """Increment relevance counters for a collection."""
        client = await get_postgres_client()

        if is_relevant:
            await client.execute(
                """
                UPDATE retrieval_strategy_state
                SET relevant_count = relevant_count + 1,
                    queries_analyzed = queries_analyzed + 1,
                    updated_at = NOW()
                WHERE collection = $1
                """,
                collection,
            )
        else:
            await client.execute(
                """
                UPDATE retrieval_strategy_state
                SET irrelevant_count = irrelevant_count + 1,
                    queries_analyzed = queries_analyzed + 1,
                    updated_at = NOW()
                WHERE collection = $1
                """,
                collection,
            )

    async def get_all_strategies(self) -> list[dict]:
        """Get all active collection strategies."""
        client = await get_postgres_client()
        rows = await client.fetch(
            "SELECT * FROM retrieval_strategy_state WHERE is_active = TRUE"
        )
        return [dict(row) for row in rows]


# Singleton
_strategy_store: Optional[RetrievalStrategyStore] = None


def get_strategy_store() -> RetrievalStrategyStore:
    global _strategy_store
    if _strategy_store is None:
        _strategy_store = RetrievalStrategyStore()
    return _strategy_store