"""F83 budget unification — CostTracker.track() PG mirror.

Postgres (``budget_service``) is the canonical ledger for budget
enforcement; Redis is only a best-effort cache. These tests guard the
regression where the PG mirror lived behind an early ``return`` when
Redis was unavailable, silently dropping spend from the enforcement
source of truth, and confirm the alert-eval hook fires exactly once
per ``track()`` call (no double-fire).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.optimization.cost_tracker import CostEvent, CostTracker


def _event(cost_cents: float = 25.0) -> CostEvent:
    return CostEvent(
        tenant_id="org-1",
        user_id="user-1",
        job_id="job-1",
        model="gpt-test",
        pipeline_node="node-a",
        cost_type="llm_tokens",
        total_cost_cents=cost_cents,
    )


@pytest.mark.asyncio
async def test_track_mirrors_to_pg_even_when_redis_is_down():
    """Redis outage must not prevent the canonical PG write."""
    tracker = CostTracker()
    with (
        patch(
            "eden.storage.redis.get_redis_client",
            new=AsyncMock(return_value=None),
        ),
        patch(
            "eden.services.budget_service.record_usage",
            new=AsyncMock(return_value=True),
        ) as mock_record_usage,
        patch(
            "eden.services.budget_service.evaluate_budget_alerts",
            new=AsyncMock(return_value=[]),
        ) as mock_evaluate,
    ):
        await tracker.track(_event(cost_cents=25.0))

    mock_record_usage.assert_awaited_once_with("org-1", 0.25)
    mock_evaluate.assert_awaited_once_with("org-1")


@pytest.mark.asyncio
async def test_track_evaluates_alerts_exactly_once_per_call():
    """The mirror must not double-fire the threshold/email evaluation."""
    tracker = CostTracker()
    with (
        patch(
            "eden.storage.redis.get_redis_client",
            new=AsyncMock(return_value=None),
        ),
        patch(
            "eden.services.budget_service.record_usage",
            new=AsyncMock(return_value=True),
        ),
        patch(
            "eden.services.budget_service.evaluate_budget_alerts",
            new=AsyncMock(return_value=[100]),
        ) as mock_evaluate,
    ):
        await tracker.track(_event(cost_cents=100.0))
        await tracker.track(_event(cost_cents=50.0))

    assert mock_evaluate.await_count == 2


@pytest.mark.asyncio
async def test_track_skips_pg_mirror_for_zero_cost_events():
    """Zero-cost events (e.g. cache hits) should not hit budget_service."""
    tracker = CostTracker()
    with (
        patch(
            "eden.storage.redis.get_redis_client",
            new=AsyncMock(return_value=None),
        ),
        patch(
            "eden.services.budget_service.record_usage",
            new=AsyncMock(return_value=True),
        ) as mock_record_usage,
    ):
        await tracker.track(_event(cost_cents=0.0))

    mock_record_usage.assert_not_awaited()
