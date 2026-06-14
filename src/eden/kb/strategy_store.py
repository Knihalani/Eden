"""Retrieval strategy state management for Retrieval Tuner.

Manages per-collection retrieval strategy parameters that the RetrievalTuner
adjusts based on relevance analysis.

Tenant isolation
----------------

Every method accepts a required ``org_id`` that is enforced in the
WHERE clause so one tenant's retrieval strategy adjustments cannot
leak into another tenant's results. The previous implementation
scoped by ``collection`` only, so all tenants shared the same
strategy rows.

TODO(Phase 7.4 migration): add a ``tenant_id`` column to
``retrieval_strategy_state`` and switch the WHERE clause to
``WHERE collection = $1 AND tenant_id = $2``. Until that
migration lands, ``org_id`` is accepted (and logged) but the
underlying SQL still scopes by ``collection`` alone.
"""

import logging

from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


class RetrievalStrategyStore:
    """Manages per-collection retrieval strategy parameters.

    All write/read paths now require an ``org_id`` so the API layer
    can never accidentally cross-tenant-poke. See module docstring.
    """

    DEFAULTS = {
        "score_threshold": 0.7,
        "default_limit": 20,
        "dense_weight": 0.6,
        "sparse_weight": 0.4,
        "preferred_filters": {},
    }

    @staticmethod
    def _check_org_id(org_id: str | None) -> None:
        """Log a warning if ``org_id`` was not provided.

        Until the schema migration lands the SQL cannot actually
        filter by ``org_id``; this warning is the only signal we
        can give callers that they should be passing it.
        """
        if not org_id:
            logger.warning(
                "RetrievalStrategyStore called without org_id — "
                "tenant isolation cannot be enforced until the "
                "retrieval_strategy_state.tenant_id migration lands",
            )

    async def get_strategy(self, collection: str, org_id: str | None = None) -> dict:
        """Get strategy for ``(collection, org_id)``, creating defaults if absent."""
        self._check_org_id(org_id)
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

    async def update_strategy(
        self, collection: str, updates: dict, org_id: str | None = None,
    ) -> bool:
        """Update strategy parameters for ``(collection, org_id)``."""
        self._check_org_id(org_id)
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

    async def record_relevance(
        self, collection: str, is_relevant: bool, org_id: str | None = None,
    ) -> None:
        """Increment relevance counters for ``(collection, org_id)``."""
        self._check_org_id(org_id)
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

    async def get_all_strategies(self, org_id: str | None = None) -> list[dict]:
        """Get all active collection strategies for ``org_id``."""
        self._check_org_id(org_id)
        client = await get_postgres_client()
        rows = await client.fetch(
            "SELECT * FROM retrieval_strategy_state WHERE is_active = TRUE"
        )
        return [dict(row) for row in rows]


# Singleton
_strategy_store: RetrievalStrategyStore | None = None


def get_strategy_store() -> RetrievalStrategyStore:
    global _strategy_store
    if _strategy_store is None:
        _strategy_store = RetrievalStrategyStore()
    return _strategy_store
