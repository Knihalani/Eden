"""Internal router delegates to ModelRouter."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.llm.client import LLMResponse, UsageStats
from eden.llm.internal_router import route_sync
from eden.optimization.model_router import ModelTier


@pytest.mark.asyncio
async def test_route_async_delegates_to_model_router() -> None:
    from eden.llm.internal_router import route_async

    mock_router = MagicMock()
    mock_router.aroute = AsyncMock(
        return_value=LLMResponse(
            content='{"ok": true}',
            usage=UsageStats(),
            model="xiaomi/mimo-v2.5",
            finish_reason="stop",
        )
    )

    with patch("eden.llm.internal_router.get_router", return_value=mock_router):
        resp = await route_async("test_agent", "hello", slot="fast")

    assert resp.content == '{"ok": true}'
    mock_router.aroute.assert_awaited_once()


def test_route_sync_builds_pipeline_task() -> None:
    mock_router = MagicMock()
    mock_router.route.return_value = LLMResponse(
        content="ok",
        usage=UsageStats(),
        model="tencent/hy3",
        finish_reason="stop",
    )

    with patch("eden.llm.internal_router.get_router", return_value=mock_router):
        resp = route_sync("trace_annotator", "tag this", slot="fast")

    assert resp.content == "ok"
    task = mock_router.route.call_args[0][0]
    assert task.agent == "trace_annotator"
    assert task.slot == "fast"


@pytest.mark.asyncio
async def test_resolve_models_returns_tier_chain() -> None:
    from eden.llm.internal_router import resolve_models

    mock_router = MagicMock()
    classification = MagicMock()
    classification.tier = ModelTier.T1
    mock_router.classifier.classify = AsyncMock(return_value=classification)

    with patch("eden.llm.internal_router.get_router", return_value=mock_router):
        tier, models = await resolve_models("chat", slot="fast")

    assert tier == ModelTier.T1
    assert "xiaomi/mimo-v2.5" in models
