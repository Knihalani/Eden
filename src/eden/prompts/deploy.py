"""F68 gateway prompt deploy — resolve prompt_id + environment without redeploy."""

from __future__ import annotations

import json
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)

_CACHE_TTL_S = 60.0
_deploy_cache: dict[str, tuple[float, dict[str, Any]]] = {}


class PromptDeployService:
    """Pin prompt versions to environments and hot-reload gateway."""

    async def list_environments(self, org_id: str, prompt_name: str) -> list[dict[str, Any]]:
        client = await self._client()
        if client is None:
            return []
        rows = await client.fetch(
            """
            SELECT * FROM prompt_environments
            WHERE org_id = $1 AND prompt_name = $2
            ORDER BY env ASC
            """,
            org_id,
            prompt_name,
        )
        return [dict(r) for r in rows]

    async def deploy(
        self,
        org_id: str,
        *,
        prompt_name: str,
        env: str,
        version: int,
        deployed_by: str | None = None,
    ) -> dict[str, Any] | None:
        client = await self._client()
        if client is None:
            return None
        await client.execute(
            """
            INSERT INTO prompt_environments
            (org_id, prompt_name, env, version, deployed_by, deployed_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (org_id, prompt_name, env) DO UPDATE SET
                version = EXCLUDED.version,
                deployed_by = EXCLUDED.deployed_by,
                deployed_at = NOW()
            """,
            org_id,
            prompt_name,
            env,
            version,
            deployed_by,
        )
        cache_key = f"{org_id}:{prompt_name}:{env}"
        _deploy_cache.pop(cache_key, None)
        resolved = await self.resolve(org_id, prompt_name=prompt_name, env=env)
        if resolved:
            try:
                from eden.llmops.filters.prompt_deploy import get_prompt_deploy_filter

                get_prompt_deploy_filter().set_cached(
                    org_id, prompt_name, env, resolved
                )
            except Exception:
                pass
        await self._reload_gateway_filter(org_id)
        try:
            from eden.api.deps import log_audit_event

            await log_audit_event(
                client=client,
                org_id=org_id,
                user_id=deployed_by or "system",
                action="prompt.deployed",
                target_type="prompt_environment",
                target_id=f"{prompt_name}:{env}",
                metadata={"version": version},
            )
        except Exception:
            pass
        return {"prompt_name": prompt_name, "env": env, "version": version}

    async def resolve(
        self, org_id: str, *, prompt_name: str, env: str = "production"
    ) -> dict[str, Any] | None:
        cache_key = f"{org_id}:{prompt_name}:{env}"
        now = time.monotonic()
        cached = _deploy_cache.get(cache_key)
        if cached and now < cached[0]:
            return cached[1]

        client = await self._client()
        if client is None:
            return None
        row = await client.fetchrow(
            """
            SELECT pe.version, pv.template, pv.model, pv.params
            FROM prompt_environments pe
            LEFT JOIN prompts p ON p.org_id = pe.org_id AND p.name = pe.prompt_name
            LEFT JOIN prompt_versions pv ON pv.prompt_id = p.id AND pv.version = pe.version
            WHERE pe.org_id = $1 AND pe.prompt_name = $2 AND pe.env = $3
            """,
            org_id,
            prompt_name,
            env,
        )
        if not row:
            return None
        payload = {
            "prompt_name": prompt_name,
            "env": env,
            "version": int(row["version"]),
            "template": row.get("template"),
            "model": row.get("model"),
            "params": dict(row.get("params") or {}),
        }
        _deploy_cache[cache_key] = (now + _CACHE_TTL_S, payload)
        return payload

    async def _reload_gateway_filter(self, org_id: str) -> None:
        try:
            from eden.llmops.learn_wiring import install_learn_filters

            install_learn_filters()
        except Exception as exc:
            logger.debug("prompt_deploy: gateway reload failed: %s", exc)

    async def _client(self) -> Any | None:
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None
