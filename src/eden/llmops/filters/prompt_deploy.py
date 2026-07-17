"""F68 gateway filter — inject env-pinned prompt template on live requests."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


class PromptDeployGatewayFilter:
    """Resolve ``prompt_id`` + ``env`` from request metadata without redeploy."""

    name = "prompt_deploy"

    def __init__(self) -> None:
        self._cache: dict[str, dict[str, Any]] = {}

    def set_cached(self, org_id: str, prompt_name: str, env: str, payload: dict[str, Any]) -> None:
        self._cache[f"{org_id}:{prompt_name}:{env}"] = payload

    def enabled(self, request: Any) -> bool:
        meta = getattr(request, "metadata", None) or {}
        return bool(meta.get("prompt_name") or meta.get("prompt_id"))

    def apply(self, request: Any) -> tuple[Any, list[str]]:
        meta = getattr(request, "metadata", None) or {}
        prompt_name = meta.get("prompt_name") or meta.get("prompt_id")
        env = meta.get("env") or meta.get("prompt_env") or "production"
        org_id = str(getattr(request, "org_id", None) or getattr(request, "tenant_id", ""))
        if not prompt_name or not org_id:
            return request, []

        resolved = self._cache.get(f"{org_id}:{prompt_name}:{env}")
        if resolved is None:
            return request, [f"prompt_deploy:cache_miss:{prompt_name}:{env}"]

        template = resolved.get("template")
        if template and getattr(request, "prompt", None):
            request.prompt = str(template)
        return request, [f"prompt_deploy:{prompt_name}@{env}:v{resolved.get('version')}"]


_filter = PromptDeployGatewayFilter()


def get_prompt_deploy_filter() -> PromptDeployGatewayFilter:
    return _filter
