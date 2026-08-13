"""OOM W3-5 — PatternsClusterer lane budget gate.

Pins that run_once() skips the per-tenant loop when the system-wide
clusterer lane cap is exceeded, returns the expected skip payload, and
continues normally when the cap is not exceeded.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from eden.observability.patterns_clusterer import PatternsClusterer


def _lane_allowed(allowed: bool, spent: float = 0.0, cap: float = 3.0):
    """Patch LaneDailyBudget('clusterer').check() to return a fixed tuple."""
    return patch(
        "eden.llmops.evolution_spend.LaneDailyBudget.check",
        new=AsyncMock(return_value=(allowed, spent, cap)),
    )


@pytest.mark.asyncio
async def test_run_once_skips_when_lane_budget_exceeded() -> None:
    """When lane budget is exceeded, run_once returns a skip payload."""
    settings = SimpleNamespace(patterns_clusterer_enabled=True)
    with (
        patch(
            "eden.observability.patterns_clusterer.get_settings",
            return_value=settings,
        ),
        _lane_allowed(False, spent=3.5, cap=3.0),
    ):
        result = await PatternsClusterer().run_once()

    assert result["skipped"] is True
    assert result["reason"] == "lane_budget_exceeded"
    assert result["tenants_processed"] == 0
    assert result["patterns_created"] == 0
    assert result["lane_spent_usd"] == pytest.approx(3.5)
    assert result["lane_cap_usd"] == pytest.approx(3.0)


@pytest.mark.asyncio
async def test_run_once_continues_when_lane_budget_ok() -> None:
    """When lane budget is fine, run_once falls through to the normal path."""
    settings = SimpleNamespace(patterns_clusterer_enabled=True)

    # After the budget check passes, block at Postgres so the test is fast.
    with (
        patch(
            "eden.observability.patterns_clusterer.get_settings",
            return_value=settings,
        ),
        _lane_allowed(True, spent=0.5, cap=3.0),
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=None),
        ),
    ):
        result = await PatternsClusterer().run_once()

    # Postgres returns None → short-circuit with 0 processed, but NOT skipped.
    assert result.get("skipped") is not True
    assert result["tenants_processed"] == 0


@pytest.mark.asyncio
async def test_run_once_fail_open_when_budget_module_raises() -> None:
    """If the budget import or check raises, run_once continues (fail-open)."""
    settings = SimpleNamespace(patterns_clusterer_enabled=True)
    with (
        patch(
            "eden.observability.patterns_clusterer.get_settings",
            return_value=settings,
        ),
        patch(
            "eden.llmops.evolution_spend.LaneDailyBudget.check",
            new=AsyncMock(side_effect=RuntimeError("redis explosion")),
        ),
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=None),
        ),
    ):
        result = await PatternsClusterer().run_once()

    # Must NOT be a skip — fail-open means we try the normal path.
    assert result.get("skipped") is not True
