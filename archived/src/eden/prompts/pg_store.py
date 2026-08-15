"""Postgres-backed prompt template store (replaces process-local registry)."""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from eden.prompts.registry import PromptRegistry, PromptTemplate

logger = logging.getLogger(__name__)


class OrgPromptStore:
    """Org-scoped write-through store: Postgres preferred, memory fallback.

    Routes should use this instead of the module-level in-memory
    ``PromptRegistry`` so templates survive process restarts.
    """

    def __init__(self, pg: Any | None = None, *, memory_only: bool = False) -> None:
        self._pg = pg
        self._memory_only = memory_only
        self._fallback: dict[str, PromptRegistry] = {}

    def _mem(self, org_id: str) -> PromptRegistry:
        if org_id not in self._fallback:
            self._fallback[org_id] = PromptRegistry()
        return self._fallback[org_id]

    async def _client(self) -> Any | None:
        if self._memory_only:
            return None
        if self._pg is not None:
            return self._pg
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None

    async def register(self, org_id: str, template: PromptTemplate) -> PromptTemplate:
        if template.version == 0:
            template.version = 1
        client = await self._client()
        if client is None:
            return self._mem(org_id).register(template)
        existing = await client.fetchval(
            """
            SELECT 1 FROM prompt_templates
            WHERE org_id = $1 AND name = $2 LIMIT 1
            """,
            org_id,
            template.name,
        )
        if existing:
            raise ValueError(f"template {template.name!r} already exists; use update()")
        await client.execute(
            """
            INSERT INTO prompt_templates (
                id, org_id, name, version, system, user_template, tools,
                required_params, optional_params, model, temperature,
                max_tokens, description
            ) VALUES (
                $1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
                $10, $11, $12, $13
            )
            """,
            str(uuid.uuid4()),
            org_id,
            template.name,
            template.version,
            template.system,
            template.user,
            json.dumps(template.tools),
            json.dumps(template.required_params),
            json.dumps(template.optional_params),
            template.model,
            template.temperature,
            template.max_tokens,
            template.description,
        )
        self._mem(org_id).register(template)
        return template

    async def get(self, org_id: str, name: str) -> PromptTemplate | None:
        client = await self._client()
        if client is None:
            return self._mem(org_id).get(name)
        row = await client.fetchrow(
            """
            SELECT * FROM prompt_templates
            WHERE org_id = $1 AND name = $2
            ORDER BY version DESC LIMIT 1
            """,
            org_id,
            name,
        )
        return _row_to_template(dict(row)) if row else self._mem(org_id).get(name)

    async def list_names(self, org_id: str) -> list[str]:
        client = await self._client()
        if client is None:
            return self._mem(org_id).list_names()
        rows = await client.fetch(
            "SELECT DISTINCT name FROM prompt_templates WHERE org_id = $1 ORDER BY name",
            org_id,
        )
        names = [str(r["name"]) for r in rows]
        return names or self._mem(org_id).list_names()

    async def list_versions(self, org_id: str, name: str) -> list[int]:
        client = await self._client()
        if client is None:
            return self._mem(org_id).list_versions(name)
        rows = await client.fetch(
            """
            SELECT version FROM prompt_templates
            WHERE org_id = $1 AND name = $2 ORDER BY version
            """,
            org_id,
            name,
        )
        versions = [int(r["version"]) for r in rows]
        return versions or self._mem(org_id).list_versions(name)

    async def update(self, org_id: str, template: PromptTemplate) -> PromptTemplate:
        client = await self._client()
        if client is None:
            return self._mem(org_id).update(template)
        latest = await client.fetchval(
            """
            SELECT MAX(version) FROM prompt_templates
            WHERE org_id = $1 AND name = $2
            """,
            org_id,
            template.name,
        )
        if latest is None:
            raise ValueError(f"template {template.name!r} does not exist; use register()")
        template.version = int(latest) + 1
        await client.execute(
            """
            INSERT INTO prompt_templates (
                id, org_id, name, version, system, user_template, tools,
                required_params, optional_params, model, temperature,
                max_tokens, description
            ) VALUES (
                $1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
                $10, $11, $12, $13
            )
            """,
            str(uuid.uuid4()),
            org_id,
            template.name,
            template.version,
            template.system,
            template.user,
            json.dumps(template.tools),
            json.dumps(template.required_params),
            json.dumps(template.optional_params),
            template.model,
            template.temperature,
            template.max_tokens,
            template.description,
        )
        try:
            self._mem(org_id).update(template)
        except ValueError:
            self._mem(org_id).register(template)
        return template

    async def rollback(
        self, org_id: str, name: str, to_version: int
    ) -> PromptTemplate:
        client = await self._client()
        if client is None:
            return self._mem(org_id).rollback(name, to_version)
        row = await client.fetchrow(
            """
            SELECT * FROM prompt_templates
            WHERE org_id = $1 AND name = $2 AND version = $3
            """,
            org_id,
            name,
            to_version,
        )
        if row is None:
            raise ValueError(f"version {to_version} of {name!r} not found")
        old = _row_to_template(dict(row))
        return await self.update(org_id, old)


def _row_to_template(row: dict[str, Any]) -> PromptTemplate:
    def _list(val: Any) -> list[Any]:
        if isinstance(val, str):
            return list(json.loads(val))
        return list(val or [])

    return PromptTemplate(
        name=str(row["name"]),
        system=str(row.get("system") or ""),
        user=str(row.get("user_template") or row.get("user") or ""),
        tools=_list(row.get("tools")),
        required_params=[str(x) for x in _list(row.get("required_params"))],
        optional_params=[str(x) for x in _list(row.get("optional_params"))],
        model=str(row.get("model") or "t1"),
        temperature=float(row.get("temperature") or 0.0),
        max_tokens=int(row.get("max_tokens") or 1024),
        description=str(row.get("description") or ""),
        version=int(row.get("version") or 1),
    )


__all__ = ["OrgPromptStore"]
