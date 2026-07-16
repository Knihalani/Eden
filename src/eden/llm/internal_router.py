"""Central ModelRouter entry point for Eden-internal LLM calls.

Platform intelligence must route through :class:`ModelRouter` so tier
selection, fallback chains, and validation stay consistent. Do not call
:class:`OpenRouterClient.call` directly from feature code — only
``ModelRouter`` and this module should reach the client.

Streaming chat (Cmd-J) uses :func:`resolve_models` to pick a tier/model,
then calls the OpenRouter chat API directly.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.llm.client import LLMResponse
from eden.optimization.model_router import ModelRouter, ModelTier, PipelineTask
from eden.optimization.model_router import TIER_MODELS

logger = logging.getLogger(__name__)

_default_router: ModelRouter | None = None


def get_router(llm_client: Any | None = None) -> ModelRouter:
    """Return a ``ModelRouter`` (process singleton unless ``llm_client`` set)."""
    global _default_router
    if llm_client is not None:
        return ModelRouter(llm_client=llm_client)
    if _default_router is None:
        from eden.llm.client import get_llm_client

        _default_router = ModelRouter(llm_client=get_llm_client())
    return _default_router


def build_task(
    agent: str,
    *,
    slot: str = "fast",
    description: str = "",
    output_type: str = "json",
    requires_novelty: bool = False,
    expected_min_length: int = 50,
    requires_quality_check: bool = True,
    org_id: str | None = None,
) -> PipelineTask:
    """Construct a :class:`PipelineTask` for routing."""
    return PipelineTask(
        agent=agent,
        description=description or agent.replace("_", " "),
        slot=slot,
        output_type=output_type,
        requires_novelty=requires_novelty,
        expected_min_length=expected_min_length,
        requires_quality_check=requires_quality_check,
        org_id=org_id,
    )


def route_sync(
    agent: str,
    prompt: str,
    *,
    slot: str = "fast",
    system_prompt: str | None = None,
    description: str = "",
    output_type: str = "json",
    expected_min_length: int = 50,
    llm_client: Any | None = None,
    router: ModelRouter | None = None,
    **kwargs: Any,
) -> LLMResponse:
    """Synchronous internal LLM call via ``ModelRouter.route``."""
    r = router or get_router(llm_client)
    task = build_task(
        agent,
        slot=slot,
        description=description,
        output_type=output_type,
        expected_min_length=expected_min_length,
        requires_quality_check=kwargs.pop("requires_quality_check", True),
    )
    return r.route(task, prompt, system_prompt=system_prompt, **kwargs)


async def route_async(
    agent: str,
    prompt: str,
    *,
    slot: str = "fast",
    system_prompt: str | None = None,
    description: str = "",
    output_type: str = "json",
    requires_novelty: bool = False,
    expected_min_length: int = 50,
    llm_client: Any | None = None,
    router: ModelRouter | None = None,
    **kwargs: Any,
) -> LLMResponse:
    """Async internal LLM call via ``ModelRouter.aroute``."""
    r = router or get_router(llm_client)
    task = build_task(
        agent,
        slot=slot,
        description=description,
        output_type=output_type,
        requires_novelty=requires_novelty,
        expected_min_length=expected_min_length,
        requires_quality_check=kwargs.pop("requires_quality_check", True),
    )
    return await r.aroute(task, prompt, system_prompt=system_prompt, **kwargs)


async def resolve_models(
    agent: str,
    *,
    slot: str = "fast",
    description: str = "",
    output_type: str = "text",
    requires_novelty: bool = False,
    llm_client: Any | None = None,
) -> tuple[ModelTier, list[str]]:
    """Classify a task and return ``(tier, model_chain)`` for streaming callers."""
    r = get_router(llm_client)
    task = build_task(
        agent,
        slot=slot,
        description=description,
        output_type=output_type,
        requires_novelty=requires_novelty,
        requires_quality_check=False,
    )
    classification = await r.classifier.classify(task)
    tier = classification.tier
    models = list(TIER_MODELS.get(tier, TIER_MODELS[ModelTier.T2]))
    return tier, models


__all__ = [
    "build_task",
    "get_router",
    "resolve_models",
    "route_async",
    "route_sync",
]
