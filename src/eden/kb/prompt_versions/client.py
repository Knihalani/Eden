"""Prompt versions client for Eden's Knowledge Base.

Manages prompt versioning, A/B testing, and promotion for the Evolution Engine.
"""

import json
import logging

from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


class PromptVersionsClient:
    """Client for prompt version operations.

    Manages the prompt_versions table for prompt evolution and A/B testing.
    """

    async def insert_version(
        self,
        agent: str,
        system_prompt: str,
        version: int,
        few_shot_examples: list[dict] | None = None,
        quality_metrics: dict | None = None,
        active: bool = False,
    ) -> bool:
        """Insert a new prompt version.

        Args:
            agent: Agent name (planner, critic, refiner, etc.)
            system_prompt: The system prompt text
            version: Version number
            few_shot_examples: Optional few-shot examples
            quality_metrics: Initial quality metrics
            active: Whether this version is currently active

        Returns:
            True if inserted successfully
        """
        client = await get_postgres_client()

        query = """
            INSERT INTO prompt_versions (
                agent, version, system_prompt, few_shot_examples,
                quality_metrics, active, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (agent, version) DO UPDATE SET
                system_prompt = EXCLUDED.system_prompt,
                few_shot_examples = EXCLUDED.few_shot_examples,
                quality_metrics = EXCLUDED.quality_metrics
        """

        try:
            await client.execute(
                query,
                agent,
                version,
                system_prompt,
                json.dumps(few_shot_examples or []),
                json.dumps(quality_metrics or {}),
                active,
            )
            return True
        except Exception as e:
            logger.error(f"Failed to insert prompt version: {e}")
            return False

    async def get_active_prompt(self, agent: str) -> dict | None:
        """Get the currently active prompt version for an agent.

        Args:
            agent: Agent name

        Returns:
            Prompt version dict or None if none active
        """
        client = await get_postgres_client()

        query = """
            SELECT id, agent, version, system_prompt, few_shot_examples,
                   quality_metrics, active, created_at, promoted_at
            FROM prompt_versions
            WHERE agent = $1 AND active = TRUE
            LIMIT 1
        """

        row = await client.fetchrow(query, agent)
        if not row:
            return None

        return self._row_to_prompt(row)

    async def get_prompt_history(
        self,
        agent: str,
        limit: int = 10,
        include_inactive: bool = True,
    ) -> list[dict]:
        """Get prompt version history for an agent.

        Args:
            agent: Agent name
            limit: Max versions to return
            include_inactive: Include inactive versions

        Returns:
            List of prompt version dicts, newest first
        """
        client = await get_postgres_client()

        query = """
            SELECT id, agent, version, system_prompt, few_shot_examples,
                   quality_metrics, active, created_at, promoted_at
            FROM prompt_versions
            WHERE agent = $1
            ORDER BY version DESC
            LIMIT $2
        """

        rows = await client.fetch(query, agent, limit)
        return [self._row_to_prompt(row) for row in rows]

    async def get_latest_version(self, agent: str) -> int:
        """Get the latest version number for an agent.

        Args:
            agent: Agent name

        Returns:
            Latest version number, or 0 if none exist
        """
        client = await get_postgres_client()

        query = """
            SELECT MAX(version) as max_version
            FROM prompt_versions
            WHERE agent = $1
        """

        result = await client.fetchval(query, agent)
        return result or 0

    async def deactivate_prompt(self, agent: str, version: int) -> bool:
        """Deactivate a specific prompt version.

        Args:
            agent: Agent name
            version: Version number

        Returns:
            True if updated successfully
        """
        client = await get_postgres_client()

        query = """
            UPDATE prompt_versions
            SET active = FALSE
            WHERE agent = $1 AND version = $2
        """

        try:
            await client.execute(query, agent, version)
            return True
        except Exception as e:
            logger.error(f"Failed to deactivate prompt: {e}")
            return False

    async def activate_prompt(self, agent: str, version: int) -> bool:
        """Activate a specific prompt version (deactivates all others for agent).

        Args:
            agent: Agent name
            version: Version number to activate

        Returns:
            True if updated successfully
        """
        client = await get_postgres_client()

        # Use transaction to deactivate all others then activate target
        async with client.transaction():
            # Deactivate all versions for this agent
            await client.execute(
                "UPDATE prompt_versions SET active = FALSE WHERE agent = $1",
                agent
            )
            # Activate the target version
            await client.execute(
                "UPDATE prompt_versions SET active = TRUE, promoted_at = NOW() "
                "WHERE agent = $1 AND version = $2",
                agent,
                version
            )
        return True

    async def update_quality_metrics(
        self,
        agent: str,
        version: int,
        metrics: dict,
    ) -> bool:
        """Update quality metrics for a prompt version.

        Args:
            agent: Agent name
            version: Version number
            metrics: Quality metrics to merge

        Returns:
            True if updated successfully
        """
        client = await get_postgres_client()

        # Get existing metrics and merge
        query = """
            SELECT quality_metrics
            FROM prompt_versions
            WHERE agent = $1 AND version = $2
        """

        row = await client.fetchrow(query, agent, version)
        if not row:
            return False

        existing = row.get("quality_metrics") or {}
        merged = {**existing, **metrics}

        update_query = """
            UPDATE prompt_versions
            SET quality_metrics = $3
            WHERE agent = $1 AND version = $2
        """

        try:
            await client.execute(update_query, agent, version, json.dumps(merged))
            return True
        except Exception as e:
            logger.error(f"Failed to update quality metrics: {e}")
            return False

    async def increment_metric(
        self,
        agent: str,
        version: int,
        metric_path: str,
        delta: float = 1.0,
    ) -> bool:
        """Increment a numeric quality metric.

        Args:
            agent: Agent name
            version: Version number
            metric_path: Dot-notation path (e.g., "test_pass_rate.total")
            delta: Amount to increment

        Returns:
            True if updated successfully
        """
        client = await get_postgres_client()

        # Get current metrics
        query = """
            SELECT quality_metrics
            FROM prompt_versions
            WHERE agent = $1 AND version = $2
        """

        row = await client.fetchrow(query, agent, version)
        if not row:
            return False

        metrics = row.get("quality_metrics") or {}

        # Navigate and increment using dot notation
        parts = metric_path.split(".")
        current = metrics
        for part in parts[:-1]:
            if part not in current:
                current[part] = {}
            current = current[part]

        last_key = parts[-1]
        if last_key in current:
            current[last_key] = current[last_key] + delta
        else:
            current[last_key] = delta

        # Write back
        update_query = """
            UPDATE prompt_versions
            SET quality_metrics = $3
            WHERE agent = $1 AND version = $2
        """

        try:
            await client.execute(update_query, agent, version, json.dumps(metrics))
            return True
        except Exception as e:
            logger.error(f"Failed to increment metric: {e}")
            return False

    async def get_candidates_for_ab_test(
        self,
        agent: str,
        limit: int = 3,
    ) -> list[dict]:
        """Get inactive prompt versions eligible for A/B testing.

        Args:
            agent: Agent name
            limit: Max candidates to return

        Returns:
            List of candidate prompt versions
        """
        client = await get_postgres_client()

        query = """
            SELECT id, agent, version, system_prompt, few_shot_examples,
                   quality_metrics, active, created_at, promoted_at
            FROM prompt_versions
            WHERE agent = $1
              AND active = FALSE
              AND quality_metrics->>'ab_test_active' = 'true'
            ORDER BY version DESC
            LIMIT $2
        """

        rows = await client.fetch(query, agent, limit)
        return [self._row_to_prompt(row) for row in rows]

    async def get_prompts_for_agent(
        self,
        agent: str,
        version: int | None = None,
    ) -> dict | None:
        """Get a specific prompt version or active if version not specified.

        Args:
            agent: Agent name
            version: Specific version, or None for active

        Returns:
            Prompt version dict or None
        """
        if version is not None:
            client = await get_postgres_client()
            query = """
                SELECT id, agent, version, system_prompt, few_shot_examples,
                       quality_metrics, active, created_at, promoted_at
                FROM prompt_versions
                WHERE agent = $1 AND version = $2
            """
            row = await client.fetchrow(query, agent, version)
            return self._row_to_prompt(row) if row else None
        else:
            return await self.get_active_prompt(agent)

    def _row_to_prompt(self, row: dict) -> dict:
        """Convert a database row to a prompt version dict."""
        return {
            "id": str(row["id"]),
            "agent": row["agent"],
            "version": row["version"],
            "system_prompt": row["system_prompt"],
            "few_shot_examples": row.get("few_shot_examples") or [],
            "quality_metrics": row.get("quality_metrics") or {},
            "active": row["active"],
            "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
            "promoted_at": row["promoted_at"].isoformat() if row.get("promoted_at") else None,
        }


# Singleton
_prompt_versions_client: PromptVersionsClient | None = None


def get_prompt_versions_client() -> PromptVersionsClient:
    """Get the singleton prompt versions client."""
    global _prompt_versions_client
    if _prompt_versions_client is None:
        _prompt_versions_client = PromptVersionsClient()
    return _prompt_versions_client
