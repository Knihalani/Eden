"""Procedural memory - Skill Library client.

Manages reusable code patterns and skill templates.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Optional, Any
from uuid import uuid4

from eden.storage.postgres import get_postgres_client
from eden.kb.semantic.vector_client import get_vector_client
from eden.kb.retrieval_logger import get_retrieval_logger

logger = logging.getLogger(__name__)


class SkillNotFoundError(Exception):
    """Raised when a skill is not found."""
    pass


class ProceduralClient:
    """Client for Skill Library operations.

    Stores reusable code templates and patterns.
    """

    async def insert(self, skill: dict) -> bool:
        """Insert a new skill.

        Skill should have:
        - name: str
        - description: str
        - code_template: str
        - parameters: dict
        - applicable_env_classes: list[str]
        - applicable_frameworks: list[str]
        - quality_metrics: dict
        - archivist_reviewed: bool
        - confidence_score: float
        - embedding: list[float]
        """
        client = await get_postgres_client()
        vector_client = get_vector_client()

        # Insert into PostgreSQL
        query = """
            INSERT INTO skills (
                id, name, description, code_template, parameters,
                applicable_env_classes, applicable_frameworks,
                quality_metrics, archivist_reviewed, confidence_score,
                embedding, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
        """

        skill_id = skill.get("id", str(uuid4()))

        try:
            await client.execute(
                query,
                skill_id,
                skill["name"],
                skill["description"],
                skill["code_template"],
                json.dumps(skill.get("parameters", {})),
                skill.get("applicable_env_classes", []),
                skill.get("applicable_frameworks", []),
                json.dumps(skill.get("quality_metrics", {})),
                skill.get("archivist_reviewed", False),
                skill.get("confidence_score", 0.5),
                skill.get("embedding"),
            )

            # Also upsert to vector store
            if skill.get("embedding"):
                await vector_client.upsert("skills", [{
                    "id": skill_id,
                    "vector": skill["embedding"],
                    "payload": {
                        "name": skill["name"],
                        "description": skill["description"],
                        "applicable_env_classes": skill.get("applicable_env_classes", []),
                        "applicable_frameworks": skill.get("applicable_frameworks", []),
                    }
                }])

            return True
        except Exception as e:
            logger.error(f"Failed to insert skill: {e}")
            return False

    async def get(self, skill_id: str) -> Optional[dict]:
        """Get a skill by ID."""
        client = await get_postgres_client()

        query = "SELECT * FROM skills WHERE id = $1"
        return await client.fetchrow(query, skill_id)

    async def get_by_name(self, name: str) -> Optional[dict]:
        """Get a skill by name."""
        client = await get_postgres_client()

        query = "SELECT * FROM skills WHERE name = $1"
        return await client.fetchrow(query, name)

    async def list(
        self,
        env_class: Optional[str] = None,
        framework: Optional[str] = None,
        archivist_reviewed: Optional[bool] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict]:
        """List skills with optional filters."""
        client = await get_postgres_client()

        conditions = []
        params = []
        param_idx = 1

        if env_class:
            conditions.append(f"${param_idx} = ANY(applicable_env_classes)")
            params.append(env_class)
            param_idx += 1

        if framework:
            conditions.append(f"${param_idx} = ANY(applicable_frameworks)")
            params.append(framework)
            param_idx += 1

        if archivist_reviewed is not None:
            conditions.append(f"archivist_reviewed = ${param_idx}")
            params.append(archivist_reviewed)
            param_idx += 1

        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        query = f"""
            SELECT * FROM skills
            {where_clause}
            ORDER BY confidence_score DESC, created_at DESC
            LIMIT ${param_idx} OFFSET ${param_idx + 1}
        """
        params.extend([limit, offset])

        return await client.fetch(query, *params)

    async def search_by_embedding(
        self,
        query_vector: list[float],
        env_class: Optional[str] = None,
        framework: Optional[str] = None,
        limit: int = 5,
    ) -> list[dict]:
        """Find similar skills by embedding.

        Args:
            query_vector: Query embedding
            env_class: Optional environment class filter
            framework: Optional framework filter
            limit: Max results

        Returns:
            List of similar skills
        """
        # Build filter conditions
        filter_conditions = {}
        if env_class:
            filter_conditions["applicable_env_classes"] = {"$eq": env_class}
        if framework:
            filter_conditions["applicable_frameworks"] = {"$eq": framework}

        vector_client = get_vector_client()
        results = await vector_client.search(
            collection="skills",
            query_vector=query_vector,
            filter_conditions=filter_conditions,
            limit=limit,
        )

        # Fetch full skill records
        skills = []
        for result in results:
            skill = await self.get(str(result.id))
            if skill:
                skills.append(skill)

        # Log retrieval for RetrievalTuner
        try:
            logger = get_retrieval_logger()
            await logger.log_retrieval(
                collection="skills",
                query_vector=query_vector,
                retrieved_items=[{"id": s.get("id")} for s in skills],
                retrieval_method="vector",
                filter_conditions=filter_conditions,
            )
        except Exception as e:
            logger.warning(f"Failed to log retrieval: {e}")

        return skills

    async def update(
        self,
        skill_id: str,
        updates: dict,
    ) -> bool:
        """Update a skill with partial updates."""
        client = await get_postgres_client()

        set_clauses = []
        params = []
        param_idx = 1

        json_fields = {"parameters", "quality_metrics", "applicable_env_classes", "applicable_frameworks"}

        for key, value in updates.items():
            if key == "id":
                continue
            if key in json_fields:
                set_clauses.append(f"{key} = ${param_idx}")
                params.append(json.dumps(value))
                param_idx += 1
            else:
                set_clauses.append(f"{key} = ${param_idx}")
                params.append(value)
                param_idx += 1

        if not set_clauses:
            return True

        set_clauses.append(f"updated_at = NOW()")
        params.append(skill_id)

        query = f"""
            UPDATE skills SET {', '.join(set_clauses)}
            WHERE id = ${param_idx}
        """

        try:
            await client.execute(query, *params)
            return True
        except Exception as e:
            logger.error(f"Failed to update skill: {e}")
            return False

    async def mark_reviewed(
        self,
        skill_id: str,
        reviewed: bool = True,
    ) -> bool:
        """Mark a skill as reviewed by the Archivist."""
        return await self.update(skill_id, {"archivist_reviewed": reviewed})


# Singleton
_procedural_client: Optional[ProceduralClient] = None


def get_procedural_client() -> ProceduralClient:
    """Get the singleton procedural client."""
    global _procedural_client
    if _procedural_client is None:
        _procedural_client = ProceduralClient()
    return _procedural_client