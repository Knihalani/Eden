"""Unit tests for N23 ImprovementAgent."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.improvement.agent import ImprovementAgent


@pytest.mark.asyncio
async def test_sweep_disabled_when_flag_off() -> None:
    with patch(
        "eden.improvement.agent._agent_enabled_for_org",
        AsyncMock(return_value=False),
    ):
        result = await ImprovementAgent().sweep("org-1")
    assert result["status"] == "disabled"


@pytest.mark.asyncio
async def test_sweep_completes_with_no_candidates(monkeypatch) -> None:
    monkeypatch.setattr("eden.improvement.agent._agent_enabled", lambda: True)
    with (
        patch(
            "eden.improvement.agent.runs_repo.get_watermark",
            AsyncMock(return_value=__import__("datetime").datetime(1970, 1, 1)),
        ),
        patch(
            "eden.improvement.agent.runs_repo.create_run",
            AsyncMock(return_value={"id": "run-1"}),
        ),
        patch(
            "eden.improvement.agent.runs_repo.finish_run",
            AsyncMock(return_value={"id": "run-1", "status": "completed"}),
        ),
        patch(
            "eden.improvement.agent.imp_settings.get_settings",
            AsyncMock(return_value={"improvement_max_plans_per_sweep": 10}),
        ),
        patch.object(
            ImprovementAgent,
            "_rank_and_generate_issue_patches",
            AsyncMock(
                return_value={
                    "created": 0,
                    "skipped": 0,
                    "cost_usd": 0.0,
                    "plan_ids": [],
                }
            ),
        ),
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
        patch("eden.improvement.agent._emit_sweep_completed", AsyncMock()),
    ):
        result = await ImprovementAgent().sweep("org-1")
    assert result["status"] == "completed"
    assert result["plans_created"] == 0
