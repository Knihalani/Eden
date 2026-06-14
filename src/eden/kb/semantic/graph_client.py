"""Semantic memory - temporal knowledge graph client.

Handles graph entities and entity links with bitemporal model.
"""

import json
import logging
from datetime import datetime
from uuid import uuid4

from eden.kb.retrieval_logger import get_retrieval_logger
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


class GraphEntityNotFoundError(Exception):
    """Raised when a graph entity is not found."""
    pass


class SemanticGraphClient:
    """Client for temporal knowledge graph operations.

    Uses PostgreSQL with recursive CTEs for graph traversal.
    """

    async def insert_entity(self, entity: dict) -> bool:
        """Insert a new graph entity.

        Entity should have:
        - entity_type: str (EnvironmentClass, DesignPattern, FailureMode, etc.)
        - name: str
        - properties: dict
        - valid_at: datetime (when it was true in the world)
        - recorded_at: datetime (when Eden learned it)
        - embedding: optional list[float]
        """
        client = await get_postgres_client()

        query = """
            INSERT INTO graph_entities (
                id, entity_type, name, properties, valid_at, recorded_at,
                embedding, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        """

        try:
            await client.execute(
                query,
                entity.get("id", str(uuid4())),
                entity["entity_type"],
                entity["name"],
                json.dumps(entity.get("properties", {})),
                entity.get("valid_at", datetime.utcnow()),
                entity.get("recorded_at", datetime.utcnow()),
                entity.get("embedding"),
            )
            return True
        except Exception as e:
            logger.error(f"Failed to insert entity: {e}")
            return False

    async def insert_link(self, link: dict) -> bool:
        """Insert a new entity link (edge).

        Link should have:
        - source_id: UUID
        - target_id: UUID
        - edge_type: str (CAUSES, PREVENTS, ENABLES, IMPROVES, CONTRADICTS, etc.)
        - properties: dict
        - valid_at: datetime
        - recorded_at: datetime
        """
        client = await get_postgres_client()

        query = """
            INSERT INTO entity_links (
                id, source_id, target_id, edge_type, properties, valid_at, recorded_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (source_id, target_id, edge_type) DO UPDATE
            SET properties = EXCLUDED.properties,
                valid_at = EXCLUDED.valid_at,
                recorded_at = EXCLUDED.recorded_at
        """

        try:
            await client.execute(
                query,
                link.get("id", str(uuid4())),
                link["source_id"],
                link["target_id"],
                link["edge_type"],
                json.dumps(link.get("properties", {})),
                link.get("valid_at", datetime.utcnow()),
                link.get("recorded_at", datetime.utcnow()),
            )
            return True
        except Exception as e:
            logger.error(f"Failed to insert link: {e}")
            return False

    async def get_entity(self, entity_id: str) -> dict | None:
        """Get a graph entity by ID."""
        client = await get_postgres_client()

        query = "SELECT * FROM graph_entities WHERE id = $1 AND invalid_at IS NULL"
        return await client.fetchrow(query, entity_id)

    async def get_entity_by_name(
        self,
        name: str,
        entity_type: str | None = None,
    ) -> dict | None:
        """Get a graph entity by name and optional type."""
        client = await get_postgres_client()

        if entity_type:
            query = """
                SELECT * FROM graph_entities
                WHERE name = $1 AND entity_type = $2 AND invalid_at IS NULL
            """
            return await client.fetchrow(query, name, entity_type)
        else:
            query = """
                SELECT * FROM graph_entities
                WHERE name = $1 AND invalid_at IS NULL
            """
            return await client.fetchrow(query, name)

    async def get_links(
        self,
        entity_id: str,
        direction: str = "outgoing",
    ) -> list[dict]:
        """Get links for an entity.

        Args:
            entity_id: The entity ID
            direction: "outgoing" (source), "incoming" (target), or "both"
        """
        client = await get_postgres_client()

        if direction == "outgoing":
            query = """
                SELECT el.*, ge.name as target_name, ge.entity_type as target_type
                FROM entity_links el
                JOIN graph_entities ge ON ge.id = el.target_id
                WHERE el.source_id = $1 AND el.invalid_at IS NULL
            """
        elif direction == "incoming":
            query = """
                SELECT el.*, ge.name as source_name, ge.entity_type as source_type
                FROM entity_links el
                JOIN graph_entities ge ON ge.id = el.source_id
                WHERE el.target_id = $1 AND el.invalid_at IS NULL
            """
        else:  # both
            query = """
                SELECT * FROM entity_links
                WHERE (source_id = $1 OR target_id = $1) AND invalid_at IS NULL
            """

        return await client.fetch(query, entity_id)

    async def traverse_causal_chain(
        self,
        start_id: str,
        max_depth: int = 3,
    ) -> list[dict]:
        """Traverse causal chain from a starting entity.

        Uses recursive CTE for efficient graph traversal.
        """
        client = await get_postgres_client()

        query = """
            WITH RECURSIVE chain AS (
                -- Base case: starting entity
                SELECT
                    ge.id, ge.name, ge.entity_type, ge.properties,
                    'root' as path,
                    0 as depth,
                    ARRAY[ge.id] as visited
                FROM graph_entities ge
                WHERE ge.id = $1 AND ge.invalid_at IS NULL

                UNION ALL

                -- Recursive case: follow CAUSES edges
                SELECT
                    ge.id, ge.name, ge.entity_type, ge.properties,
                    c.path || ' -> ' || ge.name,
                    c.depth + 1,
                    c.visited || ge.id
                FROM chain c
                JOIN entity_links el ON el.source_id = c.id
                JOIN graph_entities ge ON ge.id = el.target_id
                WHERE el.edge_type = 'CAUSES'
                    AND el.invalid_at IS NULL
                    AND ge.invalid_at IS NULL
                    AND c.depth < $2
                    AND NOT (ge.id = ANY(c.visited))
            )
            SELECT * FROM chain ORDER BY depth, path
        """

        return await client.fetch(query, start_id, max_depth)

    async def query_by_type(
        self,
        entity_type: str,
        valid_at: datetime | None = None,
        limit: int = 100,
    ) -> list[dict]:
        """Query entities by type with optional temporal filter."""
        client = await get_postgres_client()

        if valid_at:
            query = """
                SELECT * FROM graph_entities
                WHERE entity_type = $1
                    AND valid_at <= $2
                    AND (invalid_at IS NULL OR invalid_at > $2)
                ORDER BY recorded_at DESC
                LIMIT $3
            """
            entities = await client.fetch(query, entity_type, valid_at, limit)
        else:
            query = """
                SELECT * FROM graph_entities
                WHERE entity_type = $1 AND invalid_at IS NULL
                ORDER BY recorded_at DESC
                LIMIT $2
            """
            entities = await client.fetch(query, entity_type, limit)

        # Log retrieval for RetrievalTuner
        try:
            logger = get_retrieval_logger()
            await logger.log_retrieval(
                collection="graph_entities",
                query_text=entity_type,
                retrieved_items=[{"id": e.get("id")} for e in entities],
                retrieval_method="graph_query",
            )
        except Exception as e:
            logger.warning(f"Failed to log retrieval: {e}")

        return entities

    async def invalidate_entity(self, entity_id: str) -> bool:
        """Mark an entity as invalid (soft delete)."""
        client = await get_postgres_client()

        query = """
            UPDATE graph_entities SET invalid_at = NOW()
            WHERE id = $1
        """

        try:
            await client.execute(query, entity_id)
            return True
        except Exception as e:
            logger.error(f"Failed to invalidate entity: {e}")
            return False


# Singleton
_graph_client: SemanticGraphClient | None = None


def get_graph_client() -> SemanticGraphClient:
    """Get the singleton graph client."""
    global _graph_client
    if _graph_client is None:
        _graph_client = SemanticGraphClient()
    return _graph_client
