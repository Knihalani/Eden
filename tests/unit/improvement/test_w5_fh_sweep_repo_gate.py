"""Wave 5 pinning tests — 5.4 F-H: non-GitHub orgs never draft code_patch plans.

The issue→plan path already gates on a repo (``repo_not_connected``);
this pins the sweep-level gate that stops the code-patch lane from even
churning cheap-gate collection + ranking when no repo is connected, and
stamps ``repo_not_connected`` on the run so the cockpit can surface it.
"""

from __future__ import annotations

from contextlib import ExitStack
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.improvement.agent import ImprovementAgent, _sweep_code_lane_enabled


@pytest.mark.asyncio
async def test_sweep_code_lane_disabled_without_repo() -> None:
    # resolve_active_repo_id is imported inside the helper → patch the
    # source module.
    with patch(
        "eden.providers.factory.resolve_active_repo_id", AsyncMock(return_value=None)
    ):
        assert await _sweep_code_lane_enabled("org-1", None) is False


@pytest.mark.asyncio
async def test_sweep_code_lane_enabled_with_repo() -> None:
    with patch(
        "eden.providers.factory.resolve_active_repo_id",
        AsyncMock(return_value="repo-1"),
    ):
        assert await _sweep_code_lane_enabled("org-1", "checkout-agent") is True


def _patch_sweep_body(lane: AsyncMock) -> tuple[list, AsyncMock]:
    finish_run = AsyncMock()
    patches = [
        patch("eden.improvement.agent.runs_repo.get_watermark", AsyncMock(return_value=None)),
        patch(
            "eden.improvement.agent.runs_repo.create_run",
            AsyncMock(return_value={"id": "run-1"}),
        ),
        patch(
            "eden.improvement.agent.imp_settings.get_settings",
            AsyncMock(return_value={}),
        ),
        patch("eden.improvement.agent.begin_sweep_llm_budget", MagicMock()),
        patch("eden.improvement.agent.clear_sweep_llm_budget", MagicMock()),
        patch.object(ImprovementAgent, "_rank_and_generate_issue_patches", lane),
        patch.object(ImprovementAgent, "_from_traces", AsyncMock(return_value=[])),
        patch.object(ImprovementAgent, "_from_metrics", AsyncMock(return_value=[])),
        patch.object(ImprovementAgent, "_from_repo_health", AsyncMock(return_value=[])),
        patch.object(ImprovementAgent, "_from_cost_anomalies", AsyncMock(return_value=[])),
        patch.object(
            ImprovementAgent, "_from_prompt_nudge_candidates", AsyncMock(return_value=[])
        ),
        patch(
            "eden.improvement.agent.persist_candidates",
            AsyncMock(return_value=([], 0)),
        ),
        patch("eden.improvement.agent.runs_repo.finish_run", finish_run),
        patch("eden.improvement.agent._emit_sweep_completed", AsyncMock()),
    ]
    return patches, finish_run


@pytest.mark.asyncio
async def test_sweep_without_repo_skips_code_lane_and_stamps_run() -> None:
    lane = AsyncMock(side_effect=AssertionError("code lane must not run"))
    patches, finish_run = _patch_sweep_body(lane)
    with (
        patch(
            "eden.improvement.agent._sweep_code_lane_enabled",
            AsyncMock(return_value=False),
        ),
    ):
        with _enter(patches):
            agent = ImprovementAgent()
            result = await agent._sweep_body("org-1")

    lane.assert_not_awaited()
    assert result["repo_not_connected"] is True
    assert result["code_patch_created"] == 0
    # Run row carries the stamp for the cockpit.
    finish_kwargs = finish_run.await_args.kwargs
    meta = finish_kwargs.get("metadata_patch") or {}
    assert meta.get("sweep.repo_not_connected") is True


@pytest.mark.asyncio
async def test_sweep_with_repo_still_runs_code_lane() -> None:
    lane = AsyncMock(
        return_value={"created": 1, "skipped": 0, "cost_usd": 0.5, "plan_ids": ["p1"]}
    )
    patches, finish_run = _patch_sweep_body(lane)
    with patch(
        "eden.improvement.agent._sweep_code_lane_enabled",
        AsyncMock(return_value=True),
    ):
        with _enter(patches):
            agent = ImprovementAgent()
            result = await agent._sweep_body("org-1")

    lane.assert_awaited_once()
    assert result["repo_not_connected"] is False
    assert result["code_patch_created"] == 1


def _enter(patches: list) -> ExitStack:
    stack = ExitStack()
    for p in patches:
        stack.enter_context(p)
    return stack
