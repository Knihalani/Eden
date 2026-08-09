"""OPT-18: ModelRouter.route/aroute bind cost_context for attribution."""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest

from eden.llm.client import LLMResponse, OpenRouterClient, UsageStats
from eden.llmops import cost_ledger as cl
from eden.optimization.model_router import ModelRouter, PipelineTask


def _ok_response() -> LLMResponse:
    return LLMResponse(
        content='{"ok": true}',
        usage=UsageStats(prompt_tokens=10, completion_tokens=5, total_tokens=15),
        model="test/model",
        finish_reason="stop",
    )


@pytest.mark.asyncio
async def test_aroute_binds_org_id_and_feature_in_worker_thread() -> None:
    captured: list[dict] = []

    def fake_call(**_kwargs: object) -> LLMResponse:
        captured.append(cl.current_cost_context())
        return _ok_response()

    router = ModelRouter()
    router.llm_client.call = fake_call  # type: ignore[method-assign]
    task = PipelineTask(
        agent="patch_generator",
        description="generate patch",
        output_type="code",
        expected_min_length=1,
        org_id="org_from_task",
    )

    await router.aroute(
        task,
        "prompt",
        org_id="org_override",
        feature="patches",
    )

    assert captured, "expected llm_client.call to run"
    assert captured[0]["org_id"] == "org_override"
    assert captured[0]["feature"] == "patches"
    assert captured[0]["agent_id"] == "patch_generator"


def test_route_binds_org_id_from_task_when_param_omitted() -> None:
    captured: list[dict] = []

    def fake_call(**_kwargs: object) -> LLMResponse:
        captured.append(cl.current_cost_context())
        return _ok_response()

    router = ModelRouter()
    router.llm_client.call = fake_call  # type: ignore[method-assign]
    task = PipelineTask(
        agent="patch_generator",
        description="generate patch",
        output_type="code",
        expected_min_length=1,
        org_id="org_task_only",
    )

    router.route(task, "prompt", feature="patches")

    assert captured[0]["org_id"] == "org_task_only"
    assert captured[0]["feature"] == "patches"


@pytest.mark.asyncio
async def test_aroute_cost_context_visible_to_log_usage(monkeypatch) -> None:
    """End-to-end: attribution survives to_thread into _log_usage."""
    recorded: list[cl.CostEvent] = []

    async def _capture(event: cl.CostEvent) -> bool:
        recorded.append(event)
        return True

    monkeypatch.setattr(cl, "record_cost_event", _capture)
    cl.reset_event_loop_binding()
    cl.bind_event_loop()

    router = ModelRouter()

    def fake_call(**_kwargs: object) -> LLMResponse:
        resp = _ok_response()
        resp.usage.cost = 0.01
        OpenRouterClient._log_usage(router.llm_client, resp)
        return resp

    router.llm_client.call = fake_call  # type: ignore[method-assign]
    task = PipelineTask(
        agent="patch_generator",
        description="x",
        output_type="code",
        expected_min_length=1,
    )
    await router.aroute(task, "hi", org_id="org_pg", feature="patches")
    for _ in range(20):
        if recorded:
            break
        await asyncio.sleep(0.01)

    cl.reset_event_loop_binding()

    assert recorded, "cost event should be scheduled from worker thread"
    assert recorded[0].org_id == "org_pg"
    assert recorded[0].feature == "patches"
