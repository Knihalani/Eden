"""Unit tests for AgentEfficiencyController + issue patch suppress."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from eden.closed_loop.efficiency import AgentEfficiencyController


@pytest.mark.asyncio
async def test_should_run_triage_already_triaged() -> None:
    ctrl = AgentEfficiencyController()
    issue = SimpleNamespace(triage_result={"root_cause": "x"}, fingerprint="fp")
    ok, reason = await ctrl.should_run_triage(
        "org", "iss-1", issue=issue, force=False
    )
    assert ok is False
    assert reason == "already_triaged"


@pytest.mark.asyncio
async def test_should_run_triage_forced() -> None:
    ctrl = AgentEfficiencyController()
    issue = SimpleNamespace(triage_result={"root_cause": "x"}, fingerprint="fp")
    ok, reason = await ctrl.should_run_triage(
        "org", "iss-1", issue=issue, force=True
    )
    assert ok is True
    assert reason == "forced"


@pytest.mark.asyncio
async def test_should_run_patch_duplicate_open() -> None:
    ctrl = AgentEfficiencyController()
    with patch.object(
        ctrl,
        "_open_patch_for_rca",
        AsyncMock(return_value={"id": "patch_1"}),
    ):
        ok, reason = await ctrl.should_run_patch("org", "iss-1")
    assert ok is False
    assert reason == "duplicate_open_patch"


@pytest.mark.asyncio
async def test_should_run_scheduled_requires_opt_in() -> None:
    ctrl = AgentEfficiencyController()
    ok, reason = await ctrl.should_run_scheduled(
        "org",
        {
            "code_change_enabled": False,
            "optimization_schedule": "weekly",
            "optimization_weekday": 0,
            "optimization_hour_utc": 9,
        },
        now=datetime(2026, 7, 13, 9, 0, tzinfo=UTC),
    )
    assert ok is False
    assert reason == "code_change_enabled=false"


@pytest.mark.asyncio
async def test_should_run_scheduled_due() -> None:
    ctrl = AgentEfficiencyController()
    ok, reason = await ctrl.should_run_scheduled(
        "org",
        {
            "code_change_enabled": True,
            "optimization_schedule": "weekly",
            "optimization_weekday": 0,
            "optimization_hour_utc": 9,
            "last_optimization_run_at": None,
            "daily_maintenance_budget_usd": None,
        },
        now=datetime(2026, 7, 13, 9, 0, tzinfo=UTC),
    )
    assert ok is True
    assert reason == "due"


@pytest.mark.asyncio
async def test_should_run_scheduled_not_due() -> None:
    ctrl = AgentEfficiencyController()
    ok, reason = await ctrl.should_run_scheduled(
        "org",
        {
            "code_change_enabled": True,
            "optimization_schedule": "weekly",
            "optimization_weekday": 0,
            "optimization_hour_utc": 9,
        },
        now=datetime(2026, 7, 13, 12, 0, tzinfo=UTC),
    )
    assert ok is False
    assert reason == "not_due"
