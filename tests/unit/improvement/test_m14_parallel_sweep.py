"""M14 (§8.4) — parallel sweep signal gather smoke test."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.improvement.agent import ImprovementAgent, _SWEEP_TIMEOUT_S
from eden.improvement.planner import PlanCandidate


def test_sweep_timeout_cap_is_sixty() -> None:
    """§8.4: overall sweep p95 target < 60s (was 300s)."""
    assert _SWEEP_TIMEOUT_S == 60


@pytest.mark.asyncio
async def test_sweep_body_gathers_signal_stages_in_parallel() -> None:
    """Independent signal classes run via asyncio.gather (order-independent)."""
    agent = ImprovementAgent()
    call_order: list[str] = []
    started = asyncio.Event()
    release = asyncio.Event()

    async def _slow_traces(*_a, **_k):
        call_order.append("traces_start")
        started.set()
        await release.wait()
        call_order.append("traces_end")
        return []

    async def _fast_metrics(*_a, **_k):
        # Must be able to start while traces is still waiting —
        # proves gather, not sequential await.
        await started.wait()
        call_order.append("metrics")
        return [
            PlanCandidate(
                plan_kind="advisory",
                title="m",
                source_ref="metrics:1",
                source_fingerprint="fp-m",
                confidence=0.5,
            )
        ]

    async def _empty(*_a, **_k):
        return []

    run = {"id": "run-1"}
    with (
        patch(
            "eden.improvement.agent.runs_repo.get_watermark",
            AsyncMock(return_value=datetime.now(UTC)),
        ),
        patch("eden.improvement.agent.runs_repo.create_run", AsyncMock(return_value=run)),
        patch("eden.improvement.agent.runs_repo.finish_run", AsyncMock()),
        patch(
            "eden.improvement.agent.imp_settings.get_settings",
            AsyncMock(
                return_value={
                    "improvement_max_plans_per_sweep": 10,
                    "improvement_max_code_patch_per_sweep": 3,
                    "improvement_max_advisory_per_sweep": 5,
                    "improvement_max_generates_per_sweep": 3,
                }
            ),
        ),
        patch(
            "eden.improvement.agent.begin_sweep_llm_budget",
            MagicMock(),
        ),
        patch("eden.improvement.agent.clear_sweep_llm_budget", MagicMock()),
        patch.object(
            agent,
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
        patch.object(agent, "_from_traces", side_effect=_slow_traces),
        patch.object(agent, "_from_metrics", side_effect=_fast_metrics),
        patch.object(agent, "_from_repo_health", side_effect=_empty),
        patch.object(agent, "_from_cost_anomalies", side_effect=_empty),
        patch.object(agent, "_from_prompt_nudge_candidates", side_effect=_empty),
        patch(
            "eden.improvement.agent.persist_candidates",
            AsyncMock(return_value=([], 0)),
        ),
        patch(
            "eden.improvement.agent._emit_sweep_completed",
            AsyncMock(),
        ),
        patch(
            "eden.config.get_settings",
            return_value=SimpleNamespace(
                patch_max_llm_calls_per_sweep=8,
                sweep_signal_timeout_s=5.0,
            ),
        ),
    ):
        task = asyncio.create_task(agent._sweep_body("org-1"))
        await started.wait()
        # metrics should have a chance to run while traces is blocked
        await asyncio.sleep(0.05)
        release.set()
        result = await task

    assert result["status"] == "completed"
    assert "traces_start" in call_order
    assert "metrics" in call_order
    # metrics finished (or at least started) before traces_end → parallel
    assert call_order.index("metrics") < call_order.index("traces_end")
