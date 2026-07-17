"""F66 collaborative prompt workspace for SMEs."""

from __future__ import annotations

import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)


class PromptWorkspaceService:
    """Collaborators + SME-friendly prompt editing without provider keys."""

    async def list_collaborators(
        self, org_id: str, prompt_name: str
    ) -> list[dict[str, Any]]:
        client = await self._client()
        if client is None:
            return []
        rows = await client.fetch(
            """
            SELECT user_id, role, created_at FROM prompt_collaborators
            WHERE org_id = $1 AND prompt_name = $2
            ORDER BY created_at ASC
            """,
            org_id,
            prompt_name,
        )
        return [dict(r) for r in rows]

    async def add_collaborator(
        self,
        org_id: str,
        *,
        prompt_name: str,
        user_id: str,
        role: str = "editor",
    ) -> dict[str, Any] | None:
        client = await self._client()
        if client is None:
            return None
        cid = str(uuid.uuid4())
        await client.execute(
            """
            INSERT INTO prompt_collaborators (id, org_id, prompt_name, user_id, role)
            VALUES ($1::uuid, $2, $3, $4, $5)
            ON CONFLICT (org_id, prompt_name, user_id) DO UPDATE SET role = EXCLUDED.role
            """,
            cid,
            org_id,
            prompt_name,
            user_id,
            role,
        )
        return {"prompt_name": prompt_name, "user_id": user_id, "role": role}

    async def get_workspace(self, org_id: str, prompt_name: str) -> dict[str, Any]:
        from eden.services.prompt_versioning import PromptService

        prompt = await PromptService().get_prompt(org_id, prompt_name)
        versions = await PromptService().list_versions(org_id, prompt_name)
        collaborators = await self.list_collaborators(org_id, prompt_name)
        from eden.prompts.deploy import PromptDeployService

        envs = await PromptDeployService().list_environments(org_id, prompt_name)
        return {
            "prompt": prompt,
            "versions": versions,
            "collaborators": collaborators,
            "environments": envs,
        }

    async def _client(self) -> Any | None:
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None
