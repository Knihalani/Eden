"""Tests for ``eden.model_router`` — slot → LiteLLM name mapping."""

from __future__ import annotations

import pytest

from eden.config import ModelsConfig
from eden.model_router import ModelRouter, build_router


@pytest.fixture
def router() -> ModelRouter:
    return ModelRouter(
        ModelsConfig(
            reasoning="anthropic/claude-sonnet-4.6",
            code="qwen/qwen3-coder:free",
            fast="deepseek/deepseek-v4-flash:free",
            fallback="meta-llama/llama-3.3-70b-instruct",
        )
    )


def test_resolve_known_slots(router: ModelRouter):
    assert router.resolve("reasoning") == "anthropic/claude-sonnet-4.6"
    assert router.resolve("code") == "qwen/qwen3-coder:free"
    assert router.resolve("fast") == "deepseek/deepseek-v4-flash:free"
    assert router.resolve("fallback") == "meta-llama/llama-3.3-70b-instruct"


def test_resolve_unknown_slot_raises(router: ModelRouter):
    with pytest.raises(ValueError):
        router.resolve("nonexistent")  # type: ignore[arg-type]


def test_default_for_chat_is_code(router: ModelRouter):
    assert router.default() == "qwen/qwen3-coder:free"


def test_for_task_heuristic(router: ModelRouter):
    assert router.for_task("plan and reason") == router.reasoning
    assert router.for_task("implement feature") == router.code
    assert router.for_task("summary please") == router.fast
    assert router.for_task("refactor module") == router.code
    # Unknown task → code
    assert router.for_task("dance party") == router.code


def test_as_dict_round_trip(router: ModelRouter):
    out = router.as_dict()
    assert set(out.keys()) == {"reasoning", "code", "fast", "fallback"}
    assert out["code"] == "qwen/qwen3-coder:free"


def test_build_router_from_config():
    from eden.config import EdenCLIConfig

    cfg = EdenCLIConfig(
        models=ModelsConfig(
            reasoning="r", code="c", fast="f", fallback="fb"
        )
    )
    r = build_router(cfg)
    assert r.reasoning == "r"
    assert r.code == "c"
    assert r.fast == "f"
    assert r.fallback == "fb"
